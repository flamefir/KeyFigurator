//! HID transport: the boundary between the app and the keyboard.
//!
//! The whole app talks to the board ONLY through the `HidTransport` trait, so the
//! rest of the code never knows whether it's talking to a real board or the mock.
//! - `MockHid` works with no hardware.
//! - `RealHid` speaks the firmware's Raw HID channel (Macro-Pro-Firmware,
//!   `keyboards/macro_pad_pro/kf_hid.h` is the protocol source of truth).
//!
//! Wire format: 32-byte reports on the QMK Raw HID interface, shared with
//! VIA/Vial. Every KeyFigurator report is framed behind the KF_MAGIC byte so it
//! can never collide with VIA/Vial command ids:
//!
//!   byte 0    KF_MAGIC (0xC0)
//!   byte 1    command id
//!   byte 2+   payload
//!
//! Key index space 0..=20 (0..=19 reading order, 20 = encoder push) matches
//! BOARD_POSITIONS in main.js. LED slots: 0..=20 keys, then underglow
//! 21 = top-left, 22 = top-right, 23 = bottom-right, 24 = bottom-left.

use crate::keycodes;
use crate::model::{KeyMap, Layer, LedState, KEY_COUNT, LAYER_COUNT, UNDERGLOW_COUNT};
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

pub const REPORT_LEN: usize = 32;
pub const KF_MAGIC: u8 = 0xC0;

/// Command ids for the Raw HID channel. Must match the firmware's kf_hid.h.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum Cmd {
    Ping = 0x01,
    GetKeymap = 0x10,
    SetKeymap = 0x11,
    SetLeds = 0x20,
    RunHostCmd = 0x30,   // board -> host: "run this bound command" (index only)
    EepromCommit = 0x40, // host -> board: persist LED overlay to EEPROM
}

/// SET_LEDS control-frame selectors (first payload byte).
pub const KF_LED_BRIGHTNESS: u8 = 0xF0;
pub const KF_LED_OVERLAY_OFF: u8 = 0xF1;
pub const KF_LED_OVERLAY_ON: u8 = 0xF2;

pub const KF_STATUS_OK: u8 = 0x00;

/// Max keycodes per GET/SET_KEYMAP report, max RGB triples per SET_LEDS report.
pub const KEYMAP_CHUNK: usize = 13;
pub const LED_CHUNK: usize = 9;

/// Total LED slots on the wire: 21 per-key + 4 underglow corners.
pub const LED_SLOTS: usize = KEY_COUNT + UNDERGLOW_COUNT;

#[derive(Debug, thiserror::Error)]
pub enum HidError {
    #[error("no device connected")]
    NotConnected,
    #[error("device i/o error: {0}")]
    Io(String),
    #[error("board answered with error status for {0}")]
    BoardError(&'static str),
}

/// Everything the app needs from a keyboard. Implemented by Mock + Real.
/// Send only (not Sync): the app always accesses it through a Mutex, and
/// hidapi's HidDevice is not Sync.
pub trait HidTransport: Send {
    fn is_connected(&self) -> bool;
    fn ping(&mut self) -> Result<(), HidError>;
    fn get_keymap(&mut self) -> Result<KeyMap, HidError>;
    fn set_keymap(&mut self, map: &KeyMap) -> Result<(), HidError>;
    fn set_leds(&mut self, leds: &LedState) -> Result<(), HidError>;
    fn eeprom_commit(&mut self) -> Result<(), HidError>;
    /// Drain any RunHostCmd indices the board has sent since the last call.
    fn poll_host_cmds(&mut self) -> Vec<u8> {
        Vec::new()
    }
    /// True for the in-memory fake; lets the app keep trying to upgrade to a
    /// real board while the mock is active.
    fn is_mock(&self) -> bool {
        false
    }
}

/// Frame a KeyFigurator report: [KF_MAGIC, cmd, payload..], zero-padded.
pub fn frame_report(cmd: Cmd, payload: &[u8]) -> [u8; REPORT_LEN] {
    let mut report = [0u8; REPORT_LEN];
    report[0] = KF_MAGIC;
    report[1] = cmd as u8;
    let n = payload.len().min(REPORT_LEN - 2);
    report[2..2 + n].copy_from_slice(&payload[..n]);
    report
}

// ---------------------------------------------------------------------------
// Mock: an in-memory fake board. No hardware needed.
// ---------------------------------------------------------------------------
pub struct MockHid {
    keymap: KeyMap,
    leds: LedState,
}

impl MockHid {
    pub fn new() -> Self {
        Self {
            keymap: KeyMap::default_21key(),
            leds: LedState::all_off(KEY_COUNT),
        }
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
    fn ping(&mut self) -> Result<(), HidError> {
        Ok(())
    }
    fn get_keymap(&mut self) -> Result<KeyMap, HidError> {
        Ok(self.keymap.clone())
    }
    fn set_keymap(&mut self, map: &KeyMap) -> Result<(), HidError> {
        self.keymap = map.clone();
        Ok(())
    }
    fn set_leds(&mut self, leds: &LedState) -> Result<(), HidError> {
        self.leds = leds.clone();
        Ok(())
    }
    fn eeprom_commit(&mut self) -> Result<(), HidError> {
        Ok(()) // mock: already in EEPROM (there is no real EEPROM)
    }
    fn is_mock(&self) -> bool {
        true
    }
}

// ---------------------------------------------------------------------------
// Real: talks to the board over Raw HID via hidapi.
// ---------------------------------------------------------------------------

/// Must match the firmware's keyboard.json / config.h.
pub const VENDOR_ID: u16 = 0xFEED; // QMK community placeholder VID
pub const PRODUCT_ID: u16 = 0x4D50; // "MP"; replace before public release
pub const USAGE_PAGE: u16 = 0xFF60; // QMK Raw HID usage page
pub const USAGE: u16 = 0x61; // QMK Raw HID usage

const READ_TIMEOUT_MS: i32 = 250;
const XFER_DEADLINE: Duration = Duration::from_millis(1000);

pub struct RealHid {
    device: hidapi::HidDevice,
    connected: bool,
    /// RunHostCmd indices received while waiting for other responses.
    pending_host_cmds: Vec<u8>,
}

impl RealHid {
    pub fn open() -> Result<Self, HidError> {
        let api = hidapi::HidApi::new().map_err(|e| HidError::Io(e.to_string()))?;
        let info = api
            .device_list()
            .find(|d| {
                d.vendor_id() == VENDOR_ID
                    && d.product_id() == PRODUCT_ID
                    && d.usage_page() == USAGE_PAGE
                    && d.usage() == USAGE
            })
            .ok_or(HidError::NotConnected)?;
        let device = info
            .open_device(&api)
            .map_err(|e| HidError::Io(e.to_string()))?;
        Ok(Self {
            device,
            connected: true,
            pending_host_cmds: Vec::new(),
        })
    }

    fn write_report(&mut self, report: &[u8; REPORT_LEN]) -> Result<(), HidError> {
        // hidapi requires a leading report-id byte; QMK raw HID uses none (0).
        let mut buf = [0u8; REPORT_LEN + 1];
        buf[1..].copy_from_slice(report);
        self.device.write(&buf).map_err(|e| {
            self.connected = false;
            HidError::Io(e.to_string())
        })?;
        Ok(())
    }

    /// Read reports until one matches our (magic, cmd) or the deadline hits.
    /// Unsolicited RunHostCmd packets seen along the way are queued, VIA/Vial
    /// traffic addressed to other clients is ignored.
    fn read_response(&mut self, cmd: Cmd) -> Result<[u8; REPORT_LEN], HidError> {
        let deadline = Instant::now() + XFER_DEADLINE;
        loop {
            let mut buf = [0u8; REPORT_LEN];
            let n = self
                .device
                .read_timeout(&mut buf, READ_TIMEOUT_MS)
                .map_err(|e| {
                    self.connected = false;
                    HidError::Io(e.to_string())
                })?;
            if n > 0 && buf[0] == KF_MAGIC {
                if buf[1] == cmd as u8 {
                    return Ok(buf);
                }
                if buf[1] == Cmd::RunHostCmd as u8 {
                    self.pending_host_cmds.push(buf[2]);
                }
            }
            if Instant::now() >= deadline {
                self.connected = false;
                return Err(HidError::Io(format!("timeout waiting for {cmd:?}")));
            }
        }
    }

    fn xfer(&mut self, cmd: Cmd, payload: &[u8]) -> Result<[u8; REPORT_LEN], HidError> {
        self.write_report(&frame_report(cmd, payload))?;
        self.read_response(cmd)
    }

    fn xfer_ok(&mut self, cmd: Cmd, payload: &[u8], what: &'static str) -> Result<(), HidError> {
        let resp = self.xfer(cmd, payload)?;
        if resp[2] == KF_STATUS_OK {
            Ok(())
        } else {
            Err(HidError::BoardError(what))
        }
    }
}

impl HidTransport for RealHid {
    fn is_connected(&self) -> bool {
        self.connected
    }

    fn ping(&mut self) -> Result<(), HidError> {
        self.xfer(Cmd::Ping, &[])?;
        self.connected = true;
        Ok(())
    }

    fn get_keymap(&mut self) -> Result<KeyMap, HidError> {
        let mut layers = Vec::with_capacity(LAYER_COUNT);
        for layer in 0..LAYER_COUNT as u8 {
            let mut keys = Vec::with_capacity(KEY_COUNT);
            let mut offset = 0usize;
            while offset < KEY_COUNT {
                let count = (KEY_COUNT - offset).min(KEYMAP_CHUNK) as u8;
                let resp = self.xfer(Cmd::GetKeymap, &[layer, offset as u8, count])?;
                if resp[4] != count {
                    return Err(HidError::BoardError("GetKeymap"));
                }
                for i in 0..count as usize {
                    let lo = resp[5 + i * 2] as u16;
                    let hi = resp[6 + i * 2] as u16;
                    keys.push(keycodes::code_to_name(lo | (hi << 8)));
                }
                offset += count as usize;
            }
            layers.push(Layer { keys });
        }
        Ok(KeyMap { layers })
    }

    fn set_keymap(&mut self, map: &KeyMap) -> Result<(), HidError> {
        for (layer, l) in map.layers.iter().enumerate().take(LAYER_COUNT) {
            let mut offset = 0usize;
            while offset < l.keys.len().min(KEY_COUNT) {
                let count = (l.keys.len().min(KEY_COUNT) - offset).min(KEYMAP_CHUNK);
                let mut payload = vec![layer as u8, offset as u8, count as u8];
                for name in &l.keys[offset..offset + count] {
                    // unknown strings become KC_NO rather than failing the sync
                    let code = keycodes::name_to_code(name).unwrap_or(0);
                    payload.push((code & 0xFF) as u8);
                    payload.push((code >> 8) as u8);
                }
                self.xfer_ok(Cmd::SetKeymap, &payload, "SetKeymap")?;
                offset += count;
            }
        }
        Ok(())
    }

    fn set_leds(&mut self, leds: &LedState) -> Result<(), HidError> {
        self.xfer_ok(
            Cmd::SetLeds,
            &[KF_LED_BRIGHTNESS, leds.brightness],
            "SetLeds brightness",
        )?;
        // slots 0..=20 keys, 21..=24 underglow TL/TR/BR/BL
        let mut slots = [[0u8; 3]; LED_SLOTS];
        for (i, rgb) in leds.keys.iter().enumerate().take(KEY_COUNT) {
            slots[i] = *rgb;
        }
        for (i, rgb) in leds.underglow.iter().enumerate().take(UNDERGLOW_COUNT) {
            slots[KEY_COUNT + i] = *rgb;
        }
        let mut offset = 0usize;
        while offset < LED_SLOTS {
            let count = (LED_SLOTS - offset).min(LED_CHUNK);
            let mut payload = vec![offset as u8, count as u8];
            for rgb in &slots[offset..offset + count] {
                payload.extend_from_slice(rgb);
            }
            self.xfer_ok(Cmd::SetLeds, &payload, "SetLeds")?;
            offset += count;
        }
        Ok(())
    }

    fn eeprom_commit(&mut self) -> Result<(), HidError> {
        self.xfer_ok(Cmd::EepromCommit, &[], "EepromCommit")
    }

    fn poll_host_cmds(&mut self) -> Vec<u8> {
        // non-blocking drain of anything the board pushed since last poll
        loop {
            let mut buf = [0u8; REPORT_LEN];
            match self.device.read_timeout(&mut buf, 0) {
                Ok(n) if n > 0 => {
                    if buf[0] == KF_MAGIC && buf[1] == Cmd::RunHostCmd as u8 {
                        self.pending_host_cmds.push(buf[2]);
                    }
                }
                Ok(_) => break,
                Err(_) => {
                    self.connected = false;
                    break;
                }
            }
        }
        std::mem::take(&mut self.pending_host_cmds)
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
    fn mock_sets_leds() {
        let mut hid = MockHid::new();
        let mut leds = LedState::all_off(KEY_COUNT);
        leds.keys[4] = [255, 0, 0];
        assert!(hid.set_leds(&leds).is_ok());
    }

    #[test]
    fn frame_layout_matches_firmware() {
        let r = frame_report(Cmd::Ping, &[]);
        assert_eq!(r[0], 0xC0);
        assert_eq!(r[1], 0x01);
        assert_eq!(&r[2..], &[0u8; 30]);

        let r = frame_report(Cmd::SetKeymap, &[2, 0, 1, 0x04, 0x00]); // layer 2, KC_A
        assert_eq!(&r[..7], &[0xC0, 0x11, 2, 0, 1, 0x04, 0x00]);
    }

    #[test]
    fn chunking_covers_everything_exactly_once() {
        // 21 keys in chunks of 13 -> 13 + 8; 25 LED slots in chunks of 9 -> 9+9+7
        let key_chunks: Vec<usize> = (0..KEY_COUNT)
            .step_by(KEYMAP_CHUNK)
            .map(|o| (KEY_COUNT - o).min(KEYMAP_CHUNK))
            .collect();
        assert_eq!(key_chunks.iter().sum::<usize>(), KEY_COUNT);
        assert!(key_chunks.iter().all(|&c| c <= KEYMAP_CHUNK));

        let led_chunks: Vec<usize> = (0..LED_SLOTS)
            .step_by(LED_CHUNK)
            .map(|o| (LED_SLOTS - o).min(LED_CHUNK))
            .collect();
        assert_eq!(led_chunks.iter().sum::<usize>(), LED_SLOTS);
        assert!(led_chunks.iter().all(|&c| c <= LED_CHUNK));
        // every report stays within 32 bytes: 2 magic/cmd + 2 header + 9*3 rgb = 31
        assert!(2 + 2 + LED_CHUNK * 3 <= REPORT_LEN);
        // 2 + 3 header + 13*2 keycodes = 31
        assert!(2 + 3 + KEYMAP_CHUNK * 2 <= REPORT_LEN);
    }
}
