---
kind: doc
type: analysis
domain: [config-app, hardware]
title: App ⟷ firmware feature gaps (protocol v1 audit)
status: adopted
links: [keymatrix-led-layout, vial-vs-custom-config-app]
---

# protocol-feature-gaps — what actually crosses the wire

Audit run 2026-07-26, after the first successful hardware link, prompted by an
observation on the bench: **the board only ever shows solid colour.** That is not
a bug. It is the entire designed surface of protocol v1.

The LED editor renders 7 animations, rate/intensity, and cycle palettes in
JavaScript for the app's own preview. `buildLedState()` sends the *base colour*
per key and per corner and nothing else, so every animation collapses to its
base colour on the board. Same story for most of the OLED and encoder editors.

This doc is the reference for what is real and what is preview. See
[[keymatrix-led-layout]] for the index contract the wire uses.

## Fully wired (app ⟷ protocol ⟷ firmware)

PING / version negotiation · `GET/SET_KEYMAP` (4 layers × 21 keys, persists by
itself through QMK dynamic keymap) · `SET_LEDS` colour data (25 slots) ·
`EEPROM_COMMIT` · OLED layer titles + `show_title` · OLED screen list + types ·
OLED custom text · OLED countdown *duration* · OLED time sync · inbound
`RUN_HOST_CMD` → `runner.rs` → `host-cmd` event.

Confirmed on hardware: keycode assignment, per-key LED colour, underglow colour.

## In the protocol, but the app never sends it

| Gap | Where | Effect |
|---|---|---|
| Overlay off/on (`0xF1`/`0xF2`) | `kf_protocol::overlay_frame` is dead code | Colour data sets `overlay_on = 1` in firmware and there is **no path back** — once the app pushes LEDs the board is locked to static colour until an EEPROM reset |
| Brightness (`0xF0`) | `buildLedState()` hardcodes `brightness: 255` | Plumbed through `hid.rs::set_leds`, firmware scales every channel by it, nothing feeds it. There is no global brightness control in the UI; the RATE/INTENSITY sliders are animation parameters, not this |

The overlay one is an outright bug rather than a missing feature.

## In the app, with no wire representation at all

| App feature | App state | Wire |
|---|---|---|
| 7 animations (solid, rainbow, snake, breathe, wave, reactive, sparkle) | `keyAnimStates[]`, `ugAnimation` | none |
| Rate / intensity, per-key + underglow | `klRate/klIntensity`, `ugRate/ugIntensity` | none |
| Cycle palettes | `klPalette`, `ugPalette`, per-key `palette[]` | none |
| Per-key icons + images | `keyIconLabels`, `keyIconImages` | none |
| OLED font picker | `oledFontId` | none |
| Encoder mode (layer / scroll) | `encoderMode` | none |
| OLED back key | `oledBackKeyIdx` | none |
| OLED event keys | `oledEventKeys` | none |
| OLED screen images | `oledCustomScreens[].imageDataUrl` | `0x52` carries text only |
| Timer / countdown start-stop-reset | `oledTimerRunning`, `oledCdRunning` | duration only (`0x53`) |

## The firmware blocker underneath the LED gap

`keyboards/macro_pad_pro/config.h` has **zero** `ENABLE_RGB_MATRIX_*` effect
defines. `RGB_MATRIX_DEFAULT_MODE` is `RGB_MATRIX_SOLID_COLOR` and that is all
that is compiled in. So even if the app sent an overlay-off today, the board has
nothing to fall back to but solid colour. **Firmware effects have to be enabled
before any animation protocol work is worth doing.**

## Open design question (decide before building animations)

QMK's RGB matrix effects are **global** — one mode for the whole board. The app's
model is *per-key* animation state. Those do not reconcile directly. Two routes:

1. **Board-side animation** — app sends mode/rate/intensity, firmware runs a QMK
   effect. Cheap, robust, survives USB disconnect. Loses per-key animation.
2. **Host-driven frames** — overlay stays on, the app streams colour frames at
   some frame rate. Keeps per-key animation and exact parity with the preview.
   Costs continuous USB traffic, dies when the app closes, and needs the LED
   chunking to be fast enough for a usable frame rate (25 slots = 3 frames per
   update today).

Not decided. Route 1 for a v2 `SET_ANIM` command is the conservative default;
route 2 is what the app's current editor model actually implies.

## Sequencing

1. Overlay off + brightness — protocol v1 as it stands, no firmware change.
2. Firmware RGB effects, then the animation command (protocol v2, bump
   `PROTOCOL_VERSION`, mirror in `kf_hid.h` + `kf_protocol.rs`).
3. OLED extras (font, images, timer transport) + encoder mode — independent,
   one new command each.
4. Icons / OLED key assignments — first decide whether they are app-only
   concepts. The firmware's Present Keys screen derives labels from the dynamic
   keymap, so per-key icons may be intentionally host-side.

## Timeline
2026-07-26 | audit written after the first hardware link, triggered by "only solid colour works" on the bench.
