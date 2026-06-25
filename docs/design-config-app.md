---
kind: doc
type: design
domain: [config-app]
status: draft
links: [[decisions-log]] [[vial-vs-custom-config-app]]
---

# KeyFigurator — config app design brief

The design intent for the KeyFigurator UI. The current build is a plain key grid (functional,
ugly). This brief is the target: a UI that renders the **real Macro Pad Pro board** and makes
assigning keys/macros/layers feel easy, intuitive, and smart. Written so a fresh Claude Code
session inherits the intent and can iterate against it.

> Aesthetic judgement is human-verifiable only. Claude Code can verify the board RENDERS, all
> inputs are present and positioned, clicking assigns, and layers switch — but "does it look
> good" is graded by Malte. Build to the checkable sub-goals below; iterate on look with a
> human in the loop.

## The board (ground truth — render THIS, not a uniform grid)

20 keys + 1 encoder (rotary, with push) = **21 addressable inputs**. A central OLED sits in
the middle, keys wrap around it. Physical layout, row by row:

```
Row 1:  [ / ] [ * ] [ - ] [ + ]  (◉ encoder, upper far right)
Row 2:  [ 7 ]  ┌──────────────┐  [ 4 ]
Row 3:  [ 1 ]  │    OLED      │  [ 9 ]
Row 4:  [ 6 ]  │  (center)    │  [ 3 ]
               └──────────────┘
Row 5:  [ 0 ] [ ↑ ] [ 2 ] [ 5 ] [ 8 ]
Row 6:  [ ← ] [ ↓ ] [ → ] [ . ] [ ↵ ]
```

- The OLED spans the middle columns of rows 2–4 (occupies the center, keys 7/1/6 to its left,
  4/9/3 to its right).
- The encoder is top-right of row 1, to the right of the `+` key. It is NOT a keycap — render
  it as a knob. It has THREE assignable actions: rotate-CW, rotate-CCW, push.
- Key positions/sizes are uniform keycaps except where the layout shows otherwise. Use the
  KiCad PCB switch positions as the final source of truth if they differ from this sketch.

## Visual direction (match the board render)

- **Palette:** near-black background (#15171c-ish), warm **amber** accent (#ffb454-ish) for
  active/highlight, soft amber glow around the active layer / selected key. This is already the
  app's accent — lean into it.
- **Keycaps:** realistic-ish — subtle top-face highlight, slight bevel/shadow so they read as
  physical caps, not flat rectangles. Legends in a clean mono or condensed sans.
- **OLED:** rendered as a real screen panel — dark, amber pixel-style text, showing the current
  layer's OLED content (see OLED designer below). Looks lit.
- **Encoder:** a knob with an indicator notch; subtle ring; reads as turnable.
- **Overall:** dark, focused, a little "device-like". The board is the hero of the Keys tab —
  big and centered, not a small grid in the corner.

## Interaction model (easy, intuitive, smart)

- **Click a key on the board → it becomes selected** (amber ring + glow). A side/below panel
  shows what's assigned and lets you change it.
- **Assigning a keycode:** BOTH a searchable/typed input (fast for power users) AND a browsable
  categorized palette (letters, numbers, nav, media, layers MO()/TG(), macros, HOST(n)).
  Clicking a palette entry assigns it to the selected key. Typing with autocomplete also works.
- **Layers:** the Layer 0–3 switcher stays, but make the active layer obvious (amber). Keys that
  are transparent/KC_NO on a layer should look visibly empty vs assigned.
- **Encoder:** clicking the knob selects it; the panel then offers three slots (CW / CCW / push)
  to assign actions to.
- **Live feel:** selecting a key and assigning should feel instant. LED colors assigned to a key update on the board immediately (no button needed) — this is not cosmetic, the board LEDs reflect the current state in real time via Raw HID to RAM.
- **"Save to board"** — replaces "Push to board". Commits the active profile to EEPROM so it survives power cycles. Explicit, infrequent action; not required for live use.

## Saved Boards (top-right hover dropdown)

A breathing-orange pill button fixed to the top-right corner of the app (below the titlebar). On hover/click it drops down a panel — not a tab, stays out of the way of the key editor.

Dropdown contents:
- List of saved profiles by name (user-named, e.g. "Work", "Gaming", "Git layer")
- **Load** — apply a profile to board RAM immediately; board reflects it live
- **Delete** (✕ per row)
- Footer: name input + **Save to board** button — saves the current state to localStorage AND commits to board EEPROM

Design: same breathing orange glow animation as the old "Push to board" button. Dropdown: dark panel (#1a1c22), amber accents, rounded corners, consistent with the rest of the app.

## OLED designer (new feature — the app designs the screen too)

Per layer, the user configures what the OLED shows. From the render, the OLED has: a small
layer indicator + name line ("LAYER 01"), a big title ("NUMPAD"), a content grid/area, and a
status line ("ENC · SCROLL" left, "USB ●" right). The app should let the user set at least:
the layer title, and the status-line hints. Start simple (title + status text per layer);
richer layouts later.

## Data model changes this implies (update model.rs)

- **Encoder:** add an encoder input with three assignable actions (cw / ccw / push) per layer.
- **OLED config:** add a per-layer OLED struct: `title: String`, `status_left: String`,
  `status_right: String` (extend later). One per layer.
- Keep the existing per-key keycode model; just make sure key ORDER/indexing matches the
  physical layout above and the KiCad matrix (document in docs/keymatrix-led-layout.md).

## Checkable sub-goals (Claude Code can self-verify these)

1. Board renders with all 20 keys in the correct row/column positions + the encoder top-right +
   the OLED in the center. (Visual check: screenshot matches the layout sketch.)
2. `cargo test` still passes after model.rs changes (encoder + OLED structs serde-roundtrip).
3. Clicking a key selects it; assigning a keycode updates it; switching layers shows different
   assignments. (Drive the frontend.)
4. The app still builds and boots (`npm run tauri dev`).
5. No regression: "Push to board" still calls set_keymap without error against the mock.

## Out of scope for the first pass
- Pixel-perfect cloning. Match the STRUCTURE + vibe; exact shadows can iterate.
- Real hardware. Mock transport only until boards arrive.
- LED designer polish — that's its own tab/pass.

## Timeline
2026-06-23 | chat — brief written from Malte's board render; 20 keys + encoder(push) + center OLED; amber/dark; palette+search assignment; OLED designer added.
2026-06-25 | chat — "Push to board" replaced by live-sync + "Save to board" (EEPROM only); "Saved Boards" top-nav tab added for profile management.
