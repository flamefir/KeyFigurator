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
Boards aren't here yet — build everything that does NOT need hardware, against a **mock HID
device**, so the app is ready the day PCBs arrive. Right now: app scaffold + the keymap/RGB
data model.

## Backlog
- [ ] Port firmware to vial-qmk (free baseline) — `vial-qmk` repo
- [ ] Scaffold Tauri app (Rust backend + frontend) — `macropad-config` repo
- [ ] Define the keymap/RGB data model (must match KiCad matrix + LED indices) → write [[keymatrix-led-layout]]
- [ ] Mock HID device: a fake board the app talks to with no hardware
- [ ] Layout editor UI (remap keys) driven against the mock
- [ ] Per-key LED designer (RGB Matrix) — the Vial gap
- [ ] Live LED sync: color changes in the app send immediately to the PCB over Raw HID (not just cosmetic — the board LEDs must reflect the current state in real time, both app-driven and board-driven changes)
- [ ] Live sync: all changes (keycodes, LEDs, macros) sent to board RAM immediately on edit; no push step
- [ ] "Save to board" — explicit EEPROM commit; replaces the old "Push to board" button
- [ ] "Saved Boards" tab — floating top-nav tab; manage saved profiles (name, load, delete, export to disk)
- [ ] On reconnect: app auto-applies active profile to board RAM
- [ ] Raw HID command channel in firmware (the `{"cmd":...}` packet)
- [ ] Host-side command runner: receive Raw HID packet → run git/shell command
- [ ] The "git layer" feature end-to-end (firmware layer + host runner + UI)
- [ ] Real HID integration behind the mock (when boards arrive)
- [ ] Harness the repo: dev-local, frontend test gate, Rust unit tests, /pr with human HW gate

## Evidence & analysis
[[vial-vs-custom-config-app]]

## Metrics
`metrics/` — TBD (build/test pass rate once harnessed).

## Timeline
2026-06-23 | setup — domain created; Tauri chosen; Raw HID architecture adopted; app scaffolded.
