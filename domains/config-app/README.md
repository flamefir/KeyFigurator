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
The app speaks the firmware's **KeyFigurator Raw HID protocol** byte-for-byte, proven against
a software model of the board (`kf_protocol::BoardModel`) and now **against real hardware** —
a flashed board enumerates and opens on first try. The USB link is **supervised**: it attaches
whenever a board is present, survives unplug/replug any number of times per session, and falls
back to the mock while dark. Remaining work is **peripheral validation on hardware** (a human
gate — see the hardware domain) and the `/pr` harness.

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

### Done — RealHid USB transport (2026-07-25)
- [x] `RealHid` implemented: hidapi enumerate/open on VID/PID `0xFEED/0x4D50` (usage `0xFF60/0x61`), single-owner I/O thread serializing all access, inbound RUN_HOST_CMD reader → host-cmd channel. App auto-detects a board at startup and falls back to `MockHid`. **Compiles + falls back cleanly; unverified on real hardware.**

### Done — USB hot-plug + keycode healing (2026-07-26)
- [x] `RealHid` is now **supervised**, not opened once at startup: one thread owns `HidApi` + the device for the whole session, rescans every 1s while dark, attaches the moment a board appears, and drops + rescans on a USB error. Unplug/replug works repeatedly in one session.
- [x] `BoardLink` routes each frame to the board when attached and the mock when not, so the editor never breaks and a board plugged in later is picked up without a restart
- [x] `board-connection` Tauri event + `board_status` command — UI reacts on the plug instead of on its 3s poll, and can tell "real board" from "mock standing in"
- [x] Profile auto-applies on every attach (not just the first), including a board already attached at app start
- [x] Keycode codec heals bare/lower-case names (`"A"` → `KC_A`) instead of silently sending KC_NO; frontend sanitizes keymaps loaded from localStorage and imported layer files

### Blocked on physical boards — remaining gap (human gate)
- [x] `RealHid` enumeration validated on a real board
- [ ] `RealHid` read/write timing + report-id framing under load (bulk LED/OLED pushes)
- [ ] Physical verification: LEDs/OLED actually change, a `HOST(n)` press runs on the host
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
2026-07-25 | RealHid USB transport — implemented the hidapi transport (enumerate/open + single-owner I/O thread + inbound RUN_HOST_CMD reader); app auto-detects a board and falls back to MockHid. Compiles + falls back cleanly; awaiting a real board for bring-up. Only the physical human gate remains.
2026-07-26 | first real link + hot-plug — the app connected to a flashed board on first try. Reworked `RealHid` into a session-long supervisor (rescan/attach/detach) behind a new `BoardLink`, so connecting is no longer startup-only; added the `board-connection` event + `board_status` command. Fixed the keycode codec silently blanking keys on bare names (`"A"` → KC_NO). 26 Rust tests pass.
