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
back to the mock while dark. **Protocol v1 is now fully exercised**: overlay, brightness, and
live-sync-on-edit shipped 2026-07-27, so everything the wire can carry, the app sends. The next
build is protocol **v2 animations**, which needs the board-side-vs-host-streamed decision made
first (see [[protocol-feature-gaps]]) — it is not blocked on firmware. Also outstanding:
**peripheral validation on hardware** (a human gate — see the hardware domain) and the `/pr` harness.

## Backlog

### Done — mock-side editor (`feature/backlog-clear`, 19 commits)
- [x] Scaffold Tauri app (Rust backend + frontend)
- [x] Mock HID device: a fake board the app talks to with no hardware
- [x] Layout editor UI (remap keys) — searchable keycode palette → `set_keymap`
- [x] Per-key LED designer (RGB Matrix) — the Vial gap — per-key anim + underglow → `set_leds`
- [~] Live sync: **NOT implemented** — marked done in error. State reaches the board only on attach or via "Save to Board"; see the gap list below
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

### Protocol feature gaps — see [[protocol-feature-gaps]] for the full audit
Confirmed on hardware: keycodes, per-key LED colour, underglow colour. Everything below is
app-side preview only or unsent. **Solid colour is the whole designed surface of protocol v1.**
The audit's "firmware has zero RGB effects compiled in" finding was **retracted 2026-07-27** —
it missed QMK's data-driven generation; eight effects were always compiled in from
`keyboard.json`. Animation work was never firmware-blocked.

### Done — protocol v1 surface closed (2026-07-27)
- [x] Send overlay off/on (`0xF1`/`0xF2`) — `overlay_frame` is no longer dead code: new `HidTransport::set_overlay` + `set_overlay` command + an "LED SOURCE — App/Board" header toggle. Every push re-asserts the current choice, because colour data implicitly latches `overlay_on = 1` in firmware. Taking the LEDs back re-pushes colours first (the board's own effects have overwritten the overlay buffer)
- [x] Feed the brightness byte (`0xF0`) — global BRIGHTNESS slider in the header, persisted; `buildLedState()` reads it instead of hardcoding 255
- [x] Live sync on edit — really implemented this time. Part-scoped (`keymap`/`leds`/`oled`) + 120 ms trailing debounce, so a colour drag re-sends only LED frames instead of the whole bundle; overlapping runs coalesce and a failed push is re-queued rather than dropped. RAM-only — persisting is still "Save to Board"

### Done — protocol v2: global animation (2026-07-27)
Decision made: **board-side QMK effects, animation is global.** The goal was reset to "the
app simulates how it will look; pushing makes the board show it" rather than frame-exact
parity, which removes the need for host-streamed frames entirely (and with it the transport
rework, frame pacing, and OLED contention — see [[protocol-feature-gaps]]).
- [x] `SET_ANIM` (`0x21`, protocol v2) — `[anim, speed, h, s, v]`. Carries **stable KeyFigurator
  anim ids**, not QMK effect numbers, because QMK builds its effect enum from whichever effects
  are compiled in — sending raw enum values would silently break on any effect-set change.
  `kf_anim_to_mode()` owns the mapping
- [x] `ANIM_SOLID` means "show the per-key colours we pushed" (the overlay), every other anim
  releases the overlay to the board's effect — so the animation picker subsumes the old LED
  SOURCE toggle, which is now a derived indicator instead of a second control over one flag
- [x] App: 21 `keyAnimStates` collapsed to one global animation, with migration for layers
  saved in the old per-key shape. **Per-key colour is untouched and still exact**
- [x] `rgb_to_hsv` in `model.rs` — QMK's hue axis is 0-255, not degrees; pinned so #ffb454
  reproduces `RGB_MATRIX_DEFAULT_{HUE,SAT}` exactly
- [ ] Cycle palettes (`klPalette`/`ugPalette`) — still app-side preview only; the wire carries
  one tint per animation

### Done — pomodoro + macros + Present Keys (2026-07-27)
- [x] Pomodoro screen (`KF_SCREEN_POMODORO`) — 25/5 with a long break every 4, state machine on
  the board so it keeps running with the app closed; app mirrors it as a preview
- [x] Present Keys blinks the focused key's LED (~2 Hz) so the index on the OLED maps to a
  physical key. Runs after the overlay, so it shows in animated mode too
- [x] `MACRO(0..15)` in the keycode codec + palette — the firmware has supported 16 dynamic
  macros via Vial all along; this makes them assignable from the app
- [ ] Macro **content** editing — still Vial's job. Needs a second, un-magicked transport path
  for VIA's `dynamic_keymap_macro_{get,set}_buffer` (`0x0B`/`0x0C`) plus a recorder UI

New command each, independent:
- [ ] OLED font picker (`oledFontId`)
- [ ] OLED screen images (`imageDataUrl`) — `0x52` carries text only
- [ ] OLED timer/countdown start-stop-reset — only the duration syncs today (`0x53`)
- [ ] Encoder mode (layer / scroll)
- [ ] OLED back key (`oledBackKeyIdx`) + OLED event keys (`oledEventKeys`)

Decide scope before building:
- [ ] Per-key icons + images (`keyIconLabels`/`keyIconImages`) — may be intentionally host-side; the firmware's Present Keys screen derives labels from the dynamic keymap

### Blocked on physical boards — remaining gap (human gate)
- [x] `RealHid` enumeration validated on a real board
- [ ] `RealHid` read/write timing + report-id framing under load (bulk LED/OLED pushes)
- [ ] Physical verification: LEDs/OLED actually change, a `HOST(n)` press runs on the host
- [ ] Confirm underglow corner orientation (TL/TR/BR/BL) on a real board

### Done — OLED image + GIF screens (2026-07-27)
- [x] `qgf.rs` — a from-scratch Quantum Painter QGF encoder. The board has no PNG/GIF decoder
  and QGF is the only container Quantum Painter reads, so the conversion must happen host-side;
  shelling out to `qmk painter-convert-graphics` was not an option since it needs a Python
  toolchain the user may not have. PALETTE_4BPP uncompressed, one palette shared across frames
- [x] Upload protocol `0x55`-`0x57` — offset-addressed (a dropped chunk is just re-sent), byte
  count verified before `qp_load_image_mem` so a short upload cannot load a truncated image
- [x] **Uploaded once, not per frame** — `qp_animate` plays it on-device, so there is no
  ongoing USB traffic and the animation keeps running with the app closed
- [x] A custom screen with an image becomes an IMAGE screen on the wire, reusing the existing
  upload UI rather than adding a redundant screen type
- [x] Upload cached against the data URL — live sync would otherwise re-send tens of KB on
  every keystroke
- [ ] **One image at a time** (single 72 KB board buffer). A per-slot buffer would be 6×.
  Multiple image screens would need a RAM pool or streaming from external flash

### Done — device manager, macro libraries, pilot fixes (2026-07-28)
- [x] **Device identity in three layers** — `GET_IDENTITY` (`0x02`) reports product id +
  hardware revision + firmware build. `products.rs` is a static capability table keyed on
  **product + hardware, never firmware** — no update can add an encoder push that was never
  soldered. Rev 1.0.0 has none, so the table names key index 5 as the default Special Enter
- [x] **Home page** — device cards (connection dot, versions, transport icon, delete) and a
  New Device scan. The editor is entered by picking a device, so it always runs against a
  known revision instead of assuming one
- [x] **Macro libraries** — browsed like folders (tiles → macros), versioned shareable format,
  import lands as its own library, per-library export, multi-select, queued Test
- [x] **Shell-script macros** — a macro is either keystrokes (`MACRO(n)`, board-executed) or a
  shell script (`HOST(n)`, run by `runner.rs`) authored in a terminal-style editor. This let
  the separate HOST BINDINGS UI be **deleted** rather than moved: binding a shell macro to a
  key *is* creating a host binding. Separate slot spaces, since the two ride different keycodes
- [x] **Per-key macro binding** in key Advanced settings; slots derived not stored, so keycodes
  and allocation cannot drift apart
- [x] Pilot fixes: countdown starts 00:00:00 and refuses a zero start · OLED app-link dot
  replaces the meaningless "USB" label · Present Keys follows a physical press · encoder rotate
  buttons no longer swallow clicks for the key below · window minWidth 420 → 940
- [x] **Persistence audit + fix** — it was *not* true. Key colours, icons and keymap only saved
  through a path that returned early without an active layer, so a fresh install lost every
  edit on restart; saves ran only on layer switch; and one global key meant two boards
  overwrote each other. Now one auto-saved blob per device, hooked into `scheduleLiveSync`
  so a new mutation point cannot sync-but-not-persist
- [ ] Macro **content** to the board is still the open item — needs the un-magicked VIA
  transport path (`0x0B`/`0x0C`). Shell macros are unaffected and work end to end today

### Pre-release attention (2026-07-27)
- [x] **Protocol v2 is a breaking change** — `PROTOCOL_VERSION` 1 → 2 on both sides and `ping()` hard-errors on mismatch, so the app refuses a board running v1 firmware. Flashing is a release prerequisite, not an option. **Everything added since is deliberately NOT behind a version bump**: older firmware answers `STATUS_ERROR` and support is detected by asking the board, never by comparing versions
- [x] **EEPROM overlay trap** — closed app-side on request rather than in firmware: the app refuses to commit a frame that computes to all-black, mirroring the firmware's own arithmetic including its integer divide

### Release 0.1.0 (2026-07-29)
- [x] First Windows build that actually runs. `release/Orbit-0.1.0-windows-x64/` — portable `Orbit.exe`, an NSIS installer, an MSI, and firmware 0.3.7
- [x] `frontendDist` pointed at `../src`: a release would have shipped unbundled source whose bare `@tauri-apps/api/core` import cannot resolve, opening to nothing. Now `../dist`
- [x] `bundle.icon` was absent, so `tauri build` had never got past "Couldn't find a .ico icon"; icons regenerated from the Orbit mark (light version baked in — a taskbar has no stylesheet to invert with)
- [ ] Unsigned. Windows SmartScreen will warn on first run; a code-signing certificate is the only real fix
- [ ] WebView2 is a runtime dependency. Present on Win11 and most Win10, but a blank window means it is missing

### In progress — chat on the OLED, over Telegram (`feature/telegram-chat-screens`)
Design + test plan: [[telegram-chat-screens]]. A two-person room lives in Orbit and renders
on the panel. Topology is forced by two Telegram rules — `getUpdates` is single-consumer
(two Orbits on one bot token get 409 and steal each other's updates) and a bot never hears
another bot — so it is **one bot per connection, owned by one Orbit, peer on any Telegram
client**. Free, no server, no inbound port.
- [x] **Phase 1 — slot space + the drift fix.** App `SCREEN_SLOTS` was 10 while firmware
  `KF_SCREEN_SLOTS` had been 11 since 0.4.6, so the 7th custom screen's LED profile was
  rejected by `BoardModel` against a board that would have taken it. Now 14 (4 layer +
  10 custom) derived from `OLED_MAX_CUSTOM_SCREENS` (7 → 10) rather than a literal, `SCREEN_CHAT`
  = 8, `MAX_CHAT_SCREENS` = 3, and two tests: one transcribing the four numbers from `kf_hid.h`,
  one driving a real `SET_SCREEN_LEDS` at the last slot and one past it. Firmware side is
  fw 0.5.0 / NVM v6 with matching `_Static_assert`s — see the hardware domain for the EEPROM
  half, which needed the block to grow and turned up 449 bytes of unreachable storage
- [x] Phase 2 — `telegram.rs`: getUpdates/sendMessage/getMe over `ureq`, thin HTTP + pure
  parse halves so every test runs offline. Distinct errors for 401/409/429; the bot token
  never reaches an error string or the log panel. **Done** — 20 tests, all offline. `ureq`
  (blocking, rustls) over reqwest: every long-lived job here is a plain thread already, and
  Tauri's reqwest carries no TLS backend so either way added rustls. The offset advances past
  updates we skip, or one sticker would be redelivered forever
- [x] Phase 3 — `chat.rs`: connections, single-use 24h pair code riding the `t.me/<bot>?start=`
  deep link, per-connection poller thread, 8 Tauri commands + `chat-message`/`chat-paired`/
  `chat-status` events. Bot token stays backend-side in the app-config dir, never `localStorage`,
  never in an export. 18 tests. Decisions worth keeping: the poll **offset is recorded before
  any message is acted on** (Telegram redelivers above the offset, so a crash costs one duplicate
  rather than the batch); the store lock is **never held across a request**, or every command
  would wait out a 25 s long poll; `ConnectionView` is a separate type rather than
  `#[serde(skip)]` on the token, because a skip is one edit away from being undone; and two rooms
  on one bot are refused at the door, since that is a self-inflicted 409
- [x] Phase 4 — home page **Chatrooms** + Create connection + room panel. A conversation works
  in Orbit with no board involved. **The frontend owns the transcript** (localStorage, beside
  layers/screens/devices) and the backend keeps none: everything the board is shown is assembled
  by `buildOledConfig()` on that side, so a second owner would mean a second restore path.
  A sent message is recorded only after Telegram accepts it — showing it first would put a line
  on the board that nobody received. Chat pushes are guarded by `syncChatToBoard()`, because
  the home page has no active device to build an OLED config from
- [x] Phase 5 — chat frames: `0x62 CHAT_SET_LINE` / `0x63 CHAT_SET_STATE`, `ChatScreen`/
  `ChatMessage` in `model`, `push_chats` in `hid`, `ChatSlotState` in `BoardModel`. 29 tests.
  The host folds to ASCII and wraps to 20 chars; the board draws what it is given, same
  division of labour as Present Keys and key icons. Decisions worth keeping:
  - **Lines are written, then `CHAT_SET_STATE` commits a count.** The board draws `count`
    lines, not however many were written, so a push that dies partway leaves the previous
    conversation up rather than a torn one — the rule `set_palette` already follows
  - **The cut to 8 lines happens AFTER wrapping.** Keeping the last 8 *messages* overflows the
    panel the moment one of them wraps; only counting lines gets it right
  - **A message that folds away to nothing becomes `[?]`**, not silence. An emoji-only reply is
    common and vanishing would read as a bug. Danish/German letters transliterate
    (`Søren` → `Soeren`) rather than blanking
  - **The clear pass walks the chat screens, not all 14 slots.** Blanket-clearing cost 14 USB
    round trips on *every* OLED push — and live sync pushes on a 120 ms debounce mid colour-drag —
    on boards that may have no chat screens at all. A deleted screen needs no clear anyway:
    `OLED_SET_SCREENS` has already taken it out of the list
- [x] **Two more instances of the slot drift**, found while wiring this and fixed with it:
  `push_oled`'s event-key loop was `for slot in 0u8..10`, silently dropping bindings on the
  highest screens, and `BoardModel::event_keys` was `[[u8; 9]; 10]` against a firmware array of
  `[14][10]`. Both now sized from `SCREEN_SLOTS`/`EVENT_COUNT`
- [ ] Phase 6 — firmware `KF_SCREEN_CHAT` (see the hardware domain)
- [ ] Phase 7 — **Connection Screen**: screen type with a cap of 3 (the first type allowed more
  than once), connection dropdown, `"chat"` live-sync part, per-room LED-ping toggle
- [ ] Known limit, by design: if both people own a pad, only the owner's board shows the room.
  Rules 1 and 2 above, not a shortcut — a symmetric room needs a userbot or a relay

### Remaining app work
- [~] Harness the repo: `/pr` with human HW gate. The older Playwright suites still live in a scratchpad; **new ones now land in `keyfigurator/tests/`** — `chat-ui.mjs` (23 checks) is the first, driving the built app in browser mode against `browserMock`. Moving the older ones in is still the open half
- [ ] **Standalone per-screen keymaps** — LED profiles now switch on the board with the app closed; the KEYMAP still does not. The board holds one dynamic keymap, so a screen's key bindings are app-side only
- [ ] Repository renames — code says Orbit / Lunar x MacroPad, but `KeyFigurator`, `Macro-Pro-Firmware` and `Macro-Pro` keep the old names on GitHub and on disk. Outward-facing, so it needs a decision rather than a commit
- [ ] (optional) Full QMK keycode table — deferred to Vial by the chosen scope

## Evidence & analysis
[[vial-vs-custom-config-app]] · [[keymatrix-led-layout]] · [[protocol-feature-gaps]] · [[telegram-chat-screens]]

## Metrics
`metrics/` — TBD (build/test pass rate once harnessed).

## Timeline
2026-06-23 | setup — domain created; Tauri chosen; Raw HID architecture adopted; app scaffolded.
2026-07-25 | backlog burndown — full mock-side editor shipped on `feature/backlog-clear` (19 commits: keymap/RGB/OLED/encoder editors, host-command runner, saved layers, save-to-board, reconnect auto-apply). Remaining work is hardware/firmware-blocked + repo harness.
2026-07-25 | app⟷firmware integration — aligned the app to the firmware's KeyFigurator Raw HID protocol byte-for-byte: new `kf_protocol.rs` (mirrors `kf_hid.h`, test-pinned), keycode codec, fixed LED payload + IDs + framing, OLED + host-cmd + PING wired, [[keymatrix-led-layout]] written. Only `RealHid` USB transport + physical bring-up remain.
2026-07-25 | RealHid USB transport — implemented the hidapi transport (enumerate/open + single-owner I/O thread + inbound RUN_HOST_CMD reader); app auto-detects a board and falls back to MockHid. Compiles + falls back cleanly; awaiting a real board for bring-up. Only the physical human gate remains.
2026-07-26 | first real link + hot-plug — the app connected to a flashed board on first try. Reworked `RealHid` into a session-long supervisor (rescan/attach/detach) behind a new `BoardLink`, so connecting is no longer startup-only; added the `board-connection` event + `board_status` command. Fixed the keycode codec silently blanking keys on bare names (`"A"` → KC_NO). 26 Rust tests pass.
2026-07-26 | Save to Board fixed + gap audit — "Save to Board" only sent `eeprom_commit`, which persists the LED block the board already holds rather than pulling from the host, so it could never move keys or OLED; it now pushes keymap/LEDs/OLED/time first. That exposed the fact that live-sync-on-edit was never implemented. Audited the whole protocol surface against the editor → [[protocol-feature-gaps]]: solid colour is all protocol v1 carries, and the firmware has zero RGB effects compiled in.
2026-07-28 | device manager + macro libraries — pilot session turned the app from a single-board editor into a device manager: three-layer identity (`GET_IDENTITY`) with a hardware-keyed capability table, a home page device list, folder-style macro libraries, and shell-script macros that replaced the HOST BINDINGS UI outright. Audited persistence on request and found it was not true — per-key colours/icons/keymap were lost on restart without an active layer, and all devices shared one storage key; now one auto-saved blob per device. 53 Rust tests.
2026-07-29 | Present Keys, per-screen LEDs, image icons, font, alerts, release 0.1.0 — five new commands (`0x5C`-`0x60`), all closing gaps where the editor could express something the board had no way to hear: Present Keys on every screen showing icon/macro/keycode by priority plus the screen action it runs, per-screen LED profiles (the board had exactly ONE, so one screen's animation ran on all of them — unfixable host-side, the encoder navigates with no app involved), PNG/SVG icons as 32x32 masks, the font picker reaching the panel as a title scale, and red LED alerts for countdown-zero and pomodoro phase changes. Then the first shippable Windows build: the bundler had never actually run, and what it would have produced could not have loaded. 76 Rust tests, 11 Playwright suites.
2026-07-28 | Orbit rename + per-screen profiles + error log — renamed to Orbit / Lunar x MacroPad; device reset now resets the app too; every screen owns its keymap, colours and animation; error log with timestamp/message/source behind an instrumented `invoke`. Save to Board silently did nothing because a pomodoro reshape left the Rust struct behind and a `try/catch` swallowed the serde rejection — fixed, catch deleted, and a payload-boundary test added that parses literal frontend JSON.
2026-07-27 | protocol v1 closed + audit correction — shipped the three remaining v1 items: overlay off/on (`set_overlay` through transport → command → an App/Board header toggle), a global brightness slider feeding the `0xF0` byte, and a real part-scoped debounced live sync. Retracted the audit's firmware blocker: `qmk generate-config-h` proves eight effects were always compiled in from `keyboard.json` — the "only solid colour" symptom was 100% the overlay latch, not missing effects. 27 Rust tests pass.
