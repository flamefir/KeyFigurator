//! Telegram Bot API client — the transport behind Connection Screens.
//!
//! Split deliberately in two halves:
//!
//!   * a thin HTTP layer (`TelegramApi`) that does nothing but build a URL,
//!     call it, and hand back the body, and
//!   * pure functions (`parse_updates`, `start_payload`, `map_api_error`) that
//!     turn a body into something this app understands.
//!
//! Everything worth testing lives in the second half, so the whole test suite
//! runs offline against captured payloads. A client that could only be tested
//! by talking to Telegram would not be tested.
//!
//! ## Two API rules that shape the design
//!
//! 1. **`getUpdates` is single-consumer.** Two processes polling the same bot
//!    token get **409** and steal each other's updates. A bot token belongs to
//!    exactly one Orbit install, which is why a connection owns its bot rather
//!    than sharing one.
//! 2. **A bot never receives messages from another bot.** So the peer is always
//!    a human Telegram account, never a second Orbit.
//!
//! See `docs/telegram-chat-screens.md` in the KeyFigurator repo for the whole
//! design and what was rejected.

use std::time::Duration;

use serde::{Deserialize, Serialize};

/// `https://api.telegram.org/bot<token>/<method>`.
const API_BASE: &str = "https://api.telegram.org";

/// How long `getUpdates` is allowed to hold the connection open waiting for a
/// message. Telegram's own cap is 50; 25 keeps us well inside any intermediate
/// proxy's idle timeout while still costing one request a minute when idle.
pub const LONG_POLL_SECS: u32 = 25;

/// The HTTP timeout has to outlast the long poll itself, or every idle poll
/// looks like a network failure.
const HTTP_TIMEOUT_MARGIN_SECS: u64 = 15;

/// Longest message we will send. Telegram's own limit is 4096; this is about
/// what a Connection Screen can show, and a truncation the user can see beats a
/// 400 from the API.
pub const MESSAGE_MAX_CHARS: usize = 1000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Why a Telegram call failed, in the terms the UI needs to explain it.
///
/// The variants that matter are the ones a user can act on: a revoked token, a
/// second Orbit polling the same bot, and a rate limit. Collapsing those into
/// one "request failed" is what makes a chat feature feel broken rather than
/// misconfigured.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChatError {
    /// 401. The token is wrong, or was revoked in BotFather.
    Unauthorized,
    /// 409. Another `getUpdates` is running against this token — a second Orbit,
    /// or a webhook still registered. This is API rule 1 biting.
    Conflict,
    /// 429. `retry_after` is Telegram's own suggestion, in seconds.
    RateLimited { retry_after: u32 },
    /// Any other `ok: false` answer, kept whole so the UI can show what the API
    /// actually said.
    Api { code: u16, description: String },
    /// Never reached Telegram, or the connection died mid-body.
    Network(String),
    /// Reached Telegram and could not make sense of the answer.
    Decode(String),
    /// Rejected before any request went out.
    InvalidToken,
}

impl std::fmt::Display for ChatError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unauthorized => write!(
                f,
                "Telegram rejected the bot token. Check it in BotFather, or paste it again."
            ),
            Self::Conflict => write!(
                f,
                "Another program is already receiving this bot's messages. \
                 A bot can only be polled from one place at a time."
            ),
            Self::RateLimited { retry_after } => {
                write!(f, "Telegram is rate limiting this bot; retrying in {retry_after}s.")
            }
            Self::Api { code, description } => write!(f, "Telegram error {code}: {description}"),
            Self::Network(m) => write!(f, "Could not reach Telegram: {m}"),
            Self::Decode(m) => write!(f, "Unexpected answer from Telegram: {m}"),
            Self::InvalidToken => write!(
                f,
                "That does not look like a bot token. BotFather gives you \
                 something like 123456789:AAG...  (digits, a colon, then 35 characters)."
            ),
        }
    }
}

impl std::error::Error for ChatError {}

/// Replace a bot token wherever it appears in `text`.
///
/// The token only ever travels in the URL, and ureq's own errors quote the URL.
/// The log panel is copy-pasteable by design and is exactly what a user pastes
/// into a bug report, so every string that could carry a token goes through
/// here before it becomes a `ChatError`.
pub fn redact_token(text: &str, token: &str) -> String {
    if token.is_empty() {
        return text.to_string();
    }
    let mut out = text.replace(token, "<bot-token>");
    // The numeric bot id before the colon is not secret, but the secret half
    // alone is still a working half. Redact it independently in case something
    // logged only the tail.
    if let Some((_, secret)) = token.split_once(':') {
        if secret.len() >= 8 {
            out = out.replace(secret, "<bot-token>");
        }
    }
    out
}

/// A bot token is `<digits>:<35 or so url-safe characters>`. Checked before the
/// first request so an obvious paste error is an immediate, specific message
/// rather than a 401 round trip.
pub fn token_looks_valid(token: &str) -> bool {
    let Some((id, secret)) = token.split_once(':') else {
        return false;
    };
    !id.is_empty()
        && id.chars().all(|c| c.is_ascii_digit())
        && secret.len() >= 20
        && secret
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/// Who the bot is, from `getMe`. The username is what makes the pairing deep
/// link (`https://t.me/<username>?start=<code>`) possible at all.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BotIdentity {
    pub id: i64,
    pub username: String,
    pub first_name: String,
}

/// One inbound message, reduced to what a chat screen needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IncomingMessage {
    /// The private chat the message came from. This is the peer's identity as
    /// far as the bot is concerned, and what pairing binds.
    pub chat_id: i64,
    pub from_name: String,
    pub text: String,
    /// Unix seconds, as Telegram sent it.
    pub date: i64,
}

/// The result of one `getUpdates` call.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct UpdateBatch {
    pub messages: Vec<IncomingMessage>,
    /// What to pass as `offset` next time. Advances past **every** update in the
    /// batch, including the ones we skipped — see `parse_updates`.
    pub next_offset: i64,
}

// ---------------------------------------------------------------------------
// Pure parsing
// ---------------------------------------------------------------------------

/// Turn a `getUpdates` body into messages plus the next offset.
///
/// Two things this gets right that a naive version does not:
///
/// * **The offset advances past skipped updates.** A sticker, a photo, an
///   edited message and a channel post all arrive here and none of them become
///   an `IncomingMessage`. If the offset only advanced past the ones we kept,
///   one sticker would be redelivered forever and the poller would never see
///   another message. The offset is an acknowledgement of *receipt*, not of
///   interest.
/// * **`ok: false` is an error, not an empty batch.** Telegram answers 200 with
///   `ok: false` in some cases, so the body has to be checked even on success.
pub fn parse_updates(body: &str) -> Result<UpdateBatch, ChatError> {
    let v: serde_json::Value =
        serde_json::from_str(body).map_err(|e| ChatError::Decode(e.to_string()))?;

    if v.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
        return Err(api_error_from_body(&v));
    }

    let results = v
        .get("result")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| ChatError::Decode("getUpdates: no result array".into()))?;

    let mut batch = UpdateBatch::default();
    for upd in results {
        let Some(update_id) = upd.get("update_id").and_then(serde_json::Value::as_i64) else {
            // An update with no id cannot be acknowledged, and acknowledging
            // the batch anyway would drop it silently. Refuse the whole body.
            return Err(ChatError::Decode("update with no update_id".into()));
        };
        batch.next_offset = batch.next_offset.max(update_id + 1);

        // Only plain `message` — not `edited_message`, not `channel_post`. An
        // edit that rewrote history on the OLED would be a surprise, and a
        // channel post cannot come from our paired peer.
        if let Some(msg) = upd.get("message") {
            if let Some(m) = message_from_json(msg) {
                batch.messages.push(m);
            }
        }
    }
    Ok(batch)
}

fn message_from_json(msg: &serde_json::Value) -> Option<IncomingMessage> {
    // No text means a photo, sticker, voice note or document. The panel is
    // 128px of amber and the one image buffer belongs to the GIF screen, so
    // these are skipped rather than rendered as a placeholder nobody asked for.
    let text = msg.get("text")?.as_str()?.to_string();
    let chat_id = msg.get("chat")?.get("id")?.as_i64()?;

    let from = msg.get("from");
    let first = from
        .and_then(|f| f.get("first_name"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let username = from
        .and_then(|f| f.get("username"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let from_name = if !first.is_empty() {
        first.to_string()
    } else if !username.is_empty() {
        username.to_string()
    } else {
        "Unknown".to_string()
    };

    let date = msg.get("date").and_then(serde_json::Value::as_i64).unwrap_or(0);

    Some(IncomingMessage { chat_id, from_name, text, date })
}

/// The payload of a `/start` command, which is how pairing arrives.
///
/// Telegram delivers a deep link `t.me/<bot>?start=CODE` as the literal message
/// `/start CODE`, and in a group appends the bot's own name to the command
/// (`/start@orbit_bot CODE`). Both forms are accepted; a bare `/start` carries
/// no payload and must not be treated as one, or the first curious stranger to
/// open the bot would pair themselves.
pub fn start_payload(text: &str) -> Option<&str> {
    let text = text.trim();
    let (cmd, rest) = match text.split_once(char::is_whitespace) {
        Some((c, r)) => (c, r.trim()),
        None => (text, ""),
    };
    let cmd = cmd.split_once('@').map_or(cmd, |(c, _)| c);
    if cmd != "/start" || rest.is_empty() {
        return None;
    }
    Some(rest)
}

/// Map an HTTP status plus body onto a `ChatError`.
///
/// Separate from the request so the mapping is testable without a socket, and
/// because the same body shape comes back from every method.
pub fn map_api_error(status: u16, body: &str) -> ChatError {
    let v: serde_json::Value = serde_json::from_str(body).unwrap_or(serde_json::Value::Null);
    match status {
        401 => ChatError::Unauthorized,
        409 => ChatError::Conflict,
        429 => ChatError::RateLimited {
            retry_after: v
                .get("parameters")
                .and_then(|p| p.get("retry_after"))
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(5) as u32,
        },
        _ => api_error_from_body(&v),
    }
}

fn api_error_from_body(v: &serde_json::Value) -> ChatError {
    let code = v
        .get("error_code")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0) as u16;
    let description = v
        .get("description")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("no description")
        .to_string();
    match code {
        401 => ChatError::Unauthorized,
        409 => ChatError::Conflict,
        _ => ChatError::Api { code, description },
    }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/// One bot's connection to the Bot API.
///
/// Blocking, and owned by the poller thread. Cheap to clone-by-token: the agent
/// pools connections, which matters because an idle chat is one held-open
/// request every 25 seconds forever.
pub struct TelegramApi {
    token: String,
    agent: ureq::Agent,
}

impl TelegramApi {
    pub fn new(token: impl Into<String>) -> Self {
        let token = token.into();
        let agent: ureq::Agent = ureq::Agent::config_builder()
            // We want the body of a 401/409/429 — Telegram puts the reason and
            // the retry delay in it. Without this, ureq turns the status into
            // an error and the body is gone.
            .http_status_as_error(false)
            .timeout_global(Some(Duration::from_secs(
                LONG_POLL_SECS as u64 + HTTP_TIMEOUT_MARGIN_SECS,
            )))
            .build()
            .into();
        Self { token, agent }
    }

    /// Scrub this bot's token out of anything on its way to the user or the log.
    pub fn redact(&self, text: &str) -> String {
        redact_token(text, &self.token)
    }

    fn url(&self, method: &str) -> String {
        format!("{API_BASE}/bot{}/{method}", self.token)
    }

    /// GET a method with no arguments beyond the query string already in `url`.
    fn call(&self, url: &str) -> Result<String, ChatError> {
        let mut resp = self
            .agent
            .get(url)
            .call()
            .map_err(|e| ChatError::Network(self.redact(&e.to_string())))?;
        let status = resp.status().as_u16();
        let body = resp
            .body_mut()
            .read_to_string()
            .map_err(|e| ChatError::Network(self.redact(&e.to_string())))?;
        if status != 200 {
            return Err(map_api_error(status, &body));
        }
        Ok(body)
    }

    /// `getMe` — validates the token and gives us the username the pairing deep
    /// link is built from.
    pub fn get_me(&self) -> Result<BotIdentity, ChatError> {
        if !token_looks_valid(&self.token) {
            return Err(ChatError::InvalidToken);
        }
        let body = self.call(&self.url("getMe"))?;
        let v: serde_json::Value =
            serde_json::from_str(&body).map_err(|e| ChatError::Decode(e.to_string()))?;
        if v.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
            return Err(api_error_from_body(&v));
        }
        parse_bot_identity(&v).ok_or_else(|| ChatError::Decode("getMe: unexpected shape".into()))
    }

    /// Long-poll for new messages. Blocks for up to `LONG_POLL_SECS`.
    ///
    /// `offset` is the acknowledgement point: passing it tells Telegram every
    /// update below it was received and may be dropped. Pass 0 on the first
    /// call of a session to get whatever is queued.
    pub fn get_updates(&self, offset: i64) -> Result<UpdateBatch, ChatError> {
        let url = format!(
            "{}?timeout={}&allowed_updates=%5B%22message%22%5D{}",
            self.url("getUpdates"),
            LONG_POLL_SECS,
            if offset > 0 { format!("&offset={offset}") } else { String::new() }
        );
        parse_updates(&self.call(&url)?)
    }

    /// Send one message to a paired chat.
    ///
    /// Plain text, no parse mode: Markdown would make an unescaped `_` in a
    /// user's message a 400, and the destination is a 5x7 font on a 128px panel
    /// that cannot render formatting anyway.
    pub fn send_message(&self, chat_id: i64, text: &str) -> Result<(), ChatError> {
        let text: String = text.chars().take(MESSAGE_MAX_CHARS).collect();
        let mut resp = self
            .agent
            .post(self.url("sendMessage"))
            .send_json(serde_json::json!({ "chat_id": chat_id, "text": text }))
            .map_err(|e| ChatError::Network(self.redact(&e.to_string())))?;
        let status = resp.status().as_u16();
        let body = resp
            .body_mut()
            .read_to_string()
            .map_err(|e| ChatError::Network(self.redact(&e.to_string())))?;
        if status != 200 {
            return Err(map_api_error(status, &body));
        }
        Ok(())
    }
}

fn parse_bot_identity(v: &serde_json::Value) -> Option<BotIdentity> {
    let r = v.get("result")?;
    Some(BotIdentity {
        id: r.get("id")?.as_i64()?,
        username: r.get("username")?.as_str()?.to_string(),
        first_name: r
            .get("first_name")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .to_string(),
    })
}

// ---------------------------------------------------------------------------
// Tests — captured payloads, no network.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "123456789:AAHhSomeSecretValueThatIsLongEnough1";

    fn update(id: i64, inner: &str) -> String {
        format!(r#"{{"update_id":{id},{inner}}}"#)
    }

    fn text_message(chat: i64, text: &str) -> String {
        format!(
            r#""message":{{"message_id":1,
               "from":{{"id":{chat},"is_bot":false,"first_name":"Ana","username":"ana_t"}},
               "chat":{{"id":{chat},"first_name":"Ana","type":"private"}},
               "date":1755800000,"text":"{text}"}}"#
        )
    }

    fn ok_body(updates: &[String]) -> String {
        format!(r#"{{"ok":true,"result":[{}]}}"#, updates.join(","))
    }

    #[test]
    fn parses_a_text_message() {
        let b = ok_body(&[update(700, &text_message(42, "hello from a phone"))]);
        let batch = parse_updates(&b).unwrap();
        assert_eq!(batch.messages.len(), 1);
        let m = &batch.messages[0];
        assert_eq!(m.chat_id, 42);
        assert_eq!(m.from_name, "Ana");
        assert_eq!(m.text, "hello from a phone");
        assert_eq!(m.date, 1755800000);
        assert_eq!(batch.next_offset, 701);
    }

    #[test]
    fn empty_result_leaves_the_offset_alone() {
        let batch = parse_updates(r#"{"ok":true,"result":[]}"#).unwrap();
        assert!(batch.messages.is_empty());
        // 0 means "unchanged" to the caller, which keeps its previous offset.
        assert_eq!(batch.next_offset, 0);
    }

    /// The bug this pins: acknowledging only the updates we kept means a single
    /// sticker is redelivered on every poll and no later message is ever seen.
    #[test]
    fn skipped_updates_still_advance_the_offset() {
        let sticker = update(
            10,
            r#""message":{"message_id":2,"chat":{"id":42,"type":"private"},
               "date":1,"sticker":{"file_id":"x"}}"#,
        );
        let edited = update(
            11,
            r#""edited_message":{"message_id":1,"chat":{"id":42,"type":"private"},
               "date":2,"text":"rewritten"}"#,
        );
        let channel = update(
            12,
            r#""channel_post":{"message_id":9,"chat":{"id":-100,"type":"channel"},
               "date":3,"text":"broadcast"}"#,
        );
        let batch = parse_updates(&ok_body(&[sticker, edited, channel])).unwrap();
        assert!(batch.messages.is_empty(), "none of these are chat messages");
        assert_eq!(batch.next_offset, 13, "but all three were received");
    }

    #[test]
    fn a_message_with_no_from_still_parses() {
        let b = ok_body(&[update(
            5,
            r#""message":{"message_id":1,"chat":{"id":42,"type":"private"},
               "date":1,"text":"anon"}"#,
        )]);
        let m = &parse_updates(&b).unwrap().messages[0];
        assert_eq!(m.from_name, "Unknown");
    }

    #[test]
    fn username_stands_in_when_there_is_no_first_name() {
        let b = ok_body(&[update(
            5,
            r#""message":{"message_id":1,"from":{"id":42,"username":"ana_t"},
               "chat":{"id":42,"type":"private"},"date":1,"text":"hi"}"#,
        )]);
        assert_eq!(parse_updates(&b).unwrap().messages[0].from_name, "ana_t");
    }

    #[test]
    fn an_update_with_no_id_fails_the_batch_rather_than_being_dropped() {
        let b = r#"{"ok":true,"result":[{"message":{"chat":{"id":1},"date":1,"text":"x"}}]}"#;
        assert!(matches!(parse_updates(b), Err(ChatError::Decode(_))));
    }

    #[test]
    fn ok_false_on_a_200_is_still_an_error() {
        let b = r#"{"ok":false,"error_code":409,"description":"Conflict: terminated by other getUpdates request"}"#;
        assert_eq!(parse_updates(b), Err(ChatError::Conflict));
    }

    #[test]
    fn garbage_is_a_decode_error_not_a_panic() {
        assert!(matches!(parse_updates("<html>502</html>"), Err(ChatError::Decode(_))));
    }

    // ── /start payload ──────────────────────────────────────────────────────

    #[test]
    fn start_payload_forms() {
        assert_eq!(start_payload("/start ORBIT7K2M9QX4"), Some("ORBIT7K2M9QX4"));
        assert_eq!(start_payload("  /start   ORBIT7K2M9QX4  "), Some("ORBIT7K2M9QX4"));
        // Groups append the bot name to the command.
        assert_eq!(start_payload("/start@orbit_bot ORBIT7K2M9QX4"), Some("ORBIT7K2M9QX4"));
    }

    /// A bare `/start` is what every curious stranger who opens the bot sends.
    /// Treating it as a payload would pair the first one to arrive.
    #[test]
    fn bare_start_carries_no_payload() {
        assert_eq!(start_payload("/start"), None);
        assert_eq!(start_payload("/start   "), None);
        assert_eq!(start_payload("/start@orbit_bot"), None);
        assert_eq!(start_payload("start ORBIT7K2M9QX4"), None);
        assert_eq!(start_payload("hello"), None);
    }

    // ── error mapping ───────────────────────────────────────────────────────

    #[test]
    fn actionable_statuses_map_to_their_own_variants() {
        assert_eq!(map_api_error(401, r#"{"ok":false,"description":"Unauthorized"}"#), ChatError::Unauthorized);
        assert_eq!(map_api_error(409, r#"{"ok":false,"description":"Conflict"}"#), ChatError::Conflict);
        assert_eq!(
            map_api_error(429, r#"{"ok":false,"description":"Too Many Requests","parameters":{"retry_after":17}}"#),
            ChatError::RateLimited { retry_after: 17 }
        );
    }

    #[test]
    fn rate_limit_without_a_suggestion_still_gives_a_delay() {
        assert_eq!(map_api_error(429, "{}"), ChatError::RateLimited { retry_after: 5 });
    }

    #[test]
    fn an_unmapped_status_keeps_what_telegram_said() {
        let e = map_api_error(400, r#"{"ok":false,"error_code":400,"description":"chat not found"}"#);
        assert_eq!(e, ChatError::Api { code: 400, description: "chat not found".into() });
        assert!(e.to_string().contains("chat not found"));
    }

    #[test]
    fn a_non_json_error_body_does_not_panic() {
        let e = map_api_error(502, "<html>bad gateway</html>");
        assert!(matches!(e, ChatError::Api { .. }));
    }

    // ── the token must not leak ─────────────────────────────────────────────

    /// The log panel is copy-pasteable by design. ureq quotes the URL in its
    /// errors, and the URL is where the token lives.
    #[test]
    fn the_token_never_survives_redaction() {
        let leaky = format!("http status 401 for https://api.telegram.org/bot{TOKEN}/getUpdates");
        let clean = redact_token(&leaky, TOKEN);
        assert!(!clean.contains(TOKEN));
        assert!(!clean.contains("AAHhSomeSecretValueThatIsLongEnough1"));
        assert!(clean.contains("<bot-token>"));
    }

    /// A leak of only the half after the colon is still a working credential.
    #[test]
    fn the_secret_half_alone_is_also_redacted() {
        let leaky = "auth failed for AAHhSomeSecretValueThatIsLongEnough1";
        assert!(!redact_token(leaky, TOKEN).contains("AAHhSomeSecretValueThatIsLongEnough1"));
    }

    #[test]
    fn no_error_message_contains_a_token() {
        for e in [
            ChatError::Unauthorized,
            ChatError::Conflict,
            ChatError::RateLimited { retry_after: 3 },
            ChatError::Api { code: 400, description: "bad".into() },
            ChatError::Network("connection reset".into()),
            ChatError::Decode("eof".into()),
            ChatError::InvalidToken,
        ] {
            assert!(!e.to_string().contains(TOKEN), "{e:?} leaked the token");
        }
    }

    // ── token shape ─────────────────────────────────────────────────────────

    #[test]
    fn token_shape_is_checked_before_the_network_is() {
        assert!(token_looks_valid(TOKEN));
        assert!(!token_looks_valid(""));
        assert!(!token_looks_valid("no-colon-here"));
        assert!(!token_looks_valid("123456789:short"));
        assert!(!token_looks_valid("notdigits:AAHhSomeSecretValueThatIsLongEnough1"));
        // A pasted token with a stray space is the common real mistake.
        assert!(!token_looks_valid("123456789:AAHhSome SecretValueThatIsLong1"));
    }

    #[test]
    fn get_me_refuses_a_malformed_token_without_calling_out() {
        // No network is reachable from a test, so the only way this can return
        // is the pre-flight check.
        assert_eq!(TelegramApi::new("nonsense").get_me(), Err(ChatError::InvalidToken));
    }

    #[test]
    fn parses_get_me() {
        let v: serde_json::Value = serde_json::from_str(
            r#"{"ok":true,"result":{"id":123456789,"is_bot":true,
                "first_name":"Orbit Room","username":"orbit_room_bot"}}"#,
        )
        .unwrap();
        assert_eq!(
            parse_bot_identity(&v).unwrap(),
            BotIdentity {
                id: 123456789,
                username: "orbit_room_bot".into(),
                first_name: "Orbit Room".into()
            }
        );
    }
}
