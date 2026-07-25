---
kind: doc
domain: [config-app, hardware]
title: Key-matrix + LED index layout (app ⟷ firmware contract)
status: current
---

# keymatrix-led-layout — the shared index contract

The one mapping that the **config app** and the **firmware** must agree on. The
firmware is the source of truth: these tables are transcribed from
`Macro-Pro-Firmware/keyboards/macro_pad_pro/kf_hid.c` (`kf_index_to_matrix`,
`kf_slot_to_chain`) and `config.h` / `keyboard.json`. The app mirrors them in
`keyfigurator/src-tauri/src/kf_protocol.rs` (constants + `BoardModel`) and
`src/main.js` (`BOARD_POSITIONS`). See [[design-config-app]].

## Board identity
| | value | source |
|---|---|---|
| USB VID | `0xFEED` | `keyboard.json` |
| USB PID | `0x4D50` ("MP") | `keyboard.json` |
| Raw HID usage page / usage | `0xFF60` / `0x61` | QMK Raw HID |
| MCU | RP2040 | `keyboard.json` |
| Keymap layers | 4 | `config.h` `DYNAMIC_KEYMAP_LAYER_COUNT` |
| Matrix | 6 rows × 5 cols | `config.h` |
| Per-key + underglow LEDs | 21 + 4 = 25 | `config.h` `RGB_MATRIX_LED_COUNT` |

## KeyFigurator key index → matrix position
Index space `0..20` is the KeyFigurator order (reading order, top-left to
bottom-right), **index 20 = encoder push**. This is exactly `BOARD_POSITIONS`
in `main.js` and the `layer/offset` space of `GET/SET_KEYMAP`.

| idx | matrix (row,col) | physical | idx | matrix (row,col) | physical |
|----:|:---:|---|----:|:---:|---|
| 0 | (0,0) | top row 1 | 11 | (4,1) | 5-key row 2 |
| 1 | (0,1) | top row 2 | 12 | (4,2) | 5-key row 3 |
| 2 | (0,2) | top row 3 | 13 | (4,3) | 5-key row 4 |
| 3 | (0,3) | top row 4 | 14 | (4,4) | 5-key row 5 |
| 4 | (1,0) | OLED-row1 L | 15 | (5,0) | bottom 1 |
| 5 | (1,4) | OLED-row1 R | 16 | (5,1) | bottom 2 |
| 6 | (2,0) | OLED-row2 L | 17 | (5,2) | bottom 3 |
| 7 | (2,4) | OLED-row2 R | 18 | (5,3) | bottom 4 |
| 8 | (3,0) | OLED-row3 L | 19 | (5,4) | bottom 5 |
| 9 | (3,4) | OLED-row3 R | 20 | (0,4) | **encoder push** |
| 10 | (4,0) | 5-key row 1 | | | |

The encoder push switch is wired into the matrix at **(0,4)** via diode D1
(not a dedicated GPIO); the encoder rotate is claimed by the on-device OLED
navigator and never reaches `process_record_user`.

## KeyFigurator LED slot → WS2812 chain index
Slot space `0..24`: slots `0..20` are the per-key LEDs (same order as the key
index above, slot 20 = encoder LED), slots `21..24` are the underglow corners.
`SET_LEDS` addresses these slots; the firmware maps each to its physical chain
position (traced from the PCB, LED11 first after the level shifter).

| slots | chain indices | region |
|---|---|---|
| 0–3 | 3, 4, 5, 6 | keys 0–3 |
| 4–5 | 2, 8 | keys 4–5 |
| 6–7 | 1, 9 | keys 6–7 |
| 8–9 | 0, 10 | keys 8–9 |
| 10–14 | 17, 18, 19, 20, 11 | keys 10–14 |
| 15–19 | 16, 15, 14, 13, 12 | keys 15–19 |
| 20 | 7 | encoder LED |
| 21–24 | 23, 24, 21, 22 | underglow **TL, TR, BR, BL** |

### Underglow corner order
Slots `21, 22, 23, 24` = **top-left, top-right, bottom-right, bottom-left**.
The app's `cornerColors[0..3]` and `LedState.underglow[0..3]` are sent in this
same order. (App-side corner→physical-corner orientation is the one thing that
needs a real board to confirm; if a corner looks wrong on hardware, it is a
one-line reorder here + in `main.js`.)

## HOST(n) keycodes
`HOST_0 .. HOST_15` = `QK_KB_0 .. QK_KB_15` = `0x7E00 .. 0x7E0F` (16 host
commands). Pressing one makes the firmware send an unsolicited
`RUN_HOST_CMD [index]` packet; the app resolves the index against its own
approved binding list and runs it (`runner.rs`). The command string never
crosses the wire.

## Protocol pointer
Full frame/command definitions live in the firmware header
`keyboards/macro_pad_pro/kf_hid.h` and are mirrored byte-for-byte in
`kf_protocol.rs` (pinned by that module's tests). See [[vial-vs-custom-config-app]].
