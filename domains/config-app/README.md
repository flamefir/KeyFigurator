---
kind: domain
domain: config-app
status: active
goal: Ship a Tauri config app that does what Vial can't — script/git keys + true per-key LED control.
cadence: manual
---

# config-app — the Macro Pad Pro companion

The custom Tauri desktop app that configures the keyboard over **Raw HID**. Rust backend
owns the HID transport; web frontend owns the editor UI. Consumes the real key-matrix/LED
layout from the KiCad project; produces keymap + LED profiles pushed to the board, and
host-side command bindings (run scripts/git from a key). See [[vial-vs-custom-config-app]].

## Current focus
The app now speaks the firmware's **KeyFigurator Raw HID protocol** byte-for-byte, proven
against a software model of the board (`kf_protocol::BoardModel`, 23 Rust tests). Everything
the differentiator needs — keymap, per-key + underglow RGB, OLED, the host-command/git layer —
is wired and testable with **no hardware**. The only thing between the mock and a real board
is `RealHid`'s USB transport (hidapi); all protocol logic is already shared between mock and
real. After that: physical bring-up (a human gate) and the `/pr` harness.

## Backlog

### Done — mock-side editor (`feature/backlog-clear`, 19 commits)
- [x] Scaffold Tauri app (Rust backend + frontend)
- [x] Mock HID device: a fake board the app talks to with no hardware
- [x] Layout editor UI (remap keys) — searchable keycode palette → `set_keymap`
- [x] Per-key LED designer (RGB Matrix) — the Vial gap — per-key anim + underglow → `set_leds`
- [x] Live sync: changes sent to board RAM immediately on edit; no push step
- [x] "Save to board" — explicit EEPROM commit (`eeprom_commit`)
- [x] "Saved Boards" tab — manage saved profiles (name, load, delete, export/import per layer)
- [x] On reconnect: app auto-applies active profile to board RAM (3s poll)
- [x] Host-side command runner: run git/shell from a HOST(n) binding (`runner.rs` + `run_binding` + UI)

### Done — firmware + app⟷firmware protocol integration (2026-07-25)
- [x] Firmware: Macro Pad Pro added to the vial-qmk fork (`Macro-Pro-Firmware`, RP2040, SSD1351 OLED)
- [x] Firmware: KeyFigurator Raw HID channel (`kf_hid.c`) — keymap/LED/OLED/eeprom + unsolicited RUN_HOST_CMD
- [x] App: byte-accurate protocol module `kf_protocol.rs` mirroring `kf_hid.h` (constants + `BoardModel`, test-pinned)
- [x] App: keycode string↔u16 codec (palette subset + `HOST(n)`→`QK_KB_n`); exotic keycodes defer to Vial
- [x] Fixed VID/PID (`0xFEED`/`0x4D50`), `KF_MAGIC` framing, underglow → 4 corners
- [x] LED transport: chunked colour frames + brightness/overlay control frames (fixed the broken `set_leds` payload)
- [x] OLED protocol wired end to end (`oled_push`, cmds `0x50–0x54`) + time sync
- [x] Inbound RUN_HOST_CMD listener → `runner` → `host-cmd` event (+ `simulate_board_host_cmd` to test without hardware)
- [x] PING protocol-version negotiation
- [x] The keymap/RGB data model now matches the REAL matrix/LED indices → wrote [[keymatrix-led-layout]]

### Blocked on physical boards — the only remaining gap
- [ ] `RealHid` USB transport: hidapi enumerate/open + inbound read thread (only `transceive` left; protocol shared with mock)
- [ ] Physical verification: LEDs/OLED actually change, a `HOST(n)` press runs on the host (human gate)
- [ ] Confirm underglow corner orientation (TL/TR/BR/BL) on a real board

### Remaining app work
- [ ] Harness the repo: `/pr` with human HW gate (Rust unit tests exist in kf_protocol/hid/model/runner; Playwright dep present)
- [ ] (optional) Full QMK keycode table — deferred to Vial by the chosen scope

## Evidence & analysis
[[vial-vs-custom-config-app]]

## Metrics
`metrics/` — TBD (build/test pass rate once harnessed).

## Timeline
2026-06-23 | setup — domain created; Tauri chosen; Raw HID architecture adopted; app scaffolded.
2026-07-25 | backlog burndown — full mock-side editor shipped on `feature/backlog-clear` (19 commits: keymap/RGB/OLED/encoder editors, host-command runner, saved layers, save-to-board, reconnect auto-apply). Remaining work is hardware/firmware-blocked + repo harness.
2026-07-25 | app⟷firmware integration — aligned the app to the firmware's KeyFigurator Raw HID protocol byte-for-byte: new `kf_protocol.rs` (mirrors `kf_hid.h`, test-pinned), keycode codec, fixed LED payload + IDs + framing, OLED + host-cmd + PING wired, [[keymatrix-led-layout]] written. Only `RealHid` USB transport + physical bring-up remain.
