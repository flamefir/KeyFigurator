---
kind: doc
type: decision
domain: [config-app, hardware]
title: Chat on the OLED — Telegram connections + Connection Screens
status: draft
links: [protocol-feature-gaps, keymatrix-led-layout, decisions-log]
---

# telegram-chat-screens — a two-person chatroom on the panel

Goal: a chatroom lives in Orbit, its history renders on the board's OLED, and the
board keeps showing it with the app open. Home page grows a **Chatrooms** area
with **+ Create connection**; the editor grows a **Connection Screen** type, up
to **3**, each pointing at one connection through a dropdown.

Transport is **Telegram Bot API** — free, no server, no hosting, no inbound port,
works behind NAT with long polling. Chosen 2026-08-22.

---

## 1. The constraint that shapes the whole design

Two Telegram rules decide the topology before any of our code does:

1. **`getUpdates` is single-consumer.** Two processes polling the same bot token
   get HTTP **409 Conflict**, and whichever wins *consumes* updates the other
   will never see. A bot token can therefore live in exactly one Orbit install.
2. **A bot never receives messages from another bot.** So bot ⟷ bot relay — the
   obvious way to give both ends of a room their own bot — cannot work at all.

Everything below follows from those two.

### Chosen topology: one bot per connection, owned by one Orbit

```
   Orbit (owner)                    Telegram                     peer
   ┌──────────────┐   sendMessage   ┌──────────┐   private chat  ┌────────┐
   │ chat.rs      │ ──────────────► │  bot_A   │ ──────────────► │ any    │
   │  poller      │ ◄────────────── │          │ ◄────────────── │ client │
   └──────┬───────┘   getUpdates    └──────────┘                 └────────┘
          │ Raw HID
          ▼
   ┌──────────────┐
   │ Connection   │
   │ Screen (OLED)│
   └──────────────┘
```

The owner runs Orbit and a bot. The peer is a **human Telegram account** in a
private chat with that bot, on any Telegram client. That is a complete two-person
room, it needs nothing from the peer but Telegram, and it never double-polls.

### Rejected

| Option | Why not |
|---|---|
| Both sides run Orbit, one shared bot token | 409 + stolen updates. Rule 1. |
| Both sides run Orbit, one bot each, same group | Bots do not hear bots. Rule 2. |
| Group chat with both humans + one bot | Works, but needs `/setprivacy Disabled` and adds a group-admin step for no gain over a private chat at two people. Revisit for 3+. |
| Webhook instead of long polling | Needs a public HTTPS endpoint. Not free, not local. |
| Matrix / Discord / MQTT | All viable; Telegram was chosen. Recorded so the reason is "picked", not "only option". |
| userbot (MTProto, real account) | Would make both-ends-on-hardware work, but it is a ToS grey area and a much larger client. See §9. |

**Known limit, stated up front:** if *both* people own a macro pad, only the
connection owner's board shows the conversation. The peer's board cannot join the
same room. That is rules 1 and 2, not an implementation shortcut.

---

## 2. Pairing: the generated token

The user's model — "they share a generated token to set up the connection" — maps
onto Telegram's `start` deep-link payload exactly.

1. Owner pastes a **bot token** from @BotFather once per connection. Orbit calls
   `getMe` to validate it and learn `@botusername`.
2. Orbit generates a **pair code**: 8 chars, Crockford base32 alphabet minus
   `I L O U`, shown as `ORBIT-XXXX-XXXX`, plus a link
   `https://t.me/<botusername>?start=ORBITXXXXXXXX`.
   (Telegram's start payload allows `[A-Za-z0-9_-]`, max 64. Ours is 13.)
3. Owner sends the code or link to the peer out of band.
4. Peer opens the link (or DMs the bot `/start ORBITXXXXXXXX`). It arrives in
   `getUpdates`.
5. Orbit matches the code, records `peer_chat_id` + display name, **burns the
   code**, and the bot replies "Connected to <room>".

Rules that make the code worth anything:
- Single use. A second `/start` with the same code is rejected.
- Expires after **24 h**; regenerating is one click.
- **Any message from an unpaired chat id is dropped.** A stranger who finds the
  bot cannot inject into the room or reach the OLED.

### 2.1 Who owns the transcript

The **frontend** does, in `localStorage`, beside layers, screens and device
configuration. The backend delivers each message once as an event and keeps
none.

Not a convenience call. Everything the board is shown is assembled by
`buildOledConfig()` on the frontend, so a transcript owned by Rust would mean
two owners of one list and a second restore path to keep in step with the first.
The one thing the backend *does* persist is the poll **offset**, because that is
an acknowledgement to Telegram rather than data: losing it replays, inventing it
drops.

Consequences worth stating:
- A sent message is recorded only **after** Telegram accepts it. Recording it
  first would put a line in the transcript, and on the OLED, that nobody got.
- Chat only reaches the board when a device is open in the editor
  (`syncChatToBoard()`). Rooms keep receiving regardless; the board catches up
  on the next push.

## 3. Where the secret lives

The bot token is a credential: anyone holding it owns the bot.

- Stored **backend-side only**, in `connections.json` under Tauri's app-config
  dir. Never in `localStorage` — that is a plain file next to the web assets.
- The frontend never receives it after save. `redacted()` hands over id, name,
  `@botusername`, peer name, paired flag, and a masked tail.
- **Redacted from the error log.** The log panel is copy-pasteable by design and
  is the exact thing a user would paste into a bug report.
- Device export (`Export` on the home page) carries connections **without** bot
  tokens. An export is a shareable file.

---

## 4. Wire protocol additions

New screen type, joining the enum at the next free id:

```c
KF_SCREEN_CHAT = 8
```

Two new commands. Everything else reuses what exists — the room name goes out as
the screen **title** through `0x52 OLED_SET_TEXT` field 0, so there is no third
command for it.

```
0x62 CHAT_SET_LINE   req [slot, line_idx, origin, offset, len<=25, bytes...]
                     resp [status]
                     One history line for a chat screen. origin: 0 = peer,
                     1 = me. Header is 7 bytes, so a KF_CHAT_LINE_MAX line
                     always fits one frame; offset stays in the format so a
                     longer line is a change of constant, not of protocol.

0x63 CHAT_SET_STATE  req [slot, count, unread, flags]
                     resp [status]
                     count = how many of the pushed lines are valid, and the
                     commit point: the board renders nothing for a slot until
                     it arrives. count 0 clears the slot, which is how a
                     deleted connection stops showing an old conversation.
                     flags bit0 = LED ping on new message.
```

```c
#define KF_CHAT_LINES     8   /* history lines kept per chat screen */
#define KF_CHAT_LINE_MAX 20   /* 128px / (6 * scale 1) = 21, minus the origin marker */
```

RAM cost: `3 * 8 * 21 = 504` bytes. Cheap next to the 72 KB image buffer.

**The host wraps, the board draws.** Word-wrapping a UTF-8 Telegram message into
20-char lines is host work for the same reason Present Keys' labels and the key
icons are: the board's 5x7 font covers ASCII 32..126, it has no room for a
transliteration table, and the app already has the string. The board receives
lines that are already the right width and already ASCII.

`fold_to_ascii` + `wrap_ascii` + `ChatScreen::lines()` in `model.rs` do it. Three
rules that are not obvious until you hit them:

- **The 8-line cut happens after wrapping, not before.** Trimming to the last 8
  messages overflows the panel as soon as one of them wraps. Eight one-line
  messages and one nine-line message both fill it; only counting lines knows.
- **A message that folds away to nothing becomes `[?]`.** Emoji-only replies are
  common, and a message you cannot read is a different thing from no message.
- **A word wider than the panel is hard-split.** The board does no wrapping, so a
  URL that does not fit would be drawn straight off the edge.

## 5. Slot space, and a drift bug to fix on the way

Three chat screens is the first time the app allows **more than one screen of a
type**, so the counts move:

| Constant | Now | After | Why |
|---|---|---|---|
| `KF_MAX_CUSTOM_SCREENS` | 7 | 10 | 6 content + logo + up to 3 chat |
| `KF_SCREEN_SLOTS` | 11 | 14 | 4 layer + 10 custom |
| `KF_EVENT_COUNT` | 9 | 10 | `KF_EVENT_CHAT_MARK_READ` |
| `KF_LED_STATE_VERSION` | 5 | 6 | both array dims of `event_key[][]` move, and every field after them |
| `kf_protocol::SCREEN_SLOTS` | **10** | 14 | see below |
| `kf_protocol::OLED_MAX_CUSTOM_SCREENS` | 7 | 10 | |

`sleep_mask` is a `uint16_t` over the nav-index space. 14 slots still fit; **16
is the ceiling**, so the next multi-instance screen type has to widen it. Written
down here because nothing in the code says so.

**The drift bug:** the app's `SCREEN_SLOTS` is **10** while the firmware's
`KF_SCREEN_SLOTS` has been **11** since 0.4.6. The seventh custom screen's LED
profile is rejected by `BoardModel` and has no room in `screen_leds[]`. It ships
as phase 1 on its own, with a test that pins both numbers, so a real bug is not
buried inside a feature commit.

### 5.1 The EEPROM wall

This decided phase 1, and it took two rounds to get right. The numbers below are
**measured** — read out of the compiler with `char (*p)[EXPR] = 1;` probes — not
estimated. The first estimate was wrong by more than a factor of two and the QMK
build is what caught it, which is why nothing here is arithmetic done by hand.

```
kf_led_state_t                     83
kf_screen_leds_t               84 each
kf_nvm_t  now   (11 / 7 /  9)    1791   of EECONFIG_KB_DATA_SIZE 1792
kf_nvm_t  naive (14 / 10 / 10)   2285   of 1792        <-- 493 over
kf_nvm_t  shipped                1836   of 2048        <-- 212 spare
```

**There was one byte of headroom.** Not "room to add fields without moving the
layout again", which is what `config.h` claimed. Even the mark-read event on its
own — `KF_EVENT_COUNT` 9 → 10, nothing else — would have overflowed it, at 1802.

#### The 449 bytes that were never reachable

`kf_display_nvm_t` stored `custom_body[KF_MAX_CUSTOM_SCREENS][49]`: a body per
custom screen. A body is only ever drawn by `KF_SCREEN_CUSTOM_TEXT`, and the app
allows exactly one of those, so nine of ten slots could never be filled. It now
stores **one body plus the slot that owns it** (`custom_body_slot`, sentinel
`KF_NO_BODY_SLOT`), which is contained entirely inside
`kf_display_nvm_export/import` — bodies stay per-screen in RAM, where they cost
nothing. 2285 → **1836**.

That is what turned a 768-byte move into a 256-byte one.

#### What the block actually shares the EEPROM with

The first estimate assumed the macro buffer was everything left over after the
keymap. It is not: Vial's own features take **1192 bytes** before the macro
buffer gets any, and that is why 2560 failed to build at all.

| | at 1792 (before) | at 2048 (shipped) |
|---|---|---|
| eeconfig + VIA config + KB block | 1833 | 2089 |
| dynamic keymap (4 x 6 x 5 x 2) | 240 | 240 |
| encoder map (4 x 1 x 2 x 2) | 16 | 16 |
| Vial QMK settings | 40 | 40 |
| Vial tap dance / combos / key overrides / alt repeat | 1152 | 1152 |
| **Vial dynamic macro buffer** | **814** | **559** |

QMK asserts a floor of 100 bytes of macro buffer, so the ceiling for
`EECONFIG_KB_DATA_SIZE` is about **2506** as the build stands. 2560 was over it.

**The lever, if the macro buffer is ever needed back:** those 1152 bytes are four
Vial features (tap dance, combos, key overrides, alt repeat), none of which this
product uses through Orbit. Turning off the unused ones is worth far more than
anything left to squeeze out of `kf_nvm_t`. Not done here — it changes what Vial
offers, which is a product decision, not a slot-space one.

And every already-flashed board reads its stored keymap at the wrong offsets: it
must be reset and re-pushed. Two things make that cheaper than it sounds here —
0.5.0 bumps `KF_LED_STATE_VERSION` anyway, so the KeyFigurator block is falling
to defaults regardless, and Orbit re-pushes keymap, LEDs, screens and OLED config
on every connect. What is genuinely lost is **Vial macro content**, which Orbit
cannot re-push (that is the open `0x0B`/`0x0C` backlog item).

**Chat content is deliberately not persisted.** Three rooms of history would be
another 504 bytes, and a power-cycled board showing a conversation from last week
is worse than one showing an empty room. Lines are RAM-only and the app
re-pushes on connect, exactly like the rest of the OLED model was before 0.4.x.
The room *name* persists, because it is the screen title.

## 6. On-device behaviour

- **Render:** title = room name (existing font scale), then the newest
  `KF_CHAT_LINES` lines, `>` prefix on `origin == 1` (me), peer lines unprefixed.
  An unread count draws in the header as `(3)`.
- **Mark read:** encoder push on a chat screen, or a key bound to
  `KF_EVENT_CHAT_MARK_READ` (revision 1.0.0 has no encoder push soldered, which
  is exactly why event keys exist). Clears the badge locally and tells the host.
- **New-message alert:** `kf_alert_pulse_color(2, 0, 80, 255)` — two **blue**
  flashes. Not red: red is the countdown alarm and the pomodoro phase change, and
  a chat ping that looks like an alarm is a worse alert than none. Not amber
  either: amber is the control-key hint. Existing `kf_alert_pulse()` keeps its
  signature and delegates in red, so nothing already shipped changes.
  Per-connection opt-in via the `flags` bit.
- **Sleep:** a chat screen participates in the sleep mask like any other. A new
  message wakes the panel through `oled_note_activity()`.

## 7. Test plan

Rust, in-module `mod tests` per this repo's practice. **No test touches the
network** — the client splits into a thin HTTP call plus pure parse functions,
and the tests drive the parse half with captured fixtures.

**`telegram.rs`**
- a captured `getUpdates` body parses into messages: text, chat id, sender name, `update_id`
- offset advances to `max(update_id) + 1`; an empty result leaves it unchanged
- non-text updates (photo, sticker, edit) are skipped **and still advance the offset** — otherwise one sticker stalls the poller forever
- `/start ORBITXXXXXXXX` yields the payload; bare `/start` yields none
- 401 / 409 / 429 map to distinct errors, so the UI can say "token revoked" and "another Orbit is polling this bot" instead of one generic failure
- no error `Display` string, and no log line, contains the bot token

**`chat.rs`**
- pair code is 8 chars from the reduced alphabet; 1000 draws are unique
- an expired code does not pair
- a code pairs exactly once; a replayed `/start` is rejected
- a message from an unpaired chat id never becomes a `ChatMessage`
- store round-trips through JSON; `redacted()` output contains no `bot_token`
- the deep link is `https://t.me/<user>?start=<code>` and the payload is Telegram-legal

**`kf_protocol.rs`**
- `chat_line_frames` byte-exact for a short line
- a line longer than `CHAT_LINE_MAX` is truncated, never overrunning the report — the same class of bug `oled_text_len_bounded_by_the_report_not_just_the_buffer` already pins
- non-ASCII is folded before it reaches the wire
- `chat_state_frame` byte-exact; `count` above `CHAT_LINES` clamps
- `BoardModel` stores lines per slot and rejects `slot >= SCREEN_SLOTS`
- a screens list with 3 chat screens is accepted, 4 rejected
- **constant pin:** `SCREEN_SLOTS == 14`, `OLED_MAX_CUSTOM_SCREENS == 10`, quoting `kf_hid.h`

**`model.rs`**
- an `OledConfig` payload with no `chats` field still deserializes (every config saved before today)
- literal frontend JSON for a chat screen parses — the payload-boundary test pattern added after the pomodoro reshape silently broke Save to Board
- wrapping: a 200-char message becomes at most 8 lines of at most 20 chars, newest last, words unbroken where they fit

**`hid.rs`**
- `push_oled` with chats emits title, lines, then state, in that order, against `MockHid`
- a removed chat screen pushes `count = 0`, so a stale conversation cannot linger on the board

**Firmware:** QMK has no unit harness here. Gate is a clean
`qmk compile -kb macro_pad_pro -km vial`, plus a bench checklist (§8 phase 8)
recorded as hardware-domain backlog items. Same human gate as every other
LED/OLED change.

**Frontend:** no in-repo harness — the Playwright suites still live in a
scratchpad (existing backlog item). Chat logic that deserves testing
(`wrapChatLines`, slot mapping, the per-type cap) goes in pure functions so it
lifts into the harness unchanged when that lands.

## 8. Implementation order

Each phase is independently useful and independently verifiable. The ordering
rule: **prove Telegram before touching the wire, and prove the wire before
touching the board.**

| # | Phase | Repo | Done when |
|---|---|---|---|
| 0 | Branches + this doc | both | `feature/telegram-chat-screens`, `feature/chat-screen` |
| 1 | Constants + slot space, the 10-vs-11 fix, `EECONFIG_KB_DATA_SIZE` 1792 → 2048 (§5.1) | both | ✅ pinned both sides; NVM v6; fw compiles |
| 2 | `telegram.rs` — client, parsing, error mapping | app | ✅ 20 offline tests |
| 3 | `chat.rs` — connections, pairing, poller thread, Tauri commands + events | app | ✅ 18 tests |
| 4 | Home page **Chatrooms** + Create connection flow | app | ✅ 23 browser checks in `keyfigurator/tests/chat-ui.mjs` |
| 5 | Chat frames: `kf_protocol` + `model` + `hid::push_chats` | app | ✅ 29 tests; `MockHid` round-trips a conversation |
| 6 | Firmware: `KF_SCREEN_CHAT`, `0x62`/`0x63`, render, mark-read, blue pulse | firmware | ✅ fw 0.5.1; no NVM field moves (chat is RAM-only) |
| 7 | **Connection Screen**: screen type, cap of 3, connection dropdown, `"chat"` live-sync part, LED-ping toggle | app | ✅ 24 offline tests in `tests/chat-text.mjs`; preview verified byte-identical to the wire |
| 8 | Bench gate (human) | hardware | ⏳ recorded as backlog items, see below |

Phase 8 checklist:
- chat screen renders, `>` marks own lines, badge counts and clears
- three chat screens navigate and each shows its own room
- LED ping is blue and is not mistaken for the countdown alarm
- a board on NVM v5 upgrades to v6 by falling to defaults, and the app re-pushes
- bulk push (3 rooms x 8 lines = 27 frames) does not starve the display task

Versions at ship: firmware **0.5.1**, app **0.3.0**. The firmware moved in two
steps rather than one — **0.5.0** was the slot space and the NVM break (phase 1),
**0.5.1** is the commands and the rendering (phase 6). Chat content is RAM-only,
so phase 6 moved no NVM field and is a patch.

## 9. Open questions

- **Sending from the board.** v1 composes in the app; the board is read-only plus
  mark-read. Canned quick-replies bound to keys are the obvious next step and
  need no protocol change (a key runs a host binding that calls `chat_send`).
- **Both ends on hardware** needs something other than the Bot API. The honest
  options are a userbot (MTProto) or a small relay we host. Neither is v1.
- **Group rooms (3+).** The group topology in §1 covers it and needs only
  `/setprivacy Disabled` plus a sender-name prefix per line. Deferred until the
  two-person case is real.
- **Media.** Photos and stickers are skipped. A 128px panel showing a JPEG is
  possible through the existing QGF path, but there is one image buffer and it
  belongs to the GIF screen.

## Timeline
2026-08-22 | designed — Telegram chosen; the two Bot API rules (single-consumer
`getUpdates`, bots do not hear bots) fixed the topology at one bot per
connection with the peer on any Telegram client. Pairing rides the `start` deep
link. Found the app/firmware `SCREEN_SLOTS` drift (10 vs 11) while sizing the
slot space for 3 chat screens; it ships as phase 1 on its own. Then measured the
NVM blob and found it at **1791 of 1792** — one byte spare, against a `config.h`
comment claiming room to grow.
2026-08-22 | phase 1 shipped — slot space to 14/10/10 on both sides, app
`SCREEN_SLOTS` 10 → 14 (the drift fix) with two pin tests, firmware 0.5.0 with
NVM v6 and static asserts on both sides of the relationship. The EEPROM sizing
took two rounds: an estimated `2560` failed to build because Vial's own features
take 1192 bytes before the macro buffer sees any, and probing the compiler for
the real layout then showed 449 bytes of `kf_display_nvm_t` were bodies for
screens that can never have one. Deduplicating those brought the block to 1836
and the move to `2048` (§5.1). Firmware compiles clean; 124 Rust tests pass.
