// The panel's text rules, tested without a browser.
//
// `src/chat-text.js` has no DOM and no state, so this runs under plain node:
//   node tests/chat-text.mjs
//
// Many of these are transcribed from model.rs's own `mod tests`. That is the
// point: the app folds and wraps to draw the OLED preview, the wire folds and
// wraps to fill the frames, and the preview is only worth having if the two
// agree character for character. They are the same rules written twice rather
// than one side guessing, so both sides get the same tests.

import { foldToAscii, wrapChatText, wrapChatLines, CHAT_LINES, CHAT_LINE_MAX }
  from "../src/chat-text.js";

let failed = 0;
const check = (name, cond) => {
  if (!cond) failed++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
};
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    failed++;
    console.log(`FAIL  ${name}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);
  } else console.log(`PASS  ${name}`);
};

// ── constants are the firmware's, not ours ──────────────────────────────────
check("CHAT_LINES matches KF_CHAT_LINES", CHAT_LINES === 8);
check("CHAT_LINE_MAX matches KF_CHAT_LINE_MAX", CHAT_LINE_MAX === 20);

// ── folding: the model.rs assertions, transcribed ───────────────────────────
eq("plain ASCII is untouched",
  foldToAscii("meet at 7? bring the KEY!"), "meet at 7? bring the KEY!");
eq("smart quotes and apostrophes fold",
  foldToAscii("“it’s fine”"), '"it\'s fine"');
eq("an ellipsis becomes three dots", foldToAscii("wait…"), "wait...");
eq("an em dash becomes a hyphen", foldToAscii("a — b"), "a - b");
eq("a non-breaking space is a space", foldToAscii("a b"), "a b");
eq("a bullet becomes an asterisk", foldToAscii("• item"), "* item");

// NFKD — the obvious JS shortcut — fails every one of these: no decomposition
// exists for these letters, so they would be DROPPED rather than
// transliterated, and the preview would disagree with the panel.
eq("a Danish name transliterates", foldToAscii("Søren"), "Soeren");
eq("an accent loses the mark, not the letter", foldToAscii("café"), "cafe");
eq("a German umlaut transliterates", foldToAscii("Müller"), "Mueller");
eq("the sharp s becomes ss", foldToAscii("straße"), "strasse");
eq("ae and aa fold too", foldToAscii("Ærøskøbing"), "AEroeskoebing");

eq("a single emoji becomes [?]", foldToAscii("\u{1F44D}"), "[?]");
eq("a run of emoji becomes [?]", foldToAscii("\u{1F389}\u{1F389}\u{1F389}"), "[?]");
eq("mixed content keeps the readable half and closes the gap",
  foldToAscii("hi \u{1F44B} there"), "hi there");
eq("newlines and tabs become spaces", foldToAscii("a\nb\tc"), "a b c");
eq("runs of whitespace collapse", foldToAscii("a     b"), "a b");

// Empty is no message. Whitespace-only is a message that renders as nothing,
// which is a different thing and says so.
eq("empty text stays empty", foldToAscii(""), "");
eq("whitespace-only text becomes [?]", foldToAscii("   "), "[?]");
eq("null and undefined do not crash", foldToAscii(undefined) + foldToAscii(null), "");

// ── wrapping one message ────────────────────────────────────────────────────
eq("a short message is one line", wrapChatText("on my way"), ["on my way"]);
check("no wrapped line exceeds the panel width",
  wrapChatText("the quick brown fox jumps over the lazy dog again and again")
    .every(l => l.length <= CHAT_LINE_MAX));
eq("words are kept whole where they fit",
  wrapChatText("aaaa bbbb cccc dddd eeee"), ["aaaa bbbb cccc dddd", "eeee"]);

// The board does no wrapping, so a word wider than the panel has to be split
// here or it is drawn straight off the edge.
const url = "https://example.com/a/very/long/path/that/never/ends";
const urlLines = wrapChatText(url);
check("an over-wide word is hard-split", urlLines.length > 1);
check("every piece of it still fits", urlLines.every(l => l.length <= CHAT_LINE_MAX));
eq("hard-splitting loses no characters", urlLines.join(""), url);

eq("an emoji-only message becomes one [?] line", wrapChatText("\u{1F642}"), ["[?]"]);
// Genuinely empty contributes NO line, matching wrap_ascii(fold_to_ascii("")).
eq("an empty message contributes no line", wrapChatText(""), []);

// ── the cut ─────────────────────────────────────────────────────────────────
// The bug this pins: keeping the last 8 MESSAGES overflows the panel as soon as
// one of them wraps. The cut has to happen after wrapping, on lines.
const long = "word ".repeat(40).trim();          // wraps well past 8 lines
const many = [{ mine: false, text: "one" }, { mine: true, text: long }];
check("a single long message is cut to the panel height",
  wrapChatLines(many).length === CHAT_LINES);
check("the cut keeps the NEWEST lines",
  wrapChatLines(many).every(l => l.mine === true));

const twelve = Array.from({ length: 12 }, (_, i) => ({ mine: false, text: `msg ${i}` }));
eq("twelve one-line messages keep the last eight",
  wrapChatLines(twelve).map(l => l.text),
  ["msg 4", "msg 5", "msg 6", "msg 7", "msg 8", "msg 9", "msg 10", "msg 11"]);

check("origin survives the wrap",
  wrapChatLines([{ mine: true, text: "mine" }, { mine: false, text: "theirs" }])
    .map(l => l.mine).join(",") === "true,false");

eq("no messages is no lines, not a crash", wrapChatLines([]), []);
eq("undefined is no lines", wrapChatLines(undefined), []);

// A conversation that exactly fills the panel is not truncated.
const exact = Array.from({ length: CHAT_LINES }, (_, i) => ({ mine: false, text: `l${i}` }));
check("exactly eight lines are all kept", wrapChatLines(exact).length === CHAT_LINES);

// An unrenderable message still occupies its line in the history, so it cannot
// silently vanish out of a conversation that is otherwise readable.
eq("an emoji reply keeps its place in the transcript",
  wrapChatLines([{ mine: false, text: "you there?" }, { mine: true, text: "\u{1F44D}" }])
    .map(l => l.text),
  ["you there?", "[?]"]);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
