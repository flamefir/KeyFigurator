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
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
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
    pub pause_min: u8,
    /// How many work+pause repetitions make a session; after the last one the
    /// board stops rather than looping.
    pub cycles: u8,
}

impl Default for PomodoroConfig {
    fn default() -> Self {
        Self { work_min: 25, pause_min: 5, cycles: 4 }
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
    /// Which key triggers which screen action: (screen_slot, event, key_idx),
    /// screen_slot in the board's nav-index space. Without these the board only
    /// reaches a screen's actions through the encoder push, which hardware
    /// revision 1.0.0 does not have.
    #[serde(default)]
    pub event_keys: Vec<(u8, u8, u8)>,
    /// What Present Keys shows about each key. The board cannot derive any of
    /// it — the keycode table is too big for it, and macro titles and icons
    /// exist only here.
    #[serde(default)]
    pub key_info: Vec<KeyInfo>,
    /// Per-key icon, rasterised host-side from the user's PNG or SVG to the
    /// board's 32x32 1-bit mask. `None` is a key with no icon, which is sent
    /// explicitly — otherwise a removed icon would linger on the board.
    ///
    /// Rasterised in the app because the board can decode neither format, and
    /// the app already has a canvas.
    #[serde(default)]
    pub key_icons: Vec<Option<Vec<u8>>>,
    /// How big screen titles are drawn, 1..4. A scale, not a typeface: the
    /// board has one font. 0 (the serde default) means "leave it alone", which
    /// is what a payload written before this existed means.
    #[serde(default)]
    pub font_scale: u8,
    /// Each screen's own LED profile. The app has always had these; the board
    /// had one global set, so an animation configured on one screen ran on all
    /// of them once you rotated away from it.
    #[serde(default)]
    pub screen_leds: Vec<ScreenLeds>,
}

/// One screen's LEDs: which slot it is, its colours, and the two animations.
///
/// Sent per screen rather than only for the active one because the encoder
/// changes screens with no app involved — the board has to already know what
/// every screen wants, including with the app closed.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ScreenLeds {
    /// The app's fixed slot space: 4 layer screens, then custom screens.
    pub slot: u8,
    pub leds: LedState,
    pub anim: AnimState,
    #[serde(default)]
    pub underglow: UnderglowAnim,
}

/// The TEXT Present Keys can show about a key. The board picks the macro title
/// if there is one, else the keycode — and skips both entirely when the key has
/// an icon, which outranks them. Empty means "this key has none".
///
/// The icon is not here: it is pixels, and travels as `key_icons`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeyInfo {
    #[serde(default)]
    pub macro_title: String,
    #[serde(default)]
    pub keycode: String,
}

fn default_sleep_timeout() -> u8 {
    60
}

/// The underglow's own animation. Separate from `AnimState` because it carries
/// no colour: the animated modes reuse the corner colours already pushed by
/// SET_LEDS, and rainbow generates its own spectrum.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UnderglowAnim {
    pub name: String,
    pub speed: u8,
    pub intensity: u8,
}

impl Default for UnderglowAnim {
    fn default() -> Self {
        Self { name: "solid".into(), speed: 128, intensity: 180 }
    }
}

/// A "Cycle Colors" palette: the running animation steps through these instead
/// of holding one tint. Empty means no cycling.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct Palette {
    pub colors: Vec<Rgb>,
    /// The app's animation-rate byte; the board maps it to a cycle period.
    pub rate: u8,
}

#[cfg(test)]
mod payload_tests {
    use super::*;

    /// The exact JSON `buildOledConfig()` emits, deserialized the way Tauri
    /// does it.
    ///
    /// This exists because a field rename on the JS side and a stale struct
    /// here made `oled_push` reject the whole payload — and the frontend's
    /// `try/catch` swallowed it, so Save to Board reported success while
    /// nothing OLED ever reached the board. Every Rust-side test passed
    /// throughout, because they all build the struct directly in Rust and
    /// never cross the boundary that actually broke.
    ///
    /// If you rename a field in `main.js`, this test is what fails.
    #[test]
    fn frontend_oled_payload_deserializes() {
        let json = r#"{
            "layers":  [{"name":"Launch Apps","show_title":true}],
            "screens": [{"kind":"pomodoro","title":"","body":""},
                        {"kind":"datetime","title":"","body":""}],
            "countdown": [0,0,0],
            "sleep_mask": 0,
            "sleep_timeout_s": 60,
            "pomodoro": {"work_min":25,"pause_min":5,"cycles":4},
            "event_keys": [[0,0,5],[4,8,11]],
            "key_info": [{"macro_title":"Claude in Repos","keycode":"ENTER"},
                         {"macro_title":"","keycode":"F5"}],
            "key_icons": [[1,2,3], null],
            "font_scale": 3
        }"#;
        let cfg: OledConfig = serde_json::from_str(json).expect("frontend payload must parse");
        assert_eq!(cfg.layers.len(), 1);
        assert_eq!(cfg.layers[0].name, "Launch Apps");
        assert_eq!(cfg.screens.len(), 2);
        assert_eq!(cfg.pomodoro.work_min, 25);
        assert_eq!(cfg.pomodoro.pause_min, 5);
        assert_eq!(cfg.pomodoro.cycles, 4);
        // (screen_slot, event, key_idx) — Present Keys on layer 0, key 5.
        assert_eq!(cfg.event_keys, vec![(0, 0, 5), (4, 8, 11)]);
        // Both text fields survive separately. A rename on either side of this
        // boundary is exactly the kind of silent breakage that once made Save
        // to Board do nothing at all.
        assert_eq!(cfg.key_info.len(), 2);
        assert_eq!(cfg.key_info[0].macro_title, "Claude in Repos");
        assert_eq!(cfg.key_info[0].keycode, "ENTER");
        assert_eq!(cfg.key_info[1].keycode, "F5");
        // And the icon masks come through as bytes, with null meaning "none".
        assert_eq!(cfg.key_icons, vec![Some(vec![1u8, 2, 3]), None]);
        assert_eq!(cfg.font_scale, 3);
    }

    /// A binding as the frontend actually sends it. The macro-library action
    /// shape is a shared format between the two halves of the app, so a change
    /// on either side that breaks the tagging has to fail here rather than at a
    /// keypress.
    #[test]
    fn a_keystroke_binding_deserializes_from_the_frontend_shape() {
        let b: HostBinding = serde_json::from_str(
            r#"{"index":2,"label":"Copy","command":[],"script":"","cwd":null,
                "keys":[{"type":"down","key":"KC_LCTL"},
                        {"type":"tap","key":"KC_C"},
                        {"type":"up","key":"KC_LCTL"},
                        {"type":"delay","ms":30},
                        {"type":"text","value":"hi"}]}"#,
        )
        .unwrap();
        assert_eq!(b.keys.len(), 5);
        assert_eq!(b.keys[1], MacroAction::Tap { key: "KC_C".into() });
        assert_eq!(b.keys[3], MacroAction::Delay { ms: 30 });
        assert_eq!(b.keys[4], MacroAction::Text { value: "hi".into() });
    }

    /// Bindings written before keystroke macros existed carry no `keys` field
    /// at all, and must still load as the shell bindings they are.
    #[test]
    fn a_binding_without_keys_still_deserializes() {
        let b: HostBinding =
            serde_json::from_str(r#"{"index":0,"label":"x","script":"echo hi","cwd":null}"#)
                .unwrap();
        assert!(b.keys.is_empty());
    }

    /// The other two payloads the frontend sends that carry named fields.
    #[test]
    fn frontend_anim_and_palette_payloads_deserialize() {
        let ug: UnderglowAnim =
            serde_json::from_str(r#"{"name":"breathe","speed":128,"intensity":180}"#).unwrap();
        assert_eq!(ug.name, "breathe");

        let pal: Palette =
            serde_json::from_str(r#"{"colors":[[255,0,0],[0,255,0]],"rate":200}"#).unwrap();
        assert_eq!(pal.colors.len(), 2);
        assert_eq!(pal.rate, 200);

        let leds: LedState = serde_json::from_str(
            r#"{"keys":[[1,2,3]],"underglow":[[4,5,6]],"brightness":255}"#,
        )
        .unwrap();
        assert_eq!(leds.brightness, 255);
    }
}

/// One step of a keystroke macro, in the same shape the macro library stores
/// and the `keyfigurator.macro-library` v1 export format carries — so a macro
/// recorded in the editor reaches the runner without a translation layer.
///
/// `key` holds a QMK keycode NAME (`KC_LCTL`), not a keycode number: that is
/// what the recorder produces and what the editor's text form reads back.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum MacroAction {
    /// Press and release.
    Tap { key: String },
    /// Hold, without releasing.
    Down { key: String },
    Up { key: String },
    Delay { ms: u32 },
    /// Type a literal string. Sent as text rather than as keycodes, so it does
    /// not depend on the host's keyboard layout.
    Text { value: String },
}

/// A host-side action bound to a HOST(n) key. When the board sends a
/// RunHostCmd Raw HID packet with index n, the app performs this.
///
/// Three shapes, checked in this order: recorded `keys`, a shell `script`, or a
/// `command` list. The frontend only ever writes one of them for a given
/// binding — a macro is either keystrokes or a script, never both — but the
/// order is fixed here so a binding edited from one kind to the other cannot
/// keep silently doing the old thing.
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
    /// A recorded keystroke macro, replayed on the HOST rather than by the
    /// board's macro engine. Takes precedence over both fields above.
    ///
    /// The board cannot be given macro content over this protocol (that needs
    /// VIA's un-magicked `dynamic_keymap_macro_*` buffer), so keystroke macros
    /// ride the same index-only channel shell macros already do: the board
    /// sends n, the host performs the keys. The security property is unchanged
    /// — content never crosses the wire in either direction.
    #[serde(default)]
    pub keys: Vec<MacroAction>,
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
