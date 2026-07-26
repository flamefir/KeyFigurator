//! KeyFigurator Raw HID protocol — the byte-accurate mirror of the firmware's
//! `keyboards/macro_pad_pro/kf_hid.h` / `kf_hid.c`.
//!
//! This module is the SINGLE SOURCE OF TRUTH for the wire format on the app
//! side. Both `MockHid` (a software model of the board) and `RealHid` (hidapi)
//! build and parse frames through here, so "mock behaves like firmware" is
//! guaranteed by shared code rather than by hand. `BoardModel` + [`handle`] are
//! a direct port of `kf_hid_handle()`; the mock simply owns a `BoardModel`.
//!
//! Keep the constants below in lockstep with `kf_hid.h`. The tests at the bottom
//! pin the values and byte layouts, so a firmware change that isn't mirrored
//! here breaks `cargo test`.

// ---------------------------------------------------------------------------
// Constants — mirror kf_hid.h / config.h / keyboard.json
// ---------------------------------------------------------------------------

/// Every KeyFigurator report is framed behind this magic byte so it can never
/// collide with VIA (0x01..0x1D) / Vial (0xFE) command ids on the shared Raw
/// HID interface.
pub const KF_MAGIC: u8 = 0xC0;

/// Fixed QMK Raw HID report size.
pub const REPORT_LEN: usize = 32;

pub const PROTOCOL_VERSION: u8 = 1;

/// 20 keys + encoder push at index 20 (KeyFigurator index space, == BOARD_POSITIONS).
pub const KEY_COUNT: usize = 21;
/// 21 per-key LEDs + 4 underglow corners.
pub const LED_COUNT: usize = 25;
pub const UNDERGLOW_COUNT: usize = 4;
pub const LAYER_COUNT: usize = 4;

/// Max keycodes carried in one GET/SET_KEYMAP frame.
pub const KEYMAP_CHUNK_MAX: usize = 13;
/// Max (r,g,b) triples carried in one SET_LEDS data frame.
pub const LED_CHUNK_MAX: usize = 9;

// USB identity + Raw HID usage (kf_hid.h + keyboard.json `usb`).
pub const VENDOR_ID: u16 = 0xFEED;
pub const PRODUCT_ID: u16 = 0x4D50; // "MP"
pub const USAGE_PAGE: u16 = 0xFF60;
pub const USAGE: u16 = 0x61;

// Commands (host -> board unless noted).
pub const CMD_PING: u8 = 0x01;
pub const CMD_GET_KEYMAP: u8 = 0x10;
pub const CMD_SET_KEYMAP: u8 = 0x11;
pub const CMD_SET_LEDS: u8 = 0x20;
pub const CMD_RUN_HOST_CMD: u8 = 0x30; // board -> host, unsolicited: [index]
pub const CMD_EEPROM_COMMIT: u8 = 0x40;
pub const CMD_OLED_SET_LAYER: u8 = 0x50;
pub const CMD_OLED_SET_SCREENS: u8 = 0x51;
pub const CMD_OLED_SET_TEXT: u8 = 0x52;
pub const CMD_OLED_SET_COUNTDOWN: u8 = 0x53;
pub const CMD_OLED_SYNC_TIME: u8 = 0x54;

// SET_LEDS control-frame selectors (first payload byte).
pub const LED_BRIGHTNESS: u8 = 0xF0;
pub const LED_OVERLAY_OFF: u8 = 0xF1;
pub const LED_OVERLAY_ON: u8 = 0xF2;

pub const STATUS_OK: u8 = 0x00;
pub const STATUS_ERROR: u8 = 0x01;

/// HOST(n) custom keycodes: HOST_0 = QK_KB_0 .. HOST_15 = QK_KB_15.
pub const QK_KB_0: u16 = 0x7E00;
pub const HOST_CMD_COUNT: u8 = 16;

// OLED limits (kf_hid.h).
pub const OLED_MAX_CUSTOM_SCREENS: usize = 6;
pub const OLED_LAYER_NAME_MAX: usize = 16;
pub const OLED_CUSTOM_TITLE_MAX: usize = 14;
pub const OLED_BODY_MAX: usize = 48;

/// `enum kf_screen_type` in kf_hid.h.
pub const SCREEN_TIMER: u8 = 1;
pub const SCREEN_COUNTDOWN: u8 = 2;
pub const SCREEN_DATETIME: u8 = 3;
pub const SCREEN_CUSTOM_TEXT: u8 = 4;

// ---------------------------------------------------------------------------
// Frame construction
// ---------------------------------------------------------------------------

/// Build a 32-byte report: `[KF_MAGIC, cmd, payload…, 0…]`.
pub fn frame(cmd: u8, payload: &[u8]) -> [u8; REPORT_LEN] {
    let mut r = [0u8; REPORT_LEN];
    r[0] = KF_MAGIC;
    r[1] = cmd;
    let n = payload.len().min(REPORT_LEN - 2);
    r[2..2 + n].copy_from_slice(&payload[..n]);
    r
}

/// SET_KEYMAP frames for one layer's keycodes, chunked to `KEYMAP_CHUNK_MAX`.
/// `keycodes` is the full 0..KEY_COUNT list; keycodes are u16 little-endian.
pub fn set_keymap_frames(layer: u8, keycodes: &[u16]) -> Vec<[u8; REPORT_LEN]> {
    keycodes
        .chunks(KEYMAP_CHUNK_MAX)
        .enumerate()
        .map(|(ci, chunk)| {
            let offset = (ci * KEYMAP_CHUNK_MAX) as u8;
            let mut p = Vec::with_capacity(3 + chunk.len() * 2);
            p.push(layer);
            p.push(offset);
            p.push(chunk.len() as u8);
            for &kc in chunk {
                p.push((kc & 0xFF) as u8);
                p.push((kc >> 8) as u8);
            }
            frame(CMD_SET_KEYMAP, &p)
        })
        .collect()
}

/// GET_KEYMAP request frames covering the whole 0..KEY_COUNT range for a layer.
pub fn get_keymap_frames(layer: u8) -> Vec<[u8; REPORT_LEN]> {
    let mut frames = Vec::new();
    let mut offset = 0usize;
    while offset < KEY_COUNT {
        let count = (KEY_COUNT - offset).min(KEYMAP_CHUNK_MAX);
        frames.push(frame(CMD_GET_KEYMAP, &[layer, offset as u8, count as u8]));
        offset += count;
    }
    frames
}

/// SET_LEDS colour-data frames for the full 0..LED_COUNT slot list.
pub fn set_led_color_frames(colors: &[[u8; 3]]) -> Vec<[u8; REPORT_LEN]> {
    colors
        .chunks(LED_CHUNK_MAX)
        .enumerate()
        .map(|(ci, chunk)| {
            let offset = (ci * LED_CHUNK_MAX) as u8;
            let mut p = Vec::with_capacity(2 + chunk.len() * 3);
            p.push(offset);
            p.push(chunk.len() as u8);
            for c in chunk {
                p.extend_from_slice(c);
            }
            frame(CMD_SET_LEDS, &p)
        })
        .collect()
}

pub fn brightness_frame(brightness: u8) -> [u8; REPORT_LEN] {
    frame(CMD_SET_LEDS, &[LED_BRIGHTNESS, brightness])
}

pub fn overlay_frame(on: bool) -> [u8; REPORT_LEN] {
    frame(
        CMD_SET_LEDS,
        &[if on { LED_OVERLAY_ON } else { LED_OVERLAY_OFF }],
    )
}

pub fn eeprom_commit_frame() -> [u8; REPORT_LEN] {
    frame(CMD_EEPROM_COMMIT, &[])
}

pub fn ping_frame() -> [u8; REPORT_LEN] {
    frame(CMD_PING, &[])
}

pub fn oled_set_layer_frame(layer: u8, show_title: bool, name: &str) -> [u8; REPORT_LEN] {
    let bytes = name.as_bytes();
    let len = bytes.len().min(OLED_LAYER_NAME_MAX);
    let mut p = Vec::with_capacity(3 + len);
    p.push(layer);
    p.push(show_title as u8);
    p.push(len as u8);
    p.extend_from_slice(&bytes[..len]);
    frame(CMD_OLED_SET_LAYER, &p)
}

pub fn oled_set_screens_frame(types: &[u8]) -> [u8; REPORT_LEN] {
    let count = types.len().min(OLED_MAX_CUSTOM_SCREENS);
    let mut p = Vec::with_capacity(1 + count);
    p.push(count as u8);
    p.extend_from_slice(&types[..count]);
    frame(CMD_OLED_SET_SCREENS, &p)
}

/// OLED_SET_TEXT frames for one slot/field, chunked (title max 14, body max 48).
/// `field`: 0 = title, 1 = body.
pub fn oled_set_text_frames(slot: u8, field: u8, text: &str) -> Vec<[u8; REPORT_LEN]> {
    let max = if field == 0 { OLED_CUSTOM_TITLE_MAX } else { OLED_BODY_MAX };
    let bytes = &text.as_bytes()[..text.len().min(max)];
    if bytes.is_empty() {
        return vec![frame(CMD_OLED_SET_TEXT, &[slot, field, 0, 0])];
    }
    // Payload room per frame = REPORT_LEN - 2 (magic+cmd) - 4 (slot,field,offset,len).
    const CHUNK: usize = REPORT_LEN - 2 - 4;
    bytes
        .chunks(CHUNK)
        .enumerate()
        .map(|(ci, chunk)| {
            let offset = (ci * CHUNK) as u8;
            let mut p = Vec::with_capacity(4 + chunk.len());
            p.push(slot);
            p.push(field);
            p.push(offset);
            p.push(chunk.len() as u8);
            p.extend_from_slice(chunk);
            frame(CMD_OLED_SET_TEXT, &p)
        })
        .collect()
}

pub fn oled_set_countdown_frame(h: u8, m: u8, s: u8) -> [u8; REPORT_LEN] {
    frame(CMD_OLED_SET_COUNTDOWN, &[h, m, s])
}

pub fn oled_sync_time_frame(
    year_2000: u8,
    month: u8,
    day: u8,
    hour: u8,
    min: u8,
    sec: u8,
    weekday: u8,
) -> [u8; REPORT_LEN] {
    frame(
        CMD_OLED_SYNC_TIME,
        &[year_2000, month, day, hour, min, sec, weekday],
    )
}

// ---------------------------------------------------------------------------
// Keycode codec — string <-> u16, bounded to the palette the app exposes plus
// the parametric layer/host forms. Exotic keycodes fall through to a hex
// string (round-trips numerically, never silently wrong). Values are taken
// from the firmware's own quantum/keycodes.h so the two stay in sync.
// ---------------------------------------------------------------------------

/// Parametric layer / host keycodes, e.g. `MO(1)`, `HOST(3)`.
fn parse_parametric(name: &str) -> Option<u16> {
    const BASES: &[(&str, u16)] = &[
        ("HOST", QK_KB_0),
        ("MO", 0x5220),
        ("TO", 0x5200),
        ("TG", 0x5260),
        ("DF", 0x5240),
        ("OSL", 0x5280),
    ];
    for &(kw, base) in BASES {
        if let Some(inner) = name
            .strip_prefix(kw)
            .and_then(|s| s.strip_prefix('('))
            .and_then(|s| s.strip_suffix(')'))
        {
            if let Ok(n) = inner.trim().parse::<u16>() {
                return Some(base.wrapping_add(n));
            }
        }
    }
    None
}

fn format_parametric(kc: u16) -> Option<String> {
    Some(match kc {
        0x7E00..=0x7E0F => format!("HOST({})", kc - QK_KB_0),
        0x5220..=0x523F => format!("MO({})", kc - 0x5220),
        0x5200..=0x521F => format!("TO({})", kc - 0x5200),
        0x5260..=0x527F => format!("TG({})", kc - 0x5260),
        0x5240..=0x525F => format!("DF({})", kc - 0x5240),
        0x5280..=0x529F => format!("OSL({})", kc - 0x5280),
        _ => return None,
    })
}

/// Named keycodes the palette / default keymap use. The app's preferred short
/// name is listed first for each value so the reverse lookup produces it.
const KEYCODES: &[(&str, u16)] = &[
    // internal
    ("KC_NO", 0x0000),
    ("KC_TRNS", 0x0001),
    // letters
    ("KC_A", 0x0004), ("KC_B", 0x0005), ("KC_C", 0x0006), ("KC_D", 0x0007),
    ("KC_E", 0x0008), ("KC_F", 0x0009), ("KC_G", 0x000A), ("KC_H", 0x000B),
    ("KC_I", 0x000C), ("KC_J", 0x000D), ("KC_K", 0x000E), ("KC_L", 0x000F),
    ("KC_M", 0x0010), ("KC_N", 0x0011), ("KC_O", 0x0012), ("KC_P", 0x0013),
    ("KC_Q", 0x0014), ("KC_R", 0x0015), ("KC_S", 0x0016), ("KC_T", 0x0017),
    ("KC_U", 0x0018), ("KC_V", 0x0019), ("KC_W", 0x001A), ("KC_X", 0x001B),
    ("KC_Y", 0x001C), ("KC_Z", 0x001D),
    // numbers
    ("KC_1", 0x001E), ("KC_2", 0x001F), ("KC_3", 0x0020), ("KC_4", 0x0021),
    ("KC_5", 0x0022), ("KC_6", 0x0023), ("KC_7", 0x0024), ("KC_8", 0x0025),
    ("KC_9", 0x0026), ("KC_0", 0x0027),
    // nav / editing (palette-preferred short names)
    ("KC_ENTER", 0x0028), ("KC_ESC", 0x0029), ("KC_BSPC", 0x002A), ("KC_TAB", 0x002B),
    ("KC_SPACE", 0x002C),
    // symbols
    ("KC_MINS", 0x002D), ("KC_EQL", 0x002E), ("KC_LBRC", 0x002F), ("KC_RBRC", 0x0030),
    ("KC_BSLS", 0x0031), ("KC_SCLN", 0x0033), ("KC_QUOT", 0x0034), ("KC_GRV", 0x0035),
    ("KC_COMM", 0x0036), ("KC_DOT", 0x0037), ("KC_SLSH", 0x0038),
    // misc / locks
    ("KC_CAPS", 0x0039),
    // F-keys
    ("KC_F1", 0x003A), ("KC_F2", 0x003B), ("KC_F3", 0x003C), ("KC_F4", 0x003D),
    ("KC_F5", 0x003E), ("KC_F6", 0x003F), ("KC_F7", 0x0040), ("KC_F8", 0x0041),
    ("KC_F9", 0x0042), ("KC_F10", 0x0043), ("KC_F11", 0x0044), ("KC_F12", 0x0045),
    ("KC_PSCR", 0x0046), ("KC_SLCK", 0x0047), ("KC_PAUS", 0x0048),
    ("KC_INS", 0x0049), ("KC_HOME", 0x004A), ("KC_PGUP", 0x004B), ("KC_DEL", 0x004C),
    ("KC_END", 0x004D), ("KC_PGDN", 0x004E),
    ("KC_RIGHT", 0x004F), ("KC_LEFT", 0x0050), ("KC_DOWN", 0x0051), ("KC_UP", 0x0052),
    ("KC_NLCK", 0x0053),
    // keypad (default keymap)
    ("KC_PSLS", 0x0054), ("KC_PAST", 0x0055), ("KC_PMNS", 0x0056), ("KC_PPLS", 0x0057),
    ("KC_PENT", 0x0058), ("KC_P1", 0x0059), ("KC_P2", 0x005A), ("KC_P3", 0x005B),
    ("KC_P4", 0x005C), ("KC_P5", 0x005D), ("KC_P6", 0x005E), ("KC_P7", 0x005F),
    ("KC_P8", 0x0060), ("KC_P9", 0x0061), ("KC_P0", 0x0062), ("KC_PDOT", 0x0063),
    ("KC_APP", 0x0065),
    // media / audio
    ("KC_MUTE", 0x00A8), ("KC_VOLU", 0x00A9), ("KC_VOLD", 0x00AA),
    ("KC_MNXT", 0x00AB), ("KC_MPRV", 0x00AC), ("KC_MSTP", 0x00AD), ("KC_MPLY", 0x00AE),
    ("KC_BRIU", 0x00BD), ("KC_BRID", 0x00BE),
    // modifiers
    ("KC_LCTL", 0x00E0), ("KC_LSFT", 0x00E1), ("KC_LALT", 0x00E2), ("KC_LGUI", 0x00E3),
    ("KC_RCTL", 0x00E4), ("KC_RSFT", 0x00E5), ("KC_RALT", 0x00E6), ("KC_RGUI", 0x00E7),
    ("KC_MEH", 0x0700), ("KC_HYPR", 0x0F00),
    // quantum
    ("QK_BOOT", 0x7C00),
    // ---- input-only aliases (never chosen by reverse lookup) ----
    ("KC_TRANSPARENT", 0x0001), ("_______", 0x0001),
    ("KC_ENT", 0x0028), ("KC_SPC", 0x002C), ("KC_RGHT", 0x004F),
    ("RESET", 0x7C00),
];

/// One lookup pass over the parametric forms, the hex escape hatch, and the
/// name table. Exact string match — casing/prefix healing happens in the caller.
fn lookup_exact(name: &str) -> Option<u16> {
    if let Some(v) = parse_parametric(name) {
        return Some(v);
    }
    if let Some(hex) = name.strip_prefix("0x").or_else(|| name.strip_prefix("0X")) {
        return u16::from_str_radix(hex, 16).ok();
    }
    KEYCODES.iter().find(|(n, _)| *n == name).map(|&(_, v)| v)
}

/// Convert a keycode string to its u16 wire value. Returns `None` for names
/// outside the supported subset (caller logs + substitutes KC_NO).
///
/// Tolerant by design: the UI, older saved profiles and imported layer files all
/// carry hand-written keycodes, so a bare or lower-case name (`"a"`, `"ENTER"`,
/// `"5"`) is healed to its `KC_*` form rather than silently becoming KC_NO. A
/// name that already carries a prefix is NOT re-prefixed, so genuine typos
/// (`"KC_NONSENSE"`) still fail loudly.
pub fn keycode_to_u16(name: &str) -> Option<u16> {
    let raw = name.trim();
    if raw.is_empty() {
        return Some(0); // KC_NO
    }
    // Exact match first: the table's own spelling always wins.
    if let Some(v) = lookup_exact(raw) {
        return Some(v);
    }
    let up = raw.to_ascii_uppercase();
    if up != raw {
        if let Some(v) = lookup_exact(&up) {
            return Some(v);
        }
    }
    // Bare name: try the KC_ namespace it almost certainly meant.
    if !up.contains('(') && !up.starts_with("KC_") {
        if let Some(v) = lookup_exact(&format!("KC_{up}")) {
            return Some(v);
        }
    }
    None
}

/// Convert a u16 wire value back to a keycode string. Falls back to `0xXXXX`.
pub fn keycode_from_u16(kc: u16) -> String {
    if let Some(s) = format_parametric(kc) {
        return s;
    }
    KEYCODES
        .iter()
        .find(|(_, v)| *v == kc)
        .map(|&(n, _)| n.to_string())
        .unwrap_or_else(|| format!("0x{:04X}", kc))
}

// ---------------------------------------------------------------------------
// BoardModel — a software model of the keyboard, a direct port of the state +
// handler in kf_hid.c. The mock owns one of these; `handle` applies a frame and
// returns the response, exactly like `kf_hid_handle`.
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct BoardModel {
    pub keymap: [[u16; KEY_COUNT]; LAYER_COUNT],
    pub rgb: [[u8; 3]; LED_COUNT],
    pub brightness: u8,
    pub overlay_on: bool,
    /// Last-committed snapshot (EEPROM). Purely to model persistence.
    pub committed: Option<([[u8; 3]; LED_COUNT], u8, bool)>,
    // OLED state (push-only; recorded so tests can assert it was received).
    pub oled_layer_names: [String; LAYER_COUNT],
    pub oled_show_title: [bool; LAYER_COUNT],
    pub oled_screen_types: Vec<u8>,
    pub oled_countdown: (u8, u8, u8),
}

impl Default for BoardModel {
    fn default() -> Self {
        Self {
            keymap: [[0u16; KEY_COUNT]; LAYER_COUNT],
            rgb: [[0u8; 3]; LED_COUNT],
            brightness: 255,
            overlay_on: false,
            committed: None,
            oled_layer_names: Default::default(),
            oled_show_title: [true; LAYER_COUNT],
            oled_screen_types: Vec::new(),
            oled_countdown: (0, 0, 0),
        }
    }
}

impl BoardModel {
    /// Apply one 32-byte report and return the 32-byte response. Mirrors
    /// `kf_hid_handle`: returns `None` if the report is not a KeyFigurator frame.
    pub fn handle(&mut self, input: &[u8]) -> Option<[u8; REPORT_LEN]> {
        if input.len() < 2 || input[0] != KF_MAGIC {
            return None;
        }
        let cmd = input[1];
        let p = &input[2..];
        let mut out = [0u8; REPORT_LEN];
        out[0] = KF_MAGIC;
        out[1] = cmd;
        let r = &mut out[2..];
        match cmd {
            CMD_PING => {
                r[0] = PROTOCOL_VERSION;
                r[1] = 0; // fw major (matches KF_FW_VERSION_MAJOR)
                r[2] = 1; // fw minor
            }
            CMD_GET_KEYMAP => {
                let (layer, offset, count) = (p[0], p[1], p[2]);
                if layer as usize >= LAYER_COUNT
                    || count as usize > KEYMAP_CHUNK_MAX
                    || (offset as usize + count as usize) > KEY_COUNT
                {
                    r[0] = 0;
                    r[1] = 0;
                    r[2] = STATUS_ERROR;
                } else {
                    r[0] = layer;
                    r[1] = offset;
                    r[2] = count;
                    for i in 0..count as usize {
                        let kc = self.keymap[layer as usize][offset as usize + i];
                        r[3 + i * 2] = (kc & 0xFF) as u8;
                        r[4 + i * 2] = (kc >> 8) as u8;
                    }
                }
            }
            CMD_SET_KEYMAP => {
                let (layer, offset, count) = (p[0], p[1], p[2]);
                if layer as usize >= LAYER_COUNT
                    || count as usize > KEYMAP_CHUNK_MAX
                    || (offset as usize + count as usize) > KEY_COUNT
                {
                    r[0] = STATUS_ERROR;
                } else {
                    for i in 0..count as usize {
                        let kc = p[3 + i * 2] as u16 | ((p[4 + i * 2] as u16) << 8);
                        self.keymap[layer as usize][offset as usize + i] = kc;
                    }
                    r[0] = STATUS_OK;
                }
            }
            CMD_SET_LEDS => {
                r[0] = self.apply_set_leds(p);
            }
            CMD_EEPROM_COMMIT => {
                self.committed = Some((self.rgb, self.brightness, self.overlay_on));
                r[0] = STATUS_OK;
            }
            CMD_OLED_SET_LAYER => {
                let (layer, show_title, len) = (p[0], p[1], p[2] as usize);
                if layer as usize >= LAYER_COUNT || len > OLED_LAYER_NAME_MAX {
                    r[0] = STATUS_ERROR;
                } else {
                    self.oled_layer_names[layer as usize] =
                        String::from_utf8_lossy(&p[3..3 + len]).into_owned();
                    self.oled_show_title[layer as usize] = show_title != 0;
                    r[0] = STATUS_OK;
                }
            }
            CMD_OLED_SET_SCREENS => {
                let count = p[0] as usize;
                if count > OLED_MAX_CUSTOM_SCREENS {
                    r[0] = STATUS_ERROR;
                } else {
                    self.oled_screen_types = p[1..1 + count].to_vec();
                    r[0] = STATUS_OK;
                }
            }
            CMD_OLED_SET_TEXT => {
                let (slot, field, offset, len) = (p[0], p[1], p[2] as usize, p[3] as usize);
                let max = if field == 0 { OLED_CUSTOM_TITLE_MAX } else { OLED_BODY_MAX };
                if slot as usize >= OLED_MAX_CUSTOM_SCREENS || field > 1 || offset + len > max {
                    r[0] = STATUS_ERROR;
                } else {
                    r[0] = STATUS_OK; // content recording omitted in the mock
                }
            }
            CMD_OLED_SET_COUNTDOWN => {
                self.oled_countdown = (p[0], p[1], p[2]);
                r[0] = STATUS_OK;
            }
            CMD_OLED_SYNC_TIME => {
                r[0] = STATUS_OK;
            }
            _ => {
                r[0] = STATUS_ERROR;
            }
        }
        Some(out)
    }

    fn apply_set_leds(&mut self, p: &[u8]) -> u8 {
        match p[0] {
            LED_BRIGHTNESS => {
                self.brightness = p[1];
                STATUS_OK
            }
            LED_OVERLAY_OFF => {
                self.overlay_on = false;
                STATUS_OK
            }
            LED_OVERLAY_ON => {
                self.overlay_on = true;
                STATUS_OK
            }
            _ => {
                let (offset, count) = (p[0] as usize, p[1] as usize);
                if count > LED_CHUNK_MAX || offset + count > LED_COUNT {
                    return STATUS_ERROR;
                }
                for i in 0..count {
                    self.rgb[offset + i] = [p[2 + i * 3], p[3 + i * 3], p[4 + i * 3]];
                }
                self.overlay_on = true;
                STATUS_OK
            }
        }
    }
}

/// Parse an inbound RUN_HOST_CMD frame -> binding index. `None` if it isn't one.
pub fn parse_run_host_cmd(report: &[u8]) -> Option<u8> {
    if report.len() >= 3 && report[0] == KF_MAGIC && report[1] == CMD_RUN_HOST_CMD {
        Some(report[2])
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// Tests — golden vectors pinned against kf_hid.h.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constants_match_firmware() {
        assert_eq!(KF_MAGIC, 0xC0);
        assert_eq!(REPORT_LEN, 32);
        assert_eq!((VENDOR_ID, PRODUCT_ID), (0xFEED, 0x4D50));
        assert_eq!((USAGE_PAGE, USAGE), (0xFF60, 0x61));
        assert_eq!((KEY_COUNT, LED_COUNT, UNDERGLOW_COUNT), (21, 25, 4));
        assert_eq!((KEYMAP_CHUNK_MAX, LED_CHUNK_MAX), (13, 9));
    }

    #[test]
    fn frame_has_magic_and_cmd() {
        let f = frame(CMD_PING, &[]);
        assert_eq!(f[0], 0xC0);
        assert_eq!(f[1], 0x01);
        assert_eq!(f.len(), 32);
    }

    #[test]
    fn keymap_chunks_and_u16_le() {
        let kcs: Vec<u16> = (0..KEY_COUNT as u16).collect();
        let frames = set_keymap_frames(2, &kcs);
        assert_eq!(frames.len(), 2); // 13 + 8
        // first frame: [C0,11, layer=2, offset=0, count=13, kc0_lo,kc0_hi,...]
        assert_eq!(&frames[0][0..5], &[0xC0, CMD_SET_KEYMAP, 2, 0, 13]);
        assert_eq!(frames[0][5], 0x00); // kc0 lo
        assert_eq!(frames[0][6], 0x00); // kc0 hi
        assert_eq!(&frames[1][0..5], &[0xC0, CMD_SET_KEYMAP, 2, 13, 8]);
    }

    #[test]
    fn led_color_chunks_and_control_frames() {
        let colors = [[1u8, 2, 3]; LED_COUNT];
        let frames = set_led_color_frames(&colors);
        assert_eq!(frames.len(), 3); // 9 + 9 + 7
        assert_eq!(&frames[0][0..4], &[0xC0, CMD_SET_LEDS, 0, 9]);
        assert_eq!(&frames[2][2..4], &[18, 7]); // offset 18, count 7 -> underglow last slots
        assert_eq!(&brightness_frame(200)[0..4], &[0xC0, CMD_SET_LEDS, LED_BRIGHTNESS, 200]);
        assert_eq!(&overlay_frame(true)[0..3], &[0xC0, CMD_SET_LEDS, LED_OVERLAY_ON]);
        assert_eq!(&overlay_frame(false)[0..3], &[0xC0, CMD_SET_LEDS, LED_OVERLAY_OFF]);
    }

    #[test]
    fn keycode_codec_roundtrips() {
        for (name, val) in [
            ("KC_A", 0x0004u16),
            ("KC_Z", 0x001D),
            ("KC_ENTER", 0x0028),
            ("KC_MPLY", 0x00AE),
            ("KC_LCTL", 0x00E0),
            ("KC_MEH", 0x0700),
            ("KC_HYPR", 0x0F00),
            ("QK_BOOT", 0x7C00),
            ("MO(1)", 0x5221),
            ("TO(0)", 0x5200),
            ("TG(2)", 0x5262),
            ("DF(1)", 0x5241),
            ("OSL(1)", 0x5281),
            ("HOST(3)", 0x7E03),
        ] {
            assert_eq!(keycode_to_u16(name), Some(val), "to_u16 {name}");
            assert_eq!(keycode_from_u16(val), name, "from_u16 {val:#06x}");
        }
    }

    #[test]
    fn keycode_aliases_and_unknowns() {
        assert_eq!(keycode_to_u16("KC_RGHT"), Some(0x004F));
        assert_eq!(keycode_to_u16("_______"), Some(0x0001));
        assert_eq!(keycode_to_u16("RESET"), Some(0x7C00));
        assert_eq!(keycode_to_u16("KC_NONSENSE"), None);
        // unknown value round-trips as hex, and back
        assert_eq!(keycode_from_u16(0x1234), "0x1234");
        assert_eq!(keycode_to_u16("0x1234"), Some(0x1234));
    }

    #[test]
    fn keycode_heals_bare_and_lowercase_names() {
        // Bare names (older saved profiles / imported layer files) used to land
        // on KC_NO and silently blank the key on the board.
        assert_eq!(keycode_to_u16("A"), Some(0x0004));
        assert_eq!(keycode_to_u16("a"), Some(0x0004));
        assert_eq!(keycode_to_u16("5"), Some(0x0022));
        assert_eq!(keycode_to_u16("ENTER"), Some(0x0028));
        assert_eq!(keycode_to_u16("esc"), Some(0x0029));
        assert_eq!(keycode_to_u16("f12"), Some(0x0045));
        assert_eq!(keycode_to_u16(" KC_TAB "), Some(0x002B));
        assert_eq!(keycode_to_u16("kc_lctl"), Some(0x00E0));
        assert_eq!(keycode_to_u16("host(2)"), Some(0x7E02));
        assert_eq!(keycode_to_u16("mo(1)"), Some(0x5221));
        assert_eq!(keycode_to_u16(""), Some(0x0000));
        // Real typos must still fail loudly rather than being re-prefixed.
        assert_eq!(keycode_to_u16("KC_NOPE"), None);
        assert_eq!(keycode_to_u16("NOPE"), None);
    }

    #[test]
    fn host_keycode_maps_to_qk_kb() {
        assert_eq!(keycode_to_u16("HOST(0)"), Some(QK_KB_0));
        assert_eq!(keycode_to_u16("HOST(15)"), Some(QK_KB_0 + 15));
    }

    #[test]
    fn board_model_keymap_roundtrip() {
        let mut b = BoardModel::default();
        let kcs: Vec<u16> = (100..100 + KEY_COUNT as u16).collect();
        for f in set_keymap_frames(1, &kcs) {
            let resp = b.handle(&f).unwrap();
            assert_eq!(resp[2], STATUS_OK);
        }
        // read back
        let mut got = Vec::new();
        for f in get_keymap_frames(1) {
            let resp = b.handle(&f).unwrap();
            let count = resp[4] as usize;
            for i in 0..count {
                got.push(resp[5 + i * 2] as u16 | ((resp[6 + i * 2] as u16) << 8));
            }
        }
        assert_eq!(got, kcs);
    }

    #[test]
    fn board_model_leds_and_overlay() {
        let mut b = BoardModel::default();
        let colors = [[9u8, 8, 7]; LED_COUNT];
        for f in set_led_color_frames(&colors) {
            assert_eq!(b.handle(&f).unwrap()[2], STATUS_OK);
        }
        assert_eq!(b.rgb[24], [9, 8, 7]); // last underglow corner set
        assert!(b.overlay_on); // colour data implies overlay on
        b.handle(&brightness_frame(123)).unwrap();
        assert_eq!(b.brightness, 123);
        b.handle(&overlay_frame(false)).unwrap();
        assert!(!b.overlay_on);
    }

    #[test]
    fn board_model_rejects_bad_chunks() {
        let mut b = BoardModel::default();
        // count 14 > KEYMAP_CHUNK_MAX
        let bad = frame(CMD_SET_KEYMAP, &[0, 0, 14]);
        assert_eq!(b.handle(&bad).unwrap()[2], STATUS_ERROR);
        // led offset+count out of range
        let bad_led = frame(CMD_SET_LEDS, &[20, 9]);
        assert_eq!(b.handle(&bad_led).unwrap()[2], STATUS_ERROR);
    }

    #[test]
    fn oled_layer_and_screens() {
        let mut b = BoardModel::default();
        b.handle(&oled_set_layer_frame(0, true, "GIT")).unwrap();
        assert_eq!(b.oled_layer_names[0], "GIT");
        assert!(b.oled_show_title[0]);
        b.handle(&oled_set_screens_frame(&[SCREEN_TIMER, SCREEN_DATETIME])).unwrap();
        assert_eq!(b.oled_screen_types, vec![SCREEN_TIMER, SCREEN_DATETIME]);
        b.handle(&oled_set_countdown_frame(0, 5, 30)).unwrap();
        assert_eq!(b.oled_countdown, (0, 5, 30));
    }

    #[test]
    fn parses_inbound_run_host_cmd() {
        let f = frame(CMD_RUN_HOST_CMD, &[7]);
        assert_eq!(parse_run_host_cmd(&f), Some(7));
        assert_eq!(parse_run_host_cmd(&frame(CMD_PING, &[])), None);
    }

    #[test]
    fn ping_returns_version() {
        let mut b = BoardModel::default();
        let resp = b.handle(&ping_frame()).unwrap();
        assert_eq!(&resp[2..5], &[PROTOCOL_VERSION, 0, 1]);
    }
}
