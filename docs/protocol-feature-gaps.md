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

## The firmware blocker underneath the LED gap — RETRACTED 2026-07-27

> The original audit claimed `config.h` has **zero** `ENABLE_RGB_MATRIX_*`
> defines and that firmware effects therefore had to be enabled before any
> animation work. **That was wrong**, and it was wrong in a way worth recording:
> it read `config.h` alone and missed QMK's data-driven build.

`keyboards/macro_pad_pro/keyboard.json` declares eight effects under
`rgb_matrix.animations`, and `lib/python/qmk/cli/generate/config_h.py`
(`generate_led_animations_config`) turns each one into an
`ENABLE_RGB_MATRIX_<NAME>` define in the generated `info_config.h`. Verified by
running `qmk generate-config-h -kb macro_pad_pro`: all eight defines are
emitted. `config.h` is bare here **by design**, not by omission.

The two effects with extra prerequisites are handled too — QMK's
`quantum/rgb_matrix/post_config.h` derives `RGB_MATRIX_KEYPRESSES` from the
reactive `ENABLE_*` defines and `RGB_MATRIX_FRAMEBUFFER_EFFECTS` from the
typing-heatmap one, so nothing is silently dropped.

**There is no firmware blocker.** The board has had a full effect set compiled in
the whole time. The reason the bench only ever showed solid colour is entirely
the overlay bug in the row above: the app pushes colours, the firmware latches
`overlay_on = 1`, and `kf_led_overlay_render()` paints over every running effect
with no path back.

The one real firmware gap was **coverage**, not existence: two of the app's seven
animations had no board-side counterpart. Fixed 2026-07-27 by adding `riverflow`
(backs snake — it flows along chain index, which is what the app's snake does)
and `pixel_rain` (backs sparkle). The full mapping now lives as a comment in
`config.h` next to `RGB_MATRIX_DEFAULT_MODE`:

| App animation | Firmware effect |
|---|---|
| solid | `SOLID_COLOR` |
| rainbow | `CYCLE_ALL` |
| breathe | `BREATHING` |
| wave | `CYCLE_LEFT_RIGHT` |
| reactive | `SOLID_REACTIVE_SIMPLE` |
| snake | `RIVERFLOW` |
| sparkle | `PIXEL_RAIN` |

`RAINBOW_MOVING_CHEVRON`, `TYPING_HEATMAP` and `SOLID_REACTIVE` are also compiled
in with no app counterpart — spare capacity for protocol v2, not a gap.

## RESOLVED 2026-07-27 — route 1, animation is global

The open question below was settled by resetting the goal: the app **simulates**
how the board will look, and pushing makes the board show it. Frame-exact parity
was never the requirement.

That picks **route 1** and deletes the entire cost of route 2 — no fire-and-forget
transport rework, no host-side frame pacing, no fighting the OLED's ~34 ms
blocking full-screen redraw. Protocol v2 is one command, `SET_ANIM`
(`[anim, speed, h, s, v]`), rather than a subsystem.

The cost is the one thing route 1 cannot express: **per-key animation**. Per-key
*colour* still crosses the wire exactly. The editor was collapsed to a single
global animation to match, so the preview cannot promise what the board will not
reproduce.

Two implementation notes worth keeping:
- The wire carries **KeyFigurator anim ids, never QMK effect numbers**. QMK builds
  `rgb_matrix_effects` from whichever effects are compiled in, so those numbers
  shift the moment `keyboard.json` changes. `kf_anim_to_mode()` owns the mapping.
- `ANIM_SOLID` is not an effect. It means "render the colours the host pushed",
  i.e. the overlay. This is what makes the animation picker subsume the separate
  overlay control instead of the two fighting over one firmware flag.

If per-key animation is ever revisited, VialRGB (already vendored in the fork)
implements route 2 as a *selectable mode* — `vialrgb_direct_fastset`, 9 LEDs per
packet, rendered by a normal `VIALRGB_DIRECT` effect. Copy that shape.

## Open design question (historical — resolved above)

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

1. ~~Overlay off + brightness~~ — **done 2026-07-27**, plus live-sync-on-edit.
   Protocol v1 as it stands, no firmware change.
2. The animation command (protocol v2, bump `PROTOCOL_VERSION`, mirror in
   `kf_hid.h` + `kf_protocol.rs`). No longer gated on firmware work — the
   effects are compiled in and every app animation now has a counterpart. The
   open design question below is the only thing left to settle.
3. OLED extras (font, images, timer transport) + encoder mode — independent,
   one new command each.
4. Icons / OLED key assignments — first decide whether they are app-only
   concepts. The firmware's Present Keys screen derives labels from the dynamic
   keymap, so per-key icons may be intentionally host-side.

## Timeline
2026-07-26 | audit written after the first hardware link, triggered by "only solid colour works" on the bench.
2026-07-27 | firmware blocker retracted — the "zero effects compiled in" finding was an artefact of reading `config.h` without QMK's data-driven generation; eight effects were always compiled in. Added `riverflow` + `pixel_rain` so all seven app animations have a board-side counterpart. Overlay off/on, brightness, and live sync shipped, so step 1 is closed and step 2 is unblocked.
