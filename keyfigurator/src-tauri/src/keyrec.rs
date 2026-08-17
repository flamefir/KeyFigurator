//! Macro keystroke recorder — Windows low-level keyboard hook.
//!
//! Records what the user types so a macro can be captured by performing it,
//! instead of hand-assembling `TAP`/`DOWN`/`UP` lines in the editor.
//!
//! # Why a global hook rather than webview key events
//!
//! The webview only sees keys while it has focus, and never sees the ones the
//! OS claims first — Alt+Tab, the Windows key, Ctrl+Alt+Del. Those are exactly
//! the shortcuts people want on a macro pad, so an in-app recorder would
//! silently drop the interesting half of the input. `WH_KEYBOARD_LL` sees the
//! stream before applications do.
//!
//! # Constraints this module holds itself to
//!
//! A low-level keyboard hook is the same mechanism a keylogger is built on, so
//! the scope is deliberately narrow and enforced here rather than left to
//! callers:
//!
//! * The hook exists ONLY between `start_key_recording` and
//!   `stop_key_recording`. It is installed when recording starts and torn down
//!   when it stops — there is no always-on path, and no way to arm it except an
//!   explicit user action in the macro editor.
//! * Captured keys live in memory only, are handed to the frontend once, and
//!   the buffer is cleared on both start and stop. Nothing is written to disk
//!   and nothing leaves the process.
//! * The hook never swallows input. Every event is passed to `CallNextHookEx`,
//!   so typing behaves normally while recording.
//! * Injected events are ignored, so testing a macro cannot record itself into
//!   a feedback loop.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::Instant;

use serde::Serialize;
use windows_sys::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::System::Threading::GetCurrentThreadId;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, PostThreadMessageW, SetWindowsHookExW,
    TranslateMessage, UnhookWindowsHookEx, HC_ACTION, KBDLLHOOKSTRUCT, LLKHF_INJECTED, MSG,
    WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP, WM_QUIT, WM_SYSKEYDOWN, WM_SYSKEYUP,
};

/// One key transition, as handed to the frontend.
///
/// Timestamps are milliseconds since recording started, which is what makes
/// "natural delay" possible — the frontend decides whether to turn the gaps
/// into `DELAY` actions or discard them.
#[derive(Debug, Clone, Serialize)]
pub struct RecordedKey {
    /// QMK keycode name, e.g. `KC_LCTL`. `None` for keys with no mapping.
    pub kc: Option<String>,
    /// Windows virtual-key code, kept so the UI can report what it could not map.
    pub vk: u32,
    pub down: bool,
    pub t_ms: u64,
}

static ARMED: AtomicBool = AtomicBool::new(false);
static HOOK_THREAD: AtomicU32 = AtomicU32::new(0);
static EVENTS: Mutex<Vec<RecordedKey>> = Mutex::new(Vec::new());
static START: Mutex<Option<Instant>> = Mutex::new(None);
/// Test-only seam: lets the hook accept SendInput-generated events so the whole
/// pipeline can be exercised without a human at the keyboard. Never set outside
/// `#[cfg(test)]`.
static ALLOW_INJECTED: AtomicBool = AtomicBool::new(false);

/// The hook callback runs on the hook thread for every key system-wide, so it
/// does the minimum: map, timestamp, push, hand on. Anything slower here shows
/// up as input lag across the whole desktop.
unsafe extern "system" fn ll_keyboard_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 && ARMED.load(Ordering::Relaxed) {
        let kb = &*(lparam as *const KBDLLHOOKSTRUCT);

        // Ignore anything SendInput produced — otherwise "Test" on a macro
        // records the macro replaying itself. The override exists only so the
        // tests can drive the hook with synthetic input; nothing sets it at
        // runtime.
        if kb.flags & LLKHF_INJECTED == 0 || ALLOW_INJECTED.load(Ordering::Relaxed) {
            let msg = wparam as u32;
            let down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
            let up = msg == WM_KEYUP || msg == WM_SYSKEYUP;

            if down || up {
                let t_ms = START
                    .lock()
                    .ok()
                    .and_then(|s| *s)
                    .map(|s| s.elapsed().as_millis() as u64)
                    .unwrap_or(0);

                if let Ok(mut ev) = EVENTS.lock() {
                    // Bounded so a recording left running cannot grow without
                    // limit. 4000 transitions is far longer than any macro that
                    // would fit the board's buffer.
                    if ev.len() < 4000 {
                        ev.push(RecordedKey {
                            kc: vk_to_kc(kb.vkCode, kb.flags).map(str::to_string),
                            vk: kb.vkCode,
                            down,
                            t_ms,
                        });
                    }
                }
            }
        }
    }
    // Always pass it on. Recording observes; it must never eat a keystroke.
    CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
}

/// Begin recording. Installs the hook on a dedicated thread with its own
/// message pump — `WH_KEYBOARD_LL` only delivers to a thread that is pumping
/// messages, so it cannot live on the Tauri command thread.
pub fn start() -> Result<(), String> {
    // Self-healing rather than an error. The Rust side outlives a webview
    // reload, so a page refresh mid-recording (Vite does this on every edit)
    // left ARMED set with no UI attached to it, and every subsequent attempt
    // failed with "already recording" until the app was restarted. Pressing
    // Record means "start a new recording"; honour that by tearing down
    // whatever was left behind first.
    if ARMED.load(Ordering::SeqCst) {
        let _ = stop();
    }

    EVENTS.lock().map_err(|_| "recorder state poisoned")?.clear();
    *START.lock().map_err(|_| "recorder state poisoned")? = Some(Instant::now());
    ARMED.store(true, Ordering::SeqCst);

    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();

    std::thread::spawn(move || unsafe {
        let hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(ll_keyboard_proc), std::ptr::null_mut(), 0);
        if hook.is_null() {
            ARMED.store(false, Ordering::SeqCst);
            let _ = tx.send(Err("SetWindowsHookExW failed".into()));
            return;
        }
        HOOK_THREAD.store(GetCurrentThreadId(), Ordering::SeqCst);
        let _ = tx.send(Ok(()));

        // Pump until stop() posts WM_QUIT.
        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }

        UnhookWindowsHookEx(hook);
        HOOK_THREAD.store(0, Ordering::SeqCst);
    });

    rx.recv_timeout(std::time::Duration::from_secs(3))
        .map_err(|_| "recorder thread did not start".to_string())?
}

/// Stop recording, tear the hook down, and hand back what was captured.
/// Draining here is deliberate: the buffer does not outlive the call.
pub fn stop() -> Result<Vec<RecordedKey>, String> {
    ARMED.store(false, Ordering::SeqCst);

    let tid = HOOK_THREAD.load(Ordering::SeqCst);
    if tid != 0 {
        // Ends GetMessageW, after which the thread unhooks and exits.
        unsafe { PostThreadMessageW(tid, WM_QUIT, 0, 0) };
    }

    let mut guard = EVENTS.lock().map_err(|_| "recorder state poisoned")?;
    let out = std::mem::take(&mut *guard);
    *START.lock().map_err(|_| "recorder state poisoned")? = None;
    Ok(out)
}

/// What has been captured so far, WITHOUT draining.
///
/// Drives the live preview in the editor: the frontend polls this while
/// recording so the actions appear as they are performed, rather than the user
/// pressing keys into a void and finding out at the end whether the right thing
/// was captured. `stop` still returns the full buffer, so peeking cannot lose
/// events or double-count them.
pub fn peek() -> Result<Vec<RecordedKey>, String> {
    Ok(EVENTS.lock().map_err(|_| "recorder state poisoned")?.clone())
}

pub fn is_recording() -> bool {
    ARMED.load(Ordering::SeqCst)
}

/// Windows virtual-key code -> QMK keycode name.
///
/// Keyed on the VK rather than the scan code because the VK is what identifies
/// the key's role; the extended-key flag disambiguates the pairs that share a
/// VK (right-hand modifiers, the navigation cluster vs the numpad).
fn vk_to_kc(vk: u32, flags: u32) -> Option<&'static str> {
    const EXT: u32 = 0x01; // LLKHF_EXTENDED
    let ext = flags & EXT != 0;

    Some(match vk {
        // Letters / digits — VK codes match ASCII for these ranges.
        0x41..=0x5A => return LETTERS.get((vk - 0x41) as usize).copied(),
        0x30..=0x39 => return DIGITS.get((vk - 0x30) as usize).copied(),

        0x08 => "KC_BSPC",
        0x09 => "KC_TAB",
        0x0D => if ext { "KC_KP_ENTER" } else { "KC_ENT" },
        0x1B => "KC_ESC",
        0x20 => "KC_SPC",

        // Modifiers. VK_SHIFT/CONTROL/MENU also arrive as the L/R specific
        // codes from a low-level hook, which is why both are mapped.
        0x10 | 0xA0 => "KC_LSFT",
        0xA1 => "KC_RSFT",
        0x11 | 0xA2 => "KC_LCTL",
        0xA3 => "KC_RCTL",
        0x12 | 0xA4 => "KC_LALT",
        0xA5 => "KC_RALT",
        0x5B => "KC_LGUI",
        0x5C => "KC_RGUI",
        0x5D => "KC_APP",
        0x14 => "KC_CAPS",

        // Navigation
        0x21 => "KC_PGUP",
        0x22 => "KC_PGDN",
        0x23 => "KC_END",
        0x24 => "KC_HOME",
        0x25 => "KC_LEFT",
        0x26 => "KC_UP",
        0x27 => "KC_RGHT",
        0x28 => "KC_DOWN",
        0x2D => "KC_INS",
        0x2E => "KC_DEL",

        // Function row
        0x70..=0x7B => return FKEYS.get((vk - 0x70) as usize).copied(),

        // Punctuation (US layout — see note below)
        0xBA => "KC_SCLN",
        0xBB => "KC_EQL",
        0xBC => "KC_COMM",
        0xBD => "KC_MINS",
        0xBE => "KC_DOT",
        0xBF => "KC_SLSH",
        0xC0 => "KC_GRV",
        0xDB => "KC_LBRC",
        0xDC => "KC_BSLS",
        0xDD => "KC_RBRC",
        0xDE => "KC_QUOT",

        // Numpad
        0x60..=0x69 => return KP_DIGITS.get((vk - 0x60) as usize).copied(),
        0x6A => "KC_PAST",
        0x6B => "KC_PPLS",
        0x6D => "KC_PMNS",
        0x6E => "KC_PDOT",
        0x6F => "KC_PSLS",
        0x90 => "KC_NUM",
        0x91 => "KC_SCRL",
        0x13 => "KC_PAUS",
        0x2C => "KC_PSCR",

        _ => return None,
    })
}

const LETTERS: [&str; 26] = [
    "KC_A", "KC_B", "KC_C", "KC_D", "KC_E", "KC_F", "KC_G", "KC_H", "KC_I", "KC_J", "KC_K", "KC_L",
    "KC_M", "KC_N", "KC_O", "KC_P", "KC_Q", "KC_R", "KC_S", "KC_T", "KC_U", "KC_V", "KC_W", "KC_X",
    "KC_Y", "KC_Z",
];
const DIGITS: [&str; 10] = [
    "KC_0", "KC_1", "KC_2", "KC_3", "KC_4", "KC_5", "KC_6", "KC_7", "KC_8", "KC_9",
];
const FKEYS: [&str; 12] = [
    "KC_F1", "KC_F2", "KC_F3", "KC_F4", "KC_F5", "KC_F6", "KC_F7", "KC_F8", "KC_F9", "KC_F10",
    "KC_F11", "KC_F12",
];
const KP_DIGITS: [&str; 10] = [
    "KC_P0", "KC_P1", "KC_P2", "KC_P3", "KC_P4", "KC_P5", "KC_P6", "KC_P7", "KC_P8", "KC_P9",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_letters_and_digits() {
        assert_eq!(vk_to_kc(0x41, 0), Some("KC_A"));
        assert_eq!(vk_to_kc(0x5A, 0), Some("KC_Z"));
        assert_eq!(vk_to_kc(0x30, 0), Some("KC_0"));
        assert_eq!(vk_to_kc(0x39, 0), Some("KC_9"));
    }

    #[test]
    fn distinguishes_left_and_right_modifiers() {
        assert_eq!(vk_to_kc(0xA0, 0), Some("KC_LSFT"));
        assert_eq!(vk_to_kc(0xA1, 0), Some("KC_RSFT"));
        assert_eq!(vk_to_kc(0xA2, 0), Some("KC_LCTL"));
        assert_eq!(vk_to_kc(0xA3, 0), Some("KC_RCTL"));
    }

    /// Enter and numpad-enter share VK_RETURN; only the extended flag separates
    /// them, and getting this backwards would make every recorded Enter a
    /// numpad Enter.
    #[test]
    fn extended_flag_separates_enter_from_numpad_enter() {
        assert_eq!(vk_to_kc(0x0D, 0), Some("KC_ENT"));
        assert_eq!(vk_to_kc(0x0D, 0x01), Some("KC_KP_ENTER"));
    }

    #[test]
    fn unmapped_keys_are_none() {
        assert_eq!(vk_to_kc(0xFF, 0), None);
    }

    #[test]
    fn function_row_is_in_order() {
        assert_eq!(vk_to_kc(0x70, 0), Some("KC_F1"));
        assert_eq!(vk_to_kc(0x7B, 0), Some("KC_F12"));
    }

    /// End-to-end through the real hook: install it, synthesise a Ctrl+C, and
    /// check what came out. Unit-testing `vk_to_kc` proves the table but not the
    /// plumbing — this is what tells us whether a reported "Ctrl+C is not
    /// captured" is the hook, the mapping, or something above it.
    /// IGNORED BY DEFAULT — `SendInput` injects real system-wide keystrokes, so
    /// running this fires Ctrl+C into whatever window happens to be focused.
    /// Only run it deliberately, on a machine nobody is using:
    ///   cargo test hook_captures_ctrl_c_end_to_end -- --ignored --test-threads=1
    #[test]
    #[ignore]
    fn hook_captures_ctrl_c_end_to_end() {
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
            SendInput, INPUT, INPUT_KEYBOARD, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, VIRTUAL_KEY,
        };

        ALLOW_INJECTED.store(true, Ordering::SeqCst);
        start().expect("hook should install");

        unsafe fn key(vk: u16, up: bool) {
            let mut input: INPUT = std::mem::zeroed();
            input.r#type = INPUT_KEYBOARD;
            input.Anonymous.ki.wVk = vk as VIRTUAL_KEY;
            input.Anonymous.ki.dwFlags =
                if up { KEYEVENTF_KEYUP } else { 0 as KEYBD_EVENT_FLAGS };
            SendInput(1, &input, std::mem::size_of::<INPUT>() as i32);
        }

        unsafe {
            key(0xA2, false); // LCtrl down
            key(0x43, false); // C down
            key(0x43, true);  // C up
            key(0xA2, true);  // LCtrl up
        }

        // The hook thread needs a moment to drain its message queue.
        std::thread::sleep(std::time::Duration::from_millis(300));

        let events = stop().expect("stop");
        ALLOW_INJECTED.store(false, Ordering::SeqCst);

        let seen: Vec<(Option<String>, bool)> =
            events.into_iter().map(|e| (e.kc, e.down)).collect();

        assert!(
            seen.contains(&(Some("KC_LCTL".into()), true)),
            "LCtrl down was not captured; saw {seen:?}"
        );
        assert!(
            seen.contains(&(Some("KC_C".into()), true)),
            "C down was not captured; saw {seen:?}"
        );
        assert!(
            seen.contains(&(Some("KC_LCTL".into()), false)),
            "LCtrl up was not captured; saw {seen:?}"
        );
    }
}
