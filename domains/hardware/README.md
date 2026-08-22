---
kind: domain
domain: hardware
status: active
goal: Get Macro Pad Pro PCBs made, brought up, and validated.
cadence: manual
---

# hardware — Macro Pad Pro board

The finite, milestone-driven hardware track. Not a recurring loop — just the home for the
remaining board to-dos and decisions. Boards are built, flashed, and talking to the config
app over Raw HID; functional validation of the peripherals is what's left.

## Current focus
Functional validation on hardware: key matrix, per-key RGB, underglow, OLED, and the
HOST(n) round-trip. `RealHid` enumeration is confirmed working; read/write timing and
report-id framing still need a proper exercise under load.

## Backlog
- [x] Place PCBWay order (BOM locked)
- [x] Receive boards
- [x] Assemble + bench-test boards — soldered and tested successfully (power/enumeration)
- [x] Flash firmware (`macro_pad_pro_vial.uf2`) — flashed via double-tap-reset UF2 bootloader
- [x] `RealHid` enumeration confirmed on real hardware — the app finds and opens the board (`kf: board attached over Raw HID`)
- [ ] Validate: key matrix, per-key RGB, underglow, OLED, USB-C
- [ ] Exercise `RealHid` read/write timing + report-id framing under load (bulk LED/OLED pushes)
- [ ] Confirm underglow corner orientation (TL/TR/BR/BL) — one-line reorder in [[keymatrix-led-layout]] + `main.js` if wrong
- [ ] Verify a physical `HOST(n)` press runs its binding on the host
- [ ] **Flash 0.3.7 and verify on hardware** — the board reports 0.3.0, so six firmware releases are unverified. Specifically: Present Keys on non-layer screens, the icon mask rendering, the title font scale, per-screen LED profiles switching on encoder navigation, and both red LED alerts
- [ ] OLED font sizes only ever checked on the layer screen; other screen types unverified
- [ ] Fresh/invalidated EEPROM boots the board dark (`memset` → `KF_ANIM_SOLID` with an all-black `rgb[]`) — recorded, never reproduced on hardware
- [x] ~~Firmware: enable `ENABLE_RGB_MATRIX_*` effects in `config.h`~~ — **false finding, retracted 2026-07-27.** Eight effects were always compiled in: `keyboard.json`'s `rgb_matrix.animations` block generates the `ENABLE_RGB_MATRIX_*` defines through QMK's data-driven build, and `post_config.h` derives `RGB_MATRIX_KEYPRESSES`/`RGB_MATRIX_FRAMEBUFFER_EFFECTS` on top. Verified with `qmk generate-config-h -kb macro_pad_pro`. Nothing was ever blocked. See [[protocol-feature-gaps]]
- [x] Firmware: cover the app's remaining two animations — added `riverflow` (snake) + `pixel_rain` (sparkle) to `keyboard.json`, so all seven app animations have a board-side effect for protocol v2 to map onto. Mapping documented in `config.h`
- [x] Document the real key-matrix + LED index map → [[keymatrix-led-layout]] (written from the firmware's `kf_hid.c` tables; the app mirrors it)

### Chat screen (`feature/chat-screen`, fw 0.5.0) — design in [[telegram-chat-screens]]
- [ ] `KF_SCREEN_CHAT = 8` + `0x62 CHAT_SET_LINE` / `0x63 CHAT_SET_STATE`, 8 lines x 20 chars
  per screen (504 bytes for three rooms)
- [x] **`EECONFIG_KB_DATA_SIZE` 1792 → 2048.** `kf_nvm_t` was at **1791 of 1792** — one byte
  spare, against a `config.h` comment claiming room to grow. Two corrections on the way there:
  an estimated 2560 **failed to build**, because Vial's own features (tap dance, combos, key
  overrides, alt repeat) take 1192 bytes before the macro buffer sees any, and QMK asserts a
  100-byte floor on it — the real ceiling is ~2506. Then probing the compiler for the actual
  layout showed 449 bytes of `kf_display_nvm_t` were a body per custom screen, nine of which
  can never be filled (only `KF_SCREEN_CUSTOM_TEXT` draws one, and there is one of those). It
  now stores one body plus its owning slot, so the block is **1836 of 2048** with 212 spare and
  the move is 256 bytes instead of 768. Vial macro buffer 814 → 559. Every flashed board must
  still be reset and re-pushed; Vial macro CONTENT is the only thing Orbit cannot restore.
  See §5.1 of [[telegram-chat-screens]]
- [x] `KF_MAX_CUSTOM_SCREENS` 7 → 10, `KF_SCREEN_SLOTS` 11 → 14, `KF_EVENT_COUNT` 9 → 10
  (`KF_EVENT_CHAT_MARK_READ`) → `KF_LED_STATE_VERSION` 5 → 6, plus `_Static_assert`s pinning
  slots == layers + custom, slots <= 16, and the body sentinel outside the slot range.
  `sleep_mask` is `uint16_t`: 14 slots fit, **16 is the ceiling**, so the next multi-instance
  screen type has to widen it. fw 0.5.0 compiles clean
- [ ] **Lever for later:** those 1192 bytes of Vial tap dance / combos / key overrides / alt
  repeat are unused by this product through Orbit. Turning off the ones nobody wants is worth
  more than anything left to squeeze out of `kf_nvm_t` — but it changes what Vial offers, so
  it is a product decision rather than a slot-space one
- [ ] `kf_alert_pulse_color()` — two BLUE flashes for a new message. Red is the countdown
  alarm and the pomodoro change, amber is the control-key hint; a chat ping must not read as
  either. Existing `kf_alert_pulse()` keeps its signature and delegates in red
- [ ] Bench gate: chat screen renders with `>` on own lines · badge counts and clears from the
  bound key · three rooms navigate independently · the blue ping is not mistaken for the alarm ·
  an NVM v5 board upgrades by falling to defaults and the app re-pushes · 27 frames of bulk
  chat push does not starve the display task

## Evidence & analysis
[[vial-vs-custom-config-app]] · [[keymatrix-led-layout]] · [[protocol-feature-gaps]] · [[telegram-chat-screens]]

## Timeline
2026-06-23 | setup — domain created; BOM locked, about to order.
2026-07-25 | boards in hand — PCBs received, soldered, and bench-tested successfully (power + RP2040 enumeration). Firmware flashing next; then functional validation + RealHid bring-up.
2026-07-26 | firmware flashed + first app link — `macro_pad_pro_vial.uf2` flashed; the config app enumerated and opened the board over Raw HID on first try. Peripheral validation (matrix/RGB/OLED/HOST) is the remaining hardware work.
2026-07-26 | first bench results — keycodes + per-key/underglow colour confirmed working on hardware. Only solid colour renders: the audit ([[protocol-feature-gaps]]) traced it to zero RGB matrix effects compiled into `config.h`, which is a firmware prerequisite for every animation feature.
2026-07-27 | that trace was wrong — `config.h` is bare by design; the effects are declared in `keyboard.json` and generated by QMK's data-driven build (verified by running the generator). The bench symptom was the app's overlay latch, now fixed app-side. Added `riverflow` + `pixel_rain` for full app-animation coverage and rebuilt the vial firmware.
2026-07-29 | firmware 0.3.7 built, NOT yet flashed — the board still reports 0.3.0, so everything from 0.3.1 onward is unverified on hardware. `macro_pad_pro_vial.uf2`, 162,816 bytes, MD5 `B3A6829FAA18238A737D6FC21C2F3A3F`, shipped inside `release/Orbit-0.1.0-windows-x64/firmware/`. Adds per-screen LED profiles, Present Keys on every screen with icon/macro/keycode priority and the screen action it runs, PNG/SVG key icons as 32x32 masks, title font scale, and red LED alerts for countdown-zero and pomodoro phase changes. The LED and OLED behaviour cannot be auto-verified — the app-side halves are test-pinned, the panel and the LEDs are a human gate.
