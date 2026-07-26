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
- [ ] Firmware: enable `ENABLE_RGB_MATRIX_*` effects in `config.h` — currently **zero** effects are compiled in (only `RGB_MATRIX_SOLID_COLOR` as default mode), which blocks every LED animation feature in the app. See [[protocol-feature-gaps]]
- [x] Document the real key-matrix + LED index map → [[keymatrix-led-layout]] (written from the firmware's `kf_hid.c` tables; the app mirrors it)

## Evidence & analysis
[[vial-vs-custom-config-app]] · [[keymatrix-led-layout]] · [[protocol-feature-gaps]]

## Timeline
2026-06-23 | setup — domain created; BOM locked, about to order.
2026-07-25 | boards in hand — PCBs received, soldered, and bench-tested successfully (power + RP2040 enumeration). Firmware flashing next; then functional validation + RealHid bring-up.
2026-07-26 | firmware flashed + first app link — `macro_pad_pro_vial.uf2` flashed; the config app enumerated and opened the board over Raw HID on first try. Peripheral validation (matrix/RGB/OLED/HOST) is the remaining hardware work.
2026-07-26 | first bench results — keycodes + per-key/underglow colour confirmed working on hardware. Only solid colour renders: the audit ([[protocol-feature-gaps]]) traced it to zero RGB matrix effects compiled into `config.h`, which is a firmware prerequisite for every animation feature.
