# Orbit

The **Lunar x MacroPad** configuration app (Tauri). Does what Vial can't: bind keys to
real host commands (git/shell), and true per-key LED control. Talks to the board over
**Raw HID**, alongside Vial. See `../docs/vial-vs-custom-config-app.md` for the why.

Installing it: see the [root README](../README.md).

## Architecture

```
frontend (src/, vanilla JS + Vite)
   │  invoke()
   ▼
Tauri commands (src-tauri/src/main.rs)
   │
   ├── model.rs     keymap + per-key LED state + host bindings
   ├── hid.rs       HidTransport trait → RealHid (hidapi) | MockHid (tests, browser)
   ├── runner.rs    runs a bound host command (the git/shell feature)
   ├── keyrec.rs    macro keystroke recorder (Windows low-level keyboard hook)
   └── qgf.rs       image → Quantum Painter format, for OLED image screens
```

The whole app talks to the keyboard ONLY through the `HidTransport` trait. `RealHid`
drives an attached board; `MockHid` is an in-memory fake that is always "connected", so
the entire UI stays buildable and testable with **no hardware**. `npm run dev` (browser)
uses a JS-side stub for the same reason.

## Run it

Prereqs: Rust + the Tauri v2 prerequisites for your OS, Node 18+.

```bash
npm install
npm run tauri dev      # full app (Rust backend + webview)
# or, frontend only (browser, uses an in-memory JS stub — no Rust needed):
npm run dev
```

## Test it

```bash
cd src-tauri && cargo test     # unit tests: model serde, mock roundtrip, runner
```

There are real tests on the parts that matter without hardware: the data model
round-trips, the mock transport behaves, and the host-command runner actually runs a
command and reports exit/stdout/stderr.

## Verification carve-out (read this)

Standard harness verifies features by driving a browser. Two deviations:
1. **Tauri, not browser** — drive the frontend + run `cargo test` on the backend.
2. **Hardware-in-the-loop is a HUMAN step** — "the RGB actually changed on the board"
   can't be auto-verified, so the physical check is a human gate before merging.

## Macro recorder

Records a macro by performing it, rather than hand-writing `TAP`/`DOWN`/`UP` lines.

It reads from two sources, because neither alone is complete:

| Source | Covers | Why |
|---|---|---|
| Win32 `WH_KEYBOARD_LL` hook (`keyrec.rs`) | everything outside Orbit | sees Alt+Tab, the Windows key — combos the OS claims before any app |
| DOM `keydown`/`keyup` | everything inside Orbit | the hook does not deliver keys landing in Orbit's own window |

Merged on a shared clock and deduplicated, so a key seen by both is recorded once.

**The hook is installed only between Record and Stop.** It is torn down on Stop, on
closing the editor, and on app load if one survived a webview reload. It never swallows
input, and it ignores injected events so testing a macro cannot record itself. Nothing
captured is written to disk or leaves the process.

Windows only — the hook is Win32. Elsewhere the commands report that rather than
silently recording nothing.
