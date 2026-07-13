## Summary

<!-- what changed and why -->

## Test plan

- [ ] `cargo test` passes (backend, CI-enforced)
- [ ] `npm run build` + Playwright smoke test pass (frontend, CI-enforced)

### Human hardware gate

CI can only verify the app against `MockHid` - it has no board to plug in.
If this PR touches anything that behaves differently on real hardware
(`RealHid`, the Raw HID wire protocol, OLED config push, keymap/LED sync,
`HOST(n)` execution), check the ones that apply and get them verified on a
flashed board before merging:

- [ ] Board still enumerates (VID `0xFEED` / PID `0x4D50`) and connects
- [ ] Keymap read/write round-trips correctly
- [ ] LED/underglow sync matches what's shown in the app
- [ ] OLED screens render and the encoder navigates/interacts as expected
- [ ] `HOST(n)` keys fire the correct binding
- [ ] N/A - this PR has no hardware-visible behavior change
