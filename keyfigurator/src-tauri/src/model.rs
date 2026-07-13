//! The data model: keymap + per-key LED state + host-command bindings.
//!
//! IMPORTANT: `KEY_COUNT` and the key ordering MUST match the real hardware —
//! the KiCad key-matrix + LED indices. Treat the KiCad project as the source of
//! truth and document it in docs/keymatrix-led-layout.md, then make this match.

use serde::{Deserialize, Serialize};

pub const KEY_COUNT: usize = 21;
pub const LAYER_COUNT: usize = 4;
/// Underglow corners, in wire-slot order: top-left, top-right, bottom-right,
/// bottom-left (LED slots 21..=24, see hid.rs / firmware kf_hid.h).
pub const UNDERGLOW_COUNT: usize = 4;

/// RGB as [r, g, b].
pub type Rgb = [u8; 3];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Layer {
    /// QMK keycode strings, one per physical key, in hardware index order.
    /// e.g. "KC_A", "MO(1)", "MACRO(0)", or "HOST(0)" for a Raw HID host command.
    pub keys: Vec<String>,
}

impl Layer {
    pub fn blank() -> Self {
        Self {
            keys: vec!["KC_NO".to_string(); KEY_COUNT],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct KeyMap {
    pub layers: Vec<Layer>,
}

impl KeyMap {
    /// A sensible default for a fresh 21-key board: layer 0 with a few keys,
    /// the rest transparent layers.
    pub fn default_21key() -> Self {
        let mut base = Layer::blank();
        // a tiny starter layout so the UI shows something
        let starter = [
            "KC_1", "KC_2", "KC_3", "KC_4", "KC_5", "KC_6", "KC_7", "KC_8", "KC_9", "KC_0",
            "KC_A", "KC_B", "KC_C", "KC_D", "KC_E", "KC_F", "KC_G", "MO(1)", "KC_UP", "KC_DOWN",
            "MO(2)",
        ];
        for (i, kc) in starter.iter().enumerate() {
            if i < base.keys.len() {
                base.keys[i] = kc.to_string();
            }
        }
        let mut layers = vec![base];
        for _ in 1..LAYER_COUNT {
            layers.push(Layer::blank());
        }
        Self { layers }
    }
}

impl Default for KeyMap {
    fn default() -> Self {
        Self::default_21key()
    }
}

/// Per-key LED colors + underglow. This is the "Vial gap" feature: arbitrary
/// per-key static colors that the Vial GUI doesn't fully expose.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LedState {
    /// One color per physical key, in the same index order as the keymap.
    pub keys: Vec<Rgb>,
    /// Bottom underglow (RGBLIGHT). A handful of LEDs along the base.
    pub underglow: Vec<Rgb>,
    /// Global brightness 0-255.
    pub brightness: u8,
}

impl LedState {
    pub fn all_off(key_count: usize) -> Self {
        Self {
            keys: vec![[0, 0, 0]; key_count],
            underglow: vec![[0, 0, 0]; UNDERGLOW_COUNT],
            brightness: 180,
        }
    }
}

/// A host-side command bound to a HOST(n) key. When the board sends a
/// RunHostCmd Raw HID packet with index n, the app runs this.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HostBinding {
    pub index: u8,
    pub label: String,
    /// The program + args to run, e.g. ["git", "commit", "-am", "wip"].
    pub command: Vec<String>,
    /// Working directory to run it in (so git knows which repo).
    pub cwd: Option<String>,
}

/// OLED screen configuration - mirrors the firmware's on-device screen model
/// (Macro-Pro-Firmware keyboards/macro_pad_pro/kf_hid.h, KF_CMD_OLED_*).
/// v1: RAM-only on the board, so the app re-pushes this on every reconnect
/// (see hid.rs::HidTransport::push_oled_config).
pub const OLED_LAYER_NAME_MAX: usize = 16;
pub const OLED_CUSTOM_TITLE_MAX: usize = 14;
pub const OLED_CUSTOM_BODY_MAX: usize = 48;
pub const OLED_MAX_CUSTOM_SCREENS: usize = 6;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum OledScreenType {
    Timer = 1,
    Countdown = 2,
    Datetime = 3,
    CustomText = 4,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OledLayerInfo {
    pub show_title: bool,
    /// Truncated to OLED_LAYER_NAME_MAX bytes on the wire.
    pub name: String,
}

impl Default for OledLayerInfo {
    fn default() -> Self {
        Self {
            show_title: true,
            name: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OledCustomScreen {
    pub screen_type: OledScreenType,
    /// Truncated to OLED_CUSTOM_TITLE_MAX bytes on the wire.
    pub title: String,
    /// Truncated to OLED_CUSTOM_BODY_MAX bytes on the wire.
    pub body: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OledConfig {
    /// Exactly LAYER_COUNT entries, one per hardware layer.
    pub layers: [OledLayerInfo; LAYER_COUNT],
    /// At most OLED_MAX_CUSTOM_SCREENS entries.
    pub custom_screens: Vec<OledCustomScreen>,
    /// Single global countdown duration (h, m, s) - the board only tracks
    /// one countdown instance, matching the app's own model.
    pub countdown: (u8, u8, u8),
}

impl Default for OledConfig {
    fn default() -> Self {
        Self {
            layers: std::array::from_fn(|_| OledLayerInfo::default()),
            custom_screens: Vec::new(),
            countdown: (0, 1, 0),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_keymap_has_right_shape() {
        let m = KeyMap::default_21key();
        assert_eq!(m.layers.len(), LAYER_COUNT);
        for l in &m.layers {
            assert_eq!(l.keys.len(), KEY_COUNT);
        }
    }

    #[test]
    fn leds_default_off() {
        let l = LedState::all_off(KEY_COUNT);
        assert_eq!(l.keys.len(), KEY_COUNT);
        assert!(l.keys.iter().all(|c| *c == [0, 0, 0]));
    }

    #[test]
    fn keymap_serde_roundtrip() {
        let m = KeyMap::default_21key();
        let json = serde_json::to_string(&m).unwrap();
        let back: KeyMap = serde_json::from_str(&json).unwrap();
        assert_eq!(m, back);
    }

    #[test]
    fn oled_config_default_has_right_shape() {
        let cfg = OledConfig::default();
        assert_eq!(cfg.layers.len(), LAYER_COUNT);
        assert!(cfg.custom_screens.is_empty());
    }

    #[test]
    fn oled_config_serde_roundtrip() {
        let mut cfg = OledConfig::default();
        cfg.layers[0].name = "NUMPAD".into();
        cfg.custom_screens.push(OledCustomScreen {
            screen_type: OledScreenType::Timer,
            title: String::new(),
            body: String::new(),
        });
        let json = serde_json::to_string(&cfg).unwrap();
        let back: OledConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(cfg, back);
    }
}
