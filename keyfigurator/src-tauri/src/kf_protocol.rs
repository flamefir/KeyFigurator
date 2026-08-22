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
use crate::model::Rgb;

pub const KF_MAGIC: u8 = 0xC0;

/// Fixed QMK Raw HID report size.
pub const REPORT_LEN: usize = 32;

/// v2 added SET_ANIM (global animation).
pub const PROTOCOL_VERSION: u8 = 2;

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
pub const CMD_GET_IDENTITY: u8 = 0x02;
pub const CMD_GET_KEYMAP: u8 = 0x10;
pub const CMD_SET_KEYMAP: u8 = 0x11;
pub const CMD_SET_LEDS: u8 = 0x20;
pub const CMD_SET_ANIM: u8 = 0x21;
/// The four underglow corners get their own animation, rendered by the firmware
/// rather than by QMK's RGB matrix. QMK has one effect for the whole board, so
/// SET_ANIM alone could never give the underglow something different from the
/// keys — the app's separate underglow picker had no way to reach the hardware.
pub const CMD_SET_UG_ANIM: u8 = 0x22;
/// "Cycle Colors": a palette the running animation steps through instead of
/// holding one tint. Two targets, keys and underglow, because each runs its own
/// animation and the app offers a separate colour list for each.
pub const CMD_SET_PALETTE: u8 = 0x23;
pub const CMD_RUN_HOST_CMD: u8 = 0x30; // board -> host, unsolicited: [index]
pub const CMD_EEPROM_COMMIT: u8 = 0x40;
pub const CMD_OLED_SET_LAYER: u8 = 0x50;
pub const CMD_OLED_SET_SCREENS: u8 = 0x51;
pub const CMD_OLED_SET_TEXT: u8 = 0x52;
pub const CMD_OLED_SET_COUNTDOWN: u8 = 0x53;
/// Deliberately NOT gated behind a protocol-version bump: firmware older than
/// this command answers STATUS_ERROR and keeps its compile-time defaults, which
/// is what lets the app keep talking to a board that has not been reflashed.
pub const CMD_OLED_SET_POMODORO: u8 = 0x58;
/// Per-screen OLED sleep. Same "not behind a version bump" rule as 0x58:
/// firmware that predates it answers STATUS_ERROR and simply never sleeps.
pub const CMD_OLED_SET_SLEEP: u8 = 0x59;
/// How many layer screens the board shows. Its keymap always has LAYER_COUNT
/// layers; this is only about the OLED's screen list, which the app's own
/// arbitrary-length layer list drives.
pub const CMD_OLED_SET_LAYER_COUNT: u8 = 0x5A;
/// Which physical key triggers which screen action.
pub const CMD_OLED_SET_EVENT_KEYS: u8 = 0x5B;
/// What Present Keys shows for a key besides its number.
pub const CMD_OLED_SET_KEY_LABEL: u8 = 0x5C;
pub const CMD_OLED_SET_KEY_INFO: u8 = 0x5D;
pub const CMD_SET_SCREEN_LEDS: u8 = 0x5E;
pub const CMD_OLED_SET_KEY_ICON: u8 = 0x5F;
pub const CMD_OLED_SET_FONT: u8 = 0x60;
pub const CMD_OLED_SET_BUSY: u8 = 0x61;
/// Title text scale. The board has one font drawn at integer multiples, so
/// this is the whole of what a "font size" can be there.
pub const FONT_SCALE_MIN: u8 = 1;
pub const FONT_SCALE_MAX: u8 = 4;
/// The board's icon: 32x32 1-bit, 4 bytes per row, MSB = leftmost pixel.
pub const KEY_ICON_BYTES: usize = 128;
/// Sentinel in the offset position: this key has no icon.
pub const KEY_ICON_CLEAR: u8 = 0xFF;
/// 30 payload bytes per frame, less key_idx/offset/count.
pub const KEY_ICON_CHUNK_MAX: usize = REPORT_LEN - 5;
pub const SCREEN_LEDS_HDR: u8 = 0xF0;
pub const KEY_LABEL_MAX: usize = 16;
/// Present Keys text fields, in the order they are fallen back through. The
/// icon is not one of them — it is pixels, and travels via SET_KEY_ICON.
pub const KEY_INFO_MACRO: u8 = 0;
pub const KEY_INFO_KEYCODE: u8 = 1;
pub const KEY_INFO_COUNT: usize = 2;
/// Bindings one frame can carry: 32 - (magic, cmd, slot, count), two bytes each.
pub const EVENT_KEYS_CHUNK_MAX: usize = (REPORT_LEN - 4) / 2;
pub const EVENT_KEY_NONE: u8 = 0xFF;
/// `KF_EVENT_COUNT`. Grew to 10 with `KF_EVENT_CHAT_MARK_READ`.
pub const EVENT_COUNT: usize = 10;

/// Pomodoro limits + defaults, mirroring `KF_POMO_*` in `kf_hid.h`. The board
/// clamps to these, so the app applies the same bounds rather than letting the
/// user set a value that silently becomes something else.
pub const POMO_MIN_MINUTES: u8 = 1;
pub const POMO_MAX_MINUTES: u8 = 240;
pub const POMO_MIN_CYCLES: u8 = 1;
pub const POMO_MAX_CYCLES: u8 = 16;
pub const POMO_DEFAULT_WORK_MIN: u8 = 25;
pub const POMO_DEFAULT_PAUSE_MIN: u8 = 5;
pub const POMO_DEFAULT_CYCLES: u8 = 4;
pub const CMD_OLED_SYNC_TIME: u8 = 0x54;
pub const CMD_OLED_IMG_BEGIN: u8 = 0x55;
pub const CMD_OLED_IMG_DATA: u8 = 0x56;
pub const CMD_OLED_IMG_END: u8 = 0x57;

// SET_LEDS control-frame selectors (first payload byte).
pub const LED_BRIGHTNESS: u8 = 0xF0;
pub const LED_OVERLAY_OFF: u8 = 0xF1;
pub const LED_OVERLAY_ON: u8 = 0xF2;

pub const STATUS_OK: u8 = 0x00;
pub const STATUS_ERROR: u8 = 0x01;

/// HOST(n) custom keycodes: HOST_0 = QK_KB_0 .. HOST_15 = QK_KB_15.
pub const QK_KB_0: u16 = 0x7E00;
pub const HOST_CMD_COUNT: u8 = 16;

/// MACRO(n) — QMK dynamic macros, recorded and stored on the board itself
/// (`dynamic_keymap_macro_*`). QMK's keycode space runs to QK_MACRO_31, but the
/// board compiles in `DYNAMIC_KEYMAP_MACRO_COUNT` (16) of them, so only 0..15
/// will actually fire.
pub const QK_MACRO_0: u16 = 0x7700;
pub const MACRO_COUNT: u8 = 16;

// OLED limits (kf_hid.h).
/// 10: the six content types (timer, countdown, datetime, custom text,
/// pomodoro, image), the permanent home screen, and up to `MAX_CHAT_SCREENS`
/// chat screens — the first type the app allows more than one of.
pub const OLED_MAX_CUSTOM_SCREENS: usize = 10;
/// How many Connection Screens can exist at once. The cap is a slot-space
/// decision, not a UI one: each costs a custom screen, a `SCREEN_SLOTS` entry
/// and 161 bytes of the board's persisted config block.
pub const MAX_CHAT_SCREENS: usize = 3;
pub const OLED_LAYER_NAME_MAX: usize = 16;
pub const OLED_CUSTOM_TITLE_MAX: usize = 14;
pub const OLED_BODY_MAX: usize = 48;
/// Most text bytes ONE frame can carry: 32 - (magic+cmd+slot+field+offset+len).
/// A source limit, unrelated to `OLED_BODY_MAX` which bounds the destination —
/// a 48-byte body is legal, it just takes two frames.
pub const OLED_TEXT_CHUNK_MAX: usize = REPORT_LEN - 6;

/// `enum kf_screen_type` in kf_hid.h.
pub const SCREEN_TIMER: u8 = 1;
pub const SCREEN_COUNTDOWN: u8 = 2;
pub const SCREEN_DATETIME: u8 = 3;
pub const SCREEN_CUSTOM_TEXT: u8 = 4;
pub const SCREEN_POMODORO: u8 = 5;
pub const SCREEN_IMAGE: u8 = 6;
/// The permanent home screen. Always present, never deletable, and drawn by the
/// board from its own logo bitmap — no content crosses the wire for it.
pub const SCREEN_LOGO: u8 = 7;
/// A Connection Screen: one chat room's recent history. Its title is the room
/// name and travels through `OLED_SET_TEXT` field 0 like any other screen's;
/// its lines travel through `CHAT_SET_LINE`.
pub const SCREEN_CHAT: u8 = 8;

// Chat (kf_hid.h). One history line per frame; `CHAT_SET_STATE` commits.
pub const CMD_CHAT_SET_LINE: u8 = 0x62;
pub const CMD_CHAT_SET_STATE: u8 = 0x63;
/// History lines the board keeps per chat screen.
pub const CHAT_LINES: usize = 8;
/// Characters per line. The panel is 128px and the font is 6px wide at scale 1,
/// giving 21 columns; one is the origin marker.
pub const CHAT_LINE_MAX: usize = 20;
/// Most line bytes ONE frame can carry: 32 - (magic, cmd, slot, line, origin,
/// offset, len). A source limit like `OLED_TEXT_CHUNK_MAX`, and unrelated to
/// `CHAT_LINE_MAX` — validating only the destination is what let an
/// `OLED_SET_TEXT` frame claim a length that ran off the end of the report.
pub const CHAT_LINE_CHUNK_MAX: usize = REPORT_LEN - 7;
/// `flags` bit 0 of `CHAT_SET_STATE`: flash the board on a new message.
pub const CHAT_FLAG_LED_PING: u8 = 0x01;
/// A line the app wrote.
pub const CHAT_ORIGIN_ME: u8 = 1;
/// A line from the paired peer.
pub const CHAT_ORIGIN_PEER: u8 = 0;

/// The board's single image buffer (`KF_OLED_IMG_MAX_BYTES`), and the caps the
/// encoder must respect to stay inside it.
pub const OLED_IMG_MAX_BYTES: usize = 72 * 1024;
pub const OLED_IMG_MAX_FRAMES: usize = 8;
pub const OLED_IMG_MAX_DIM: u32 = 128;
/// Image bytes one frame can carry: 32 - (magic, cmd, offset×3, len).
pub const OLED_IMG_CHUNK_MAX: usize = REPORT_LEN - 6;

/// `enum kf_anim` in kf_hid.h. Stable wire ids — the firmware maps these to
/// whichever QMK effect is compiled in, because QMK's own effect numbers shift
/// whenever the enabled effect set changes. Never send a QMK enum value here.
///
/// `ANIM_SOLID` is special: it means "the per-key colours the app pushed",
/// which the firmware renders through the overlay rather than as an effect.
pub const ANIM_SOLID: u8 = 0;
pub const ANIM_RAINBOW: u8 = 1;
pub const ANIM_SNAKE: u8 = 2;
pub const ANIM_BREATHE: u8 = 3;
pub const ANIM_WAVE: u8 = 4;
pub const ANIM_REACTIVE: u8 = 5;
pub const ANIM_SPARKLE: u8 = 6;
pub const ANIM_COUNT: u8 = 7;

/// Map the app's animation name to its wire id. Unknown names fall back to
/// solid, matching the firmware's own default arm.
pub fn anim_id(name: &str) -> u8 {
    match name {
        "rainbow" => ANIM_RAINBOW,
        "snake" => ANIM_SNAKE,
        "breathe" => ANIM_BREATHE,
        "wave" => ANIM_WAVE,
        "reactive" => ANIM_REACTIVE,
        "sparkle" => ANIM_SPARKLE,
        _ => ANIM_SOLID,
    }
}

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

/// SET_ANIM: `[anim, speed, hue, sat, val]`. Animation is global — QMK's RGB
/// matrix has one mode for the whole board, so per-key state is colour only.
pub fn identity_frame() -> [u8; REPORT_LEN] {
    frame(CMD_GET_IDENTITY, &[])
}

/// Longest product name GET_IDENTITY can carry (mirrors `KF_PRODUCT_NAME_MAX`).
pub const PRODUCT_NAME_MAX: usize = REPORT_LEN - 10;

pub fn set_anim_frame(anim: u8, speed: u8, hue: u8, sat: u8, val: u8) -> [u8; REPORT_LEN] {
    frame(CMD_SET_ANIM, &[anim, speed, hue, sat, val])
}

pub const PALETTE_MAX: usize = 20;
pub const PALETTE_CHUNK_MAX: usize = 9;
pub const PALETTE_SET_LEN: u8 = 0xF0;
pub const PALETTE_TARGET_KEYS: u8 = 0;
pub const PALETTE_TARGET_UNDERGLOW: u8 = 1;

/// Palette length + cycle rate for one target. `len` 0 clears it.
pub fn set_palette_len_frame(target: u8, len: u8, rate: u8) -> [u8; REPORT_LEN] {
    frame(CMD_SET_PALETTE, &[target, PALETTE_SET_LEN, len, rate])
}

/// Palette colours, chunked to what one report carries.
pub fn set_palette_frames(target: u8, colors: &[Rgb]) -> Vec<[u8; REPORT_LEN]> {
    colors
        .chunks(PALETTE_CHUNK_MAX)
        .enumerate()
        .map(|(ci, chunk)| {
            let mut p = Vec::with_capacity(3 + chunk.len() * 3);
            p.push(target);
            p.push((ci * PALETTE_CHUNK_MAX) as u8);
            p.push(chunk.len() as u8);
            for c in chunk {
                p.extend_from_slice(c);
            }
            frame(CMD_SET_PALETTE, &p)
        })
        .collect()
}

/// Underglow animation. No colour: the animated modes use the corner colours
/// SET_LEDS already pushed, and RAINBOW generates its own spectrum.
pub fn set_ug_anim_frame(anim: u8, speed: u8, intensity: u8) -> [u8; REPORT_LEN] {
    frame(CMD_SET_UG_ANIM, &[anim, speed, intensity])
}

/// One screen's LED profile: a header frame that marks the slot valid and
/// carries both animations, then the 25 colours in offset-addressed chunks.
///
/// Header first on purpose. The board applies a slot the moment it is written
/// if that slot is the one on screen, so sending the animation before the
/// colours means the very first apply already has both — the alternative shows
/// the new colours under the old animation for one frame.
#[allow(clippy::too_many_arguments)]
pub fn set_screen_leds_frames(
    slot: u8,
    colors: &[[u8; 3]],
    anim: u8,
    speed: u8,
    hsv: (u8, u8, u8),
    ug_anim: u8,
    ug_speed: u8,
    ug_intensity: u8,
) -> Vec<[u8; REPORT_LEN]> {
    let (h, s, v) = hsv;
    let mut out = vec![frame(
        CMD_SET_SCREEN_LEDS,
        &[slot, SCREEN_LEDS_HDR, anim, speed, h, s, v, ug_anim, ug_speed, ug_intensity],
    )];
    for (ci, chunk) in colors.chunks(LED_CHUNK_MAX).enumerate() {
        let mut p = Vec::with_capacity(3 + chunk.len() * 3);
        p.push(slot);
        p.push((ci * LED_CHUNK_MAX) as u8);
        p.push(chunk.len() as u8);
        for c in chunk {
            p.extend_from_slice(c);
        }
        out.push(frame(CMD_SET_SCREEN_LEDS, &p));
    }
    out
}

/// One chat history line.
///
/// Chunked like `oled_set_text_frames`, even though a `CHAT_LINE_MAX` line
/// always fits one frame today. The offset stays in the wire format so that
/// widening the line is a change of constant rather than a change of protocol —
/// and so this cannot become the function that writes past the end of a report
/// the day it is widened.
///
/// The text is expected to be ASCII and already the right width: the board's
/// 5x7 font covers 32..126 and it does no wrapping. `ChatScreen::lines()` in
/// `model.rs` is what produces that; this only truncates as a last guard.
pub fn chat_line_frames(slot: u8, line: u8, origin: u8, text: &str) -> Vec<[u8; REPORT_LEN]> {
    let bytes = text.as_bytes();
    let bytes = &bytes[..bytes.len().min(CHAT_LINE_MAX)];
    if bytes.is_empty() {
        return vec![frame(CMD_CHAT_SET_LINE, &[slot, line, origin, 0, 0])];
    }
    bytes
        .chunks(CHAT_LINE_CHUNK_MAX)
        .enumerate()
        .map(|(ci, chunk)| {
            let mut p = Vec::with_capacity(5 + chunk.len());
            p.push(slot);
            p.push(line);
            p.push(origin);
            p.push((ci * CHAT_LINE_CHUNK_MAX) as u8);
            p.push(chunk.len() as u8);
            p.extend_from_slice(chunk);
            frame(CMD_CHAT_SET_LINE, &p)
        })
        .collect()
}

/// Commit a chat screen: how many of the pushed lines are live, the unread
/// badge, and the flags.
///
/// Sent last on purpose. The board renders nothing for a slot until this
/// arrives, so a half-pushed conversation is never drawn — the same "length
/// after the data" rule `set_palette` follows, for the same reason.
///
/// `count` of 0 clears the slot, which is how a deleted room stops showing an
/// old conversation rather than leaving it on the panel forever.
pub fn chat_state_frame(slot: u8, count: u8, unread: u8, flags: u8) -> [u8; REPORT_LEN] {
    frame(
        CMD_CHAT_SET_STATE,
        &[slot, count.min(CHAT_LINES as u8), unread, flags],
    )
}

pub fn oled_img_begin_frame(total_len: u32) -> [u8; REPORT_LEN] {
    let b = total_len.to_le_bytes();
    frame(CMD_OLED_IMG_BEGIN, &[b[0], b[1], b[2]])
}

/// Chunk the QGF into offset-addressed data frames. Offset-addressed rather than
/// sequential so a dropped chunk can just be re-sent.
pub fn oled_img_data_frames(image: &[u8]) -> Vec<[u8; REPORT_LEN]> {
    image
        .chunks(OLED_IMG_CHUNK_MAX)
        .enumerate()
        .map(|(ci, chunk)| {
            let off = (ci * OLED_IMG_CHUNK_MAX) as u32;
            let ob = off.to_le_bytes();
            let mut p = Vec::with_capacity(4 + chunk.len());
            p.extend_from_slice(&[ob[0], ob[1], ob[2], chunk.len() as u8]);
            p.extend_from_slice(chunk);
            frame(CMD_OLED_IMG_DATA, &p)
        })
        .collect()
}

pub fn oled_img_end_frame() -> [u8; REPORT_LEN] {
    frame(CMD_OLED_IMG_END, &[])
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

/// Which screens may blank themselves, as a bitmap over the nav-index space
/// (bits 0..3 = layer screens, 4..9 = custom screens), and after how long.
/// A `timeout_s` of 0 leaves the board's current timeout alone.
pub fn oled_set_layer_count_frame(count: u8) -> [u8; REPORT_LEN] {
    frame(CMD_OLED_SET_LAYER_COUNT, &[count])
}

/// Bindings for ONE screen, chunked. `(event, key_idx)` pairs; 0xFF clears.
pub fn oled_set_event_keys_frames(slot: u8, pairs: &[(u8, u8)]) -> Vec<[u8; REPORT_LEN]> {
    pairs
        .chunks(EVENT_KEYS_CHUNK_MAX)
        .map(|chunk| {
            let mut p = Vec::with_capacity(2 + chunk.len() * 2);
            p.push(slot);
            p.push(chunk.len() as u8);
            for (e, k) in chunk {
                p.push(*e);
                p.push(*k);
            }
            frame(CMD_OLED_SET_EVENT_KEYS, &p)
        })
        .collect()
}

/// One key's Present Keys label. ASCII only — the board's 5x7 font covers
/// 32..126, so anything else would render as '?'.
pub fn oled_set_key_label_frame(key_idx: u8, label: &str) -> [u8; REPORT_LEN] {
    let bytes: Vec<u8> = label
        .bytes()
        .filter(|b| (32..=126).contains(b))
        .take(KEY_LABEL_MAX)
        .collect();
    let mut p = Vec::with_capacity(2 + bytes.len());
    p.push(key_idx);
    p.push(bytes.len() as u8);
    p.extend_from_slice(&bytes);
    frame(CMD_OLED_SET_KEY_LABEL, &p)
}

/// One field of one key's Present Keys text.
///
/// Filtered to printable ASCII, which is all the board's 5x7 font covers —
/// anything else would come out as the font's '?' fallback.
pub fn oled_set_key_info_frame(key_idx: u8, field: u8, text: &str) -> [u8; REPORT_LEN] {
    let bytes: Vec<u8> = text
        .bytes()
        .filter(|b| (32..=126).contains(b))
        .take(KEY_LABEL_MAX)
        .collect();
    let mut p = Vec::with_capacity(3 + bytes.len());
    p.push(key_idx);
    p.push(field);
    p.push(bytes.len() as u8);
    p.extend_from_slice(&bytes);
    frame(CMD_OLED_SET_KEY_INFO, &p)
}

/// One key's icon mask, in offset-addressed chunks. `None` clears it, which has
/// to be sent explicitly or a removed icon would linger on the board.
pub fn oled_set_key_icon_frames(key_idx: u8, mask: Option<&[u8]>) -> Vec<[u8; REPORT_LEN]> {
    let Some(mask) = mask else {
        return vec![frame(CMD_OLED_SET_KEY_ICON, &[key_idx, KEY_ICON_CLEAR, 0])];
    };
    mask.iter()
        .copied()
        .take(KEY_ICON_BYTES)
        .collect::<Vec<u8>>()
        .chunks(KEY_ICON_CHUNK_MAX)
        .enumerate()
        .map(|(ci, chunk)| {
            let mut p = Vec::with_capacity(3 + chunk.len());
            p.push(key_idx);
            p.push((ci * KEY_ICON_CHUNK_MAX) as u8);
            p.push(chunk.len() as u8);
            p.extend_from_slice(chunk);
            frame(CMD_OLED_SET_KEY_ICON, &p)
        })
        .collect()
}

/// Title scale, clamped to what the panel can draw.
pub fn oled_set_font_frame(scale: u8) -> [u8; REPORT_LEN] {
    frame(CMD_OLED_SET_FONT, &[scale.clamp(FONT_SCALE_MIN, FONT_SCALE_MAX)])
}

/// Put the board's panel on the "Saving ..." splash, or take it off.
///
/// A save is a dozen commands back to back and every OLED one dirties the
/// panel, so it cleared and redrew a dozen times — the flicker. While the
/// splash is up the board suppresses those redraws entirely.
pub fn oled_set_busy_frame(on: bool) -> [u8; REPORT_LEN] {
    frame(CMD_OLED_SET_BUSY, &[u8::from(on)])
}

#[cfg(test)]
mod busy_tests {
    use super::*;

    /// The splash is one byte behind the magic, and the two states have to be
    /// distinguishable — a frame that said "busy" for both would leave the
    /// panel stuck on the splash after every save.
    #[test]
    fn busy_frame_carries_the_flag() {
        let on = oled_set_busy_frame(true);
        let off = oled_set_busy_frame(false);
        assert_eq!(on[0], KF_MAGIC, "framed like every other command");
        assert_eq!(on[1], CMD_OLED_SET_BUSY);
        assert_eq!(on[2], 1);
        assert_eq!(off[2], 0);
    }

    /// 0x61 has to stay clear of the commands around it. Reusing an id would
    /// silently turn a save into a font change on older firmware.
    #[test]
    fn busy_command_id_is_unique() {
        for other in [
            CMD_OLED_SET_FONT,
            CMD_OLED_SET_KEY_ICON,
            CMD_OLED_SET_SLEEP,
            CMD_SET_SCREEN_LEDS,
            CMD_OLED_SET_LAYER_COUNT,
        ] {
            assert_ne!(CMD_OLED_SET_BUSY, other);
        }
    }
}

pub fn oled_set_sleep_frame(timeout_s: u8, mask: u16) -> [u8; REPORT_LEN] {
    frame(
        CMD_OLED_SET_SLEEP,
        &[timeout_s, (mask & 0xFF) as u8, (mask >> 8) as u8],
    )
}

/// Pomodoro phase durations in minutes, plus how many work phases earn a long
/// break. A zero field means "leave that one alone" on the firmware side.
pub fn oled_set_pomodoro_frame(work_min: u8, pause_min: u8, cycles: u8) -> [u8; REPORT_LEN] {
    frame(CMD_OLED_SET_POMODORO, &[work_min, pause_min, cycles])
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
        // Before "MO" only for readability — "MACRO(0)" cannot match the "MO"
        // prefix anyway, since it starts "MA".
        ("MACRO", QK_MACRO_0),
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
        0x7700..=0x771F => format!("MACRO({})", kc - QK_MACRO_0),
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

/// A "Cycle Colors" palette as the board holds it.
#[derive(Clone, Copy)]
pub struct PaletteState {
    pub rgb: [Rgb; PALETTE_MAX],
    pub len: u8,
    pub rate: u8,
}

impl Default for PaletteState {
    fn default() -> Self {
        Self { rgb: [[0, 0, 0]; PALETTE_MAX], len: 0, rate: 128 }
    }
}

/// How many screens the board can hold bindings for: 4 layer screens plus
/// MAX_CUSTOM_SCREENS. The app's FIXED slot space, mirroring KF_SCREEN_SLOTS —
/// not the board's compressed nav_index.
///
/// This was **10 while the firmware was 11**, from 0.4.6 (when the home screen
/// took a slot of its own) until 2026-08-22. The seventh custom screen's LED
/// profile was silently rejected here and had nowhere to live in
/// `BoardModel::screen_leds`, so a board that accepted it was told otherwise by
/// its own config app. `slot_space_matches_the_firmware` below pins the
/// arithmetic so the two cannot drift again.
pub const SCREEN_SLOTS: usize = LAYER_COUNT + OLED_MAX_CUSTOM_SCREENS;

/// One chat screen as the board holds it.
///
/// `lines` is written by `CHAT_SET_LINE` and `count` by `CHAT_SET_STATE`, and
/// they are separate for a reason: the board draws `count` lines, not
/// `lines.len()`. A push in progress has lines written but no count yet, so a
/// half-sent conversation is never on screen.
#[derive(Clone, PartialEq, Debug, Default)]
pub struct ChatSlotState {
    /// Indexed by line number, oldest first. `(origin, text)`.
    pub lines: [(u8, String); CHAT_LINES],
    /// How many of `lines` are live. 0 means the slot shows nothing.
    pub count: u8,
    pub unread: u8,
    pub flags: u8,
}

impl ChatSlotState {
    /// What the panel would actually show: the live lines, in order.
    pub fn visible(&self) -> Vec<(u8, String)> {
        self.lines[..(self.count as usize).min(CHAT_LINES)].to_vec()
    }
}

/// One screen's LED profile as the board holds it. Mirrors `kf_screen_leds_t`.
#[derive(Clone, PartialEq, Debug)]
pub struct ScreenLedState {
    pub rgb: [Rgb; LED_COUNT],
    pub anim: u8,
    pub anim_speed: u8,
    pub anim_hsv: (u8, u8, u8),
    pub ug_anim: u8,
    pub ug_speed: u8,
    pub ug_intensity: u8,
}

impl Default for ScreenLedState {
    fn default() -> Self {
        Self {
            rgb: [[0, 0, 0]; LED_COUNT],
            anim: ANIM_SOLID,
            anim_speed: 128,
            anim_hsv: (0, 0, 0),
            ug_anim: ANIM_SOLID,
            ug_speed: 128,
            ug_intensity: 180,
        }
    }
}

#[derive(Clone)]
pub struct BoardModel {
    pub keymap: [[u16; KEY_COUNT]; LAYER_COUNT],
    pub rgb: [[u8; 3]; LED_COUNT],
    pub brightness: u8,
    pub overlay_on: bool,
    /// Global animation state (`kf_led_state_t.anim*` in kf_hid.c).
    pub anim: u8,
    pub anim_speed: u8,
    pub anim_hsv: (u8, u8, u8),
    /// Last-committed snapshot (EEPROM). Purely to model persistence.
    pub committed: Option<([[u8; 3]; LED_COUNT], u8, bool)>,
    // OLED state (push-only; recorded so tests can assert it was received).
    pub oled_layer_names: [String; LAYER_COUNT],
    pub oled_show_title: [bool; LAYER_COUNT],
    pub oled_screen_types: Vec<u8>,
    pub oled_countdown: (u8, u8, u8),
    /// Pomodoro durations: (work, short break, long break, long every).
    /// Starts at the firmware's compile-time defaults, same as a real board.
    pub pomodoro: (u8, u8, u8),
    /// Simulate firmware older than SET_POMODORO, which answers STATUS_ERROR
    /// for an unknown command. The un-reflashed board is a real configuration
    /// the app has to keep working against, so it is worth modelling.
    pub reject_pomodoro: bool,
    /// Same idea for SET_KEY_INFO: a board on 0.3.x has SET_KEY_LABEL but not
    /// this, and the app is expected to fall back rather than fail the save.
    pub reject_key_info: bool,
    /// Per-screen sleep: bitmap over the nav-index space, plus the idle
    /// timeout. Starts empty — a board nobody configured never goes dark.
    /// Underglow animation, independent of the global one (kf_hid.c renders
    /// slots 21..24 itself).
    /// One palette per target (keys, underglow), mirroring kf_palettes.
    pub palettes: [PaletteState; 2],
    pub ug_anim: u8,
    pub ug_speed: u8,
    pub ug_intensity: u8,
    /// How many layer screens the board shows (not how many keymap layers it
    /// has, which is always LAYER_COUNT).
    pub layer_screen_count: u8,
    /// [screen_slot][event] -> key index, 0xFF unbound. Mirrors event_key[][].
    ///
    /// Sized from the constants, not from literals. It was `[[u8; 9]; 10]`
    /// while the firmware's array was `[14][10]`, which is the same drift
    /// `SCREEN_SLOTS` had: the model quietly rejected slots the board accepts.
    pub event_keys: [[u8; EVENT_COUNT]; SCREEN_SLOTS],
    /// Present Keys text per key, as the board holds it: [macro, keycode].
    pub key_info: [[String; KEY_INFO_COUNT]; KEY_COUNT],
    /// Present Keys icon mask per key. `None` is a key with no icon.
    pub key_icons: [Option<[u8; KEY_ICON_BYTES]>; KEY_COUNT],
    /// Title text scale. Starts at the firmware's own default.
    pub font_scale: u8,
    /// Per-screen LED profiles, indexed by the app's fixed slot space. `None`
    /// is a slot the app never pushed, which the board leaves alone.
    pub screen_leds: [Option<ScreenLedState>; SCREEN_SLOTS],
    /// Chat history per screen slot. `None` is a slot with no room bound to it;
    /// the board draws nothing for one.
    pub chats: [Option<ChatSlotState>; SCREEN_SLOTS],
    pub sleep_mask: u16,
    pub sleep_timeout_s: u8,
    /// Image upload state, mirroring the board's single image buffer.
    pub oled_img_expected: usize,
    pub oled_img_received: usize,
    pub oled_img_ready: bool,
}

impl Default for BoardModel {
    fn default() -> Self {
        Self {
            keymap: [[0u16; KEY_COUNT]; LAYER_COUNT],
            rgb: [[0u8; 3]; LED_COUNT],
            brightness: 255,
            overlay_on: false,
            anim: ANIM_SOLID,
            anim_speed: 128,
            anim_hsv: (24, 171, 150), // RGB_MATRIX_DEFAULT_* in config.h
            committed: None,
            oled_layer_names: Default::default(),
            oled_show_title: [true; LAYER_COUNT],
            oled_screen_types: Vec::new(),
            oled_countdown: (0, 0, 0),
            pomodoro: (POMO_DEFAULT_WORK_MIN, POMO_DEFAULT_PAUSE_MIN, POMO_DEFAULT_CYCLES),
            reject_pomodoro: false,
            reject_key_info: false,
            palettes: [PaletteState::default(); 2],
            ug_anim: ANIM_SOLID,
            ug_speed: 128,
            ug_intensity: 180,
            // Zero, like the firmware: an unconfigured board has no screens
            // and shows the Orbit mark, not four empty layer screens.
            layer_screen_count: 0,
            event_keys: [[EVENT_KEY_NONE; EVENT_COUNT]; SCREEN_SLOTS],
            key_info: Default::default(),
            key_icons: [None; KEY_COUNT],
            font_scale: 2,
            screen_leds: Default::default(),
            chats: Default::default(),
            sleep_mask: 0,
            sleep_timeout_s: 60,
            oled_img_expected: 0,
            oled_img_received: 0,
            oled_img_ready: false,
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
            CMD_GET_IDENTITY => {
                // Mirrors kf_hid.c: the mock reports the same product 0x01 /
                // hw 1.0.0 the bench board does, so capability lookups behave
                // identically with and without hardware attached.
                let name = b"Lunar x MacroPad";
                r[0] = 0x01; // product id
                r[1] = 1; // hardware 1.0.0
                r[2] = 0;
                r[3] = 0;
                r[4] = 0; // firmware 0.2.0
                r[5] = 2;
                r[6] = 0;
                r[7] = name.len() as u8;
                r[8..8 + name.len()].copy_from_slice(name);
            }
            CMD_SET_LEDS => {
                r[0] = self.apply_set_leds(p);
            }
            CMD_SET_PALETTE => {
                let t = p[0] as usize;
                if t >= self.palettes.len() {
                    r[0] = STATUS_ERROR;
                } else if p[1] == PALETTE_SET_LEN {
                    if p[2] as usize > PALETTE_MAX {
                        r[0] = STATUS_ERROR;
                    } else {
                        self.palettes[t].len = p[2];
                        self.palettes[t].rate = p[3];
                        r[0] = STATUS_OK;
                    }
                } else {
                    let (off, n) = (p[1] as usize, p[2] as usize);
                    if n > PALETTE_CHUNK_MAX || off + n > PALETTE_MAX {
                        r[0] = STATUS_ERROR;
                    } else {
                        for i in 0..n {
                            self.palettes[t].rgb[off + i] =
                                [p[3 + i * 3], p[4 + i * 3], p[5 + i * 3]];
                        }
                        r[0] = STATUS_OK;
                    }
                }
            }
            CMD_SET_UG_ANIM => {
                if p[0] >= ANIM_COUNT {
                    r[0] = STATUS_ERROR;
                } else {
                    self.ug_anim      = p[0];
                    self.ug_speed     = p[1];
                    self.ug_intensity = p[2];
                    r[0] = STATUS_OK;
                }
            }
            CMD_SET_ANIM => {
                if p[0] >= ANIM_COUNT {
                    r[0] = STATUS_ERROR;
                } else {
                    self.anim = p[0];
                    self.anim_speed = p[1];
                    self.anim_hsv = (p[2], p[3], p[4]);
                    // Mirrors kf_apply_anim(): solid means "show the host's
                    // per-key colours", i.e. the overlay; anything else hands
                    // the LEDs to the board's own effect.
                    self.overlay_on = self.anim == ANIM_SOLID;
                    r[0] = STATUS_OK;
                }
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
                // `len` is bounded against the destination AND the report. Without
                // the second check a frame claiming len=48 would read past the end
                // of a 32-byte report on the board — mirrors kf_hid.c.
                if slot as usize >= OLED_MAX_CUSTOM_SCREENS
                    || field > 1
                    || len > OLED_TEXT_CHUNK_MAX
                    || offset + len > max
                {
                    r[0] = STATUS_ERROR;
                } else {
                    r[0] = STATUS_OK; // content recording omitted in the mock
                }
            }
            // Image upload — models the board's buffer state machine so the mock
            // rejects exactly what the firmware rejects.
            CMD_OLED_IMG_BEGIN => {
                let total = p[0] as usize | ((p[1] as usize) << 8) | ((p[2] as usize) << 16);
                if total == 0 || total > OLED_IMG_MAX_BYTES {
                    r[0] = STATUS_ERROR;
                } else {
                    self.oled_img_expected = total;
                    self.oled_img_received = 0;
                    self.oled_img_ready = false;
                    r[0] = STATUS_OK;
                }
            }
            CMD_OLED_IMG_DATA => {
                let offset = p[0] as usize | ((p[1] as usize) << 8) | ((p[2] as usize) << 16);
                let len = p[3] as usize;
                if self.oled_img_expected == 0
                    || len > OLED_IMG_CHUNK_MAX
                    || offset + len > self.oled_img_expected
                {
                    r[0] = STATUS_ERROR;
                } else {
                    self.oled_img_received += len;
                    r[0] = STATUS_OK;
                }
            }
            CMD_OLED_IMG_END => {
                let complete = self.oled_img_expected > 0
                    && self.oled_img_received == self.oled_img_expected;
                self.oled_img_expected = 0;
                self.oled_img_ready = complete;
                r[0] = if complete { STATUS_OK } else { STATUS_ERROR };
            }
            CMD_OLED_SET_COUNTDOWN => {
                self.oled_countdown = (p[0], p[1], p[2]);
                r[0] = STATUS_OK;
            }
            // Superseded by SET_KEY_INFO; still handled, and writes the macro
            // field, so a board's-eye view of an old app stays coherent.
            CMD_OLED_SET_KEY_LABEL => {
                let (idx, len) = (p[0] as usize, p[1] as usize);
                if idx >= self.key_info.len() || len > KEY_LABEL_MAX {
                    r[0] = STATUS_ERROR;
                } else {
                    self.key_info[idx][KEY_INFO_MACRO as usize] =
                        String::from_utf8_lossy(&p[2..2 + len]).into_owned();
                    r[0] = STATUS_OK;
                }
            }
            CMD_OLED_SET_FONT => {
                if (FONT_SCALE_MIN..=FONT_SCALE_MAX).contains(&p[0]) {
                    self.font_scale = p[0];
                    r[0] = STATUS_OK;
                } else {
                    // The firmware clamps rather than rejects, and so does the
                    // frame builder — an out-of-range byte means a bug here.
                    r[0] = STATUS_ERROR;
                }
            }
            CMD_OLED_SET_KEY_ICON => {
                let idx = p[0] as usize;
                if idx >= self.key_icons.len() {
                    r[0] = STATUS_ERROR;
                } else if p[1] == KEY_ICON_CLEAR {
                    self.key_icons[idx] = None;
                    r[0] = STATUS_OK;
                } else {
                    let (offset, count) = (p[1] as usize, p[2] as usize);
                    if count > KEY_ICON_CHUNK_MAX || offset + count > KEY_ICON_BYTES {
                        r[0] = STATUS_ERROR;
                    } else {
                        let m = self.key_icons[idx].get_or_insert([0u8; KEY_ICON_BYTES]);
                        m[offset..offset + count].copy_from_slice(&p[3..3 + count]);
                        r[0] = STATUS_OK;
                    }
                }
            }
            CMD_SET_SCREEN_LEDS => {
                let slot = p[0] as usize;
                if slot >= SCREEN_SLOTS {
                    r[0] = STATUS_ERROR;
                } else if p[1] == SCREEN_LEDS_HDR {
                    let s = self.screen_leds[slot].get_or_insert_with(Default::default);
                    s.anim = p[2];
                    s.anim_speed = p[3];
                    s.anim_hsv = (p[4], p[5], p[6]);
                    s.ug_anim = p[7];
                    s.ug_speed = p[8];
                    s.ug_intensity = p[9];
                    r[0] = STATUS_OK;
                } else {
                    let (offset, count) = (p[1] as usize, p[2] as usize);
                    if count > LED_CHUNK_MAX || offset + count > LED_COUNT {
                        r[0] = STATUS_ERROR;
                    } else {
                        let s = self.screen_leds[slot].get_or_insert_with(Default::default);
                        for i in 0..count {
                            let b = 3 + i * 3;
                            s.rgb[offset + i] = [p[b], p[b + 1], p[b + 2]];
                        }
                        r[0] = STATUS_OK;
                    }
                }
            }
            CMD_OLED_SET_KEY_INFO if self.reject_key_info => {
                r[0] = STATUS_ERROR;
            }
            CMD_OLED_SET_KEY_INFO => {
                let (idx, field, len) = (p[0] as usize, p[1] as usize, p[2] as usize);
                if idx >= self.key_info.len() || field >= KEY_INFO_COUNT || len > KEY_LABEL_MAX {
                    r[0] = STATUS_ERROR;
                } else {
                    self.key_info[idx][field] =
                        String::from_utf8_lossy(&p[3..3 + len]).into_owned();
                    r[0] = STATUS_OK;
                }
            }
            CMD_CHAT_SET_LINE => {
                let (slot, line, origin, offset, len) =
                    (p[0] as usize, p[1] as usize, p[2], p[3] as usize, p[4] as usize);
                // `len` is checked against what the REPORT can hold, not just
                // against the line buffer: a frame claiming len 20 at offset 20
                // would otherwise read past the end of `p`.
                if slot >= SCREEN_SLOTS
                    || line >= CHAT_LINES
                    || len > CHAT_LINE_CHUNK_MAX
                    || offset + len > CHAT_LINE_MAX
                {
                    r[0] = STATUS_ERROR;
                } else {
                    let chat = self.chats[slot].get_or_insert_with(ChatSlotState::default);
                    let text = String::from_utf8_lossy(&p[5..5 + len]).into_owned();
                    if offset == 0 {
                        chat.lines[line] = (origin, text);
                    } else {
                        chat.lines[line].0 = origin;
                        chat.lines[line].1.push_str(&text);
                    }
                    r[0] = STATUS_OK;
                }
            }
            CMD_CHAT_SET_STATE => {
                let slot = p[0] as usize;
                if slot >= SCREEN_SLOTS || p[1] as usize > CHAT_LINES {
                    r[0] = STATUS_ERROR;
                } else {
                    let chat = self.chats[slot].get_or_insert_with(ChatSlotState::default);
                    chat.count = p[1];
                    chat.unread = p[2];
                    chat.flags = p[3];
                    r[0] = STATUS_OK;
                }
            }
            CMD_OLED_SET_EVENT_KEYS => {
                let (slot, count) = (p[0] as usize, p[1] as usize);
                if slot >= self.event_keys.len() || count > EVENT_KEYS_CHUNK_MAX {
                    r[0] = STATUS_ERROR;
                } else {
                    for i in 0..count {
                        let (e, k) = (p[2 + i * 2] as usize, p[3 + i * 2]);
                        if e < self.event_keys[slot].len() {
                            self.event_keys[slot][e] = k;
                        }
                    }
                    r[0] = STATUS_OK;
                }
            }
            CMD_OLED_SET_LAYER_COUNT => {
                // 0 is accepted. The `if p[0] > 0` guard mirrored the firmware's
                // old one, and both meant an app with no layers could not say so.
                self.layer_screen_count = p[0].min(LAYER_COUNT as u8);
                r[0] = STATUS_OK;
            }
            CMD_OLED_SET_SLEEP => {
                // Mirrors oled_set_sleep(): timeout 0 keeps the current value.
                if p[0] > 0 {
                    self.sleep_timeout_s = p[0];
                }
                self.sleep_mask = (p[1] as u16) | ((p[2] as u16) << 8);
                r[0] = STATUS_OK;
            }
            CMD_OLED_SET_POMODORO if self.reject_pomodoro => {
                // What firmware predating 0x58 does with an unknown command.
                r[0] = STATUS_ERROR;
            }
            CMD_OLED_SET_POMODORO => {
                // Mirrors kf_hid.c: 0 keeps the current value, everything else
                // is clamped rather than rejected.
                let keep_or = |want: u8, current: u8, max: u8| {
                    if want == 0 {
                        current
                    } else {
                        want.min(max)
                    }
                };
                self.pomodoro = (
                    keep_or(p[0], self.pomodoro.0, POMO_MAX_MINUTES),
                    keep_or(p[1], self.pomodoro.1, POMO_MAX_MINUTES),
                    keep_or(p[2], self.pomodoro.2, POMO_MAX_CYCLES),
                );
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
                // Colour data fills the overlay buffer, but whether it is SHOWN
                // belongs to the animation mode — see the same comment in
                // kf_hid.c. Asserting it unconditionally (v1) meant live colour
                // sync silently killed a running animation.
                self.overlay_on = self.anim == ANIM_SOLID;
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
    fn set_anim_frame_shape_and_ids() {
        let f = set_anim_frame(ANIM_BREATHE, 200, 24, 171, 150);
        assert_eq!(&f[0..7], &[0xC0, CMD_SET_ANIM, ANIM_BREATHE, 200, 24, 171, 150]);
        // Wire ids are ours, not QMK's — pin them so a reorder is a test failure.
        assert_eq!(
            (
                anim_id("solid"),
                anim_id("rainbow"),
                anim_id("snake"),
                anim_id("breathe"),
                anim_id("wave"),
                anim_id("reactive"),
                anim_id("sparkle"),
            ),
            (0, 1, 2, 3, 4, 5, 6)
        );
        assert_eq!(anim_id("nonsense"), ANIM_SOLID); // unknown degrades to solid
    }

    /// The interaction that broke v1: colour data must NOT steal the LEDs back
    /// from a running animation, but must still assert the overlay in solid mode.
    #[test]
    fn colour_push_respects_the_active_animation() {
        let mut b = BoardModel::default();
        b.handle(&set_anim_frame(ANIM_RAINBOW, 128, 0, 255, 255)).unwrap();
        assert!(!b.overlay_on, "a real animation releases the overlay");

        for f in set_led_color_frames(&[[1u8, 2, 3]; LED_COUNT]) {
            b.handle(&f).unwrap();
        }
        assert!(!b.overlay_on, "colour push must not kill the animation");
        assert_eq!(b.rgb[0], [1, 2, 3], "but the buffer is still updated");

        b.handle(&set_anim_frame(ANIM_SOLID, 128, 0, 0, 0)).unwrap();
        assert!(b.overlay_on, "solid means show the host's colours");
    }

    /// Regression: OLED_SET_TEXT validated `len` only against the destination
    /// buffer, so `field=1, len=48` passed and the firmware memcpy'd 48 bytes
    /// out of the 26 a report actually carries — an out-of-bounds read on the
    /// board. Both sides must reject it.
    #[test]
    fn oled_text_len_bounded_by_the_report_not_just_the_buffer() {
        let mut b = BoardModel::default();
        let over = frame(CMD_OLED_SET_TEXT, &[0, 1, 0, (OLED_TEXT_CHUNK_MAX + 1) as u8]);
        assert_eq!(b.handle(&over).unwrap()[2], STATUS_ERROR);

        // A 48-byte body is still legal — it just has to arrive in two frames.
        let ok = frame(CMD_OLED_SET_TEXT, &[0, 1, 0, OLED_TEXT_CHUNK_MAX as u8]);
        assert_eq!(b.handle(&ok).unwrap()[2], STATUS_OK);

        // And the real chunker never emits an over-long frame.
        for f in oled_set_text_frames(0, 1, &"x".repeat(OLED_BODY_MAX)) {
            assert!(f[5] as usize <= OLED_TEXT_CHUNK_MAX, "chunker exceeded report room");
            assert_eq!(b.handle(&f).unwrap()[2], STATUS_OK);
        }
    }

    #[test]
    fn board_model_rejects_unknown_anim() {
        let mut b = BoardModel::default();
        let resp = b.handle(&set_anim_frame(ANIM_COUNT, 0, 0, 0, 0)).unwrap();
        assert_eq!(resp[2], STATUS_ERROR);
    }

    #[test]
    fn macro_keycodes_roundtrip() {
        assert_eq!(keycode_to_u16("MACRO(0)"), Some(QK_MACRO_0));
        assert_eq!(keycode_to_u16("MACRO(15)"), Some(QK_MACRO_0 + 15));
        assert_eq!(keycode_from_u16(QK_MACRO_0), "MACRO(0)");
        assert_eq!(keycode_from_u16(QK_MACRO_0 + 15), "MACRO(15)");
        // "MACRO" must not be swallowed by the "MO" layer-keycode prefix.
        assert_ne!(keycode_to_u16("MACRO(1)"), keycode_to_u16("MO(1)"));
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

    /// The app's slot space against `kf_hid.h`. These four numbers have to agree
    /// with the firmware exactly, and for eight months two of them did not:
    /// `SCREEN_SLOTS` sat at 10 while `KF_SCREEN_SLOTS` was 11, so the seventh
    /// custom screen's LED profile was rejected by an app talking to a board
    /// that would have accepted it.
    ///
    /// Written as literals rather than derived, deliberately. A test that
    /// recomputes what the code computes proves nothing; these are transcribed
    /// from the header, so changing the header without changing the app fails
    /// here instead of on a bench.
    #[test]
    fn slot_space_matches_the_firmware() {
        assert_eq!(LAYER_COUNT, 4, "DYNAMIC_KEYMAP_LAYER_COUNT");
        assert_eq!(OLED_MAX_CUSTOM_SCREENS, 10, "KF_MAX_CUSTOM_SCREENS");
        assert_eq!(SCREEN_SLOTS, 14, "KF_SCREEN_SLOTS");
        assert_eq!(MAX_CHAT_SCREENS, 3);
        // 6 content types + the home screen + the chat screens.
        assert_eq!(OLED_MAX_CUSTOM_SCREENS, 6 + 1 + MAX_CHAT_SCREENS);
        // The sleep mask is a u16 over this same space (OLED_SET_SLEEP). 14 fit;
        // 16 is the ceiling, and the next multi-instance screen type has to
        // widen the field rather than quietly drop the top slots.
        assert!(SCREEN_SLOTS <= 16, "sleep_mask is u16 — widen it before growing past 16");
    }

    /// `screen_leds` is indexed by the slot the wire carries, so its length and
    /// the bounds check have to be the same number. Sizing it from a literal
    /// while checking against a constant is how the 10-vs-11 drift stayed
    /// invisible.
    #[test]
    fn every_screen_slot_has_an_led_profile_and_one_past_the_end_does_not() {
        let mut b = BoardModel::default();
        assert_eq!(b.screen_leds.len(), SCREEN_SLOTS);

        let last = (SCREEN_SLOTS - 1) as u8;
        let ok = set_screen_leds_frames(last, &[[1, 2, 3]; LED_COUNT], 0, 128, (0, 0, 0), 0, 128, 180);
        for f in &ok {
            assert_eq!(b.handle(f).unwrap()[2], STATUS_OK, "slot {last} must be accepted");
        }
        assert!(b.screen_leds[last as usize].is_some());

        let past = SCREEN_SLOTS as u8;
        let hdr = frame(CMD_SET_SCREEN_LEDS, &[past, SCREEN_LEDS_HDR, 0, 128, 0, 0, 0, 0, 128, 180]);
        assert_eq!(b.handle(&hdr).unwrap()[2], STATUS_ERROR, "slot {past} must be rejected");
    }

    // ── chat frames ─────────────────────────────────────────────────────────

    #[test]
    fn chat_line_frame_is_byte_exact() {
        let f = &chat_line_frames(4, 2, CHAT_ORIGIN_ME, "hi there")[0];
        assert_eq!(f[0], KF_MAGIC);
        assert_eq!(f[1], CMD_CHAT_SET_LINE);
        assert_eq!(&f[2..7], &[4, 2, CHAT_ORIGIN_ME, 0, 8]);
        assert_eq!(&f[7..15], b"hi there");
        assert!(f[15..].iter().all(|&b| b == 0), "tail must be zero-padded");
    }

    /// The `OLED_SET_TEXT` version of this bug shipped: validating only the
    /// destination let a frame claim a length that ran off the end of the
    /// report. One frame has to hold a whole line.
    #[test]
    fn a_full_width_line_still_fits_one_frame() {
        let text = "12345678901234567890"; // exactly CHAT_LINE_MAX
        let frames = chat_line_frames(0, 0, CHAT_ORIGIN_PEER, text);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0][6] as usize, CHAT_LINE_MAX);
        assert!(CHAT_LINE_MAX <= CHAT_LINE_CHUNK_MAX);
    }

    #[test]
    fn an_over_long_line_is_truncated_not_overrun() {
        let text = "x".repeat(200);
        let frames = chat_line_frames(0, 0, CHAT_ORIGIN_PEER, &text);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0][6] as usize, CHAT_LINE_MAX);
    }

    /// An empty line has to be sent, not skipped: it is how a line that used to
    /// hold text is blanked.
    #[test]
    fn an_empty_line_is_still_a_frame() {
        let f = &chat_line_frames(1, 3, CHAT_ORIGIN_PEER, "")[0];
        assert_eq!(&f[2..7], &[1, 3, CHAT_ORIGIN_PEER, 0, 0]);
    }

    #[test]
    fn chat_state_frame_is_byte_exact_and_clamps() {
        let f = chat_state_frame(6, 3, 2, CHAT_FLAG_LED_PING);
        assert_eq!(&f[..6], &[KF_MAGIC, CMD_CHAT_SET_STATE, 6, 3, 2, CHAT_FLAG_LED_PING]);
        // A count above what the board can hold would index past its buffer.
        let over = chat_state_frame(6, 99, 0, 0);
        assert_eq!(over[3] as usize, CHAT_LINES);
    }

    #[test]
    fn board_model_round_trips_a_conversation() {
        let mut b = BoardModel::default();
        let slot = 5u8;
        for f in chat_line_frames(slot, 0, CHAT_ORIGIN_PEER, "you at the desk") {
            assert_eq!(b.handle(&f).unwrap()[2], STATUS_OK);
        }
        for f in chat_line_frames(slot, 1, CHAT_ORIGIN_ME, "yep") {
            assert_eq!(b.handle(&f).unwrap()[2], STATUS_OK);
        }

        // Lines are written, but nothing is live until the state frame lands.
        assert_eq!(b.chats[slot as usize].as_ref().unwrap().count, 0);
        assert!(b.chats[slot as usize].as_ref().unwrap().visible().is_empty());

        b.handle(&chat_state_frame(slot, 2, 1, CHAT_FLAG_LED_PING)).unwrap();
        let chat = b.chats[slot as usize].as_ref().unwrap();
        assert_eq!(
            chat.visible(),
            vec![
                (CHAT_ORIGIN_PEER, "you at the desk".to_string()),
                (CHAT_ORIGIN_ME, "yep".to_string()),
            ]
        );
        assert_eq!(chat.unread, 1);
        assert_eq!(chat.flags & CHAT_FLAG_LED_PING, CHAT_FLAG_LED_PING);
    }

    /// How a deleted room stops showing an old conversation.
    #[test]
    fn count_zero_clears_a_slot() {
        let mut b = BoardModel::default();
        for f in chat_line_frames(2, 0, CHAT_ORIGIN_PEER, "old news") {
            b.handle(&f).unwrap();
        }
        b.handle(&chat_state_frame(2, 1, 0, 0)).unwrap();
        assert_eq!(b.chats[2].as_ref().unwrap().visible().len(), 1);

        b.handle(&chat_state_frame(2, 0, 0, 0)).unwrap();
        assert!(b.chats[2].as_ref().unwrap().visible().is_empty());
    }

    #[test]
    fn chat_frames_out_of_range_are_rejected() {
        let mut b = BoardModel::default();
        let past_slot = SCREEN_SLOTS as u8;
        let f = frame(CMD_CHAT_SET_LINE, &[past_slot, 0, 0, 0, 1, b'x']);
        assert_eq!(b.handle(&f).unwrap()[2], STATUS_ERROR);

        let past_line = frame(CMD_CHAT_SET_LINE, &[0, CHAT_LINES as u8, 0, 0, 1, b'x']);
        assert_eq!(b.handle(&past_line).unwrap()[2], STATUS_ERROR);

        // A length that would read past the end of the report.
        let long = frame(CMD_CHAT_SET_LINE, &[0, 0, 0, 0, (CHAT_LINE_CHUNK_MAX + 1) as u8]);
        assert_eq!(b.handle(&long).unwrap()[2], STATUS_ERROR);

        assert_eq!(b.handle(&frame(CMD_CHAT_SET_STATE, &[past_slot, 0, 0, 0])).unwrap()[2], STATUS_ERROR);
    }

    /// Three rooms fit the custom-screen list; a fourth does not.
    #[test]
    fn three_chat_screens_fit_and_a_fourth_does_not() {
        let mut b = BoardModel::default();
        let mut types = vec![SCREEN_LOGO, SCREEN_TIMER, SCREEN_COUNTDOWN, SCREEN_DATETIME,
                             SCREEN_CUSTOM_TEXT, SCREEN_POMODORO, SCREEN_IMAGE];
        types.extend(std::iter::repeat_n(SCREEN_CHAT, MAX_CHAT_SCREENS));
        assert_eq!(types.len(), OLED_MAX_CUSTOM_SCREENS);
        b.handle(&oled_set_screens_frame(&types)).unwrap();
        assert_eq!(b.oled_screen_types.len(), OLED_MAX_CUSTOM_SCREENS);

        let too_many = frame(CMD_OLED_SET_SCREENS, &[(OLED_MAX_CUSTOM_SCREENS + 1) as u8]);
        assert_eq!(b.handle(&too_many).unwrap()[2], STATUS_ERROR);
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
