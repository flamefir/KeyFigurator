//! The data model: keymap + per-key LED state + host-command bindings.
//!
//! IMPORTANT: `KEY_COUNT` and the key ordering MUST match the real hardware —
//! the KiCad key-matrix + LED indices. Treat the KiCad project as the source of
//! truth and document it in docs/keymatrix-led-layout.md, then make this match.

use serde::{Deserialize, Serialize};

pub const KEY_COUNT: usize = 21;
pub const LAYER_COUNT: usize = 4;

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
    /// One color per physical key (21: indices 0..20, encoder at 20), in the
    /// same index order as the keymap / `BOARD_POSITIONS`.
    pub keys: Vec<Rgb>,
    /// The 4 underglow corners, in firmware slot order: TL, TR, BR, BL
    /// (LED slots 21..24 in `kf_hid.c`).
    pub underglow: Vec<Rgb>,
    /// Global brightness 0-255.
    pub brightness: u8,
}

/// Number of underglow corners — matches `kf_protocol::UNDERGLOW_COUNT`.
pub const UNDERGLOW_COUNT: usize = 4;

impl LedState {
    pub fn all_off(key_count: usize) -> Self {
        Self {
            keys: vec![[0, 0, 0]; key_count],
            underglow: vec![[0, 0, 0]; UNDERGLOW_COUNT],
            brightness: 180,
        }
    }

    /// Flatten to the 25 wire LED slots the firmware expects: keys 0..20
    /// followed by the 4 underglow corners (slots 21..24). Missing entries are
    /// padded with off; extras are ignored.
    pub fn to_slots(&self) -> Vec<Rgb> {
        let mut slots = vec![[0u8, 0, 0]; KEY_COUNT + UNDERGLOW_COUNT];
        for (i, c) in self.keys.iter().take(KEY_COUNT).enumerate() {
            slots[i] = *c;
        }
        for (i, c) in self.underglow.iter().take(UNDERGLOW_COUNT).enumerate() {
            slots[KEY_COUNT + i] = *c;
        }
        slots
    }
}

/// One OLED layer screen: the title shown for a keymap layer.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct OledLayer {
    pub name: String,
    pub show_title: bool,
}

/// One ordered custom OLED screen. `kind` is "timer" | "countdown" |
/// "datetime" | "custom"; `title`/`body` apply to custom-text screens.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct OledScreen {
    pub kind: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub body: String,
}

/// The full OLED configuration the app pushes to the board. RAM-only on the
/// firmware side, so the app re-pushes this on every reconnect.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct OledConfig {
    /// Per keymap layer (index 0..LAYER_COUNT-1).
    pub layers: Vec<OledLayer>,
    /// Ordered custom screens (max 6).
    pub screens: Vec<OledScreen>,
    /// Single global countdown duration: hours, minutes, seconds.
    pub countdown: (u8, u8, u8),
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
}
