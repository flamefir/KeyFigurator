---
kind: doc
type: decision
domain: [config-app, hardware]
status: adopted
links: [[keymatrix-led-layout]]
---

# Vial vs. a custom Tauri config app

**Decision:** Port the firmware to Vial for the free baseline, AND build a custom Tauri app
for the three things Vial structurally cannot do. Add a **Raw HID** command channel in
firmware *alongside* the Vial protocol — don't replace it.

## Why Vial alone isn't enough

Vial is an excellent open-source configurator (native + WebHID web app) that writes keymap
config to the board's flash in real time. Porting to it is worthwhile and nearly free, and
it's a credible tool to hand to buyers. But all three of our headline features live beyond it:

1. **Scripts / commands → a key.** A Vial macro is NOT a script. It has five primitives
   (tap, down, up, delay, beep) and only basic `KC_` keycodes. The keyboard is a USB HID
   device — it can only *type*, it cannot *execute*. "Bind a key to `git commit`" is
   impossible on the keyboard alone. It needs a **host-side program** that listens and runs
   the command.
2. **A git control layer.** Layers themselves are Vial-native; switching into a dedicated
   "git layer" is free. But keys that run real git commands must fire a **Raw HID packet**
   the host app catches and acts on — not a Vial macro.
3. **True per-key LED control.** Our LEDs are RGB Matrix (per-key SK6812MINI-E) + RGBLIGHT
   underglow. Vial's GUI exposes global effect/brightness/color well, but arbitrary per-key
   static colors ("key 4 red, key 7 blue, rest off") are historically weak/absent in the
   Vial GUI. Closing that gap is our app's job.

## The architecture

- **Firmware:** Vial port (baseline) + a Raw HID command channel. A key on a custom layer
  sends a packet like `{"cmd":"git-commit"}` instead of typing.
- **Host (Tauri app):** Rust backend owns the HID transport (reads/writes Raw HID); web
  frontend owns the editor UI. Frontend → Rust command → Raw HID → keyboard.
- **Division of labor with Vial:** users can still use Vial for ordinary remapping. Our app
  is for the power features. We are NOT reinventing Vial; we're adding the layer above it.

## Why this is good for the project narrative

It gives the companion app a real reason to exist (not "we rebuilt Vial"). "A physical git
control surface" and "real per-key lighting designer" are strong Hackaday/YouTube hooks.

## Timeline
2026-06-23 | chat — boundary worked out; Vial = baseline, Raw HID + Tauri = differentiators.
