//! HID transport: the boundary between the app and the keyboard.
//!
//! The whole app talks to the board ONLY through the `HidTransport` trait. An
//! implementer supplies just two things — `is_connected` and `transceive` (send
//! one 32-byte frame, get one back). Every high-level operation (keymap, LEDs,
//! OLED, eeprom, ping) is a DEFAULT method built on `transceive` using the
//! byte-accurate [`crate::kf_protocol`] codec, so `MockHid` and `RealHid` share
//! the exact same protocol logic — the mock cannot drift from the firmware.
//!
//! - `MockHid` wraps a [`kf_protocol::BoardModel`] (a software port of
//!   `kf_hid.c`) and works today with no hardware.
//! - `RealHid` is the hidapi stub you fill in once boards arrive; only its
//!   `transceive` (a USB write + read) is left to do.

use crate::kf_protocol::{self as kf, BoardModel, REPORT_LEN};
use crate::model::{KeyMap, Layer, LedState, OledConfig};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender, TryRecvError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Debug, thiserror::Error)]
pub enum HidError {
    #[error("no device connected")]
    NotConnected,
    #[error("device i/o error: {0}")]
    Io(String),
}

/// Firmware version reported by PING.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct PingInfo {
    pub protocol: u8,
    pub fw_major: u8,
    pub fw_minor: u8,
}

fn expect_ok(resp: &[u8; REPORT_LEN]) -> Result<(), HidError> {
    match resp[2] {
        kf::STATUS_OK => Ok(()),
        other => Err(HidError::Io(format!("board returned status {other:#04x}"))),
    }
}

/// Everything the app needs from a keyboard. Implementers provide `is_connected`
/// + `transceive`; the rest are protocol default methods.
pub trait HidTransport: Send + Sync {
    fn is_connected(&self) -> bool;

    /// Send one 32-byte report and return the 32-byte response.
    fn transceive(&mut self, frame: &[u8; REPORT_LEN]) -> Result<[u8; REPORT_LEN], HidError>;

    /// PING → validate the protocol version matches the app.
    fn ping(&mut self) -> Result<PingInfo, HidError> {
        let resp = self.transceive(&kf::ping_frame())?;
        let info = PingInfo {
            protocol: resp[2],
            fw_major: resp[3],
            fw_minor: resp[4],
        };
        if info.protocol != kf::PROTOCOL_VERSION {
            return Err(HidError::Io(format!(
                "protocol mismatch: board v{}, app v{}",
                info.protocol,
                kf::PROTOCOL_VERSION
            )));
        }
        Ok(info)
    }

    fn get_keymap(&mut self) -> Result<KeyMap, HidError> {
        let mut layers = Vec::with_capacity(kf::LAYER_COUNT);
        for layer in 0..kf::LAYER_COUNT as u8 {
            let mut keys = Vec::with_capacity(kf::KEY_COUNT);
            let mut offset = 0usize;
            while offset < kf::KEY_COUNT {
                let count = (kf::KEY_COUNT - offset).min(kf::KEYMAP_CHUNK_MAX);
                let req = kf::frame(kf::CMD_GET_KEYMAP, &[layer, offset as u8, count as u8]);
                let resp = self.transceive(&req)?;
                // Success echoes [layer, offset, count, …]; an error is [0, 0, status].
                if resp[2] != layer || resp[3] != offset as u8 {
                    return Err(HidError::Io("get_keymap: error response".into()));
                }
                let n = resp[4] as usize;
                for i in 0..n {
                    let kc = resp[5 + i * 2] as u16 | ((resp[6 + i * 2] as u16) << 8);
                    keys.push(kf::keycode_from_u16(kc));
                }
                offset += count;
            }
            layers.push(Layer { keys });
        }
        Ok(KeyMap { layers })
    }

    fn set_keymap(&mut self, map: &KeyMap) -> Result<(), HidError> {
        for (li, layer) in map.layers.iter().enumerate().take(kf::LAYER_COUNT) {
            let kcs: Vec<u16> = layer
                .keys
                .iter()
                .take(kf::KEY_COUNT)
                .map(|s| {
                    kf::keycode_to_u16(s).unwrap_or_else(|| {
                        eprintln!("kf: unknown keycode {s:?} -> KC_NO (defer to Vial)");
                        0
                    })
                })
                .collect();
            for req in kf::set_keymap_frames(li as u8, &kcs) {
                let resp = self.transceive(&req)?;
                expect_ok(&resp)?;
            }
        }
        Ok(())
    }

    /// Push per-key + underglow colours (25 slots) and brightness. Sending
    /// colour data implicitly turns the overlay on (firmware behaviour).
    fn set_leds(&mut self, leds: &LedState) -> Result<(), HidError> {
        for req in kf::set_led_color_frames(&leds.to_slots()) {
            let resp = self.transceive(&req)?;
            expect_ok(&resp)?;
        }
        let resp = self.transceive(&kf::brightness_frame(leds.brightness))?;
        expect_ok(&resp)
    }

    /// Push the full OLED config (RAM-only on the board, so re-push on reconnect).
    fn push_oled(&mut self, cfg: &OledConfig) -> Result<(), HidError> {
        for (li, l) in cfg.layers.iter().enumerate().take(kf::LAYER_COUNT) {
            let resp = self.transceive(&kf::oled_set_layer_frame(li as u8, l.show_title, &l.name))?;
            expect_ok(&resp)?;
        }
        let types: Vec<u8> = cfg
            .screens
            .iter()
            .take(kf::OLED_MAX_CUSTOM_SCREENS)
            .map(|s| screen_kind_to_type(&s.kind))
            .collect();
        let resp = self.transceive(&kf::oled_set_screens_frame(&types))?;
        expect_ok(&resp)?;
        for (si, s) in cfg.screens.iter().enumerate().take(kf::OLED_MAX_CUSTOM_SCREENS) {
            if screen_kind_to_type(&s.kind) == kf::SCREEN_CUSTOM_TEXT {
                for f in kf::oled_set_text_frames(si as u8, 0, &s.title) {
                    let resp = self.transceive(&f)?;
                    expect_ok(&resp)?;
                }
                for f in kf::oled_set_text_frames(si as u8, 1, &s.body) {
                    let resp = self.transceive(&f)?;
                    expect_ok(&resp)?;
                }
            }
        }
        let (h, m, s) = cfg.countdown;
        let resp = self.transceive(&kf::oled_set_countdown_frame(h, m, s))?;
        expect_ok(&resp)
    }

    #[allow(clippy::too_many_arguments)]
    fn sync_time(
        &mut self,
        year_2000: u8,
        month: u8,
        day: u8,
        hour: u8,
        min: u8,
        sec: u8,
        weekday: u8,
    ) -> Result<(), HidError> {
        let resp = self.transceive(&kf::oled_sync_time_frame(
            year_2000, month, day, hour, min, sec, weekday,
        ))?;
        expect_ok(&resp)
    }

    fn eeprom_commit(&mut self) -> Result<(), HidError> {
        let resp = self.transceive(&kf::eeprom_commit_frame())?;
        expect_ok(&resp)
    }
}

/// Map the app's OLED screen `kind` string to the firmware `kf_screen_type`.
fn screen_kind_to_type(kind: &str) -> u8 {
    match kind {
        "timer" => kf::SCREEN_TIMER,
        "countdown" => kf::SCREEN_COUNTDOWN,
        "datetime" => kf::SCREEN_DATETIME,
        _ => kf::SCREEN_CUSTOM_TEXT,
    }
}

// ---------------------------------------------------------------------------
// Mock: a software model of the board. No hardware needed. Routes every frame
// through the same BoardModel + codec the firmware uses.
// ---------------------------------------------------------------------------
pub struct MockHid {
    board: BoardModel,
}

impl MockHid {
    pub fn new() -> Self {
        let mut board = BoardModel::default();
        // Seed a starter keymap so the UI shows something on first load.
        let km = KeyMap::default_21key();
        for (li, layer) in km.layers.iter().enumerate() {
            for (ki, name) in layer.keys.iter().enumerate() {
                board.keymap[li][ki] = kf::keycode_to_u16(name).unwrap_or(0);
            }
        }
        Self { board }
    }
}

impl Default for MockHid {
    fn default() -> Self {
        Self::new()
    }
}

impl HidTransport for MockHid {
    fn is_connected(&self) -> bool {
        true // the mock is always "plugged in"
    }
    fn transceive(&mut self, frame: &[u8; REPORT_LEN]) -> Result<[u8; REPORT_LEN], HidError> {
        self.board
            .handle(frame)
            .ok_or_else(|| HidError::Io("mock: not a KeyFigurator frame".into()))
    }
}

// ---------------------------------------------------------------------------
// Real: talks to the actual board over Raw HID via `hidapi`.
//
// The `HidDevice` is not `Sync`, and unsolicited RUN_HOST_CMD packets share the
// single IN pipe with command responses. So one dedicated I/O thread OWNS the
// device and serializes all access: `transceive` hands it a request over a
// channel and blocks for the reply; when idle the thread polls for unsolicited
// RUN_HOST_CMD packets and forwards their index to the host-cmd channel.
//
// Identity constants live in kf_protocol (kf::VENDOR_ID / PRODUCT_ID / USAGE*).
// Untestable without a board — validate against hardware during bring-up.
// ---------------------------------------------------------------------------
type IoRequest = ([u8; REPORT_LEN], Sender<Result<[u8; REPORT_LEN], HidError>>);

pub struct RealHid {
    req_tx: Mutex<Sender<IoRequest>>,
    connected: Arc<AtomicBool>,
}

impl RealHid {
    /// Open the KeyFigurator Raw HID interface and start its I/O thread.
    /// `host_cmd_tx` receives the binding index whenever the board sends an
    /// unsolicited RUN_HOST_CMD packet. Returns quickly with `NotConnected` if
    /// no matching board is present, so callers can fall back to `MockHid`.
    pub fn open(host_cmd_tx: Sender<u8>) -> Result<Self, HidError> {
        let (req_tx, req_rx) = channel::<IoRequest>();
        let (ready_tx, ready_rx) = channel::<Result<(), String>>();
        let connected = Arc::new(AtomicBool::new(false));
        let conn_thread = connected.clone();

        std::thread::Builder::new()
            .name("kf-hid-io".into())
            .spawn(move || {
                // HidApi + HidDevice live entirely in this thread (HidDevice is
                // not Sync) and stay alive together for the loop's duration.
                let api = match hidapi::HidApi::new() {
                    Ok(a) => a,
                    Err(e) => {
                        let _ = ready_tx.send(Err(e.to_string()));
                        return;
                    }
                };
                let device = match find_and_open(&api) {
                    Ok(d) => d,
                    Err(e) => {
                        let _ = ready_tx.send(Err(e));
                        return;
                    }
                };
                conn_thread.store(true, Ordering::SeqCst);
                let _ = ready_tx.send(Ok(()));
                io_loop(&device, &req_rx, &host_cmd_tx);
                conn_thread.store(false, Ordering::SeqCst);
            })
            .map_err(|e| HidError::Io(e.to_string()))?;

        match ready_rx.recv() {
            Ok(Ok(())) => Ok(RealHid {
                req_tx: Mutex::new(req_tx),
                connected,
            }),
            Ok(Err(e)) => Err(HidError::Io(e)),
            Err(_) => Err(HidError::Io("hid i/o thread exited before init".into())),
        }
    }
}

/// Find the KeyFigurator interface (VID/PID on the QMK Raw HID usage) and open it.
fn find_and_open(api: &hidapi::HidApi) -> Result<hidapi::HidDevice, String> {
    let info = api
        .device_list()
        .find(|d| {
            d.vendor_id() == kf::VENDOR_ID
                && d.product_id() == kf::PRODUCT_ID
                && d.usage_page() == kf::USAGE_PAGE
                && d.usage() == kf::USAGE
        })
        .ok_or_else(|| "no KeyFigurator interface found".to_string())?;
    info.open_device(api).map_err(|e| e.to_string())
}

/// The single-owner I/O loop. Services `transceive` requests and, when idle,
/// drains unsolicited RUN_HOST_CMD packets to `host_cmd_tx`.
fn io_loop(device: &hidapi::HidDevice, req_rx: &Receiver<IoRequest>, host_cmd_tx: &Sender<u8>) {
    loop {
        match req_rx.try_recv() {
            Ok((frame, resp_tx)) => {
                let _ = resp_tx.send(write_then_read(device, &frame, host_cmd_tx));
            }
            Err(TryRecvError::Empty) => {
                // No pending request — poll briefly for unsolicited packets.
                let mut buf = [0u8; REPORT_LEN];
                match device.read_timeout(&mut buf, 10) {
                    Ok(n) if n > 0 => {
                        if let Some(idx) = kf::parse_run_host_cmd(&buf) {
                            let _ = host_cmd_tx.send(idx);
                        }
                    }
                    Ok(_) => {}         // timeout, nothing available
                    Err(_) => break,    // device gone
                }
            }
            Err(TryRecvError::Disconnected) => break, // RealHid dropped
        }
    }
}

/// Write one request frame, then read until the matching response arrives,
/// forwarding any interleaved RUN_HOST_CMD packets to `host_cmd_tx`.
fn write_then_read(
    device: &hidapi::HidDevice,
    frame: &[u8; REPORT_LEN],
    host_cmd_tx: &Sender<u8>,
) -> Result<[u8; REPORT_LEN], HidError> {
    // QMK Raw HID uses report id 0: prepend a 0x00 report-id byte on write.
    let mut wbuf = [0u8; REPORT_LEN + 1];
    wbuf[1..].copy_from_slice(frame);
    device.write(&wbuf).map_err(|e| HidError::Io(e.to_string()))?;

    // Up to ~2s (100 × 20ms) for the response.
    for _ in 0..100 {
        let mut buf = [0u8; REPORT_LEN];
        let n = device
            .read_timeout(&mut buf, 20)
            .map_err(|e| HidError::Io(e.to_string()))?;
        if n == 0 {
            continue;
        }
        if let Some(idx) = kf::parse_run_host_cmd(&buf) {
            let _ = host_cmd_tx.send(idx); // unsolicited; not our response
            continue;
        }
        return Ok(buf);
    }
    Err(HidError::Io("timeout waiting for board response".into()))
}

impl HidTransport for RealHid {
    fn is_connected(&self) -> bool {
        self.connected.load(Ordering::SeqCst)
    }
    fn transceive(&mut self, frame: &[u8; REPORT_LEN]) -> Result<[u8; REPORT_LEN], HidError> {
        let (resp_tx, resp_rx) = channel();
        self.req_tx
            .lock()
            .unwrap()
            .send((*frame, resp_tx))
            .map_err(|_| HidError::NotConnected)?;
        resp_rx
            .recv_timeout(Duration::from_secs(3))
            .map_err(|_| HidError::Io("hid i/o thread timeout".into()))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mock_roundtrips_keymap() {
        let mut hid = MockHid::new();
        let mut map = hid.get_keymap().unwrap();
        map.layers[0].keys[0] = "KC_ESC".into();
        hid.set_keymap(&map).unwrap();
        assert_eq!(hid.get_keymap().unwrap().layers[0].keys[0], "KC_ESC");
    }

    #[test]
    fn mock_is_always_connected() {
        assert!(MockHid::new().is_connected());
    }

    #[test]
    fn mock_sets_leds_and_brightness() {
        let mut hid = MockHid::new();
        let mut leds = LedState::all_off(kf::KEY_COUNT);
        leds.keys[4] = [255, 0, 0];
        leds.underglow[0] = [0, 255, 0];
        leds.brightness = 123;
        assert!(hid.set_leds(&leds).is_ok());
    }

    #[test]
    fn mock_ping_reports_version() {
        let mut hid = MockHid::new();
        let info = hid.ping().unwrap();
        assert_eq!(info.protocol, kf::PROTOCOL_VERSION);
    }

    #[test]
    fn mock_pushes_oled_and_commits() {
        let mut hid = MockHid::new();
        let cfg = OledConfig {
            layers: vec![crate::model::OledLayer { name: "GIT".into(), show_title: true }],
            screens: vec![crate::model::OledScreen {
                kind: "custom".into(),
                title: "Hi".into(),
                body: "world".into(),
            }],
            countdown: (0, 5, 0),
        };
        assert!(hid.push_oled(&cfg).is_ok());
        assert!(hid.eeprom_commit().is_ok());
    }
}
