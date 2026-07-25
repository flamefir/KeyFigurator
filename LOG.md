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
