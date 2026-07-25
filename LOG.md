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
