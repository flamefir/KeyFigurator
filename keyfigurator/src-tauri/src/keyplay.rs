//! Keystroke macro playback — the mirror image of `keyrec`.
//!
//! # Why the host types instead of the board
//!
//! A keystroke macro bound to a key does NOT run on the board. Macro content
//! lives behind VIA's `dynamic_keymap_macro_{get,set}_buffer` (`0x0B`/`0x0C`),
//! which are plain VIA ids with no `0xC0` magic, so the KeyFigurator channel
//! has no route to write it — recorded macros reached the board as a bound
//! `MACRO(n)` keycode with an empty body, and did nothing.
//!
//! So it is inverted: keystroke macros ride `HOST(n)` exactly as shell macros
//! already do. The board sends an INDEX, the host looks up the binding and
//! performs the keys with `SendInput`. That buys three things over building the
//! missing VIA route:
//!
//! * no macro-buffer encoding, and no length cap (firmware 0.4.0's persistence
//!   change took ~1.7 KB out of that buffer),
//! * the index-only security invariant is preserved — macro content never
//!   crosses the wire in either direction,
//! * one playback engine for both macro kinds.
//!
//! The cost is that macros need Orbit running. That is what the Orbit Agent is
//! for; this module is written to be liftable into it unchanged.
//!
//! # Constraints
//!
//! * Every key pressed here is released. A macro ending mid-chord (`DOWN
//!   KC_LCTL` with no matching `UP`) would otherwise leave a modifier stuck
//!   down system-wide, which looks like a broken keyboard and cannot be undone
//!   from inside the app.
//! * Input goes to whatever window has focus, the same as a real keypress.
//!   There is no targeting and no elevation.
//! * `keyrec` ignores injected events, so playing a macro cannot record itself.

use crate::model::MacroAction;

use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_KEYBOARD, KEYBD_EVENT_FLAGS, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP,
    KEYEVENTF_UNICODE, VIRTUAL_KEY,
};

/// A single DELAY step is clamped to this. A macro is user-authored so a long
/// pause can be deliberate, but a mistyped `DELAY 100000` would wedge the
/// host-command listener thread for a minute and a half with no way to cancel.
const MAX_DELAY_MS: u32 = 10_000;

fn clamped_delay(ms: u32) -> std::time::Duration {
    std::time::Duration::from_millis(ms.min(MAX_DELAY_MS) as u64)
}

/// What playback did, for the outcome the UI shows.
pub struct Played {
    pub steps: usize,
    /// Steps that could not be performed — an unmapped keycode, say. Collected
    /// rather than fatal: one unknown step in a twenty-step macro should not
    /// swallow the other nineteen, but it must not pass silently either.
    pub warnings: Vec<String>,
}

pub fn play(actions: &[MacroAction]) -> Result<Played, String> {
    let mut warnings = Vec::new();
    let mut steps = 0usize;
    // Every key this macro pressed and has not released, in press order.
    let mut held: Vec<(u16, bool)> = Vec::new();
    let mut failed: Option<String> = None;

    for action in actions {
        // A send failure stops the macro but must NOT return from here — the
        // release pass below is the only thing standing between a half-played
        // chord and a modifier stuck down system-wide, and `?` would skip it.
        match perform(action, &mut held, &mut warnings) {
            Ok(performed) => steps += usize::from(performed),
            Err(e) => {
                failed = Some(e);
                break;
            }
        }
    }

    // Release anything the macro left down, newest first so a chord unwinds the
    // way a human would let go of it. Failures here are collected, not
    // propagated: stopping early would leave MORE keys held, not fewer.
    for (vk, ext) in std::mem::take(&mut held).into_iter().rev() {
        if let Err(e) = send_key(vk, ext, true) {
            warnings.push(format!("could not release vk {vk:#04x}: {e}"));
        }
    }

    match failed {
        Some(e) => Err(e),
        None => Ok(Played { steps, warnings }),
    }
}

/// One step. `held` is the running set of keys this macro has pressed and not
/// released; `warnings` collects the steps that were skipped rather than
/// performed. Only a `SendInput` failure is an error — an unmapped keycode is a
/// warning, so one bad line does not swallow the rest of the macro.
///
/// Returns whether the step was actually performed, so the count reported back
/// describes what happened rather than what was asked for.
fn perform(
    action: &MacroAction,
    held: &mut Vec<(u16, bool)>,
    warnings: &mut Vec<String>,
) -> Result<bool, String> {
    match action {
        MacroAction::Delay { ms } => std::thread::sleep(clamped_delay(*ms)),
        MacroAction::Text { value } => send_text(value)?,
        MacroAction::Tap { key } | MacroAction::Down { key } | MacroAction::Up { key } => {
            let Some((vk, ext)) = kc_to_vk(key) else {
                warnings.push(format!("no host key for {key}"));
                return Ok(false);
            };
            match action {
                MacroAction::Tap { .. } => {
                    send_key(vk, ext, false)?;
                    send_key(vk, ext, true)?;
                    // A tap releases what it pressed, and also ends a hold if
                    // the macro pressed the same key earlier.
                    held.retain(|&(v, _)| v != vk);
                }
                MacroAction::Down { .. } => {
                    send_key(vk, ext, false)?;
                    if !held.iter().any(|&(v, _)| v == vk) {
                        held.push((vk, ext));
                    }
                }
                _ => {
                    send_key(vk, ext, true)?;
                    held.retain(|&(v, _)| v != vk);
                }
            }
        }
    }
    Ok(true)
}

fn send(inputs: &[INPUT]) -> Result<(), String> {
    if inputs.is_empty() {
        return Ok(());
    }
    let sent = unsafe {
        SendInput(
            inputs.len() as u32,
            inputs.as_ptr(),
            std::mem::size_of::<INPUT>() as i32,
        )
    };
    if sent as usize == inputs.len() {
        Ok(())
    } else {
        // The usual cause is UIPI: a process at a higher integrity level has
        // focus, and an unelevated app cannot send input to it. Worth saying,
        // because "the macro works everywhere except in that one window" is
        // otherwise baffling.
        Err(format!(
            "SendInput sent {sent} of {} events (blocked by the foreground window?)",
            inputs.len()
        ))
    }
}

fn send_key(vk: u16, extended: bool, up: bool) -> Result<(), String> {
    let mut flags: KEYBD_EVENT_FLAGS = 0;
    if up {
        flags |= KEYEVENTF_KEYUP;
    }
    if extended {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }

    // Writing a union field is safe; only reading one is not.
    let mut input: INPUT = unsafe { std::mem::zeroed() };
    input.r#type = INPUT_KEYBOARD;
    input.Anonymous.ki.wVk = vk as VIRTUAL_KEY;
    input.Anonymous.ki.dwFlags = flags;
    send(&[input])
}

/// Type a literal string.
///
/// `KEYEVENTF_UNICODE` sends the character itself rather than a key position,
/// so a macro that types `@` types `@` on a Danish layout too — going through
/// keycodes would type whatever key sits where `@` is on US.
///
/// Sent as one batch so surrogate pairs (anything above the BMP, emoji
/// included) arrive as adjacent events and are recombined by the receiver.
fn send_text(value: &str) -> Result<(), String> {
    let mut inputs: Vec<INPUT> = Vec::new();

    for unit in value.encode_utf16() {
        // Enter is a key, not a character: U+000A typed as text is swallowed by
        // most editors, so a recorded newline has to go back as VK_RETURN. \r is
        // dropped rather than sent twice for a CRLF.
        if unit == 0x0D {
            continue;
        }
        if unit == 0x0A {
            send(&inputs)?;
            inputs.clear();
            send_key(VK_RETURN, false, false)?;
            send_key(VK_RETURN, false, true)?;
            continue;
        }
        for up in [false, true] {
            let mut flags: KEYBD_EVENT_FLAGS = KEYEVENTF_UNICODE;
            if up {
                flags |= KEYEVENTF_KEYUP;
            }
            let mut input: INPUT = unsafe { std::mem::zeroed() };
            input.r#type = INPUT_KEYBOARD;
            input.Anonymous.ki.wVk = 0;
            input.Anonymous.ki.wScan = unit;
            input.Anonymous.ki.dwFlags = flags;
            inputs.push(input);
        }
    }

    send(&inputs)
}

const VK_RETURN: u16 = 0x0D;

/// QMK keycode name -> (Windows virtual-key code, extended-key flag).
///
/// The reverse of `keyrec::vk_to_kc`, and deliberately its own table rather
/// than a search of that one: the mapping is not a bijection (`VK_SHIFT` and
/// `VK_LSHIFT` both record as `KC_LSFT`) and playback needs the specific
/// left/right code, not the ambiguous one. `keyplay_matches_keyrec` in the
/// tests below asserts the two stay in step, so a key added to one and not the
/// other fails the build rather than going quiet at runtime.
///
/// The extended flag matters for the keys whose VK is shared with a numpad
/// twin — arrows, the navigation cluster, right-hand modifiers, numpad Enter.
/// Windows derives a scan code from the VK and does not set that bit for us, so
/// anything reading scan codes (games, remote-desktop clients) would see the
/// numpad variant instead.
fn kc_to_vk(kc: &str) -> Option<(u16, bool)> {
    // Accept the long spellings the editor lets people type by hand; the
    // recorder only ever emits the short QMK names.
    let kc = match kc {
        "KC_ENTER" => "KC_ENT",
        "KC_RIGHT" => "KC_RGHT",
        "KC_BSPACE" | "KC_BACKSPACE" => "KC_BSPC",
        "KC_SPACE" => "KC_SPC",
        "KC_ESCAPE" => "KC_ESC",
        "KC_DELETE" => "KC_DEL",
        "KC_INSERT" => "KC_INS",
        "KC_LSHIFT" => "KC_LSFT",
        "KC_RSHIFT" => "KC_RSFT",
        "KC_LCTRL" => "KC_LCTL",
        "KC_RCTRL" => "KC_RCTL",
        "KC_PGDOWN" => "KC_PGDN",
        "KC_CAPSLOCK" => "KC_CAPS",
        other => other,
    };

    // Letters and digits: the VK codes are the ASCII values, same as keyrec.
    if let Some(c) = kc.strip_prefix("KC_") {
        if c.len() == 1 {
            let b = c.as_bytes()[0];
            if b.is_ascii_uppercase() || b.is_ascii_digit() {
                return Some((b as u16, false));
            }
        }
        if let Some(n) = c.strip_prefix('F').and_then(|n| n.parse::<u16>().ok()) {
            if (1..=12).contains(&n) {
                return Some((0x70 + n - 1, false));
            }
        }
        if let Some(n) = c.strip_prefix('P').and_then(|n| n.parse::<u16>().ok()) {
            if n <= 9 {
                return Some((0x60 + n, false));
            }
        }
    }

    Some(match kc {
        "KC_BSPC" => (0x08, false),
        "KC_TAB" => (0x09, false),
        "KC_ENT" => (0x0D, false),
        "KC_ESC" => (0x1B, false),
        "KC_SPC" => (0x20, false),

        "KC_LSFT" => (0xA0, false),
        // Right shift is the one right-hand modifier that is NOT extended — it
        // has a scan code of its own rather than sharing the left one's.
        "KC_RSFT" => (0xA1, false),
        "KC_LCTL" => (0xA2, false),
        "KC_RCTL" => (0xA3, true),
        "KC_LALT" => (0xA4, false),
        "KC_RALT" => (0xA5, true),
        "KC_LGUI" => (0x5B, true),
        "KC_RGUI" => (0x5C, true),
        "KC_APP" => (0x5D, true),
        "KC_CAPS" => (0x14, false),

        "KC_PGUP" => (0x21, true),
        "KC_PGDN" => (0x22, true),
        "KC_END" => (0x23, true),
        "KC_HOME" => (0x24, true),
        "KC_LEFT" => (0x25, true),
        "KC_UP" => (0x26, true),
        "KC_RGHT" => (0x27, true),
        "KC_DOWN" => (0x28, true),
        "KC_INS" => (0x2D, true),
        "KC_DEL" => (0x2E, true),

        "KC_SCLN" => (0xBA, false),
        "KC_EQL" => (0xBB, false),
        "KC_COMM" => (0xBC, false),
        "KC_MINS" => (0xBD, false),
        "KC_DOT" => (0xBE, false),
        "KC_SLSH" => (0xBF, false),
        "KC_GRV" => (0xC0, false),
        "KC_LBRC" => (0xDB, false),
        "KC_BSLS" => (0xDC, false),
        "KC_RBRC" => (0xDD, false),
        "KC_QUOT" => (0xDE, false),

        "KC_KP_ENTER" => (0x0D, true),
        "KC_PAST" => (0x6A, false),
        "KC_PPLS" => (0x6B, false),
        "KC_PMNS" => (0x6D, false),
        "KC_PDOT" => (0x6E, false),
        "KC_PSLS" => (0x6F, true),
        "KC_NUM" => (0x90, false),
        "KC_SCRL" => (0x91, false),
        "KC_PAUS" => (0x13, false),
        "KC_PSCR" => (0x2C, true),

        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_letters_digits_and_function_row() {
        assert_eq!(kc_to_vk("KC_A"), Some((0x41, false)));
        assert_eq!(kc_to_vk("KC_Z"), Some((0x5A, false)));
        assert_eq!(kc_to_vk("KC_0"), Some((0x30, false)));
        assert_eq!(kc_to_vk("KC_9"), Some((0x39, false)));
        assert_eq!(kc_to_vk("KC_F1"), Some((0x70, false)));
        assert_eq!(kc_to_vk("KC_F12"), Some((0x7B, false)));
        assert_eq!(kc_to_vk("KC_P0"), Some((0x60, false)));
        assert_eq!(kc_to_vk("KC_P9"), Some((0x69, false)));
    }

    /// `KC_F13` and `KC_P10` do not exist; the prefix parse must not invent
    /// them by walking off the end of the range.
    #[test]
    fn rejects_out_of_range_function_and_numpad_keys() {
        assert_eq!(kc_to_vk("KC_F13"), None);
        assert_eq!(kc_to_vk("KC_F0"), None);
        assert_eq!(kc_to_vk("KC_P10"), None);
    }

    /// Playback needs the specific left/right code. Recording folds VK_SHIFT
    /// and VK_LSHIFT together, which is fine one way and wrong the other.
    #[test]
    fn resolves_left_and_right_modifiers_separately() {
        assert_eq!(kc_to_vk("KC_LSFT"), Some((0xA0, false)));
        assert_eq!(kc_to_vk("KC_RSFT"), Some((0xA1, false)));
        assert_eq!(kc_to_vk("KC_LCTL"), Some((0xA2, false)));
        assert_eq!(kc_to_vk("KC_RCTL"), Some((0xA3, true)));
    }

    /// The pairs that share a VK and are told apart only by the extended flag.
    /// Getting these backwards sends numpad Enter for Enter, and Home for
    /// numpad 7 on a machine with Num Lock off.
    #[test]
    fn extended_flag_separates_the_shared_vks() {
        assert_eq!(kc_to_vk("KC_ENT"), Some((0x0D, false)));
        assert_eq!(kc_to_vk("KC_KP_ENTER"), Some((0x0D, true)));
        assert_eq!(kc_to_vk("KC_HOME").unwrap().1, true);
        assert_eq!(kc_to_vk("KC_P7").unwrap().1, false);
    }

    #[test]
    fn accepts_the_long_spellings_the_editor_allows() {
        assert_eq!(kc_to_vk("KC_ENTER"), kc_to_vk("KC_ENT"));
        assert_eq!(kc_to_vk("KC_RIGHT"), kc_to_vk("KC_RGHT"));
        assert_eq!(kc_to_vk("KC_BACKSPACE"), kc_to_vk("KC_BSPC"));
        assert_eq!(kc_to_vk("KC_LSHIFT"), kc_to_vk("KC_LSFT"));
    }

    #[test]
    fn unknown_keycodes_have_no_mapping() {
        assert_eq!(kc_to_vk("KC_NO"), None);
        assert_eq!(kc_to_vk("HOST(3)"), None);
        assert_eq!(kc_to_vk(""), None);
    }

    /// The recorder and the player must agree, or a macro captured from real
    /// keys contains steps playback cannot perform. Every keycode `keyrec` can
    /// emit has to resolve back to a VK here.
    ///
    /// Not an equality check on the VK: recording is lossy on purpose
    /// (`VK_SHIFT` -> `KC_LSFT`), so the round trip is name-preserving, not
    /// code-preserving. What matters is that nothing the recorder produces is
    /// unplayable.
    #[test]
    fn every_recordable_keycode_is_playable() {
        let mut missing = Vec::new();
        for vk in 0u32..=0xFFu32 {
            for flags in [0u32, 0x01] {
                if let Some(kc) = crate::keyrec::vk_to_kc(vk, flags) {
                    if kc_to_vk(kc).is_none() {
                        missing.push(kc);
                    }
                }
            }
        }
        missing.sort_unstable();
        missing.dedup();
        assert!(
            missing.is_empty(),
            "keyrec can record these but keyplay cannot play them: {missing:?}"
        );
    }

    /// An unmapped step is skipped and reported, not fatal — one bad line in a
    /// hand-edited macro must not swallow the rest of it.
    #[test]
    fn unmapped_steps_warn_without_stopping_playback() {
        let played = play(&[
            MacroAction::Tap { key: "KC_NO".into() },
            MacroAction::Delay { ms: 0 },
        ])
        .expect("playback should not fail on an unmapped key");
        assert_eq!(played.steps, 1, "the unmapped step should not count");
        assert_eq!(played.warnings.len(), 1);
        assert!(played.warnings[0].contains("KC_NO"), "{:?}", played.warnings);
    }

    /// A long DELAY is clamped rather than obeyed, so a mistyped `DELAY 100000`
    /// cannot wedge the host-command listener thread. Asserted on the
    /// arithmetic rather than by timing a real sleep — a test that waits ten
    /// seconds to prove a cap is its own kind of wedged build.
    #[test]
    fn a_huge_delay_is_clamped() {
        assert_eq!(clamped_delay(60_000).as_millis(), MAX_DELAY_MS as u128);
        assert_eq!(clamped_delay(25).as_millis(), 25);
        assert_eq!(clamped_delay(0).as_millis(), 0);
    }
}
