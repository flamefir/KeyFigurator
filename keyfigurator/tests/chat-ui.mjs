import { chromium } from "playwright";

const URL = process.argv[2];
const errs = [];
const browser = await chromium.launch();
const page = await browser.newPage();
page.on("pageerror", e => errs.push(`pageerror: ${e.message}`));
page.on("console", m => { if (m.type() === "error") errs.push(`console: ${m.text()}`); });

await page.goto(URL, { waitUntil: "networkidle" });

const check = (name, cond) => console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);

// 1. The section exists on the home page.
const heads = await page.locator(".home-title").allTextContents();
check("Chatrooms heading on home page", heads.includes("Chatrooms"));
// The browser mock stands in one demo room, so the empty state must be hidden.
check("empty state hidden once a room exists",
  !(await page.locator("#chat-empty").isVisible()));

// 2. Create-connection modal opens with both fields.
await page.click("#chat-add");
await page.waitForSelector("#chat-create", { timeout: 3000 });
check("create modal opens", await page.locator("#chat-create").isVisible());
check("asks for a room name", await page.locator("#chat-new-name").count() === 1);
check("asks for a bot token", await page.locator("#chat-new-token").count() === 1);
check("token field is masked",
  await page.locator("#chat-new-token").getAttribute("type") === "password");
check("room name capped to the board's 14-char title",
  await page.locator("#chat-new-name").getAttribute("maxlength") === "14");

// 3. Empty token is refused before any call goes out.
await page.click("#chat-new-go");
const err = (await page.locator("#chat-new-err").textContent()).trim();
check("empty token is refused with a message", err.length > 0);
check("modal stays open on refusal", await page.locator("#chat-create").isVisible());

// 4. Escape closes it.
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
check("escape closes the modal", await page.locator("#chat-create").count() === 0);

// 5. A bad token surfaces the backend's verdict (browser mock throws).
await page.click("#chat-add");
await page.fill("#chat-new-token", "not-a-token");
await page.click("#chat-new-go");
await page.waitForTimeout(300);
const err2 = (await page.locator("#chat-new-err").textContent()).trim();
check("a rejected token is reported, not swallowed", err2.length > 0);

console.log(errs.length ? `\nPAGE ERRORS:\n${errs.join("\n")}` : "\nno page errors");
await browser.close();

// ── Room panel, with a seeded transcript ──────────────────────────────────
const b2 = await chromium.launch();
const p2 = await b2.newPage();
const errs2 = [];
p2.on("pageerror", e => errs2.push(`pageerror: ${e.message}`));
await p2.addInitScript(() => {
  localStorage.setItem("kf-chat-history", JSON.stringify({
    demo: [
      { from: "Sam", text: "are you still at the desk?", at: 1755800000, mine: false },
      { from: "You", text: "yep, testing the panel", at: 1755800060, mine: true },
      { from: "Sam", text: "https://example.com/a/very/long/url/that/must/wrap/not/widen", at: 1755800120, mine: false },
    ],
  }));
});
await p2.goto(URL, { waitUntil: "networkidle" });

const c2 = (n, v) => console.log(`${v ? "PASS" : "FAIL"}  ${n}`);
c2("room card renders for a paired room", await p2.locator(".chat-card").count() === 1);
c2("card previews the last message",
  (await p2.locator(".chat-preview").textContent()).includes("example.com"));
c2("paired room shows a live dot", await p2.locator(".chat-card .device-dot.ok").count() === 1);
c2("paired room offers no invite code", await p2.locator(".chat-card .chat-code").count() === 0);

await p2.click(".chat-card .device-name");
await p2.waitForSelector("#chat-room", { timeout: 3000 });
c2("clicking a room opens it", await p2.locator("#chat-room").isVisible());
c2("all three messages render", await p2.locator(".chat-line").count() === 3);
c2("own messages are marked", await p2.locator(".chat-line.mine").count() === 1);
c2("title names the room and the peer",
  (await p2.locator("#chat-room-title").textContent()).includes("Sam"));

// A long URL must wrap inside the modal, not widen the page.
const doc = await p2.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
c2("a long URL does not widen the page", doc);

// Sending fails in browser mode: the text must come back, not vanish.
await p2.fill("#chat-room-input", "this should not be lost");
await p2.click("#chat-room-send");
await p2.waitForTimeout(300);
c2("a failed send reports the error",
  (await p2.locator("#chat-room-err").textContent()).trim().length > 0);
c2("a failed send gives the typed text back",
  await p2.inputValue("#chat-room-input") === "this should not be lost");
c2("a failed send is not recorded in the transcript",
  await p2.locator(".chat-line").count() === 3);

console.log(errs2.length ? `\nROOM PAGE ERRORS:\n${errs2.join("\n")}` : "\nno room page errors");
await b2.close();
