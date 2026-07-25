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
The mock-side build is essentially done: the Tauri app runs, talks to `MockHid`, and the
full editor (keymap remap, per-key + underglow RGB, OLED designer, encoder, host-command
runner, saved layers) works with **no hardware**. What remains is (a) hardware/firmware-
blocked — real HID transport, the firmware Raw HID channel, and the real KiCad matrix/LED
indices — and (b) repo harness (`/pr` + human HW gate) plus the [[keymatrix-led-layout]] doc.

## Backlog

### Done — against the mock (`feature/backlog-clear`, 19 commits)
- [x] Scaffold Tauri app (Rust backend + frontend)
- [x] Mock HID device: a fake board the app talks to with no hardware
- [x] Layout editor UI (remap keys) driven against the mock — searchable keycode palette → `set_keymap`
- [x] Per-key LED designer (RGB Matrix) — the Vial gap — per-key anim + underglow → `set_leds`
- [x] Live sync: all changes (keycodes, LEDs) sent to board RAM immediately on edit; no push step
- [x] "Save to board" — explicit EEPROM commit (`eeprom_commit`; stub wires when boards arrive)
- [x] "Saved Boards" tab — manage saved profiles (name, load, delete, export/import per layer)
- [x] On reconnect: app auto-applies active profile to board RAM (3s poll)
- [x] Host-side command runner: run git/shell from a HOST(n) binding (`runner.rs` + `run_binding` + UI)

### Blocked on hardware / firmware — correctly still open
- [ ] Define the keymap/RGB data model against the REAL KiCad matrix + LED indices → write [[keymatrix-led-layout]] (model built with placeholder 21-key indices; real indices need boards)
- [ ] Live LED sync over Raw HID — app→mock works; real-time board reflection needs `RealHid`
- [ ] Port firmware to vial-qmk (free baseline) — `vial-qmk` repo
- [ ] Raw HID command channel in firmware (the `{"cmd":...}` packet) — `vial-qmk` repo
- [ ] The "git layer" feature end-to-end (firmware layer + host runner + UI) — host side done; needs firmware + real HID
- [ ] Real HID integration behind the mock (when boards arrive) — `RealHid` stub in `hid.rs`

### Remaining app work
- [ ] Harness the repo: `/pr` with human HW gate (Rust unit tests exist in hid/model/runner; Playwright dep present)

## Evidence & analysis
[[vial-vs-custom-config-app]]

## Metrics
`metrics/` — TBD (build/test pass rate once harnessed).

## Timeline
2026-06-23 | setup — domain created; Tauri chosen; Raw HID architecture adopted; app scaffolded.
2026-07-25 | backlog burndown — full mock-side editor shipped on `feature/backlog-clear` (19 commits: keymap/RGB/OLED/encoder editors, host-command runner, saved layers, save-to-board, reconnect auto-apply). Remaining work is hardware/firmware-blocked + repo harness.
