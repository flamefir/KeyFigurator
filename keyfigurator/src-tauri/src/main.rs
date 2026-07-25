// Macro Pad Pro config app — Tauri backend entry point.
//
// The frontend calls the #[tauri::command] functions below. They lock the shared
// app state (which holds the HID transport + host bindings) and delegate. Swap
// MockHid -> RealHid in `main` when boards arrive; nothing else changes.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod hid;
mod kf_protocol;
mod model;
mod runner;

use hid::{HidTransport, MockHid, PingInfo, RealHid};
use model::{HostBinding, KeyMap, LedState, OledConfig};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use tauri::window::Color;
use tauri::{Emitter, Manager, State};

/// Shared app state. `transport` is a trait object so it can be Mock or Real.
/// `bindings` is an Arc so the inbound host-cmd listener thread can read it too.
/// `host_cmd_tx` is how an incoming RunHostCmd packet (from RealHid's read
/// thread) asks the listener to run binding N.
struct AppState {
    transport: Mutex<Box<dyn HidTransport>>,
    bindings: Arc<Mutex<Vec<HostBinding>>>,
    host_cmd_tx: Sender<u8>,
}

#[tauri::command]
fn is_connected(state: State<AppState>) -> bool {
    state.transport.lock().unwrap().is_connected()
}

#[tauri::command]
fn board_ping(state: State<AppState>) -> Result<PingInfo, String> {
    state
        .transport
        .lock()
        .unwrap()
        .ping()
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_keymap(state: State<AppState>) -> Result<KeyMap, String> {
    state
        .transport
        .lock()
        .unwrap()
        .get_keymap()
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn set_keymap(state: State<AppState>, map: KeyMap) -> Result<(), String> {
    state
        .transport
        .lock()
        .unwrap()
        .set_keymap(&map)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn set_leds(state: State<AppState>, leds: LedState) -> Result<(), String> {
    state
        .transport
        .lock()
        .unwrap()
        .set_leds(&leds)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn oled_push(state: State<AppState>, config: OledConfig) -> Result<(), String> {
    state
        .transport
        .lock()
        .unwrap()
        .push_oled(&config)
        .map_err(|e| e.to_string())
}

#[tauri::command]
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

#[tauri::command]
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
#[tauri::command]
fn run_binding(state: State<AppState>, index: u8) -> Result<String, String> {
    let bindings = state.bindings.lock().unwrap();
    let out = runner::run_binding(&bindings, index).map_err(|e| e.to_string())?;
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

fn main() {
    // Inbound host-command channel: RealHid's future read thread (or the
    // simulate_board_host_cmd command) sends a binding index here; the listener
    // thread below runs it and emits a `host-cmd` event to the UI.
    let (host_cmd_tx, host_cmd_rx) = channel::<u8>();
    let bindings = Arc::new(Mutex::new(vec![HostBinding {
        index: 0,
        label: "git commit (wip)".into(),
        command: vec!["git".into(), "commit".into(), "-am".into(), "wip".into()],
        cwd: None,
    }]));

    // Prefer a real board if one is plugged in; otherwise fall back to the mock
    // so the whole app stays usable with no hardware. RealHid forwards inbound
    // RunHostCmd indices to the same host_cmd channel the listener drains below.
    let transport: Box<dyn HidTransport> = match RealHid::open(host_cmd_tx.clone()) {
        Ok(real) => {
            eprintln!("kf: connected to a Macro Pad Pro over Raw HID");
            Box::new(real)
        }
        Err(e) => {
            eprintln!("kf: no board found ({e}); using MockHid");
            Box::new(MockHid::new())
        }
    };

    let state = AppState {
        transport: Mutex::new(transport),
        bindings: bindings.clone(),
        host_cmd_tx,
    };

    let listener_bindings = bindings.clone();

    tauri::Builder::default()
        .setup(move |app| {
            // Match native window background to the app's dark theme (#16171d) so that
            // resize events don't flash white before the WebView repaints.
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_background_color(Some(Color(22, 23, 29, 255)));
            }

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
            is_connected,
            board_ping,
            get_keymap,
            set_keymap,
            set_leds,
            oled_push,
            sync_time,
            eeprom_commit,
            get_bindings,
            set_bindings,
            run_binding,
            simulate_board_host_cmd,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
