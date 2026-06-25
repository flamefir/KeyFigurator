# macropad-config

The Macro Pad Pro companion config app (Tauri). Does what Vial can't: bind keys to
real host commands (git/shell), and true per-key LED control. Talks to the board over
**Raw HID**, alongside Vial. See `../docs/vial-vs-custom-config-app.md` for the why.

## Architecture

```
frontend (src/, vanilla JS + Vite)
   │  invoke()
   ▼
Tauri commands (src-tauri/src/main.rs)
   │
   ├── model.rs     keymap + per-key LED state + host bindings
   ├── hid.rs       HidTransport trait → MockHid (now) | RealHid (when boards arrive)
   └── runner.rs    runs a bound host command (the git/shell feature)
```

The whole app talks to the keyboard ONLY through the `HidTransport` trait. Today it uses
`MockHid` (an in-memory fake board, always "connected"), so the entire UI is buildable and
testable with **no hardware**. When PCBs arrive, implement `RealHid` (hidapi) and swap one
line in `main.rs`. Nothing above the trait changes.

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
   can't be auto-verified. Until boards arrive, verify against `MockHid`; after, the
   physical check is a human gate.

## When boards arrive — the swap

1. Set real `VENDOR_ID` / `PRODUCT_ID` in `hid.rs` (from your QMK `config.h`).
2. Implement `RealHid::open()` + the trait methods using `hidapi` (uncomment in Cargo.toml).
3. In `main.rs`, replace `Box::new(MockHid::new())` with the real device.
4. Firmware: add the Raw HID command channel (`raw_hid_receive`) + a `HOST(n)` keycode
   that sends a `RunHostCmd` packet. Document the real key/LED indices in
   `../docs/keymatrix-led-layout.md` and make `model.rs` match.
