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

/// The board's global LED animation.
///
/// Deliberately NOT per-key. QMK's RGB matrix runs one effect for the whole
/// board, so animation is global and only *colour* is per-key. The app's editor
/// mirrors that shape so its preview cannot promise something the board will
/// not reproduce.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AnimState {
    /// One of: solid, rainbow, snake, breathe, wave, reactive, sparkle.
    /// Mapped to a stable wire id by `kf_protocol::anim_id`.
    pub name: String,
    /// QMK rgb matrix animation speed, 0-255.
    pub speed: u8,
    /// Base colour the effect is tinted with. Converted to QMK's HSV on the way
    /// out, since `rgb_matrix_sethsv_noeeprom` takes HSV.
    pub color: Rgb,
}

impl Default for AnimState {
    fn default() -> Self {
        Self {
            name: "solid".to_string(),
            speed: 128,
            color: [255, 180, 84], // brand amber #ffb454
        }
    }
}

impl AnimState {
    pub fn hsv(&self) -> (u8, u8, u8) {
        rgb_to_hsv(self.color)
    }
}

/// RGB → QMK's HSV space, in which hue is 0-255 rather than 0-360 degrees.
///
/// Integer-only, via a 0..1530 (6 × 255) sixths-of-the-wheel intermediate, so
/// the pure primaries land exactly on QMK's expected 0 / 85 / 170.
pub fn rgb_to_hsv(rgb: Rgb) -> (u8, u8, u8) {
    let [r, g, b] = rgb;
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let v = max;
    if max == 0 {
        return (0, 0, 0); // black: hue and saturation are meaningless
    }
    let delta = max - min;
    let s = ((delta as u16 * 255) / max as u16) as u8;
    if delta == 0 {
        return (0, 0, v); // greys: no hue
    }

    let (rf, gf, bf, d) = (r as i32, g as i32, b as i32, delta as i32);
    let h1530 = if max == r {
        (((gf - bf) * 255) / d + 1530) % 1530
    } else if max == g {
        ((bf - rf) * 255) / d + 510
    } else {
        ((rf - gf) * 255) / d + 1020
    };
    // Round rather than truncate, so #ffb454 gives hue 24 (matching
    // RGB_MATRIX_DEFAULT_HUE) instead of 23.
    let h = ((h1530 * 255 + 765) / 1530) as u8;
    (h, s, v)
}

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

/// Pomodoro phase durations in minutes, plus how many work phases earn a long
/// break instead of a short one.
///
/// These live on the board (the pomodoro runs on-device so it keeps counting
/// with the app closed), so this is push-only configuration, not live state.
/// `Default` matches the firmware's compile-time defaults, which is also what
/// a board that has never been configured is already running.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct PomodoroConfig {
    pub work_min: u8,
    pub short_break_min: u8,
    pub long_break_min: u8,
    pub long_every: u8,
}

impl Default for PomodoroConfig {
    fn default() -> Self {
        Self {
            work_min: 25,
            short_break_min: 5,
            long_break_min: 15,
            long_every: 4,
        }
    }
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
    /// Absent from an older frontend's payload, so it defaults rather than
    /// failing to deserialize.
    #[serde(default)]
    pub pomodoro: PomodoroConfig,
    /// Which screens may blank themselves after `sleep_timeout_s` idle, as a
    /// bitmap over the board's nav-index space: bits 0..3 are the four layer
    /// screens, bits 4..9 the custom screens in order. Empty by default.
    #[serde(default)]
    pub sleep_mask: u16,
    #[serde(default = "default_sleep_timeout")]
    pub sleep_timeout_s: u8,
}

fn default_sleep_timeout() -> u8 {
    60
}

/// A host-side command bound to a HOST(n) key. When the board sends a
/// RunHostCmd Raw HID packet with index n, the app runs this.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HostBinding {
    pub index: u8,
    pub label: String,
    /// The program + args to run, e.g. ["git", "commit", "-am", "wip"].
    /// Ignored when `script` is set.
    #[serde(default)]
    pub command: Vec<String>,
    /// A shell script authored in the macro library. Takes precedence over
    /// `command`, and runs through a shell rather than being spawned directly —
    /// a script needs pipes, redirects and multiple lines to mean anything.
    #[serde(default)]
    pub script: Option<String>,
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

    /// QMK's hue axis is 0-255, not degrees, and the firmware's own defaults
    /// were derived from #ffb454 — so the conversion has to land on exactly
    /// those numbers or every animation ships the wrong tint.
    #[test]
    fn rgb_to_hsv_matches_qmk_hue_space() {
        assert_eq!(rgb_to_hsv([255, 0, 0]), (0, 255, 255)); // red
        assert_eq!(rgb_to_hsv([0, 255, 0]), (85, 255, 255)); // green
        assert_eq!(rgb_to_hsv([0, 0, 255]), (170, 255, 255)); // blue
        assert_eq!(rgb_to_hsv([255, 255, 255]), (0, 0, 255)); // white: no hue
        assert_eq!(rgb_to_hsv([0, 0, 0]), (0, 0, 0)); // black
        assert_eq!(rgb_to_hsv([128, 128, 128]), (0, 0, 128)); // grey

        // Brand amber #ffb454 must reproduce RGB_MATRIX_DEFAULT_{HUE,SAT} = 24, 171.
        let (h, s, v) = rgb_to_hsv([255, 180, 84]);
        assert_eq!((h, s), (24, 171));
        assert_eq!(v, 255);
    }

    #[test]
    fn anim_state_defaults_to_solid_amber() {
        let a = AnimState::default();
        assert_eq!(a.name, "solid");
        assert_eq!(a.hsv(), (24, 171, 255));
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
