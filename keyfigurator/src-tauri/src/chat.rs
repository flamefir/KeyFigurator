//! Chat connections: the store, pairing, and the per-connection poller.
//!
//! A **connection** is one two-person room: a Telegram bot this Orbit owns, and
//! one paired peer chatting to it from any Telegram client. `telegram.rs` is the
//! wire; this is the state machine on top of it.
//!
//! ## What lives where
//!
//! | | owner |
//! |---|---|
//! | bot token, peer id, pair code, poll offset | here, on disk, backend-only |
//! | message history | the **frontend**, in localStorage |
//!
//! History is deliberately not kept here. Everything the board is shown is built
//! by the frontend (`buildOledConfig()`), and layers, screens and device
//! configuration already live in localStorage — putting the transcript anywhere
//! else would mean two owners of the same list and a second restore path to keep
//! in step. The backend delivers each message once, as an event, and forgets it.
//!
//! What the backend does keep is the poll **offset**, because that is an
//! acknowledgement to Telegram rather than data: losing it replays whatever the
//! API still holds, and inventing it drops messages.
//!
//! ## Threads
//!
//! One poller thread per connection, each blocking up to `LONG_POLL_SECS` in
//! `getUpdates`. That shape matches the rest of this app — `RealHid` supervises
//! USB on its own thread, `runner` shells out on another — and it is why
//! `telegram.rs` is a blocking client.
//!
//! **The lock is never held across a request.** A poller takes what it needs,
//! releases, blocks on the network for 25 seconds, then re-acquires to record
//! the result. Holding it would freeze every Tauri command for the duration.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::telegram::{start_payload, ChatError, IncomingMessage, TelegramApi};

/// How many rooms one install can hold. Higher than the three Connection
/// Screens on purpose: a room is useful in the app without a screen bound to it,
/// and each one costs a thread that is idle 99% of the time.
pub const MAX_CONNECTIONS: usize = 8;

/// Crockford base32 — the digits and letters, minus `I L O U`. Those four are
/// the ones people mistype when copying a code off a screen into a phone.
const PAIR_ALPHABET: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
pub const PAIR_CODE_LEN: usize = 8;
/// A code is single-use, so this is a backstop rather than the security. Long
/// enough to send someone a code and have them get to it tomorrow.
pub const PAIR_CODE_TTL_SECS: u64 = 24 * 60 * 60;
/// Telegram start payloads are `[A-Za-z0-9_-]`, so the prefix has to stay inside
/// that set. It also makes a code recognisable as ours in a chat log.
const PAIR_PREFIX: &str = "ORBIT";

/// After a failed poll, how long before trying again. Long enough not to hammer
/// a bot whose token was revoked, short enough that a dropped wifi link
/// recovers without the user doing anything.
const RETRY_SECS: u64 = 10;

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/// One room, as persisted. **Contains a credential** — see `ConnectionView` for
/// the shape the frontend is allowed to see.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Connection {
    pub id: String,
    /// The room name. Doubles as the Connection Screen's title on the board.
    pub name: String,
    /// From BotFather. Never leaves this process.
    pub bot_token: String,
    pub bot_username: String,
    /// Set once pairing completes. `None` means nobody has joined yet, and
    /// every inbound message that is not a matching `/start` is dropped.
    #[serde(default)]
    pub peer_chat_id: Option<i64>,
    #[serde(default)]
    pub peer_name: String,
    /// The outstanding invitation, if one is waiting to be used.
    #[serde(default)]
    pub pair_code: Option<String>,
    #[serde(default)]
    pub pair_expires: u64,
    /// Flash the board blue when a message arrives. Off by default: an alert
    /// nobody asked for is worse than no alert.
    #[serde(default)]
    pub led_ping: bool,
    /// `getUpdates` acknowledgement point. Persisted because it belongs to
    /// Telegram's delivery state, not to ours.
    #[serde(default)]
    pub offset: i64,
}

impl Connection {
    pub fn is_paired(&self) -> bool {
        self.peer_chat_id.is_some()
    }
}

/// A connection as the frontend sees it: everything needed to render a card,
/// and no credential.
///
/// A separate type rather than `#[serde(skip)]` on the token, because skipping
/// is a property of one field that a later edit can silently undo. This cannot
/// carry a token: there is no field for one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConnectionView {
    pub id: String,
    pub name: String,
    pub bot_username: String,
    pub peer_name: String,
    pub paired: bool,
    /// Last four characters of the token, so a user with several bots can tell
    /// which is which without the app ever showing the whole thing.
    pub token_tail: String,
    pub pair_code: Option<String>,
    pub pair_link: Option<String>,
    pub pair_expires: u64,
    pub led_ping: bool,
}

impl From<&Connection> for ConnectionView {
    fn from(c: &Connection) -> Self {
        let tail: String = c.bot_token.chars().rev().take(4).collect::<Vec<_>>()
            .into_iter().rev().collect();
        Self {
            id: c.id.clone(),
            name: c.name.clone(),
            bot_username: c.bot_username.clone(),
            peer_name: c.peer_name.clone(),
            paired: c.is_paired(),
            token_tail: tail,
            pair_link: c.pair_code.as_ref().map(|code| pair_link(&c.bot_username, code)),
            pair_code: c.pair_code.clone(),
            pair_expires: c.pair_expires,
            led_ping: c.led_ping,
        }
    }
}

/// What a poller thread reports. Drained in `main.rs`, where an `AppHandle`
/// exists, and re-emitted to the UI — the same shape `RealHid` uses for board
/// attach/detach and inbound host commands.
#[derive(Debug, Clone, PartialEq)]
pub enum ChatEvent {
    /// A message from the paired peer.
    Message { connection_id: String, from: String, text: String, at: i64 },
    /// Pairing completed. The UI swaps the invite card for a live room.
    Paired { connection_id: String, peer_name: String },
    /// The poller's health changed. `error` is `None` while it is working.
    Status { connection_id: String, error: Option<String> },
}

pub fn pair_link(bot_username: &str, code: &str) -> String {
    format!("https://t.me/{bot_username}?start={code}")
}

/// `ORBIT7K2M9QX4` on the wire, shown as `ORBIT-7K2M-9QX4`.
pub fn format_pair_code(code: &str) -> String {
    let body = code.strip_prefix(PAIR_PREFIX).unwrap_or(code);
    if body.len() == PAIR_CODE_LEN {
        format!("{PAIR_PREFIX}-{}-{}", &body[..4], &body[4..])
    } else {
        code.to_string()
    }
}

/// A fresh single-use pairing code.
///
/// Rejection sampling rather than `% 32` on a byte: 256 is a multiple of 32, so
/// modulo happens to be uniform here — but it stops being uniform the moment
/// the alphabet loses a character, and a code generator that is correct by
/// coincidence is one edit from being biased.
pub fn new_pair_code() -> String {
    let mut out = String::with_capacity(PAIR_PREFIX.len() + PAIR_CODE_LEN);
    out.push_str(PAIR_PREFIX);
    let n = PAIR_ALPHABET.len() as u8;
    let limit = u8::MAX - (u8::MAX % n) - (n - 1); // largest unbiased byte
    while out.len() < PAIR_PREFIX.len() + PAIR_CODE_LEN {
        let mut buf = [0u8; 16];
        getrandom::fill(&mut buf).expect("OS entropy unavailable");
        for b in buf {
            if b > limit {
                continue;
            }
            out.push(PAIR_ALPHABET[(b % n) as usize] as char);
            if out.len() == PAIR_PREFIX.len() + PAIR_CODE_LEN {
                break;
            }
        }
    }
    out
}

pub fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// A room's internal id. Random rather than a timestamp or an index: it is a
/// map key and a poller-thread name, and two rooms created in the same second
/// must not collide.
pub fn new_id() -> String {
    format!("cx{}", &new_pair_code()[PAIR_PREFIX.len()..])
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Serialize, Deserialize)]
struct StoreFile {
    #[serde(default)]
    connections: Vec<Connection>,
}

/// The connections, and the file they live in.
///
/// Written whole on every change. The file is a handful of small records and a
/// partial write here would strand a room the user cannot delete, so it is
/// written to a temporary file and renamed over the old one.
pub struct ConnectionStore {
    path: PathBuf,
    connections: Vec<Connection>,
}

impl ConnectionStore {
    pub fn load(path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        let connections = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<StoreFile>(&s).ok())
            .map(|f| f.connections)
            .unwrap_or_default();
        Self { path, connections }
    }

    /// Best-effort, and deliberately not fatal: a room that cannot be persisted
    /// still works for this session, and refusing to chat because a disk write
    /// failed helps nobody.
    fn save(&self) {
        let Ok(json) = serde_json::to_string_pretty(&StoreFile {
            connections: self.connections.clone(),
        }) else {
            return;
        };
        if let Some(dir) = self.path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let tmp = self.path.with_extension("json.tmp");
        if std::fs::write(&tmp, json).is_ok() {
            let _ = std::fs::rename(&tmp, &self.path);
        }
    }

    pub fn views(&self) -> Vec<ConnectionView> {
        self.connections.iter().map(ConnectionView::from).collect()
    }

    pub fn get(&self, id: &str) -> Option<&Connection> {
        self.connections.iter().find(|c| c.id == id)
    }

    fn get_mut(&mut self, id: &str) -> Option<&mut Connection> {
        self.connections.iter_mut().find(|c| c.id == id)
    }

    pub fn ids(&self) -> Vec<String> {
        self.connections.iter().map(|c| c.id.clone()).collect()
    }

    pub fn add(&mut self, c: Connection) -> Result<ConnectionView, String> {
        if self.connections.len() >= MAX_CONNECTIONS {
            return Err(format!("You can have at most {MAX_CONNECTIONS} chat rooms."));
        }
        // Two rooms on one bot would poll the same token from two threads, which
        // is the 409 in `telegram.rs` — self-inflicted rather than reported.
        if self.connections.iter().any(|e| e.bot_token == c.bot_token) {
            return Err("That bot is already used by another room. Each room needs its own bot.".into());
        }
        let view = ConnectionView::from(&c);
        self.connections.push(c);
        self.save();
        Ok(view)
    }

    pub fn remove(&mut self, id: &str) -> bool {
        let before = self.connections.len();
        self.connections.retain(|c| c.id != id);
        let removed = self.connections.len() != before;
        if removed {
            self.save();
        }
        removed
    }

    pub fn rename(&mut self, id: &str, name: &str) -> Result<ConnectionView, String> {
        let c = self.get_mut(id).ok_or("No such room.")?;
        c.name = name.trim().to_string();
        let view = ConnectionView::from(&*c);
        self.save();
        Ok(view)
    }

    pub fn set_led_ping(&mut self, id: &str, on: bool) -> Result<ConnectionView, String> {
        let c = self.get_mut(id).ok_or("No such room.")?;
        c.led_ping = on;
        let view = ConnectionView::from(&*c);
        self.save();
        Ok(view)
    }

    /// Issue a new invitation, replacing any outstanding one.
    pub fn new_invite(&mut self, id: &str) -> Result<ConnectionView, String> {
        let now = now_secs();
        let c = self.get_mut(id).ok_or("No such room.")?;
        c.pair_code = Some(new_pair_code());
        c.pair_expires = now + PAIR_CODE_TTL_SECS;
        let view = ConnectionView::from(&*c);
        self.save();
        Ok(view)
    }

    /// Forget the peer and issue a fresh code, so a room can be handed to
    /// someone else without deleting it and its bot.
    pub fn unpair(&mut self, id: &str) -> Result<ConnectionView, String> {
        let now = now_secs();
        let c = self.get_mut(id).ok_or("No such room.")?;
        c.peer_chat_id = None;
        c.peer_name.clear();
        c.pair_code = Some(new_pair_code());
        c.pair_expires = now + PAIR_CODE_TTL_SECS;
        let view = ConnectionView::from(&*c);
        self.save();
        Ok(view)
    }

    fn set_offset(&mut self, id: &str, offset: i64) {
        if let Some(c) = self.get_mut(id) {
            if offset > c.offset {
                c.offset = offset;
                self.save();
            }
        }
    }

    fn complete_pairing(&mut self, id: &str, chat_id: i64, peer_name: &str) {
        if let Some(c) = self.get_mut(id) {
            c.peer_chat_id = Some(chat_id);
            c.peer_name = peer_name.to_string();
            c.pair_code = None;
            c.pair_expires = 0;
            self.save();
        }
    }
}

// ---------------------------------------------------------------------------
// Deciding what an inbound message means
// ---------------------------------------------------------------------------

/// What one inbound message should cause. Pure, so the rules that decide who is
/// allowed into a room are testable without a socket or a thread.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Inbound {
    /// From the paired peer: show it.
    Deliver,
    /// A valid, unexpired, unused code from a chat we do not know: let them in.
    Pair,
    /// Anything else. A stranger, a stale code, a second person trying to join
    /// a room that already has two.
    Ignore,
}

/// The whole membership rule, in one place.
///
/// Order matters. The paired peer is checked first, so a peer who sends
/// `/start` again is not re-paired and their message is not swallowed. Then a
/// pairing attempt. Everything else falls through to `Ignore`, which is what
/// keeps a stranger who finds the bot out of the room and off the OLED.
pub fn classify(c: &Connection, msg: &IncomingMessage, now: u64) -> Inbound {
    if c.peer_chat_id == Some(msg.chat_id) {
        return Inbound::Deliver;
    }
    if c.is_paired() {
        return Inbound::Ignore; // a room holds two people
    }
    let Some(expected) = c.pair_code.as_deref() else {
        return Inbound::Ignore;
    };
    if now > c.pair_expires {
        return Inbound::Ignore;
    }
    match start_payload(&msg.text) {
        // Case-insensitive: the code is shown in capitals and phone keyboards
        // are not. Not a security property — the comparison is still whole.
        Some(p) if p.eq_ignore_ascii_case(expected) => Inbound::Pair,
        _ => Inbound::Ignore,
    }
}

// ---------------------------------------------------------------------------
// Pollers
// ---------------------------------------------------------------------------

/// Owns the store and one thread per connection.
pub struct ChatService {
    pub store: Arc<Mutex<ConnectionStore>>,
    events: Sender<ChatEvent>,
    stops: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl ChatService {
    pub fn new(path: impl Into<PathBuf>, events: Sender<ChatEvent>) -> Arc<Self> {
        let svc = Arc::new(Self {
            store: Arc::new(Mutex::new(ConnectionStore::load(path))),
            events,
            stops: Mutex::new(HashMap::new()),
        });
        for id in svc.store.lock().unwrap().ids() {
            svc.clone().start_poller(&id);
        }
        svc
    }

    /// Start polling one connection. A no-op if it is already running, so this
    /// is safe to call on every path that could create or revive a room.
    pub fn start_poller(self: Arc<Self>, id: &str) {
        let mut stops = self.stops.lock().unwrap();
        if stops.contains_key(id) {
            return;
        }
        let stop = Arc::new(AtomicBool::new(false));
        stops.insert(id.to_string(), stop.clone());
        drop(stops);

        let id = id.to_string();
        let store = self.store.clone();
        let events = self.events.clone();
        std::thread::spawn(move || poll_loop(id, store, events, stop));
    }

    pub fn stop_poller(&self, id: &str) {
        if let Some(stop) = self.stops.lock().unwrap().remove(id) {
            // The thread notices on its next wake. It cannot be interrupted
            // mid-request, and killing it would leak the connection instead.
            stop.store(true, Ordering::Relaxed);
        }
    }

    /// Send to the paired peer. Blocking, so it is called from an async command.
    pub fn send(&self, id: &str, text: &str) -> Result<(), String> {
        let (token, chat_id) = {
            let store = self.store.lock().unwrap();
            let c = store.get(id).ok_or("No such room.")?;
            let chat = c.peer_chat_id.ok_or("Nobody has joined this room yet.")?;
            (c.bot_token.clone(), chat)
        };
        TelegramApi::new(token).send_message(chat_id, text).map_err(|e| e.to_string())
    }
}

/// One connection's poll loop.
///
/// Structured so the store lock is taken three times per iteration and held for
/// microseconds each: read what to ask, ask (blocking up to 25 s), write what
/// came back. The naive version — lock, request, unlock — makes every Tauri
/// command wait on Telegram.
fn poll_loop(
    id: String,
    store: Arc<Mutex<ConnectionStore>>,
    events: Sender<ChatEvent>,
    stop: Arc<AtomicBool>,
) {
    let mut last_error: Option<String> = None;

    while !stop.load(Ordering::Relaxed) {
        let Some((token, offset)) = ({
            let s = store.lock().unwrap();
            s.get(&id).map(|c| (c.bot_token.clone(), c.offset))
        }) else {
            return; // deleted underneath us
        };

        let api = TelegramApi::new(token);
        let result = api.get_updates(offset);

        if stop.load(Ordering::Relaxed) {
            return;
        }

        match result {
            Ok(batch) => {
                if last_error.is_some() {
                    last_error = None;
                    let _ = events.send(ChatEvent::Status { connection_id: id.clone(), error: None });
                }

                // The offset is recorded FIRST, before any message is acted on.
                // Telegram redelivers everything above the offset, so a crash
                // between here and the last send costs one duplicate message —
                // whereas acknowledging afterwards costs the whole batch if the
                // process dies mid-loop.
                if batch.next_offset > 0 {
                    store.lock().unwrap().set_offset(&id, batch.next_offset);
                }

                for msg in batch.messages {
                    let now = now_secs();
                    let decision = {
                        let s = store.lock().unwrap();
                        match s.get(&id) {
                            Some(c) => classify(c, &msg, now),
                            None => return,
                        }
                    };
                    match decision {
                        Inbound::Deliver => {
                            let _ = events.send(ChatEvent::Message {
                                connection_id: id.clone(),
                                from: msg.from_name,
                                text: msg.text,
                                at: msg.date,
                            });
                        }
                        Inbound::Pair => {
                            let room = {
                                let mut s = store.lock().unwrap();
                                s.complete_pairing(&id, msg.chat_id, &msg.from_name);
                                s.get(&id).map(|c| c.name.clone()).unwrap_or_default()
                            };
                            // Confirm in Telegram as well as in the app. The
                            // peer has no other way to know the code worked.
                            let _ = api.send_message(
                                msg.chat_id,
                                &format!("Connected to \"{room}\". Messages here now show on the macro pad."),
                            );
                            let _ = events.send(ChatEvent::Paired {
                                connection_id: id.clone(),
                                peer_name: msg.from_name,
                            });
                        }
                        Inbound::Ignore => {}
                    }
                }
            }
            Err(e) => {
                // A 409 means something else is polling this bot. Reporting it
                // as-is matters: it is the one failure the user can fix, and it
                // looks like "chat is broken" from every other angle.
                let text = e.to_string();
                if last_error.as_deref() != Some(text.as_str()) {
                    last_error = Some(text.clone());
                    let _ = events.send(ChatEvent::Status {
                        connection_id: id.clone(),
                        error: Some(text),
                    });
                }
                let wait = match e {
                    ChatError::RateLimited { retry_after } => retry_after as u64,
                    _ => RETRY_SECS,
                };
                // Slept in short slices so deleting a room does not wait out
                // the whole backoff before the thread notices.
                for _ in 0..wait {
                    if stop.load(Ordering::Relaxed) {
                        return;
                    }
                    std::thread::sleep(Duration::from_secs(1));
                }
            }
        }
    }
}

/// Where `connections.json` lives. Passed in from `main.rs`, which is the only
/// place that knows Tauri's directory layout.
pub fn store_path(config_dir: &Path) -> PathBuf {
    config_dir.join("connections.json")
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        Connection {
            id: "c1".into(),
            name: "Ana".into(),
            bot_token: "123456789:AAHhSomeSecretValueThatIsLongEnough1".into(),
            bot_username: "orbit_room_bot".into(),
            peer_chat_id: None,
            peer_name: String::new(),
            pair_code: None,
            pair_expires: 0,
            led_ping: false,
            offset: 0,
        }
    }

    fn msg(chat_id: i64, text: &str) -> IncomingMessage {
        IncomingMessage {
            chat_id,
            from_name: "Ana".into(),
            text: text.into(),
            date: 1755800000,
        }
    }

    // ── pair codes ──────────────────────────────────────────────────────────

    #[test]
    fn pair_codes_avoid_the_characters_people_mistype() {
        let code = new_pair_code();
        assert!(code.starts_with(PAIR_PREFIX));
        let body = &code[PAIR_PREFIX.len()..];
        assert_eq!(body.len(), PAIR_CODE_LEN);
        for c in body.chars() {
            assert!(PAIR_ALPHABET.contains(&(c as u8)), "{c} is not in the alphabet");
            assert!(!"ILOU".contains(c), "{c} is one of the confusable four");
        }
    }

    #[test]
    fn pair_codes_do_not_repeat() {
        let mut seen = std::collections::HashSet::new();
        for _ in 0..1000 {
            assert!(seen.insert(new_pair_code()), "generated a duplicate code");
        }
    }

    /// Telegram rejects a start payload outside `[A-Za-z0-9_-]`, and silently:
    /// the deep link simply does not carry it.
    #[test]
    fn a_code_is_a_legal_telegram_start_payload() {
        let code = new_pair_code();
        assert!(code.len() <= 64);
        assert!(code.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'));
        assert_eq!(
            pair_link("orbit_room_bot", &code),
            format!("https://t.me/orbit_room_bot?start={code}")
        );
    }

    #[test]
    fn codes_are_grouped_for_reading_aloud() {
        assert_eq!(format_pair_code("ORBIT7K2M9QX4"), "ORBIT-7K2M-9QX4");
        // Anything unexpected is shown as-is rather than sliced blindly.
        assert_eq!(format_pair_code("SHORT"), "SHORT");
    }

    // ── who gets into a room ────────────────────────────────────────────────

    #[test]
    fn the_paired_peer_is_delivered() {
        let mut c = conn();
        c.peer_chat_id = Some(42);
        assert_eq!(classify(&c, &msg(42, "hello"), 100), Inbound::Deliver);
    }

    /// The whole point of the code. Without this a stranger who finds the bot
    /// is typing onto someone's desk.
    #[test]
    fn an_unpaired_stranger_is_ignored() {
        let mut c = conn();
        c.peer_chat_id = Some(42);
        assert_eq!(classify(&c, &msg(999, "hello?"), 100), Inbound::Ignore);
        assert_eq!(classify(&c, &msg(999, "/start ORBIT7K2M9QX4"), 100), Inbound::Ignore);
    }

    #[test]
    fn a_matching_code_pairs() {
        let mut c = conn();
        c.pair_code = Some("ORBIT7K2M9QX4".into());
        c.pair_expires = 1000;
        assert_eq!(classify(&c, &msg(42, "/start ORBIT7K2M9QX4"), 100), Inbound::Pair);
    }

    /// The code is displayed in capitals and typed on a phone keyboard.
    #[test]
    fn the_code_is_matched_without_regard_to_case() {
        let mut c = conn();
        c.pair_code = Some("ORBIT7K2M9QX4".into());
        c.pair_expires = 1000;
        assert_eq!(classify(&c, &msg(42, "/start orbit7k2m9qx4"), 100), Inbound::Pair);
    }

    #[test]
    fn a_wrong_or_absent_code_does_not_pair() {
        let mut c = conn();
        c.pair_code = Some("ORBIT7K2M9QX4".into());
        c.pair_expires = 1000;
        assert_eq!(classify(&c, &msg(42, "/start ORBITWRONGXX"), 100), Inbound::Ignore);
        assert_eq!(classify(&c, &msg(42, "/start"), 100), Inbound::Ignore);
        assert_eq!(classify(&c, &msg(42, "hello"), 100), Inbound::Ignore);
    }

    #[test]
    fn an_expired_code_does_not_pair() {
        let mut c = conn();
        c.pair_code = Some("ORBIT7K2M9QX4".into());
        c.pair_expires = 1000;
        assert_eq!(classify(&c, &msg(42, "/start ORBIT7K2M9QX4"), 1001), Inbound::Ignore);
    }

    #[test]
    fn a_room_with_no_outstanding_invite_pairs_nobody() {
        let c = conn(); // pair_code None
        assert_eq!(classify(&c, &msg(42, "/start ORBIT7K2M9QX4"), 100), Inbound::Ignore);
    }

    /// `complete_pairing` clears the code, so the replay arrives at a room with
    /// no invite outstanding AND an occupant. Checked through the store rather
    /// than by hand, because it is the store that has to close the door.
    #[test]
    fn a_code_pairs_exactly_once() {
        let dir = std::env::temp_dir().join(format!("orbit-chat-test-{}", now_secs()));
        let mut store = ConnectionStore::load(store_path(&dir));
        let mut c = conn();
        c.pair_code = Some("ORBIT7K2M9QX4".into());
        c.pair_expires = u64::MAX;
        store.add(c).unwrap();

        let first = msg(42, "/start ORBIT7K2M9QX4");
        assert_eq!(classify(store.get("c1").unwrap(), &first, 100), Inbound::Pair);
        store.complete_pairing("c1", 42, "Ana");

        // Someone else replaying the code they were forwarded.
        let replay = msg(777, "/start ORBIT7K2M9QX4");
        assert_eq!(classify(store.get("c1").unwrap(), &replay, 100), Inbound::Ignore);
        // And the peer themselves sending /start again is a message, not a re-pair.
        let again = msg(42, "/start ORBIT7K2M9QX4");
        assert_eq!(classify(store.get("c1").unwrap(), &again, 100), Inbound::Deliver);

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── the store ───────────────────────────────────────────────────────────

    fn temp_store() -> (PathBuf, ConnectionStore) {
        let dir = std::env::temp_dir()
            .join(format!("orbit-chat-{}-{}", std::process::id(), new_pair_code()));
        let path = store_path(&dir);
        let store = ConnectionStore::load(&path);
        (dir, store)
    }

    #[test]
    fn connections_survive_a_reload() {
        let (dir, mut store) = temp_store();
        let path = store_path(&dir);
        let mut c = conn();
        c.offset = 900;
        store.add(c).unwrap();

        let again = ConnectionStore::load(&path);
        let c = again.get("c1").expect("connection did not persist");
        assert_eq!(c.bot_username, "orbit_room_bot");
        // The offset is Telegram's delivery state: losing it replays, inventing
        // it drops.
        assert_eq!(c.offset, 900);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_or_corrupt_file_is_an_empty_list_not_a_crash() {
        let (dir, store) = temp_store();
        assert!(store.views().is_empty());

        let path = store_path(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&path, "{ this is not json").unwrap();
        assert!(ConnectionStore::load(&path).views().is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Two rooms on one bot would poll the same token from two threads, which is
    /// exactly the 409 `telegram.rs` reports. Better refused at the door.
    #[test]
    fn one_bot_cannot_back_two_rooms() {
        let (dir, mut store) = temp_store();
        store.add(conn()).unwrap();
        let mut second = conn();
        second.id = "c2".into();
        assert!(store.add(second).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_room_count_is_capped() {
        let (dir, mut store) = temp_store();
        for i in 0..MAX_CONNECTIONS {
            let mut c = conn();
            c.id = format!("c{i}");
            c.bot_token = format!("12345678{i}:AAHhSomeSecretValueThatIsLongEnough1");
            store.add(c).unwrap();
        }
        let mut over = conn();
        over.id = "over".into();
        over.bot_token = "999:AAHhSomeSecretValueThatIsLongEnough1".into();
        assert!(store.add(over).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── the token must not reach the frontend ───────────────────────────────

    #[test]
    fn the_view_carries_no_token() {
        let mut c = conn();
        c.pair_code = Some("ORBIT7K2M9QX4".into());
        let token = c.bot_token.clone();
        let view = ConnectionView::from(&c);

        let json = serde_json::to_string(&view).unwrap();
        assert!(!json.contains(&token), "the view serialised the bot token");
        assert!(!json.contains("AAHhSomeSecretValueThatIsLongEnough1"));
        // Enough to tell two bots apart, and no more.
        assert_eq!(view.token_tail, "ugh1");
        assert_eq!(
            view.pair_link.as_deref(),
            Some("https://t.me/orbit_room_bot?start=ORBIT7K2M9QX4")
        );
    }

    #[test]
    fn unpairing_frees_the_room_and_issues_a_new_code() {
        let (dir, mut store) = temp_store();
        let mut c = conn();
        c.peer_chat_id = Some(42);
        c.peer_name = "Ana".into();
        store.add(c).unwrap();

        let view = store.unpair("c1").unwrap();
        assert!(!view.paired);
        assert!(view.peer_name.is_empty());
        let code = view.pair_code.expect("unpair must leave a way back in");
        // And the old peer is now a stranger like anyone else.
        assert_eq!(
            classify(store.get("c1").unwrap(), &msg(42, "hello"), now_secs()),
            Inbound::Ignore
        );
        assert!(code.starts_with(PAIR_PREFIX));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
