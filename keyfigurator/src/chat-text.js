// What a Connection Screen's text becomes on the way to the panel.
//
// Its own module because it is the one part of chat with no DOM and no state:
// the design doc's test plan asks for `wrapChatLines` to be testable, and a
// pure module is testable by `node` directly rather than only by driving a
// browser. main.js imports it; tests/chat-text.mjs imports the same file.
//
// These mirror `fold_to_ascii` / `wrap_ascii` / `ChatScreen::lines()` in
// model.rs. The wire folds and wraps too — this side exists so the OLED
// PREVIEW shows the same breaks the panel will. If the two ever disagree the
// preview becomes a lie, which is the failure mode this whole project keeps
// paying for, so they are deliberately the same rules written twice rather
// than one side guessing.

// KF_CHAT_LINES / KF_CHAT_LINE_MAX, quoting kf_hid.h.
// 128px / (6px * scale 1) = 21 columns, minus one for the origin marker.
export const CHAT_LINES    = 8;
export const CHAT_LINE_MAX = 20;

/// The exact table `fold_char` in model.rs uses. Transcribed, not approximated.
///
/// The obvious JS shortcut is `normalize("NFKD")` plus a combining-mark strip,
/// and it is WRONG in a way that matters here: NFKD has no decomposition for
/// 'oe', 'ae' or the sharp s, so a Danish name folds to "Sren" while the board
/// draws "Soeren", and none of the smart punctuation Telegram clients insert on
/// their own survives it at all. Two sides disagreeing about what the panel
/// says is the exact defect this preview exists to prevent.
///
/// Punctuation is written as escapes because several of these are invisible or
/// indistinguishable in an editor; the letters are literal because they are
/// meant to be read. Same split model.rs makes.
const FOLD = {
  // Smart punctuation, which Telegram clients insert on their own.
  "\u2018": "'", "\u2019": "'", "\u201B": "'",
  "\u201C": '"', "\u201D": '"', "\u201F": '"',
  "\u2013": "-", "\u2014": "-", "\u2212": "-",
  "\u2026": "...",
  "\u00A0": " ", "\u2007": " ", "\u202F": " ",
  "\u2022": "*",
  // Latin-1 letters, so a Danish or German name is readable rather than
  // blanked. Not a full transliteration table, just the common ones.
  "æ": "ae", "Æ": "AE",
  "ø": "oe", "Ø": "OE",
  "å": "aa", "Å": "AA",
  "ä": "ae", "Ä": "AE",
  "ö": "oe", "Ö": "OE",
  "ü": "ue", "Ü": "UE",
  "ß": "ss",
  "é": "e", "è": "e", "ê": "e", "ë": "e",
  "á": "a", "à": "a", "â": "a",
  "í": "i", "ì": "i", "î": "i", "ï": "i",
  "ó": "o", "ò": "o", "ô": "o",
  "ú": "u", "ù": "u", "û": "u",
  "ñ": "n",
  "ç": "c",
  // A tab is whitespace the font has no glyph for.
  "\t": " ",
};

/// Reduce to what the board's 5x7 font can draw (ASCII 32..126).
///
/// The board has no transliteration table and no room for one, so this happens
/// here or not at all.
///
/// Returns "[?]" - not "" - for text that folds away to nothing, matching
/// `fold_to_ascii`. A message you cannot read is a different thing from no
/// message, and emoji-only replies are common. Genuinely empty input stays
/// empty, because that IS no message.
export function foldToAscii(text) {
  const src = text ?? "";
  let out = "";
  let dropped = false;
  // Iterated by code point, so an astral-plane emoji is one dropped character
  // rather than two dropped surrogate halves.
  for (const ch of src) {
    const mapped = FOLD[ch];
    if (mapped !== undefined) out += mapped;
    else if (ch >= " " && ch <= "~") out += ch;
    else if (ch === "\n" || ch === "\r") out += " ";
    else dropped = true;
  }
  // Collapse the gaps dropped characters leave behind, so "hi <emoji> there"
  // does not arrive as "hi  there".
  const collapsed = out.split(/\s+/).filter(Boolean).join(" ");
  if (!collapsed && (dropped || src.length > 0)) return "[?]";
  return collapsed;
}

/// One message becomes one or more panel lines.
///
/// A word wider than the panel is hard-split, because the board does no
/// wrapping of its own and a long URL would otherwise be drawn off the edge.
export function wrapChatText(text, width = CHAT_LINE_MAX) {
  // foldToAscii already substitutes "[?]" for a message that folds away to
  // nothing, so there is no second empty-check here — exactly the composition
  // `ChatScreen::lines()` uses: wrap_ascii(fold_to_ascii(text)). Genuinely
  // empty text folds to "" and yields no lines at all, which is right: it is
  // no message rather than an unrenderable one.
  const folded = foldToAscii(text);
  const lines = [];
  let line = "";
  for (const word of folded.split(" ")) {
    let w = word;
    while (w.length > width) {
      if (line) { lines.push(line); line = ""; }
      lines.push(w.slice(0, width));
      w = w.slice(width);
    }
    if (!w) continue;
    if (!line) line = w;
    else if (line.length + 1 + w.length <= width) line += " " + w;
    else { lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  return lines;
}

/// The newest `max` LINES of a conversation, not the newest `max` messages.
///
/// Trimming by message overflows the panel the moment one of them wraps: eight
/// one-line messages and one nine-line message both fill it, and only counting
/// lines knows the difference. So wrap everything, then cut.
export function wrapChatLines(messages, max = CHAT_LINES, width = CHAT_LINE_MAX) {
  const out = [];
  for (const m of messages || []) {
    for (const text of wrapChatText(m.text, width)) {
      out.push({ mine: !!m.mine, text });
    }
  }
  return out.slice(-max);
}
