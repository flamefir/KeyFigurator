// Macro Pad Pro config app — Tauri backend entry point.
//
// The frontend calls the #[tauri::command] functions below. They lock the shared
// app state (which holds the HID transport + host bindings) and delegate. Swap
// MockHid -> RealHid in `setup` when boards arrive; nothing else changes.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod hid;
mod model;
mod runner;

use hid::{HidTransport, MockHid};
use model::{HostBinding, KeyMap, LedState};
use std::sync::Mutex;
use tauri::{Manager, State};
use tauri::window::Color;

/// Shared app state. `transport` is a trait object so it can be Mock or Real.
struct AppState {
    transport: Mutex<Box<dyn HidTransport>>,
    bindings: Mutex<Vec<HostBinding>>,
}

#[tauri::command]
fn is_connected(state: State<AppState>) -> bool {
    state.transport.lock().unwrap().is_connected()
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

/// Manually trigger a host binding (used for UI testing without the board;
/// in production this is driven by an incoming Raw HID RunHostCmd packet).
#[tauri::command]
fn run_binding(state: State<AppState>, index: u8) -> Result<String, String> {
    let bindings = state.bindings.lock().unwrap();
    let out = runner::run_binding(&bindings, index).map_err(|e| e.to_string())?;
    Ok(format!(
        "exit={:?}\n--- stdout ---\n{}\n--- stderr ---\n{}",
        out.status, out.stdout, out.stderr
    ))
}

fn main() {
    // Until boards arrive: MockHid. When they do: Box::new(RealHid::open()?...).
    let state = AppState {
        transport: Mutex::new(Box::new(MockHid::new())),
        bindings: Mutex::new(vec![HostBinding {
            index: 0,
            label: "git commit (wip)".into(),
            command: vec!["git".into(), "commit".into(), "-am".into(), "wip".into()],
            cwd: None,
        }]),
    };

    tauri::Builder::default()
        .setup(|app| {
            // Match native window background to the app's dark theme (#16171d) so that
            // resize events don't flash white before the WebView repaints.
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_background_color(Some(Color(22, 23, 29, 255)));
            }
            Ok(())
        })
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            is_connected,
            get_keymap,
            set_keymap,
            set_leds,
            eeprom_commit,
            get_bindings,
            set_bindings,
            run_binding,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
