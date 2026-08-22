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
    /// Connection Screens, at most `MAX_CHAT_SCREENS` of them.
    ///
    /// Absent from every payload written before chat existed, so it defaults
    /// rather than failing the whole `oled_push` — the trap that made Save to
    /// Board silently do nothing after the pomodoro reshape.
    #[serde(default)]
    pub chats: Vec<ChatScreen>,
}

/// One message in a room, as the frontend hands it over.
///
/// Deliberately not the frontend's whole record: no sender name, no timestamp.
/// A 128px panel showing 20 characters a line cannot spend any of them on
/// either, and `mine` is the only distinction it draws.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatMessage {
    /// Written from this app rather than received from the peer.
    #[serde(default)]
    pub mine: bool,
    pub text: String,
}

/// One Connection Screen's contents.
///
/// The room's NAME is not here: it is the screen's title and travels through
/// `OLED_SET_TEXT` like every other screen's, so there is no second path for it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatScreen {
    /// The app's fixed slot space: 4 layer screens, then custom screens.
    pub slot: u8,
    /// Newest last. More than the board can show is fine and expected — the
    /// tail is what gets sent.
    #[serde(default)]
    pub messages: Vec<ChatMessage>,
    #[serde(default)]
    pub unread: u8,
    #[serde(default)]
    pub led_ping: bool,
}

/// Fold one character to something the board's 5x7 font can draw (ASCII
/// 32..126).
///
/// The board cannot do this: a Unicode table is far more than this firmware has
/// room for, and the app already holds the string. Same division of labour as
/// Present Keys' labels and the key icons.
///
/// Returns `None` for a character with no sensible ASCII stand-in, which is
/// most of what makes a Telegram message interesting — emoji above all.
fn fold_char(c: char) -> Option<&'static str> {
    Some(match c {
        // Smart punctuation, which Telegram clients insert on their own.
        '\u{2018}' | '\u{2019}' | '\u{201B}' => "'",
        '\u{201C}' | '\u{201D}' | '\u{201F}' => "\"",
        '\u{2013}' | '\u{2014}' | '\u{2212}' => "-",
        '\u{2026}' => "...",
        '\u{00A0}' | '\u{2007}' | '\u{202F}' => " ",
        '\u{2022}' => "*",
        // Latin-1 letters, so a Danish or German name is readable rather than
        // blanked. Not a full transliteration table, just the common ones.
        'æ' => "ae", 'Æ' => "AE",
        'ø' => "oe", 'Ø' => "OE",
        'å' => "aa", 'Å' => "AA",
        'ä' => "ae", 'Ä' => "AE",
        'ö' => "oe", 'Ö' => "OE",
        'ü' => "ue", 'Ü' => "UE",
        'ß' => "ss",
        'é' | 'è' | 'ê' | 'ë' => "e",
        'á' | 'à' | 'â' => "a",
        'í' | 'ì' | 'î' | 'ï' => "i",
        'ó' | 'ò' | 'ô' => "o",
        'ú' | 'ù' | 'û' => "u",
        'ñ' => "n",
        'ç' => "c",
        // Whitespace the font has no glyph for. A NEWLINE has to land here
        // too, not in the catch-all: it sorts below ' ' so it was being
        // DROPPED, and dropping it glues the lines either side of it into
        // one word - a two-line Telegram message arrived on the panel as
        // "helloworld". Collapsing to a space is what split_whitespace
        // below then folds away, so a break costs nothing when it is not
        // needed and does not destroy a word when it is.
        '\t' | '\n' | '\r' => " ",
        c if (' '..='~').contains(&c) => return Some(leak_ascii(c)),
        _ => return None,
    })
}

/// `fold_char` needs to return `&'static str` for the multi-character cases, and
/// a plain ASCII character has to come back the same way. The 95 printable
/// ASCII characters are a fixed, tiny set, so they live in a table.
fn leak_ascii(c: char) -> &'static str {
    const ASCII: &str =
        " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~";
    let i = c as usize - 0x20;
    &ASCII[i..i + 1]
}

/// Fold a whole message to ASCII the panel can draw.
///
/// A message that folds away to nothing becomes `[?]` rather than vanishing: a
/// message you cannot read is a different thing from no message, and an
/// emoji-only reply is common enough that silence would look like a bug.
pub fn fold_to_ascii(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut dropped = false;
    for c in text.chars() {
        match fold_char(c) {
            Some(s) => out.push_str(s),
            None => dropped = true,
        }
    }
    // Collapse the gaps dropped characters leave behind, so "hi 👋 there" does
    // not arrive as "hi  there".
    let collapsed = out.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() && (dropped || !text.is_empty()) {
        return "[?]".into();
    }
    collapsed
}

/// Break already-folded text into lines of at most `width` characters, keeping
/// words whole where they fit.
///
/// A word longer than a line (a URL, most often) is hard-split rather than
/// allowed to overflow — the board does no wrapping of its own and would simply
/// draw off the edge of the panel.
pub fn wrap_ascii(text: &str, width: usize) -> Vec<String> {
    let mut lines = Vec::new();
    let mut line = String::new();
    for word in text.split_whitespace() {
        let mut word = word;
        // Long word: fill the current line, then take whole lines out of it.
        while word.len() > width {
            if !line.is_empty() {
                lines.push(std::mem::take(&mut line));
            }
            let (head, tail) = word.split_at(width);
            lines.push(head.to_string());
            word = tail;
        }
        if word.is_empty() {
            continue;
        }
        if line.is_empty() {
            line.push_str(word);
        } else if line.len() + 1 + word.len() <= width {
            line.push(' ');
            line.push_str(word);
        } else {
            lines.push(std::mem::replace(&mut line, word.to_string()));
        }
    }
    if !line.is_empty() {
        lines.push(line);
    }
    lines
}

impl ChatScreen {
    /// The exact lines the board should hold: folded, wrapped, and cut to the
    /// newest `max_lines`.
    ///
    /// Newest-last, and the cut is taken **after** wrapping rather than before.
    /// Trimming to the last N messages first would be wrong whenever one of them
    /// wraps: eight one-line messages and one nine-line message both fill the
    /// panel, and only counting lines knows that.
    pub fn lines(&self, width: usize, max_lines: usize) -> Vec<(bool, String)> {
        let mut all: Vec<(bool, String)> = Vec::new();
        // Only the tail can possibly survive the cut, so fold at most enough
        // messages to fill the panel even if every one of them is a single line.
        let start = self.messages.len().saturating_sub(max_lines);
        for m in &self.messages[start..] {
            for line in wrap_ascii(&fold_to_ascii(&m.text), width) {
                all.push((m.mine, line));
            }
        }
        if all.len() > max_lines {
            all.drain(..all.len() - max_lines);
        }
        all
    }
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
mod chat_tests {
    use super::*;

    const W: usize = 20; // kf_protocol::CHAT_LINE_MAX
    const N: usize = 8;  // kf_protocol::CHAT_LINES

    fn screen(msgs: &[(bool, &str)]) -> ChatScreen {
        ChatScreen {
            slot: 4,
            messages: msgs
                .iter()
                .map(|(mine, t)| ChatMessage { mine: *mine, text: (*t).into() })
                .collect(),
            unread: 0,
            led_ping: false,
        }
    }

    // ── folding to what the panel can draw ──────────────────────────────────

    #[test]
    fn plain_ascii_is_untouched() {
        assert_eq!(fold_to_ascii("meet at 7? bring the KEY!"), "meet at 7? bring the KEY!");
    }

    /// Telegram clients insert these on their own, so they arrive constantly.
    #[test]
    fn smart_punctuation_folds_to_its_ascii_original() {
        assert_eq!(fold_to_ascii("\u{201C}it\u{2019}s fine\u{201D}"), "\"it's fine\"");
        assert_eq!(fold_to_ascii("wait\u{2026}"), "wait...");
        assert_eq!(fold_to_ascii("a \u{2014} b"), "a - b");
    }

    #[test]
    fn accented_names_stay_readable() {
        assert_eq!(fold_to_ascii("Søren"), "Soeren");
        // A newline separates, it does not vanish: dropping it ran the
        // words either side together.
        assert_eq!(fold_to_ascii("hello\nworld"), "hello world");
        assert_eq!(fold_to_ascii("a\r\nb"), "a b");
        assert_eq!(fold_to_ascii("café"), "cafe");
        assert_eq!(fold_to_ascii("Müller"), "Mueller");
    }

    /// Every byte must be something the board's 5x7 font (32..126) can draw.
    #[test]
    fn nothing_outside_the_fonts_range_survives() {
        for s in ["hej 👋", "→ go", "Sören’s café… 🎉", "日本語"] {
            let folded = fold_to_ascii(s);
            assert!(
                folded.bytes().all(|b| (0x20..=0x7E).contains(&b)),
                "{s:?} folded to {folded:?}, which the font cannot draw"
            );
        }
    }

    /// An emoji-only reply is common. Silence would read as a bug, so it has to
    /// arrive as *something*.
    #[test]
    fn a_message_that_folds_away_is_still_visible() {
        assert_eq!(fold_to_ascii("👍"), "[?]");
        assert_eq!(fold_to_ascii("🎉🎉🎉"), "[?]");
    }

    #[test]
    fn gaps_left_by_dropped_characters_are_closed_up() {
        assert_eq!(fold_to_ascii("hi 👋 there"), "hi there");
    }

    // ── wrapping ────────────────────────────────────────────────────────────

    #[test]
    fn words_are_kept_whole_where_they_fit() {
        assert_eq!(
            wrap_ascii("the quick brown fox jumps over it", W),
            vec!["the quick brown fox", "jumps over it"]
        );
        for line in wrap_ascii("the quick brown fox jumps over it", W) {
            assert!(line.len() <= W);
        }
    }

    /// The board does no wrapping, so a URL that does not fit would be drawn
    /// straight off the edge of the panel.
    #[test]
    fn a_word_longer_than_a_line_is_split_rather_than_overflowing() {
        let lines = wrap_ascii("see https://example.com/a/very/long/path/indeed now", W);
        assert!(lines.iter().all(|l| l.len() <= W), "{lines:?}");
        assert!(lines.concat().contains("example.com"));
    }

    #[test]
    fn wrapping_nothing_produces_no_lines() {
        assert!(wrap_ascii("", W).is_empty());
        assert!(wrap_ascii("   ", W).is_empty());
    }

    // ── what the board ends up holding ──────────────────────────────────────

    #[test]
    fn lines_are_ordered_oldest_first_and_carry_their_origin() {
        let s = screen(&[(false, "you at the desk"), (true, "yep")]);
        assert_eq!(
            s.lines(W, N),
            vec![(false, "you at the desk".to_string()), (true, "yep".to_string())]
        );
    }

    #[test]
    fn a_long_message_becomes_at_most_a_panel_of_lines() {
        let s = screen(&[(false, &"word ".repeat(60))]);
        let lines = s.lines(W, N);
        assert_eq!(lines.len(), N);
        assert!(lines.iter().all(|(_, l)| l.len() <= W));
    }

    /// The cut has to happen AFTER wrapping. Keeping the last N *messages* would
    /// overflow the panel the moment one of them wraps.
    #[test]
    fn the_newest_lines_win_not_the_newest_messages() {
        // One message that wraps to ten lines, then a short one. Two messages,
        // eleven lines: trimming to the last N *messages* would keep them all
        // and overflow the panel, so only counting lines gets this right.
        let long = format!("ALPHA {}", "word ".repeat(40));
        let s = screen(&[(false, &long), (true, "last")]);

        let lines = s.lines(W, N);
        assert_eq!(lines.len(), N, "{lines:?}");
        assert_eq!(lines.last().unwrap(), &(true, "last".to_string()));
        // The oldest lines fell off the top rather than the newest message.
        assert!(!lines.iter().any(|(_, l)| l.contains("ALPHA")), "{lines:?}");
    }

    #[test]
    fn an_empty_room_has_no_lines() {
        assert!(screen(&[]).lines(W, N).is_empty());
    }

    // ── payload compatibility ───────────────────────────────────────────────

    /// Every config saved before chat existed. A missing field must default,
    /// not fail the whole `oled_push` — that is exactly how a pomodoro reshape
    /// once made Save to Board silently do nothing.
    #[test]
    fn a_config_written_before_chat_existed_still_parses() {
        let cfg: OledConfig = serde_json::from_str(
            r#"{"layers":[],"screens":[],"countdown":[0,0,0]}"#,
        )
        .expect("older payloads must still load");
        assert!(cfg.chats.is_empty());
    }

    /// Literal frontend JSON, camelCase and all, parsed at the boundary the
    /// real payload crosses.
    #[test]
    fn frontend_chat_json_parses() {
        let cfg: OledConfig = serde_json::from_str(
            r#"{"layers":[],"screens":[],"countdown":[0,0,0],
                "chats":[{"slot":4,"unread":2,"led_ping":true,
                          "messages":[{"mine":false,"text":"hi"},
                                      {"mine":true,"text":"hello"}]}]}"#,
        )
        .expect("the frontend's own shape must parse");
        assert_eq!(cfg.chats.len(), 1);
        assert_eq!(cfg.chats[0].slot, 4);
        assert_eq!(cfg.chats[0].unread, 2);
        assert!(cfg.chats[0].led_ping);
        assert_eq!(cfg.chats[0].messages[1], ChatMessage { mine: true, text: "hello".into() });
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
