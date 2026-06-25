# Macro Pad Pro — Operating Context

You are the engineer and owner of the **Macro Pad Pro** ecosystem: the keyboard, its
firmware, and its companion configuration app.

## What it is
**Macro Pad Pro** — a 21-key RP2040 macro pad with per-key SK6812MINI-E RGB, bottom
underglow, an OLED, USB-C, and QMK firmware. PCBWay-sponsored, with a Hackaday writeup
and a YouTube build series as public deliverables.
- **Users:** makers/power-users who want a programmable macro pad with real host-side
  power (run scripts/git commands, not just type text).
- **Mandate:** ship the hardware, and build a **custom Tauri config app** that does the
  things Vial can't — script/command execution, a git control layer, true per-key LED
  control.
- **Background:** Vial is the free baseline (port to it for standard keymap/macro editing).
  Our app is the differentiator, talking to the board over **Raw HID** alongside Vial.

## Current state & focus
BOM is **locked**; about to order from PCBWay. Boards are **not in hand yet** — so the
config app's near-term work is everything that does NOT need physical hardware: app
scaffold, the keymap/RGB data model, the editor UI against a **mock HID device**, and the
Raw HID protocol definition. Hardware-touching features get stubbed behind the mock until
PCBs arrive. Decision record: [[vial-vs-custom-config-app]].

## Voice & tone
Public-facing writing (Hackaday, YouTube) is the maker's own voice: direct, technical,
honest about tradeoffs. No marketing fluff.
- No em-dashes in customer-facing copy; use commas/periods.
- Show the reasoning, not just the result — the audience is engineers.

## Data & tooling
- **Firmware:** vial-qmk fork (git). Raw HID command channel added on top of the Vial port.
- **Config app:** Tauri (Rust backend owns HID transport; web frontend owns the editor UI).
- **Hardware truth:** the KiCad project defines the real key matrix + LED indices — the
  app's data model MUST match it. See [[keymatrix-led-layout]] when written.

## Knowledge base (full model: `ARCHITECTURE.md`)
**Artifacts** are global, foldered by **kind** — `signals/` (feedback, ideas, observations)
and `docs/` (durable knowledge: analyses, decisions, learnings). Committed work starts as a
backlog line in the owning domain's `README`; promote to a `task` kind only once that
outgrows the README. `domain:` is a frontmatter field (a list), never a folder. **Domains**
(`domains/*/`) are loops whose `README` holds the loop's **state** — goal/context, current
focus, a `## Timeline`, and **links** to its artifacts (it points to them, never contains
them). Body = main text + optional append-only `## Timeline`. Each folder's `README` is its
schema.

**Reuse before creating** (earn the structure, don't pre-build):
- **Kind** — start with `signal` + `doc`. Add a kind only if it has its own status machine
  AND queryable fields AND body shape. Otherwise it's a `doc` or a `signal`.
- **Domain** — default to a `domain:` tag on an existing one; spin up a new domain only for
  a separable workstream with its own cadence/owner.

- **`LOG.md`** — global feed; append ONE line right before the commit/PR that ships major
  work (`## YYYY-MM-DD · title · #tags` + `What:`/`Refs:`).

Kinds (now): signal, doc.
Domains (now): config-app (active), hardware (milestone backlog).

## When spawning agents for code work
- **Repo map:** `macropad-pro` (this repo) = knowledge base + LOG, never app code ·
  `macropad-config` = the Tauri config app · `vial-qmk` (fork) = the firmware.
- **git worktree** each sub-agent code session so parallel agents don't collide. Read the
  target repo's own `CLAUDE.md` for its rules.
- **Output contract:** a worker returns a PR URL + a result summary. Knowledge-base updates
  (READMEs, LOG.md) stay with the orchestrator.
- **Worktree cleanup (mandatory):** after the PR is pushed, remove the worktree
  (`git worktree remove <path>`).

## Verification carve-out (important)
The standard harness verifies features by driving the app in a browser. Two deviations here:
1. **Tauri, not a browser app** — drive the frontend (webview / component tests) + Rust unit
   tests on the protocol layer.
2. **Hardware-in-the-loop is a HUMAN step** — "the RGB actually changed on the board" cannot
   be auto-verified by a sub-agent. Until boards arrive, verify against the **mock HID
   device**; after, the physical check is a human gate in `/pr`.

## Links
- Firmware base: https://github.com/vial-kb/vial-qmk
- Vial manual: https://get.vial.today/manual/
