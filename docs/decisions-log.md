---
kind: doc
type: decision
domain: [config-app, hardware]
status: adopted
links: [[vial-vs-custom-config-app]]
---

# KeyFigurator — decisions log

Durable record of the architecture decisions made for KeyFigurator (the config app) and
the Macro Pad Pro hardware, captured so a fresh session (human or agent) inherits the
*reasoning*, not just the code. Complements [[vial-vs-custom-config-app]] (the Vial boundary,
recorded separately).

---

## 1. Tauri over Electron

**Decision:** Build the config app in Tauri, not Electron.

**Why:** Rust backend sits close to the embedded/C comfort zone of this project; far lighter
binaries than Electron; the frontend is a normal web view, so frontend logic stays testable
much like a web app even though the shell is native. That last point matters because it
recovers a chunk of the standard harness's "drive the app to verify it" capability that a
fully-native app would lose.

---

## 2. Three separable workstreams, not one project

**Decision:** Split the work into distinct domains rather than one "Macro Pad Pro" bucket:
- `config-app` — the Tauri app (active, recurring code work).
- `hardware` — finite milestone track (order → bring-up → validate).
- storefront — DEFERRED until "store now" (config tool first, store later).

**Why:** The architecture's rule is one loop = one separable workstream with its own cadence.
Hardware is finite and milestone-driven; the config app ships code continuously; the store is
a future web track. Lumping them violates MECE and produces a domain that's half-done-forever.
Keep them separate so each has honest state.

---

## 3. Raw HID alongside Vial, not instead of it

**Decision:** Port firmware to vial-qmk for the free baseline (standard keymap/macro editing),
AND add a Raw HID command channel for the features Vial can't do. Don't replace Vial.

**Why:** Vial gives ordinary remapping for free and is a credible tool to hand to buyers.
Our three headline features (script/command keys, a git layer, true per-key LED control) all
live beyond what Vial structurally supports. Raw HID is a separate channel that coexists with
the Vial protocol. See [[vial-vs-custom-config-app]] for the full boundary.

---

## 4. The board sends a command INDEX, never a command string

**Decision:** When a key triggers a host command, the firmware sends a Raw HID packet
containing an *index* (e.g. `{"cmd":"run","index":0}`), not the command text. The host app
maps that index to a `HostBinding` the user configured in the app, and runs it.

**Why (security):** The keyboard is an untrusted-ish input device. If it could send arbitrary
command strings, a compromised or malicious board could inject any command to run on the host.
By sending only an index, the worst a bad board can do is trigger an *already-approved* binding
the user explicitly set up — never an arbitrary command. The command strings live only in the
host app's config, never on the wire from the board.

**Implication:** `runner.rs` looks up bindings by index and refuses unknown indices. Keep this
property as the git-layer feature grows — don't add a "board sends raw command" shortcut.

---

## 5. Hardware-in-the-loop verification is a HUMAN step

**Decision:** The standard harness verifies a feature by having a fresh sub-agent drive the
running app. For KeyFigurator, two deviations:
1. **Tauri, not a browser app** — verify by driving the frontend (webview / component tests)
   plus `cargo test` on the Rust protocol layer.
2. **"Did the RGB actually change on the board" is a human gate** — a sub-agent cannot observe
   physical LEDs. Until boards arrive, verify against the **mock HID device**; after, the
   physical check is a human step in `/pr`, not an agent claim.

**Why:** Honesty about what can be auto-verified. A green test suite with an unconfirmed
physical effect is not "done" for a hardware-touching feature.

---

## 6. Mock-first transport (the `HidTransport` trait)

**Decision:** All board communication goes through a `HidTransport` trait with two impls:
`MockHid` (in-memory fake board, works today with no hardware) and `RealHid` (stubbed, filled
in when PCBs arrive). Everything above the trait is identical for both.

**Why:** Boards aren't in hand yet (BOM locked, not ordered). Mock-first means the entire UI +
data model + profile logic is buildable and testable NOW, so the app is ready the day the PCBs
land. The swap is one module + one line in `main.rs`; nothing above the trait changes.

---

## 7. Live-sync to RAM; explicit "Save to board" for EEPROM only

**Decision:** Drop the "Push to board" model. All changes (keycodes, LED colors, macros) are
sent to the board's RAM immediately over Raw HID the moment the user makes them. A separate
"Save to board" action commits the current profile to EEPROM for persistence across power
cycles.

**Why:** If everything can be synced live (LEDs via `rgb_matrix_indicators_advanced_kb`,
keymaps and macros via Raw HID to RAM), then an explicit push step is unnecessary friction.
The board always reflects the app state while connected. EEPROM writes are reserved for
deliberate "I'm done, make this stick" moments, keeping write cycles low and the semantic
clear. For `HOST(n)` command keys the app must be running anyway, so RAM-only is sufficient
for that class of binding; only standard QMK keycodes that need to work standalone require
EEPROM.

**UX:** Tweak → see it live on board → "Save to board" when satisfied. No intermediate push
step. On reconnect the app re-applies the active profile to RAM automatically.

**Implication:** `set_keymap`, `set_leds` etc. fire on every change event, not on a button
click. The old "Push to board" button is replaced by "Save to board" (EEPROM commit only).

---

## Open / not yet decided

- **Firmware Raw HID handler details** — the `raw_hid_receive` implementation and the `HOST(n)`
  keycode that emits the packet are discussed but not yet written. Next real firmware task.
- **Real key-matrix + LED index map** — `model.rs` uses a placeholder 21-key order. The KiCad
  project is the source of truth; document it in `docs/keymatrix-led-layout.md` and make
  `model.rs` match before trusting any on-board layout.
- **VID/PID** — `hid.rs` has placeholder `VENDOR_ID`/`PRODUCT_ID`; set from QMK `config.h`.

## Timeline
2026-06-23 | chat — decisions extracted from the design conversation and filed for handoff to Claude Code.