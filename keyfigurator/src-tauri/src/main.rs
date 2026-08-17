// Macro Pad Pro config app — Tauri backend entry point.
//
// The frontend calls the #[tauri::command] functions below. They lock the shared
// app state (which holds the HID transport + host bindings) and delegate. The
// transport is a `BoardLink`: it drives a real board whenever one is attached
// and the mock otherwise, hot-swapping between them at any point in the session.
//
// EVERY command that touches the wire is `#[tauri::command(async)]`. Tauri runs
// a plain sync command ON THE MAIN THREAD, and these block: a transceive waits
// up to TRANSCEIVE_TIMEOUT (3 s), and an image upload is tens of KB in 26-byte
// chunks, so it blocks for seconds. On the main thread the window stops pumping
// messages and Windows paints it "Not Responding" — which is exactly what Save
// to Board did, since it pushes the keymap, LEDs, animation, OLED config AND a
// forced full image re-upload before committing. `(async)` moves them to the
// async runtime's pool; the functions stay synchronous, they just don't run
// where the UI lives. Cheap commands (get/set_bindings, simulate_*) are left
// sync deliberately — they only touch a Mutex<Vec> or a channel.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod hid;
mod kf_protocol;
#[cfg(target_os = "windows")]
mod keyrec;
mod model;
mod products;
mod qgf;
mod runner;

use hid::{BoardLink, HidTransport, PingInfo, RealHid};
use model::{AnimState, HostBinding, KeyMap, LedState, OledConfig, Palette, UnderglowAnim};
use serde::Serialize;
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use tauri::window::Color;
use tauri::{Emitter, Manager, State};

/// Shared app state. `transport` is a trait object so it can be Mock or Real.
/// `bindings` is an Arc so the inbound host-cmd listener thread can read it too.
/// `host_cmd_tx` is how an incoming RunHostCmd packet (from RealHid's read
/// thread) asks the listener to run binding N.
struct AppState {
    transport: Mutex<BoardLink>,
    bindings: Arc<Mutex<Vec<HostBinding>>>,
    host_cmd_tx: Sender<u8>,
}

/// What the UI needs to describe the link: whether a physical board is attached,
/// and which transport is actually serving commands right now.
#[derive(Serialize)]
struct BoardStatus {
    connected: bool,
    /// `"board"` or `"mock"`.
    transport: &'static str,
}

#[tauri::command(async)]
fn is_connected(state: State<AppState>) -> bool {
    state.transport.lock().unwrap().is_connected()
}

/// Richer form of `is_connected` — lets the UI distinguish "real board" from
/// "mock standing in", which a bare bool cannot express.
///
/// This is the frontend's ~3 s connection poll, and it deliberately touches the
/// wire rather than reading the cached flag. That does two jobs at once: it
/// refreshes the firmware's app-link timer, which is the only thing that keeps
/// the board's OLED status dot green while the app sits idle, and it catches a
/// board that has gone away before the supervisor thread has noticed.
#[tauri::command(async)]
fn board_status(state: State<AppState>) -> BoardStatus {
    let mut transport = state.transport.lock().unwrap();
    let connected = transport.has_board() && transport.heartbeat();
    BoardStatus {
        connected,
        transport: if connected { "board" } else { "mock" },
    }
}

/// One entry on the home page. Everything the card needs to render: what the
/// device is, how it is attached, and what it can do.
#[derive(Serialize)]
struct DeviceInfo {
    product_id: u8,
    product_name: String,
    hardware: String,
    firmware: String,
    /// `"usb"` today. Bluetooth is not implemented — the field exists so the UI
    /// can render a transport icon without pretending BLE already works.
    transport: &'static str,
    connected: bool,
    /// False when the board is real but this build has no entry for its
    /// product + hardware, so the UI can say "unknown device" honestly.
    known_product: bool,
    capabilities: Option<products::Capabilities>,
}

/// Scan for attached devices and report what they are.
///
/// Backs the home page's "New Device" button. Returns a list even though only
/// one board can be attached today, so the UI does not need reshaping when that
/// changes.
#[tauri::command(async)]
fn scan_devices(state: State<AppState>) -> Result<Vec<DeviceInfo>, String> {
    let mut transport = state.transport.lock().unwrap();

    // Must check for a real board FIRST. `BoardLink` deliberately falls through
    // to `MockHid` when nothing is attached, so calling identity() blind would
    // happily report the mock's identity and invent a device that is not there.
    if !transport.has_board() {
        return Ok(Vec::new());
    }
    let connected = true;

    let ident = transport.identity().map_err(|e| e.to_string())?;
    let spec = products::lookup_or_nearest(ident.product_id, ident.hardware);

    Ok(vec![DeviceInfo {
        product_id: ident.product_id,
        product_name: ident.product_name,
        hardware: ident.hardware.to_string(),
        firmware: ident.firmware.to_string(),
        transport: "usb",
        connected,
        known_product: spec.is_some(),
        capabilities: spec.map(|s| s.capabilities),
    }])
}

#[tauri::command(async)]
fn board_ping(state: State<AppState>) -> Result<PingInfo, String> {
    state
        .transport
        .lock()
        .unwrap()
        .ping()
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn get_keymap(state: State<AppState>) -> Result<KeyMap, String> {
    state
        .transport
        .lock()
        .unwrap()
        .get_keymap()
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn set_keymap(state: State<AppState>, map: KeyMap) -> Result<(), String> {
    state
        .transport
        .lock()
        .unwrap()
        .set_keymap(&map)
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn set_leds(state: State<AppState>, leds: LedState) -> Result<(), String> {
    state
        .transport
        .lock()
        .unwrap()
        .set_leds(&leds)
        .map_err(|e| e.to_string())
}

/// Set the global LED animation. Animation is board-wide by design — QMK's RGB
/// matrix has one mode — so per-key state is colour only.
#[tauri::command(async)]
fn set_anim(state: State<AppState>, anim: AnimState) -> Result<(), String> {
    state
        .transport
        .lock()
        .unwrap()
        .set_anim(&anim)
        .map_err(|e| e.to_string())
}

/// Set the underglow's own animation. Distinct from `set_anim`, which is the
/// board-wide one; the firmware renders the four corners separately.
#[tauri::command(async)]
fn set_ug_anim(state: State<AppState>, ug: UnderglowAnim) -> Result<(), String> {
    state
        .transport
        .lock()
        .unwrap()
        .set_ug_anim(&ug)
        .map_err(|e| e.to_string())
}

/// Push a Cycle Colors palette. `target` 0 = keys, 1 = underglow.
#[tauri::command(async)]
fn set_palette(state: State<AppState>, target: u8, palette: Palette) -> Result<(), String> {
    state
        .transport
        .lock()
        .unwrap()
        .set_palette(target, &palette)
        .map_err(|e| e.to_string())
}

/// Release the board to its own RGB animations (`on = false`) or re-assert the
/// host colour overlay (`on = true`). Pushing colours turns the overlay on by
/// itself, so this is what makes that reversible.
#[tauri::command(async)]
fn set_overlay(state: State<AppState>, on: bool) -> Result<(), String> {
    state
        .transport
        .lock()
        .unwrap()
        .set_overlay(on)
        .map_err(|e| e.to_string())
}

/// Returns whether the board accepted the pomodoro durations; see `push_oled`.
#[tauri::command(async)]
fn oled_push(state: State<AppState>, config: OledConfig) -> Result<bool, String> {
    state
        .transport
        .lock()
        .unwrap()
        .push_oled(&config)
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
fn sync_time(
    state: State<AppState>,
    year2000: u8,
    month: u8,
    day: u8,
    hour: u8,
    min: u8,
    sec: u8,
    weekday: u8,
) -> Result<(), String> {
    state
        .transport
        .lock()
        .unwrap()
        .sync_time(year2000, month, day, hour, min, sec, weekday)
        .map_err(|e| e.to_string())
}

/// Encode an image (PNG/JPEG/GIF data URL) as QGF and upload it to the board's
/// image screen. Returns what the board actually got, since the encoder may have
/// scaled the image down or dropped frames to fit the buffer.
#[derive(Serialize)]
struct ImageUploadResult {
    width: u16,
    height: u16,
    frames: u16,
    bytes: usize,
}

#[tauri::command(async)]
fn oled_push_image(state: State<AppState>, data_url: String) -> Result<ImageUploadResult, String> {
    let img = qgf::encode_data_url(
        &data_url,
        kf_protocol::OLED_IMG_MAX_DIM,
        kf_protocol::OLED_IMG_MAX_FRAMES,
        kf_protocol::OLED_IMG_MAX_BYTES,
    )
    .map_err(|e| e.to_string())?;

    state
        .transport
        .lock()
        .unwrap()
        .push_oled_image(&img.bytes)
        .map_err(|e| e.to_string())?;

    Ok(ImageUploadResult {
        width: img.width,
        height: img.height,
        frames: img.frames,
        bytes: img.bytes.len(),
    })
}

#[tauri::command(async)]
fn eeprom_commit(state: State<AppState>) -> Result<(), String> {
    state
        .transport
        .lock()
        .unwrap()
        .eeprom_commit()
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_bindings(state: State<AppState>) -> Vec<HostBinding> {
    state.bindings.lock().unwrap().clone()
}

#[tauri::command]
fn set_bindings(state: State<AppState>, bindings: Vec<HostBinding>) {
    *state.bindings.lock().unwrap() = bindings;
}

/// Manually trigger a host binding (UI testing without the board). Runs
/// synchronously and returns the output for display.
#[tauri::command(async)]
fn run_binding(state: State<AppState>, index: u8) -> Result<String, String> {
    let bindings = state.bindings.lock().unwrap();
    let out = runner::run_binding(&bindings, index).map_err(|e| e.to_string())?;
    Ok(format!(
        "exit={:?}\n--- stdout ---\n{}\n--- stderr ---\n{}",
        out.status, out.stdout, out.stderr
    ))
}

/// Run a script the user is editing, without needing it bound to a key.
///
/// Backs "Test" in the macro library. See `runner::run_script` for why taking a
/// script here does not weaken the board-side index indirection.
#[tauri::command(async)]
fn run_script(script: String, cwd: Option<String>) -> Result<String, String> {
    let out = runner::run_script(&script, cwd.as_deref()).map_err(|e| e.to_string())?;
    Ok(format!(
        "exit={:?}\n--- stdout ---\n{}\n--- stderr ---\n{}",
        out.status, out.stdout, out.stderr
    ))
}

/// Simulate an inbound RunHostCmd packet from the board (index only), driving
/// the same async path RealHid's read thread will use: listener runs the binding
/// and emits a `host-cmd` event. Lets us exercise the board->host->runner->UI
/// flow end to end with no hardware.
#[tauri::command]
fn simulate_board_host_cmd(state: State<AppState>, index: u8) -> Result<(), String> {
    state
        .host_cmd_tx
        .send(index)
        .map_err(|e| format!("host-cmd channel closed: {e}"))
}

// ── Macro keystroke recorder ────────────────────────────────────────────────
// Thin wrappers over keyrec. The hook lives only between start and stop; see
// the module docs for the constraints this feature holds itself to.
//
// Windows-only for now: the hook is Win32. On other platforms these report that
// rather than silently recording nothing, so the UI can say so.

#[tauri::command(async)]
fn start_key_recording() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        keyrec::start()
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("keystroke recording is only implemented on Windows".into())
    }
}

#[tauri::command(async)]
fn stop_key_recording() -> Result<Vec<serde_json::Value>, String> {
    #[cfg(target_os = "windows")]
    {
        let keys = keyrec::stop()?;
        keys.into_iter()
            .map(|k| serde_json::to_value(k).map_err(|e| e.to_string()))
            .collect()
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("keystroke recording is only implemented on Windows".into())
    }
}

#[tauri::command(async)]
fn peek_key_recording() -> Result<Vec<serde_json::Value>, String> {
    #[cfg(target_os = "windows")]
    {
        let keys = keyrec::peek()?;
        keys.into_iter()
            .map(|k| serde_json::to_value(k).map_err(|e| e.to_string()))
            .collect()
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(Vec::new())
    }
}

#[tauri::command]
fn is_key_recording() -> bool {
    #[cfg(target_os = "windows")]
    {
        keyrec::is_recording()
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

/// Writes a file the user has already chosen through the native save dialog.
///
/// Export used to be a browser-style `<a download>` click. That is silently
/// dead in a Tauri webview: WebView2 raises a download request, nothing is
/// registered to handle it, and it is cancelled — no file, no error, no console
/// message, which is exactly how it presented (2026-08-16). The path is picked
/// by the dialog plugin on the frontend and written here, so the app needs no
/// broad filesystem permission — only the exact path the user just pointed at.
#[tauri::command]
fn write_text_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| format!("{path}: {e}"))
}

fn main() {
    // Inbound host-command channel: RealHid's future read thread (or the
    // simulate_board_host_cmd command) sends a binding index here; the listener
    // thread below runs it and emits a `host-cmd` event to the UI.
    let (host_cmd_tx, host_cmd_rx) = channel::<u8>();
    // Empty: bindings are authored as shell macros in the library and pushed
    // from the frontend when one is bound to a key. A hardcoded sample would
    // reappear on every launch and mean a HOST(0) press ran something the user
    // never wrote.
    let bindings = Arc::new(Mutex::new(Vec::<HostBinding>::new()));

    // Board attach/detach notifications from the HID supervisor. Drained by a
    // listener in `setup` (where an AppHandle exists) and re-emitted to the UI.
    let (conn_tx, conn_rx) = channel::<bool>();

    // The link supervises the USB side for the whole session: it attaches to a
    // board whenever one is present — at startup or plugged in later — and falls
    // back to the mock while none is, so the editor always works. RealHid
    // forwards inbound RunHostCmd indices to the same host_cmd channel the
    // listener drains below.
    let transport = BoardLink::new(RealHid::start(host_cmd_tx.clone(), conn_tx));

    let state = AppState {
        transport: Mutex::new(transport),
        bindings: bindings.clone(),
        host_cmd_tx,
    };

    let listener_bindings = bindings.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            // Match native window background to the app's dark theme (#16171d) so that
            // resize events don't flash white before the WebView repaints.
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_background_color(Some(Color(22, 23, 29, 255)));
            }

            // Board attach/detach listener: turns supervisor state changes into a
            // `board-connection` event so the UI reacts on the plug rather than on
            // its next poll.
            let conn_handle = app.handle().clone();
            std::thread::spawn(move || {
                while let Ok(connected) = conn_rx.recv() {
                    let _ = conn_handle.emit(
                        "board-connection",
                        serde_json::json!({
                            "connected": connected,
                            "transport": if connected { "board" } else { "mock" },
                        }),
                    );
                }
            });

            // Inbound host-command listener: runs the bound command and emits the
            // result to the UI. Driven by the board (via RealHid) or the
            // simulate_board_host_cmd command.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                while let Ok(index) = host_cmd_rx.recv() {
                    let outcome = {
                        let guard = listener_bindings.lock().unwrap();
                        runner::run_binding(&guard, index)
                    };
                    let payload = match outcome {
                        Ok(o) => serde_json::json!({
                            "index": index, "ok": true,
                            "status": o.status, "stdout": o.stdout, "stderr": o.stderr,
                        }),
                        Err(e) => serde_json::json!({
                            "index": index, "ok": false, "error": e.to_string(),
                        }),
                    };
                    let _ = handle.emit("host-cmd", payload);
                }
            });
            Ok(())
        })
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            write_text_file,
            start_key_recording,
            stop_key_recording,
            peek_key_recording,
            is_key_recording,
            is_connected,
            board_status,
            board_ping,
            scan_devices,
            get_keymap,
            set_keymap,
            set_leds,
            set_anim,
            set_ug_anim,
            set_palette,
            set_overlay,
            oled_push,
            oled_push_image,
            sync_time,
            eeprom_commit,
            get_bindings,
            set_bindings,
            run_binding,
            run_script,
            simulate_board_host_cmd,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
