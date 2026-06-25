//! HID transport: the boundary between the app and the keyboard.
//!
//! The whole app talks to the board ONLY through the `HidTransport` trait, so the
//! rest of the code never knows whether it's talking to a real board or the mock.
//! - `MockHid` works today, with no hardware (use it until PCBs arrive).
//! - `RealHid` is the stub you fill in once boards are in hand.
//!
//! Protocol: Raw HID. We send 32-byte report packets; byte 0 is the command id,
//! the rest is the payload. This sits ALONGSIDE Vial, it does not replace it.

use crate::model::{KeyMap, LedState};
use serde::{Deserialize, Serialize};

pub const REPORT_LEN: usize = 32;

/// Command ids for the Raw HID channel. Must match the firmware's switch().
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum Cmd {
    Ping = 0x01,
    GetKeymap = 0x10,
    SetKeymap = 0x11,
    SetLeds = 0x20,
    RunHostCmd = 0x30, // board -> host: "run this bound command" (git, shell, ...)
}

#[derive(Debug, thiserror::Error)]
pub enum HidError {
    #[error("no device connected")]
    NotConnected,
    #[error("device i/o error: {0}")]
    Io(String),
}

/// Everything the app needs from a keyboard. Implemented by Mock + Real.
pub trait HidTransport: Send + Sync {
    fn is_connected(&self) -> bool;
    fn ping(&mut self) -> Result<(), HidError>;
    fn get_keymap(&mut self) -> Result<KeyMap, HidError>;
    fn set_keymap(&mut self, map: &KeyMap) -> Result<(), HidError>;
    fn set_leds(&mut self, leds: &LedState) -> Result<(), HidError>;
}

// ---------------------------------------------------------------------------
// Mock: an in-memory fake board. No hardware needed. This is what makes the
// entire UI buildable + testable today.
// ---------------------------------------------------------------------------
pub struct MockHid {
    keymap: KeyMap,
    leds: LedState,
}

impl MockHid {
    pub fn new() -> Self {
        Self {
            keymap: KeyMap::default_21key(),
            leds: LedState::all_off(21),
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
}

// ---------------------------------------------------------------------------
// Real: talks to the actual board over Raw HID via the `hidapi` crate.
// STUBBED until boards arrive — fill in once you have a device to enumerate.
// VID/PID come from your QMK config (config.h: VENDOR_ID / PRODUCT_ID).
// ---------------------------------------------------------------------------
pub const VENDOR_ID: u16 = 0xFEED; // TODO: set to your real QMK VENDOR_ID
pub const PRODUCT_ID: u16 = 0x0000; // TODO: set to your real QMK PRODUCT_ID
pub const USAGE_PAGE: u16 = 0xFF60; // QMK Raw HID usage page
pub const USAGE: u16 = 0x61; // QMK Raw HID usage

pub struct RealHid {
    // device: Option<hidapi::HidDevice>,  // uncomment when wiring hidapi
}

impl RealHid {
    pub fn open() -> Result<Self, HidError> {
        // TODO when boards arrive:
        //  let api = hidapi::HidApi::new().map_err(|e| HidError::Io(e.to_string()))?;
        //  find the interface matching VENDOR_ID/PRODUCT_ID + USAGE_PAGE/USAGE,
        //  open it, store the handle.
        Err(HidError::NotConnected)
    }
}

impl HidTransport for RealHid {
    fn is_connected(&self) -> bool {
        false
    }
    fn ping(&mut self) -> Result<(), HidError> {
        Err(HidError::NotConnected)
    }
    fn get_keymap(&mut self) -> Result<KeyMap, HidError> {
        Err(HidError::NotConnected)
    }
    fn set_keymap(&mut self, _map: &KeyMap) -> Result<(), HidError> {
        Err(HidError::NotConnected)
    }
    fn set_leds(&mut self, _leds: &LedState) -> Result<(), HidError> {
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
    fn mock_sets_leds() {
        let mut hid = MockHid::new();
        let mut leds = LedState::all_off(21);
        leds.keys[4] = [255, 0, 0];
        assert!(hid.set_leds(&leds).is_ok());
    }
}
