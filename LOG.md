# Work log

Append-only journal of finished work bulks. Newest at the BOTTOM. Keep entries SHORT:
header line + What + Refs.

**Entry grammar:**
```
## YYYY-MM-DD · Short title · #tag1 #tag2
What: 1-2 lines, outcome first.
Refs: [doc](path) (new|updated), repo PR/commit links.
```

---

## 2026-06-23 · Macro Pad Pro loop + Tauri config app scaffolded · #setup #config-app
What: Stood up the knowledge base (config-app + hardware domains), recorded the Vial-vs-custom decision, and scaffolded the Tauri app around a Raw HID architecture with a mock HID device.
Refs: CLAUDE.md (new), docs/vial-vs-custom-config-app.md (new), domains/config-app/README.md (new), domains/hardware/README.md (new), macropad-config/ (new).

## 2026-07-25 · Config app: full mock-side editor complete (backlog burndown) · #config-app #ui
What: Shipped the entire no-hardware editor on `feature/backlog-clear` (19 commits): searchable keycode remap, per-key + underglow RGB, OLED designer, encoder settings, host-command runner (HOST(n) → git/shell), saved-layers export/import, save-to-board (EEPROM commit stub), and auto-apply-on-reconnect — all against MockHid, zero console errors. Remaining work is hardware/firmware-blocked (real HID, vial-qmk firmware, real KiCad matrix/LED indices) plus repo harness.
Refs: domains/config-app/README.md (updated), keyfigurator/ src + src-tauri/{model,hid,runner}.rs, commits master..feature/backlog-clear (6823cf8…5d2f733).

## 2026-07-25 · App⟷firmware integration: KeyFigurator Raw HID protocol · #config-app #firmware #protocol
What: Made the config app speak the firmware's `kf_hid` protocol byte-for-byte. New `kf_protocol.rs` mirrors `kf_hid.h` (magic/commands/LED-slot + keycode maps) with a `BoardModel` port of `kf_hid.c`; MockHid + RealHid now share all protocol logic through a single `transceive()`. Added the keycode string↔u16 codec (+ `HOST(n)`→`QK_KB_n`), fixed the broken `set_leds` payload (correct `LedState` shape, underglow 4 corners) and VID/PID (`0xFEED`/`0x4D50`), wired the OLED protocol (`oled_push`, `0x50–0x54`) + time sync, the inbound RUN_HOST_CMD listener → `runner` → `host-cmd` event, and PING version negotiation. 23 Rust tests pin the wire format against the firmware; the real Tauri app boots and drives clean.
Refs: keyfigurator/src-tauri/src/{kf_protocol.rs (new), hid.rs, model.rs, main.rs}, keyfigurator/src/main.js, docs/keymatrix-led-layout.md (new); firmware Macro-Pro-Firmware/keyboards/macro_pad_pro/kf_hid.{h,c}.

## 2026-07-25 · RealHid USB transport (hidapi) implemented · #config-app #hardware #hid
What: Implemented the real Raw HID transport so the app is ready the day boards land. `RealHid` enumerates VID/PID `0xFEED/0x4D50` on usage `0xFF60/0x61`, opens the interface, and runs a single-owner I/O thread that serializes command request/response and drains unsolicited RUN_HOST_CMD packets to the host-cmd channel. `main.rs` auto-detects a board at startup and falls back to `MockHid`. Compiles clean (23 tests still pass) and falls back gracefully with no board (verified: "no KeyFigurator interface found → MockHid"); report-id framing + read/write timing await a real board for bring-up.
Refs: keyfigurator/src-tauri/{Cargo.toml, Cargo.lock}, keyfigurator/src-tauri/src/{hid.rs, main.rs}.

## 2026-07-26 · First real board link + supervised USB hot-plug · #config-app #hardware #hid
What: The flashed board enumerated and opened on first try, so `RealHid` is validated on real hardware. Reworked it from a startup-only open into a session-long supervisor (rescan while dark, attach on appear, drop + rescan on USB error) behind a new `BoardLink` that routes per frame to board-or-mock, so unplug/replug now works repeatedly in one session; added the `board-connection` event + `board_status` command and profile re-apply on every attach. Also fixed the keycode codec silently blanking keys on bare names (`"A"` → KC_NO). 26 Rust tests pass.
Refs: keyfigurator/src-tauri/src/{hid.rs, kf_protocol.rs, main.rs}, keyfigurator/src/main.js, CLAUDE.md (updated: boards in hand + repo map), domains/{config-app,hardware}/README.md (updated).
