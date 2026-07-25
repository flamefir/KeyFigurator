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
// Real: talks to the actual board over Raw HID via `hidapi`. STUBBED until
// boards arrive — only `transceive` (a USB write + read on the KeyFigurator
// interface) is left to implement; all protocol logic above is already shared.
// Identity constants live in kf_protocol (kf::VENDOR_ID / PRODUCT_ID / USAGE*).
// ---------------------------------------------------------------------------
pub struct RealHid {
    // device: Option<hidapi::HidDevice>,  // uncomment when wiring hidapi
}

impl RealHid {
    pub fn open() -> Result<Self, HidError> {
        // TODO when boards arrive:
        //  let api = hidapi::HidApi::new().map_err(|e| HidError::Io(e.to_string()))?;
        //  enumerate for kf::VENDOR_ID/PRODUCT_ID on usage_page kf::USAGE_PAGE /
        //  usage kf::USAGE, open it, keep the handle. Also spawn a read thread that
        //  parses inbound frames with kf::parse_run_host_cmd(..) and forwards the
        //  index to the host-cmd channel (see main.rs).
        Err(HidError::NotConnected)
    }
}

impl HidTransport for RealHid {
    fn is_connected(&self) -> bool {
        false
    }
    fn transceive(&mut self, _frame: &[u8; REPORT_LEN]) -> Result<[u8; REPORT_LEN], HidError> {
        // TODO: device.write(frame)?; device.read(&mut buf)?; return buf.
        Err(HidError::NotConnected)
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
