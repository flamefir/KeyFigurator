import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";

const hasTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// ── Log ─────────────────────────────────────────────────────────────────────
// Every entry is timestamp + message + SOURCE, because "something failed" with
// no source is what turned a one-line struct mismatch into a multi-session
// hunt: oled_push was rejecting the whole payload and the only trace was a
// console.warn nobody reads.
//
// Kept in memory and mirrored to localStorage so a log survives the crash or
// reload that produced it. Capped, oldest dropped first — an unbounded log in
// localStorage eventually breaks the thing it is meant to diagnose.
const LOG_KEY = "kf-log";
const LOG_MAX = 300;
let appLog = [];

function loadLog() {
  try { appLog = JSON.parse(localStorage.getItem(LOG_KEY)) || []; } catch { appLog = []; }
}

function saveLog() {
  try { localStorage.setItem(LOG_KEY, JSON.stringify(appLog)); }
  catch { /* quota: the log is diagnostic, never worth breaking the app for */ }
}

function logEvent(level, message, source) {
  const entry = { ts: new Date().toISOString(), level, message: String(message), source };
  appLog.push(entry);
  if (appLog.length > LOG_MAX) appLog.splice(0, appLog.length - LOG_MAX);
  saveLog();
  // Still goes to the console, so devtools and the log agree.
  const line = `[${source}] ${entry.message}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
  renderLogPanel();
  return entry;
}

const logError = (msg, source) => logEvent("error", msg, source);
const logWarn  = (msg, source) => logEvent("warn",  msg, source);
const logInfo  = (msg, source) => logEvent("info",  msg, source);

// Rendered from newest first: when something has just gone wrong, the entry
// you want is the last one.
function renderLogPanel() {
  const body = document.getElementById("log-body");
  const count = document.getElementById("log-count");
  if (!body || !count) return;

  const errors = appLog.filter(e => e.level === "error").length;
  count.textContent = appLog.length ? `${appLog.length}${errors ? ` · ${errors} error${errors === 1 ? "" : "s"}` : ""}` : "";
  count.classList.toggle("has-errors", errors > 0);

  if (!appLog.length) {
    body.innerHTML = `<div class="log-empty">Nothing logged yet.</div>`;
    return;
  }
  body.innerHTML = [...appLog].reverse().map(e => `
    <div class="log-row ${e.level}">
      <span class="log-ts">${escapeHtml(e.ts.slice(11, 23))}</span>
      <span class="log-src">${escapeHtml(e.source)}</span>
      <span class="log-msg">${escapeHtml(e.message)}</span>
    </div>`).join("");
}

function logAsText() {
  return appLog.map(e => `${e.ts}  [${e.level}] ${e.source}: ${e.message}`).join("\n");
}

function clearLog() {
  appLog = [];
  saveLog();
  renderLogPanel();
}

let browserState = null;

// Every backend call goes through here, so this is the one place that can see
// a failure with the command name attached. A rejected payload used to surface
// as an unlabelled console warning at best.
async function invoke(cmd, args) {
  try {
    return hasTauri ? await tauriInvoke(cmd, args) : browserMock(cmd, args);
  } catch (e) {
    logError(e?.message ?? e, `invoke:${cmd}`);
    throw e;
  }
}
function browserMock(cmd, args) {
  if (!browserState) {
    browserState = {
      keymap: { layers: Array.from({ length: 4 }, () => ({ keys: Array(21).fill("KC_NO") })) },
    };
  }
  switch (cmd) {
    case "is_connected": return false;
    case "board_status": return { connected: false, transport: "mock" };
    // Empty, not undefined: callers iterate the result, and the browser mock
    // stands for "no hardware here" rather than "command not implemented".
    case "scan_devices": return [];
    case "get_keymap":   return structuredClone(browserState.keymap);
    case "set_keymap":   browserState.keymap = structuredClone(args.map); return;
    case "set_leds":     return;
    case "set_ug_anim":  return;
    case "set_palette":  return;
    case "oled_push":    return;
    case "set_oled_busy":return;
    case "sync_time":    return;
    case "eeprom_commit":return;
    case "board_ping":   return { protocol: 1, fw_major: 0, fw_minor: 1 };
    case "get_bindings": return [];
    case "set_bindings": return;
    case "run_binding":  return "exit=Some(0)\n--- stdout ---\n(browser mock)\n--- stderr ---\n";
    case "run_script":   return `exit=Some(0)\n--- stdout ---\n(browser mock ran: ${(args?.script || "").split("\n")[0]})\n--- stderr ---\n`;
    case "simulate_board_host_cmd": return;
  }
}

const BOARD_POSITIONS = [
  { idx: 0,  row: 1, col: 1 }, { idx: 1,  row: 1, col: 2 },
  { idx: 2,  row: 1, col: 3 }, { idx: 3,  row: 1, col: 4 },
  { idx: 20, row: 1, col: 5, type: "encoder" },
  { idx: 4,  row: 2, col: 1 }, { idx: 5,  row: 2, col: 5 },
  { idx: 6,  row: 3, col: 1 }, { idx: 7,  row: 3, col: 5 },
  { idx: 8,  row: 4, col: 1 }, { idx: 9,  row: 4, col: 5 },
  { idx: 10, row: 5, col: 1 }, { idx: 11, row: 5, col: 2 },
  { idx: 12, row: 5, col: 3 }, { idx: 13, row: 5, col: 4 },
  { idx: 14, row: 5, col: 5 },
  { idx: 15, row: 6, col: 1 }, { idx: 16, row: 6, col: 2 },
  { idx: 17, row: 6, col: 3 }, { idx: 18, row: 6, col: 4 },
  { idx: 19, row: 6, col: 5 },
];

let keymap = null;
let selectedKeys = new Set();
let keyLedColors  = Array.from({ length: 21 }, () => "#ffffff");
let keyIconImages = Array(21).fill(null); // optional per-key icon: PNG/SVG data URL
// The same icon rasterised to the board's 32x32 1-bit mask, base64. Kept beside
// the image rather than derived at push time because rasterising needs a canvas
// and an image decode, both async, and buildOledConfig() is not.
let keyIconBits   = Array(21).fill(null);
let keySelectionOrder = [];              // order in which keys were selected (for snake anim)
let isDragging = false;
let wasDragging = false;
let dragFromKey = false;
let clickStartedInKeyPill = false;
let dragStartPos = null;
let activeProfileId = null;
let dragSrcId = null;

const UG_KEY          = "kf-underglow";
const UG_CORNERS_KEY  = "kf-ug-corners";
const UG_ADVANCED_KEY = "kf-ug-adv";
const KL_ADVANCED_KEY = "kf-kl-adv";
const KL_PALETTE_KEY  = "kf-kl-palette";
const UG_PALETTE_KEY  = "kf-ug-palette";
const ENC_KEY         = "kf-encoder";
const ENCODER_IDX     = 20;

// Global board LED state. `ledBrightness` is the 0xF0 byte the firmware scales
// every channel by. Whether the board shows our colours at all is NOT stored
// here — it is derived from the animation (see isAppDrivingLeds).
const BRIGHTNESS_KEY  = "kf-led-brightness";
let ledBrightness = 255;

// ── Special Enter ───────────────────────────────────────────────────────────
// Special Enter is gone: one global confirm key standing in for the encoder
// push duplicated the per-screen OLED Events, which do the same job better.
// A layer screen only ever needs Present Keys; every screen that needs a
// confirm now carries its own assignable event. Old "kf-special-enter"
// localStorage entries are simply left to rot.

let cornerColors    = ["#ffffff", "#ffffff", "#ffffff", "#ffffff"];
let selectedCorners = new Set([0, 1, 2, 3]);
const UG_SELECTED_KEY = "kf-ug-selected";
let ugAnimation   = "breathe";
let ugRate        = 128;
let ugIntensity   = 180;

let klAnimation   = "solid";
let klRate        = 128;

let klPalette     = [];
let ugPalette     = [];

const KL_PER_KEY  = "kf-kl-perkey";
const KL_ICONS_KEY = "kf-kl-icons";
const mkKeyAnim   = () => ({ animation: "solid", rate: 128, intensity: 180, palette: [] });

// Reads the one global animation out of a stored blob. Accepts both shapes:
// the current object, and the pre-2026-07-27 per-key array (21 entries), whose
// first entry becomes the global setting. Per-key animation had no wire
// representation, so collapsing an old layer loses nothing that ever reached
// the board.
function animFromStored(stored) {
  if (Array.isArray(stored)) return { ...mkKeyAnim(), ...(stored[0] ?? {}) };
  if (stored && typeof stored === "object") return { ...mkKeyAnim(), ...stored };
  return mkKeyAnim();
}

// Reassigns the theme variables AND re-syncs the controls bound to them, the
// same contract applyUnderglowSnapshot() has always had. Splitting those two
// apart is what let a layer switch, a device load or a reset leave the pill
// drawing the previous screen's theme over the new state.
//
// Safe before the DOM is wired: syncKeyLedThemeUI() null-checks every element
// it touches, and init() calls it again once the controls exist.
function applyAnimState(a) {
  klAnimation = a.animation ?? "solid";
  klRate      = a.rate ?? 128;
  klPalette   = Array.isArray(a.palette) ? [...a.palette] : [];
  syncKeyLedThemeUI();
}

function currentAnimState() {
  return { animation: klAnimation, rate: klRate, palette: [...klPalette] };
}

// Who drives the LEDs, derived rather than stored. "solid" means the board
// renders the per-key colours we pushed (the firmware overlay); any real
// animation means QMK's effect owns them. Mirrors kf_apply_anim() exactly.
function isAppDrivingLeds() {
  return klAnimation === "solid";
}
let encoderMode   = "layer"; // "layer" | "scroll"

// ── OLED state ────────────────────────────────────────────────────────────
const OLED_CUSTOM_KEY     = "kf-oled-custom";
// No OLED_CD_KEY: the countdown is not persisted at all any more, it always
// opens at 00:00:00. Old "kf-oled-cd" entries are simply left to rot.
// OLED text sizes.
//
// The board has exactly ONE font — the 5x7 table in display.c — drawn at
// integer scales, so a size is all this can be. These used to claim four
// different glyph cells (5×7, 6×8, 8×8, 8×16) and four hand-picked character
// limits, none of which the board could reproduce: it rendered every title at
// a hardcoded scale 2 whatever was picked here, and accepted titles it then
// ran off the right edge of the panel.
//
// So the limits are now derived, not chosen: draw_string() advances 6*scale
// per glyph across 128px, giving floor(128 / (6*scale)) characters.
const OLED_FONTS = [
  { id: "small",  label: "Small",  scale: 1, hw: "5×7",   previewPx: "8px",  nameMax: 21, titleMax: 21 },
  { id: "medium", label: "Medium", scale: 2, hw: "10×14", previewPx: "13px", nameMax: 10, titleMax: 10 },
  { id: "large",  label: "Large",  scale: 3, hw: "15×21", previewPx: "19px", nameMax:  7, titleMax:  7 },
  { id: "xl",     label: "XL",     scale: 4, hw: "20×28", previewPx: "25px", nameMax:  5, titleMax:  5 },
];
let oledFontId = localStorage.getItem("kf-oled-font") || "medium";
function getOledFont() { return OLED_FONTS.find(f => f.id === oledFontId) ?? OLED_FONTS[1]; }
function oledNameMax()  { return getOledFont().nameMax; }
function oledTitleMax() { return getOledFont().titleMax; }

let oledScreenIdx    = 0;
let oledSubMode      = "nav";       // "nav" | "keycycle"
let oledKeyCycleIdx  = 0;

let oledTimerRunning = false;
let oledTimerStart   = 0;
let oledTimerAcc     = 0;           // seconds accumulated before current start

let oledCdH          = 0;
let oledCdM          = 0;
let oledCdS          = 0;
let oledCdField      = "minutes";   // "hours" | "minutes" | "seconds"
let oledCdRunning    = false;
let oledCdStart      = 0;
let oledCdAcc        = 0;
let oledCdDone       = false;

// Pomodoro preview state. Mirrors the firmware's state machine in display.c
// (KF_POMO_* in kf_hid.h) so the app simulates what the board will do — the
// board runs its own copy, this is not synced live.
//
// The durations are configuration, pushed to the board via OLED_SET_POMODORO.
// These are the FIRMWARE's power-on defaults, so an unconfigured board and a
// fresh editor agree before anything is sent.
const POMO_DEFAULTS = { workMin: 25, pauseMin: 5, cycles: 4 };
// Same bounds the firmware clamps to (KF_POMO_MIN/MAX_* in kf_hid.h).
const POMO_MIN_MINUTES = 1;
const POMO_MAX_MINUTES = 240;
const POMO_MIN_CYCLES  = 1;
const POMO_MAX_CYCLES  = 16;

let oledPomo = { ...POMO_DEFAULTS };

// ── 0 is an editing state, not a duration ───────────────────────────────────
//
// These fields used to clamp UP to the minimum on every keystroke, which made
// them hostile to edit: clearing one to type a new number refilled it with `1`
// instantly, and the next digit landed after that 1 (typing 25 into a cleared
// WORK gave 125). So 0 is now allowed to sit in the field and in `oledPomo`,
// meaning "not set yet".
//
// It is NOT allowed to reach the board as a duration. The firmware clamps
// anything under KF_POMO_MIN up to it, so a 0 does not break the pomodoro — it
// does something worse, which is run 1 while the app displays 0, with nothing
// saying so. Two things close that gap: everything downstream reads
// `effectivePomo()` rather than the raw values, so the preview shows what the
// board will really do; and Save to Board asks first, since that is the point
// where a half-finished config stops being a draft.
function effectivePomo() {
  return {
    workMin:  Math.max(POMO_MIN_MINUTES, oledPomo.workMin),
    pauseMin: Math.max(POMO_MIN_MINUTES, oledPomo.pauseMin),
    cycles:   Math.max(POMO_MIN_CYCLES,  oledPomo.cycles),
  };
}

// Which fields are still unset, as labels. One source for both the inline hint
// in the pill and the Save to Board dialog, so the two cannot describe
// different states.
function pomoUnsetFields() {
  const unset = [];
  if (oledPomo.workMin  < POMO_MIN_MINUTES) unset.push("WORK");
  if (oledPomo.pauseMin < POMO_MIN_MINUTES) unset.push("PAUSE");
  if (oledPomo.cycles   < POMO_MIN_CYCLES)  unset.push("CYCLES");
  return unset;
}

// Updates the pomodoro pill's warning line and the amber outline on the fields
// that are at 0, without touching the rest of the pill. In place because the
// pill is built as one innerHTML assignment: re-rendering it to refresh a hint
// destroys the input the user is typing into, which is exactly the kind of
// interruption this whole change is meant to remove.
//
// Says what the board WOULD do rather than only that something is wrong. The
// firmware clamps silently, so "the board would use 25/5 x 4 instead" is the
// fact worth surfacing.
function renderPomoUnsetHint() {
  const el = document.getElementById("oled-pomo-unset");
  document.getElementById("oled-pomo-work")
    ?.classList.toggle("oled-num-unset", oledPomo.workMin  < POMO_MIN_MINUTES);
  document.getElementById("oled-pomo-pause")
    ?.classList.toggle("oled-num-unset", oledPomo.pauseMin < POMO_MIN_MINUTES);
  document.getElementById("oled-pomo-cycles")
    ?.classList.toggle("oled-num-unset", oledPomo.cycles   < POMO_MIN_CYCLES);
  if (!el) return;

  const unset = pomoUnsetFields();
  if (!unset.length) { el.style.display = "none"; el.textContent = ""; return; }

  const eff  = effectivePomo();
  const many = unset.length > 1;
  // Explicit "block", not "": clearing the inline style would fall back to the
  // stylesheet, which hides this by default so it cannot flash on first render.
  el.style.display = "block";
  el.textContent =
    `${unset.join(" and ")} ${many ? "are" : "is"} 0. A pomodoro cannot run on `
    + `that, so the board would use ${eff.workMin}/${eff.pauseMin} x ${eff.cycles} `
    + `instead. Set ${many ? "them" : "it"} before saving to the board.`;
}
// null = not asked yet. False means the board answered but rejected
// OLED_SET_POMODORO, i.e. firmware predating the command.
let oledPomoSupported = null;

let oledPomoPhase     = "work";     // "work" | "pause"
let oledPomoDone      = false;      // the last cycle has finished
let oledPomoRunning   = false;
let oledPomoStart     = 0;
let oledPomoAcc       = 0;          // seconds accumulated before current start
let oledPomoCompleted = 0;

function pomoPhaseSeconds() {
  const p = effectivePomo();
  return (oledPomoPhase === "pause" ? p.pauseMin : p.workMin) * 60;
}

function getPomoElapsed() {
  return oledPomoAcc + (oledPomoRunning ? (performance.now() - oledPomoStart) / 1000 : 0);
}

function getPomoRemaining() {
  return Math.max(0, pomoPhaseSeconds() - getPomoElapsed());
}

// Roll finished phases forward. Same rule as pomo_advance(): a work phase feeds
// the completed tally, and the pause after the LAST one ends the session rather
// than starting another round.
function pomoTick() {
  if (!oledPomoRunning || oledPomoDone) return;
  // Effective, not raw: with cycles at 0 the guard bound would be 0 and the
  // session could never advance past its first phase, which is not what the
  // board would do with the same config.
  const cycles = effectivePomo().cycles;
  let guard = 0;
  while (getPomoElapsed() >= pomoPhaseSeconds() && guard++ < cycles * 2) {
    if (oledPomoPhase === "work") {
      oledPomoCompleted++;
      oledPomoPhase = "pause";
    } else if (oledPomoCompleted >= cycles) {
      oledPomoDone    = true;
      oledPomoRunning = false;
      // The last phase ending is a phase change too, and the one most worth
      // noticing since nothing follows it. Mirrors pomo_advance().
      startAlertPulse(POMO_PHASE_FLASHES);
      return;
    } else {
      oledPomoPhase = "work";
    }
    oledPomoAcc   = 0;
    oledPomoStart = performance.now();
    // Work -> break or break -> work. Inside the loop, so a tick that rolls
    // two phases at once still announces the one you land on.
    startAlertPulse(POMO_PHASE_FLASHES);
  }
}

// ── LED alerts ────────────────────────────────────────────────────────────
//
// The whole board flashing red, for the two events you are meant to notice
// without reading the panel. Mirrors kf_led_alert_render() in the firmware,
// same colour and the same two rates: the countdown holds until reset (an alarm
// you can miss is not an alarm), the pomodoro fires a fixed burst and stops.
const POMO_PHASE_FLASHES = 5;
const ALERT_HOLD_MS      = 250;   // 2 Hz, countdown
const ALERT_PULSE_MS     = 100;   // 5 Hz, pomodoro burst
let alertHold   = false;
let alertPulses = 0;
let alertPulseStart = 0;
let alertWasPainting = false;

function startAlertPulse(count) {
  alertPulses     = count;
  alertPulseStart = performance.now();
}

// null when no alert is up, else true/false for the current half-period.
function alertPhase(now) {
  if (alertPulses > 0) {
    const halves = Math.floor((now - alertPulseStart) / ALERT_PULSE_MS);
    if (halves >= alertPulses * 2) { alertPulses = 0; return null; }
    return halves % 2 === 0;
  }
  if (alertHold) return Math.floor(now / ALERT_HOLD_MS) % 2 === 0;
  return null;
}

// Countdown-done drives alertHold now, so there is no second flash flag.

// No back key. It duplicated Present Keys, which already toggles the sub-mode
// both ways, and its assignment UI is gone — so a stale "kf-oled-back" entry
// could tint a key with no way left to clear it. Old entries are ignored.

const OLED_EVENT_KEYS_KEY = "kf-oled-event-keys";
let oledEventKeys      = {};    // { eventName: keyIdx }
let pendingEventAssign = null;  // eventName string while waiting for the user to pick a key

let oledCustomScreens = [];         // { id, type:"custom", title, imageDataUrl }
let oledAnimFrame     = null;
let oledLastTick      = 0;

// ── Keycode palette ────────────────────────────────────────────────────────
const KC_CATEGORIES = [
  { label: "Letters", keys: "A B C D E F G H I J K L M N O P Q R S T U V W X Y Z".split(" ").map(k => "KC_" + k) },
  { label: "Numbers", keys: ["KC_1","KC_2","KC_3","KC_4","KC_5","KC_6","KC_7","KC_8","KC_9","KC_0"] },
  { label: "F-Keys",  keys: Array.from({length:12}, (_,i) => `KC_F${i+1}`) },
  { label: "Modifiers", keys: ["KC_LCTL","KC_RCTL","KC_LSFT","KC_RSFT","KC_LALT","KC_RALT","KC_LGUI","KC_RGUI","KC_MEH","KC_HYPR"] },
  { label: "Nav",     keys: ["KC_UP","KC_DOWN","KC_LEFT","KC_RIGHT","KC_HOME","KC_END","KC_PGUP","KC_PGDN","KC_INS","KC_DEL","KC_BSPC","KC_ENTER","KC_ESC","KC_TAB","KC_SPACE"] },
  { label: "Symbols", keys: ["KC_MINS","KC_EQL","KC_LBRC","KC_RBRC","KC_BSLS","KC_SCLN","KC_QUOT","KC_GRV","KC_COMM","KC_DOT","KC_SLSH"] },
  { label: "Media",   keys: ["KC_MPLY","KC_MNXT","KC_MPRV","KC_MSTP","KC_VOLU","KC_VOLD","KC_MUTE","KC_BRIU","KC_BRID"] },
  { label: "Layers",  keys: ["MO(1)","MO(2)","MO(3)","TG(1)","TG(2)","DF(0)","DF(1)","TO(0)","TO(1)","OSL(1)"] },
  { label: "Misc",    keys: ["KC_NO","KC_TRNS","KC_PSCR","KC_SLCK","KC_PAUS","KC_CAPS","KC_NLCK","KC_APP","RESET","QK_BOOT"] },
  // No Macros or Host categories on purpose. Both emit a bare index — MACRO(n)
  // and HOST(n) — that means nothing until something owns slot n, and the macro
  // library is what owns them: assigning a macro to a key IS what allocates the
  // slot and writes the keycode. Picking a raw MACRO(3) here bound a key to
  // whatever happened to be in slot 3, or to nothing at all. The wire and
  // keycodes.rs still carry both; they are just not hand-pickable.
];
const KC_ALL_FLAT = KC_CATEGORIES.flatMap(c => c.keys);

// RATE is a SPEED: 0 = slowest, 255 = fastest. That is what the wire carries.
//
// The preview needs a DURATION, and there are TWO hardware answers, because the
// keys and the underglow are rendered by different code. One shared helper
// meant the preview could not match both, and in fact matched neither:
//
//   keys       QMK's effect_runner_i, period 65536/(speed/4 + 1) ms
//   underglow  kf_led_underglow_render(), period 4000 - speed*14 ms
//
// The old single formula was a straight 8.0s..0.3s line, which at rate 128
// previewed a 4.1 s breath while the board ran 2.0 s, and at rate 0 previewed
// 8 s against the board's 65 s. That is the "breathe changes colour at the
// wrong time" report: the palette step was landing exactly on the trough all
// along, but the breath underneath it ran at a speed the app never showed.
//
// The fix is on the firmware side — kf_rate_to_qmk_speed() converts a rate into
// the QMK speed that produces the requested period. These mirror that chain,
// quantisation included, so the preview shows the period the board will really
// run rather than one it rounds away from.
const ANIM_MIN_MS = 1050;  // at rate 255; the board's floor is 65536/64 = 1024
const ANIM_MAX_MS = 8000;  // at rate 0

// Keys. Mirrors kf_rate_to_m() + effect_runner_i, in that order:
// rate -> requested period -> quantised M -> the period M actually gives.
//
// M, not sc. QMK builds lib8tion with -DFASTLED_SCALE8_FIXED=1, so
// scale16by8(i, scale) is `(i * (1 + scale)) >> 8` — one MORE than the scale it
// is handed. The effect's multiplier is therefore qadd8(speed/4,1) + 1, and one
// cycle is 65536/M ms. Reading it as `scale` put every period here about
// (M-1)/M of its real length, and made the board's palette drift a full cycle
// against its own breath every M breaths.
//
// The define is set in builddefs/common_features.mk, not in a header, which is
// why grepping lib/lib8tion/ for it finds only the `#if` and looks like "off".
function rateToDuration(rate) {
  const r = Math.min(255, Math.max(0, Number(rate) || 0));
  const requested = ANIM_MIN_MS + Math.floor((255 - r) * (ANIM_MAX_MS - ANIM_MIN_MS) / 255);
  // speed 0 -> M 2 (32.8 s); speed 255 -> M 65 (1.008 s). Nothing else is
  // reachable on the hardware, so previewing outside it would be a lie.
  const m = Math.min(65, Math.max(2, Math.floor(65536 / requested)));
  return 65536 / m / 1000;
}

// Underglow. Was its own line, `4000 - rate*14`, mirroring a firmware
// kf_ug_period_ms() that was also its own line. Both now use the KEY mapping.
//
// At rate 128 the corners ran 2.21 s against the keys' 1.99 s — close enough to
// look deliberate, wrong enough to drift a full cycle out of step every twenty
// breaths and back. Setting both pickers to breathe never gave a board that
// breathed as one thing.
//
// Kept as a separate name rather than replacing the call sites, so the underglow
// is still addressable if it ever needs its own mapping again.
const ugRateToDuration = rateToDuration;

// noCycle: disables Cycle Colors palette when active
// keyOnly: excluded from underglow chip list (selection-order anim)
const ANIMATIONS = [
  { id: "solid",    label: "Solid",    noCycle: true              },
  { id: "rainbow",  label: "Rainbow",  noCycle: true              },
  { id: "snake",    label: "Snake",    noCycle: true, keyOnly: true },
  { id: "breathe",  label: "Breathe"                              },
  { id: "wave",     label: "Wave"                                  },
  { id: "reactive", label: "Reactive"                             },
  { id: "sparkle",  label: "Sparkle"                              },
];

// ── OLED helpers ──────────────────────────────────────────────────────────
function getOledScreens() {
  return [
    ...getSavedLayers().map(l => ({ type: "layer", layerId: l.id })),
    ...oledCustomScreens,
  ];
}

function formatTime(secs) {
  secs = Math.max(0, secs);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return h > 0
    ? `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`
    : `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
}

function getTimerElapsed() {
  return oledTimerAcc + (oledTimerRunning ? (performance.now() - oledTimerStart) / 1000 : 0);
}

function getCdRemaining() {
  const total = oledCdH * 3600 + oledCdM * 60 + oledCdS;
  const elapsed = oledCdAcc + (oledCdRunning ? (performance.now() - oledCdStart) / 1000 : 0);
  return Math.max(0, total - elapsed);
}

function saveOledCustomScreens() {
  localStorage.setItem(OLED_CUSTOM_KEY, JSON.stringify(oledCustomScreens));
}
function saveOledEventKeys() {
  localStorage.setItem(OLED_EVENT_KEYS_KEY, JSON.stringify(oledEventKeys));
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = e => resolve(e.target.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function checkImageSize(dataUrl) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload  = () => resolve(img.width <= 128 && img.height <= 128);
    img.onerror = () => resolve(false);
    img.src = dataUrl;
  });
}

// The board's icon: 32x32 1-bit, 4 bytes per row, MSB = leftmost pixel.
const ICON_MASK_W = 32, ICON_MASK_BYTES = (ICON_MASK_W / 8) * ICON_MASK_W;

// Rasterise a PNG or SVG down to that mask, returned base64.
//
// A mask, not pixels: the board draws the icon in the panel's own amber like
// every other element, so colour would cost 32x the RAM to render artwork a
// 128px amber panel cannot show off anyway.
//
// Coverage, not luminance. Icons are overwhelmingly opaque artwork on a
// transparent ground, so alpha is the shape; a black-on-transparent glyph
// thresholded by brightness would come out completely blank.
function rasterizeIconMask(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onerror = () => reject(new Error("image failed to decode"));
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = c.height = ICON_MASK_W;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      // Fit inside the square without distorting: an icon squashed to fit is
      // worse than one with margin.
      const scale = Math.min(ICON_MASK_W / img.width, ICON_MASK_W / img.height);
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      ctx.drawImage(img, (ICON_MASK_W - w) >> 1, (ICON_MASK_W - h) >> 1, w, h);
      const px = ctx.getImageData(0, 0, ICON_MASK_W, ICON_MASK_W).data;

      const bytes = new Uint8Array(ICON_MASK_BYTES);
      for (let y = 0; y < ICON_MASK_W; y++) {
        for (let x = 0; x < ICON_MASK_W; x++) {
          const a = px[(y * ICON_MASK_W + x) * 4 + 3];
          if (a >= 128) bytes[y * 4 + (x >> 3)] |= 0x80 >> (x & 7);
        }
      }
      let bin = "";
      for (const b of bytes) bin += String.fromCharCode(b);
      resolve(btoa(bin));
    };
    img.src = dataUrl;
  });
}

function iconMaskBytes(b64) {
  if (!b64) return null;
  const bin = atob(b64);
  return Array.from({ length: bin.length }, (_, i) => bin.charCodeAt(i));
}

function renderOledScreenContent(screenEl) {
  const screens = getOledScreens();
  // No screens is a legitimate state, not an error: deleting the last one
  // leaves a board whose keys and LEDs still work perfectly, and the firmware
  // reaches the same place whenever the layer count is zero. A blank rectangle
  // read as a fault, so both sides show the mark instead. No caption — naming
  // it would make it sound like something to fix.
  // A masked div, not an <img src="logo.svg">. Vite INLINES that file as a data
  // URI into index.html at build time and never emits it as an asset, so a
  // runtime src would resolve in `npm run dev` and 404 in the packaged app —
  // the same shape as the export bug. Referencing it from CSS makes Vite
  // resolve it at build time, and masking paints it the panel's amber rather
  // than approximating the board's colour through a filter chain.
  if (!screens.length) {
    // Only if it is not already up. This function replaces innerHTML wholesale
    // and is called from every mutation point, so a Save to Board rebuilt the
    // logo many times in a second — and each rebuild makes the browser
    // re-decode the inline SVG mask, which is visible as a flicker. Nothing
    // about this screen changes, so there is nothing to redraw.
    //
    // Same defect the board's saving splash had, arrived at independently on
    // the other side: a static image redrawn because something else was busy.
    if (!screenEl.firstElementChild?.classList.contains("oled-logo-screen")) {
      screenEl.innerHTML = `<div class="oled-logo-screen"></div>`;
    }
    return;
  }
  if (oledScreenIdx >= screens.length) oledScreenIdx = screens.length - 1;
  const screen = screens[oledScreenIdx];

  // Present Keys is an inspection mode for the BOARD, so it renders whatever
  // screen you are on rather than only layer screens. It used to live inside
  // the layer case, which is why triggering it elsewhere did nothing.
  if (oledSubMode === "keycycle") {
    const cyclePos    = BOARD_POSITIONS[oledKeyCycleIdx];
    const cycleKeyI   = cyclePos?.idx ?? 0;
    const ksk         = currentOledScreenKey();
    const kScreenEvMap = ksk ? (oledEventKeys[ksk] || {}) : {};
    const evEntry     = Object.entries(kScreenEvMap).find(([, v]) => evIdx(v) === cycleKeyI);
    const evLabel     = evEntry ? OLED_EVENT_LABELS[evEntry[0]] : null;
    let numLabel, icon, text;
    if (cyclePos?.type === "encoder") {
      numLabel = "ENC"; icon = null; text = "ENCODER";
    } else {
      numLabel = String(cycleKeyI + 1).padStart(2, "0");
      // Exactly one of icon / macro title / keycode, in that priority — the
      // same rule the board applies.
      const info = keyPresentInfo(cycleKeyI);
      icon = info.icon;
      text = icon ? "" : keyPresentText(cycleKeyI);
    }
    // The screen action is a separate line, not a competitor. Those three
    // answer "what is this key"; this answers "what does it do HERE" — and on
    // this screen the binding swallows the press entirely, so the keycode and
    // the action are both true and both worth saying.
    const body = icon
      ? `<img class="oled-kc-icon-img" src="${icon}" alt="" />`
      : `<div class="oled-kc-val">${escapeHtml(text || "—")}</div>`;
    screenEl.innerHTML = `<div class="oled-keycycle">
      <div class="oled-kc-num">${numLabel}</div>
      ${body}
      ${evLabel ? `<div class="oled-kc-event">${escapeHtml(evLabel)}</div>` : ""}
    </div>`;
    return;
  }

  switch (screen.type) {
    case "layer": {
      const layers = getSavedLayers();
      const layer  = layers.find(l => l.id === screen.layerId);
      const idx    = String(layers.indexOf(layer) + 1).padStart(2, "0");
      // The name IS the screen. It used to be a secondary line under a fixed
      // "LAYER NN", gated behind a Show toggle, so renaming a layer appeared
      // to do nothing — the big text never changed. Falls back to LAYER NN
      // only when the layer has no name at all.
      const name = (layer?.name || "").toUpperCase().slice(0, oledNameMax());
      screenEl.innerHTML = `<div class="oled-layer-screen">
        <div class="oled-lyr-name">${escapeHtml(name || `LAYER ${idx}`)}</div>
      </div>`;
      break;
    }
    case "timer": {
      const elapsed = getTimerElapsed();
      screenEl.innerHTML = `<div class="oled-timer-screen">
        <div class="oled-screen-lbl">TIMER</div>
        <div class="oled-time-val">${formatTime(elapsed)}</div>
        <div class="oled-screen-hint">${oledTimerRunning ? "↓ stop" : "↓ start"}</div>
      </div>`;
      break;
    }
    case "countdown": {
      if (oledCdDone) {
        screenEl.innerHTML = `<div class="oled-countdown-screen">
          <div class="oled-screen-lbl">COUNTDOWN</div>
          <div class="oled-time-val oled-cd-flash">00:00</div>
          <div class="oled-screen-hint">↓ reset</div>
        </div>`;
      } else {
        const sel = f => oledCdField === f && !oledCdRunning ? "oled-cd-sel" : "";
        const timeDisplay = oledCdRunning
          ? formatTime(getCdRemaining())
          : `<span class="${sel("hours")}">${String(oledCdH).padStart(2,"0")}</span>`
            + `:<span class="${sel("minutes")}">${String(oledCdM).padStart(2,"0")}</span>`
            + `:<span class="${sel("seconds")}">${String(oledCdS).padStart(2,"0")}</span>`;
        screenEl.innerHTML = `<div class="oled-countdown-screen">
          <div class="oled-screen-lbl">COUNTDOWN</div>
          <div class="oled-time-val">${timeDisplay}</div>
          <div class="oled-screen-hint">${oledCdRunning ? "↓ stop" : "←→ field · ↑↓ set · ↓ start"}</div>
        </div>`;
      }
      break;
    }
    case "pomodoro": {
      const phaseLabel = oledPomoDone ? "DONE" : (oledPomoPhase === "work" ? "POMODORO" : "PAUSE");
      const isBreak    = oledPomoDone || oledPomoPhase !== "work";
      screenEl.innerHTML = `<div class="oled-timer-screen">
        <div class="oled-screen-lbl">${phaseLabel}</div>
        <div class="oled-time-val${isBreak ? " oled-pomo-break" : ""}">${
          oledPomoDone ? "00:00" : formatTime(getPomoRemaining())}</div>
        <div class="oled-screen-hint">${oledPomoCompleted} / ${oledPomo.cycles}</div>
        <div class="oled-screen-hint">${
          oledPomoDone ? "↓ restart" : (oledPomoRunning ? "↓ pause" : "↓ start")}</div>
      </div>`;
      break;
    }
    case "datetime": {
      const now  = new Date();
      const time = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      const date = now.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
      screenEl.innerHTML = `<div class="oled-datetime-screen">
        <div class="oled-dt-time">${time}</div>
        <div class="oled-dt-date">${date}</div>
      </div>`;
      break;
    }
    case "gif": {
      // The browser animates the source GIF directly. The board plays a reduced
      // version (16 colours, up to 8 frames), so treat this as an approximation
      // rather than an exact mirror.
      screenEl.innerHTML = screen.imageDataUrl
        ? `<img class="oled-custom-img" src="${screen.imageDataUrl}" alt="" />`
        : `<div class="oled-custom-screen">
             <div class="oled-custom-screen-title">GIF</div>
             <div class="oled-custom-screen-body">No image uploaded</div>
           </div>`;
      break;
    }
    case "custom": {
      const title = (screen.title || "").toUpperCase().slice(0, oledTitleMax());
      const body  = screen.body || "";
      if (body) {
        screenEl.innerHTML = `<div class="oled-custom-screen">
          ${title ? `<div class="oled-custom-screen-title">${title}</div>` : ""}
          <div class="oled-custom-screen-body">${body}</div>
        </div>`;
      } else {
        screenEl.innerHTML = `<div class="oled-custom-text">${title || "—"}</div>`;
      }
      break;
    }
  }
}

function updateOledDisplay() {
  const screenEl = document.querySelector(".oled-screen");
  if (screenEl) renderOledScreenContent(screenEl);
  refreshSpecialKeyHints();
  const pill = document.getElementById("oled-pill");
  if (pill.classList.contains("visible")) {
    renderOledPillNav();
    // Don't rebuild pill content while user is typing — it would destroy the focused element
    if (!pill.querySelector("input:focus, textarea:focus")) {
      renderOledPillContent();
    }
  }
}

function oledScreenNav(dir) {
  if (oledCdDone) { oledCdDone = false; alertHold = false; oledCdAcc = 0; }
  oledSubMode = "nav";
  const screens = getOledScreens();
  oledScreenIdx = (oledScreenIdx + dir + screens.length) % screens.length;
  const screen = screens[oledScreenIdx];
  // Every screen, not just layers: a custom screen owns a profile too.
  switchToScreen(screen);
  updateOledDisplay();
  renderLayerBar();
}

// Rotation is screen navigation, always. It used to be hijacked by the
// countdown screen for field editing, which made that screen a dead end: the
// only control that moves between screens stopped moving between screens the
// moment you arrived on it. Field editing lives on the arrow keys now.
function onEncoderCW() {
  if (oledSubMode === "keycycle") {
    oledKeyCycleIdx = (oledKeyCycleIdx + 1) % 21;
    updateOledDisplay(); renderBoard(); return;
  }
  oledScreenNav(1);
}

function onEncoderCCW() {
  if (oledSubMode === "keycycle") {
    oledKeyCycleIdx = (oledKeyCycleIdx + 20) % 21;
    updateOledDisplay(); renderBoard(); return;
  }
  oledScreenNav(-1);
}

function triggerOledEvent(eventName) {
  switch (eventName) {
    case "presentKeys": {
      if (oledSubMode === "keycycle") {
        oledSubMode = "nav"; oledKeyCycleIdx = 0;
      } else {
        // Stays on the current screen. It used to jump to a layer screen,
        // because Present Keys only rendered on one — so triggering it from a
        // Pomodoro screen silently moved you somewhere else. It is an
        // inspection mode for the board, and the board is the same whichever
        // screen is showing.
        oledSubMode = "keycycle"; oledKeyCycleIdx = 0;
      }
      updateOledDisplay(); renderBoard();
      break;
    }
    case "timerStartStop":
      if (oledTimerRunning) { oledTimerAcc = getTimerElapsed(); oledTimerRunning = false; }
      else { oledTimerStart = performance.now(); oledTimerRunning = true; }
      updateOledDisplay();
      break;
    case "timerReset":
      oledTimerRunning = false; oledTimerAcc = 0; updateOledDisplay();
      break;
    // Field editing as bindable events, alongside the keycode route the board
    // uses (kf_cd_arrow). Same guard as there: only while the fields are
    // actually editable, so a bound key does nothing mid-countdown rather than
    // silently moving a marker no one can see.
    case "cdLeft":
      if (!oledCdRunning && !oledCdDone) moveCdField(-1);
      break;
    case "cdRight":
      if (!oledCdRunning && !oledCdDone) moveCdField(1);
      break;
    case "cdUp":
      if (!oledCdRunning && !oledCdDone) adjustCdField(1);
      break;
    case "cdDown":
      if (!oledCdRunning && !oledCdDone) adjustCdField(-1);
      break;
    case "pomoStartStop":
      // A fixed cycle count gives the session an end, so push needs a way out
      // of it that is not "reload the app".
      if (oledPomoDone) {
        oledPomoDone      = false;
        oledPomoCompleted = 0;
        oledPomoPhase     = "work";
        oledPomoAcc       = 0;
        oledPomoStart     = performance.now();
        oledPomoRunning   = true;
      } else if (oledPomoRunning) {
        oledPomoAcc     = getPomoElapsed();
        oledPomoRunning = false;
      } else {
        oledPomoStart   = performance.now();
        oledPomoRunning = true;
      }
      updateOledDisplay();
      break;
    case "cdEvent":
      if (oledCdDone) {
        oledCdDone = false; oledCdRunning = false; oledCdAcc = 0; alertHold = false;
        updateOledDisplay(); renderBoard();
      } else if (oledCdRunning) {
        oledCdAcc += (performance.now() - oledCdStart) / 1000;
        oledCdRunning = false; updateOledDisplay();
      } else {
        oledCdStart = performance.now(); oledCdAcc = 0; oledCdRunning = true;
        updateOledDisplay();
      }
      break;
  }
}

function onEncoderPress() {
  const screens = getOledScreens();
  const screen  = screens[oledScreenIdx];

  if (screen?.type === "layer") {
    if (oledSubMode === "keycycle") {
      oledSubMode = "nav"; oledKeyCycleIdx = 0;
    } else {
      oledSubMode = "keycycle"; oledKeyCycleIdx = 0;
    }
    updateOledDisplay(); renderBoard(); return;
  }

  if (screen?.type === "pomodoro") {
    if (oledPomoRunning) {
      oledPomoAcc     = getPomoElapsed();
      oledPomoRunning = false;
    } else {
      oledPomoStart   = performance.now();
      oledPomoRunning = true;
    }
    updateOledDisplay(); return;
  }

  if (screen?.type === "timer") {
    if (oledTimerRunning) {
      oledTimerAcc     = getTimerElapsed();
      oledTimerRunning = false;
    } else {
      oledTimerStart   = performance.now();
      oledTimerRunning = true;
    }
    updateOledDisplay(); return;
  }

  if (screen?.type === "countdown") {
    if (oledCdDone) {
      oledCdDone = false; oledCdRunning = false;
      oledCdAcc  = 0;    alertHold = false;
      updateOledDisplay(); renderBoard(); return;
    }
    if (oledCdRunning) {
      oledCdAcc    += (performance.now() - oledCdStart) / 1000;
      oledCdRunning = false;
    } else if (oledCdH + oledCdM + oledCdS > 0) {
      // Push is start/stop only. Walking the fields on push was how you used to
      // select one; the arrow keys do that now, so push means what the screen
      // says it means.
      oledCdStart   = performance.now();
      oledCdAcc     = 0;
      oledCdRunning = true;
    }
    // 00:00:00 would finish on the same tick, so it simply does not start.
    updateOledDisplay(); return;
  }
}

function adjustCdField(delta) {
  switch (oledCdField) {
    case "hours":   oledCdH = Math.max(0, Math.min(99, oledCdH + delta)); break;
    case "minutes": oledCdM = Math.max(0, Math.min(59, oledCdM + delta)); break;
    case "seconds": oledCdS = Math.max(0, Math.min(59, oledCdS + delta)); break;
  }
  updateOledDisplay();
}

// Keys with a screen action used to blink at 3 Hz to advertise themselves.
// That is now an icon drawn on the key (OLED_EVENT_ICONS) — it names the action
// instead of merely flagging it, and it holds still. Nothing here toggles a
// class any more; the hint is part of the key's content and comes out of
// renderBoard().
//
// Kept as a clearing pass rather than deleted outright: a key that was blinking
// when the screen changed would otherwise keep its class until the next full
// rebuild. Callers still invoke this on every OLED update.
//
// NOTE: the countdown arrows on a countdown screen were also blinked from here,
// including when they were plain KC_LEFT/KC_RIGHT/KC_UP/KC_DOWN keys rather
// than bound events. Those keys now show nothing unless they are bound as
// cdLeft/cdRight/cdUp/cdDown events, which is the supported way to get the
// icon. The firmware still runs its own kf_led_special_blink() for the arrows,
// so app and board no longer agree here — tracked in the Firmware backlog.
function refreshSpecialKeyHints() {
  for (const pos of BOARD_POSITIONS) {
    document.getElementById("key-" + pos.idx)?.classList.remove("key-special-blink");
  }
}

// Back to 00:00:00 with hours selected — the state the countdown screen always
// opens in. Also clears any run in progress, so a stale one cannot survive.
function resetCountdown() {
  oledCdH = 0; oledCdM = 0; oledCdS = 0;
  oledCdField   = "hours";
  oledCdRunning = false;
  oledCdDone    = false;
  oledCdAcc     = 0;
}

// The editor only ever writes layer 0, so that is where a key's keycode lives.
function keycodeAt(idx) {
  return keymap?.layers?.[0]?.keys?.[idx] ?? "KC_NO";
}

const CD_FIELDS = ["hours", "minutes", "seconds"];

function moveCdField(delta) {
  const i = CD_FIELDS.indexOf(oledCdField);
  // Wraps, so you can reach seconds from hours with one press either way.
  oledCdField = CD_FIELDS[(i + delta + CD_FIELDS.length) % CD_FIELDS.length];
  updateOledDisplay();
}

// Arrow keys drive the countdown while its screen is up: left/right pick a
// field, up/down change it.
//
// Matched on the KEYCODE rather than the key index, so remapping an arrow moves
// the control with it instead of stranding it on whatever now sits at index 11.
// Returns true when the press was consumed, which is what stops it also being
// typed — the same trade Present Keys already makes.
function handleCountdownArrow(idx) {
  const screens = getOledScreens();
  if (screens[oledScreenIdx]?.type !== "countdown") return false;
  // While it runs, the fields are not editable and the display shows remaining
  // time, so arrows should behave normally.
  if (oledCdRunning || oledCdDone) return false;

  switch (keycodeAt(idx)) {
    case "KC_LEFT":  moveCdField(-1); return true;
    case "KC_RIGHT": moveCdField(1);  return true;
    case "KC_RGHT":  moveCdField(1);  return true;
    case "KC_UP":    adjustCdField(1);  return true;
    case "KC_DOWN":  adjustCdField(-1); return true;
    default: return false;
  }
}

const OLED_EVENT_LABELS = {
  presentKeys:    "Present Keys",
  timerStartStop: "Start / Stop",
  timerReset:     "Reset Timer",
  cdEvent:        "Start / Stop",
  cdLeft:         "Field ←",
  cdRight:        "Field →",
  cdUp:           "Value +",
  cdDown:         "Value −",
  pomoStartStop:  "Start / Pause",
};

// One glyph per screen event, drawn on the key it is bound to.
//
// This replaces the 3 Hz blink that used to mark these keys. The blink said
// "this key does something here" without saying WHAT, cost an animation on
// every event key, and read as a fault rather than a hint. An icon says which
// action the key performs and holds still while it does it.
//
// Line icons on a 24×24 grid, stroked in `currentColor` so each one picks up
// its event's assigned colour. The three start/stop events deliberately share
// a glyph: only one of them can appear on any given screen, and they are the
// same gesture to the user.
const OLED_EVENT_ICONS = {
  presentKeys:
    '<rect x="3" y="5" width="5" height="5" rx="1.2"/><rect x="9.5" y="5" width="5" height="5" rx="1.2"/>'
  + '<rect x="16" y="5" width="5" height="5" rx="1.2"/><rect x="3" y="13" width="5" height="5" rx="1.2"/>'
  + '<rect x="9.5" y="13" width="5" height="5" rx="1.2"/><rect x="16" y="13" width="5" height="5" rx="1.2"/>',
  timerStartStop: '<circle cx="12" cy="12" r="8.5"/><path d="M10 8.4 L16.2 12 L10 15.6 Z"/>',
  cdEvent:        '<circle cx="12" cy="12" r="8.5"/><path d="M10 8.4 L16.2 12 L10 15.6 Z"/>',
  pomoStartStop:  '<circle cx="12" cy="12" r="8.5"/><path d="M10 8.4 L16.2 12 L10 15.6 Z"/>',
  timerReset:     '<path d="M19.2 12a7.2 7.2 0 1 1-2.1-5.1"/><path d="M19.2 3.6 v4.2 h-4.2"/>',
  cdLeft:         '<path d="M14.5 5.5 L8.5 12 L14.5 18.5"/>',
  cdRight:        '<path d="M9.5 5.5 L15.5 12 L9.5 18.5"/>',
  cdUp:           '<path d="M5.5 14.5 L12 8.5 L18.5 14.5"/>',
  cdDown:         '<path d="M5.5 9.5 L12 15.5 L18.5 9.5"/>',
};

function oledEventIconSVG(eventName) {
  const body = OLED_EVENT_ICONS[eventName];
  if (!body) return null;
  return `<svg class="key-event-icon" viewBox="0 0 24 24" aria-hidden="true"
    fill="none" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}

function currentOledScreenKey() {
  const screens = getOledScreens();
  const s = screens[oledScreenIdx];
  return s ? (s.layerId || s.id) : null;
}

// ── Per-screen sleep ────────────────────────────────────────────────────────
// Whether the OLED is allowed to blank itself after a period of no input, per
// screen. Off by default, because a screen going dark unasked reads as a fault:
// you opt a screen in. Worth having per screen rather than globally — a clock
// you glance at wants to stay lit, a countdown you started and walked away from
// does not, and burn-in is cumulative on the pixels that never change.
const OLED_SLEEP_KEY = "kf-oled-sleep";
let oledSleepScreens = {};   // { screenKey: true }

// Seconds of no input before an opted-in screen blanks. One global value: the
// board carries a single timeout, and per-screen durations would be a setting
// nobody asked for on top of one they did.
const OLED_SLEEP_TIMEOUT_S = 60;

function screenSleepEnabled(sk) {
  return sk ? oledSleepScreens[sk] === true : false;
}

// Stable wire ids, matching `enum kf_event` in kf_hid.h. Anything not listed
// here is app-only and simply is not sent.
const EVENT_WIRE_ID = {
  presentKeys:    0,
  timerStartStop: 1,
  timerReset:     2,
  cdEvent:        3,
  cdLeft:         4,
  cdRight:        5,
  cdUp:           6,
  cdDown:         7,
  pomoStartStop:  8,
};

// What Present Keys says about a key, in priority order: the ICON if the key
// has one, else the macro title, else the keycode. Exactly one of the three.
//
// The icon wins because it is the user's explicit statement of what this key
// is — a name they chose over one the app derived. The text fields are what
// stands in when there isn't one.
//
// The board is sent all of it (text via 0x5D, the icon's 32x32 mask via 0x5F)
// and applies the same priority, so the two views cannot disagree.
function keyPresentInfo(idx) {
  const macroName = keyMacros[idx] ? (findMacroById(keyMacros[idx])?.name ?? "") : "";
  const kc = keycodeAt(idx);
  return {
    icon: keyIconImages[idx] || null,
    macro_title: macroName,
    keycode: (kc === "KC_NO" || kc === "KC_TRNS") ? "" : kc.replace(/^KC_/, ""),
  };
}

// Which of the three actually shows, as one string — or null when it is the
// icon, which is an image rather than text.
function keyPresentText(idx) {
  const i = keyPresentInfo(idx);
  if (i.icon) return null;
  return i.macro_title || i.keycode || "";
}

function buildKeyInfo() {
  return Array.from({ length: 21 }, (_, i) => {
    const info = keyPresentInfo(i);
    return { macro_title: info.macro_title, keycode: info.keycode };
  });
}

// The icon masks, in board key order. `null` means "this key has no icon",
// which the board is told explicitly so a removed icon actually goes away.
function buildKeyIcons() {
  return Array.from({ length: 21 }, (_, i) => iconMaskBytes(keyIconBits[i]));
}

function buildEventKeys() {
  // Same nav-index convention as the sleep mask: the first four saved layers
  // are slots 0..3, custom screens follow at 4..9.
  const slotOf = {};
  getSavedLayers().slice(0, 4).forEach((l, i) => { slotOf[l.id] = i; });
  oledCustomScreens.slice(0, 6).forEach((sc, i) => { slotOf[sc.id] = 4 + i; });

  const out = [];
  for (const [screenKey, events] of Object.entries(oledEventKeys)) {
    const slot = slotOf[screenKey];
    if (slot === undefined) continue;
    for (const [name, entry] of Object.entries(events)) {
      const wire = EVENT_WIRE_ID[name];
      const key  = evIdx(entry);
      if (wire === undefined || key === null || key === undefined) continue;
      out.push([slot, wire, key]);
    }
  }
  return out;
}

// Every screen's LED profile, in the same fixed slot space as the sleep mask
// and the event keys.
//
// The app has always kept a profile per screen; the board held exactly one, so
// an animation set on the first layer went on running after you rotated to a
// pomodoro screen. It cannot be fixed by pushing the active profile harder:
// the encoder changes screens with no app involved and has to keep working
// with the app closed, so the board needs all of them up front.
//
// The screen being edited reads from the LIVE state rather than storage —
// captureProfile() has not run for it yet, and pushing its stale stored copy
// would undo the edit that triggered the push.
function buildScreenLeds() {
  const out = [];
  const add = (slot, id, stored) => {
    const live = id === activeProfileId;
    const prof = live ? captureProfile() : stored;
    const cols = prof?.leds ?? [];
    const anim = animFromStored(prof?.animStates);
    const ug   = prof?.underglow ?? null;
    const corners = Array.isArray(ug?.cornerColors) ? ug.cornerColors : cornerColors;
    // Same tint rule buildAnimState() uses: a palette's first entry stands in
    // for the base colour, so a cycling screen does not push a stale tint.
    const tint = (Array.isArray(anim.palette) && anim.palette.length > 0)
      ? anim.palette[0]
      : "#ffb454";
    out.push({
      slot,
      leds: {
        keys: Array.from({ length: 21 }, (_, i) => hexToRgbArr(cols[i] || "#ffffff")),
        underglow: UG_APP_TO_WIRE.map(i => hexToRgbArr(corners[i] || "#ffffff")),
        brightness: ledBrightness,
      },
      anim: { name: anim.animation ?? "solid", speed: anim.rate ?? 128, color: hexToRgbArr(tint) },
      underglow: {
        name:      ug?.animation ?? "solid",
        speed:     ug?.rate      ?? 128,
        intensity: ug?.intensity ?? 180,
      },
    });
  };
  getSavedLayers().slice(0, 4).forEach((l, i) => add(i, l.id, l));
  oledCustomScreens.slice(0, 6).forEach((s, i) => add(4 + i, s.id, s.profile));
  return out;
}

function buildSleepMask() {
  let mask = 0;
  getSavedLayers().slice(0, 4).forEach((l, i) => {
    if (screenSleepEnabled(l.id)) mask |= 1 << i;
  });
  oledCustomScreens.slice(0, 6).forEach((s, i) => {
    if (screenSleepEnabled(s.id)) mask |= 1 << (4 + i);
  });
  return mask;
}

function setScreenSleep(sk, on) {
  if (!sk) return;
  if (on) oledSleepScreens[sk] = true;
  else delete oledSleepScreens[sk];
  localStorage.setItem(OLED_SLEEP_KEY, JSON.stringify(oledSleepScreens));
  scheduleAutoSave();
  scheduleLiveSync("oled");
}

// Rendered on every screen's pill, so the setting sits in the same place
// wherever you are rather than only on the screens someone remembered to add
// it to.
function sleepRowHTML() {
  const sk = currentOledScreenKey();
  const on = screenSleepEnabled(sk);
  return `
    <div class="oled-pill-section oled-sleep-row">
      <span class="pill-label">SCREEN SLEEP</span>
      <button class="oled-sleep-btn${on ? " on" : ""}" id="oled-sleep-toggle"
        title="${on
          ? "This screen blanks after a period with no input. Any key or the encoder wakes it."
          : "This screen stays lit. Turn on to blank it after a period with no input."}">
        ${on ? "On" : "Off"}
      </button>
    </div>`;
}

function wireSleepRow(container) {
  container.querySelector("#oled-sleep-toggle")?.addEventListener("click", () => {
    const sk = currentOledScreenKey();
    setScreenSleep(sk, !screenSleepEnabled(sk));
    renderOledPillContent();
  });
}

function eventRowHTML(eventName, label) {
  const sk       = currentOledScreenKey();
  const entry    = sk ? (oledEventKeys[sk]?.[eventName] ?? null) : null;
  const keyIdx   = evIdx(entry);
  const isPending = pendingEventAssign === eventName;
  if (isPending) {
    return `<div class="oled-pill-section oled-event-row">
      <span class="oled-event-name">${label}</span>
      <span class="oled-event-key-val oled-event-picking">Press a key…</span>
      <button class="oled-action-btn oled-del-screen" data-ev-cancel="${eventName}">Cancel</button>
    </div>`;
  }
  const color = evColor(entry);
  return `<div class="oled-pill-section oled-event-row">
    <span class="oled-event-name">${label}</span>
    <span class="oled-event-key-val">${keyIdx !== null ? `Key ${keyIdx}` : "—"}</span>
    ${keyIdx !== null
      ? `<input type="color" class="oled-event-color-inp" value="${color}" data-ev-color="${eventName}" title="Key color" />
         <button class="oled-action-btn" data-ev-led="${keyIdx}" title="LED settings">LED</button>
         <button class="oled-action-btn oled-del-screen" data-ev-clear="${eventName}">Clear</button>`
      : `<button class="oled-action-btn" data-ev-assign="${eventName}">Assign</button>`
    }
  </div>`;
}

function wireEventRows(container) {
  container.querySelectorAll("[data-ev-color]").forEach(inp => {
    inp.addEventListener("input", (e) => {
      e.stopPropagation();
      const sk = currentOledScreenKey();
      const evName = inp.dataset.evColor;
      if (sk && oledEventKeys[sk]?.[evName]) {
        oledEventKeys[sk][evName].color = inp.value;
        saveOledEventKeys();
        renderBoard();
      }
    });
  });
  container.querySelectorAll("[data-ev-led]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openLedSettingsForKey(Number(btn.dataset.evLed));
    });
  });
  container.querySelectorAll("[data-ev-assign]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      pendingEventAssign = btn.dataset.evAssign;
      renderOledPillContent(); renderBoard();
    });
  });
  container.querySelectorAll("[data-ev-clear]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const sk = currentOledScreenKey();
      if (sk && oledEventKeys[sk]) { delete oledEventKeys[sk][btn.dataset.evClear]; }
      saveOledEventKeys(); renderOledPillContent(); renderBoard();
    });
  });
  container.querySelectorAll("[data-ev-cancel]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      pendingEventAssign = null;
      renderOledPillContent(); renderBoard();
    });
  });
}

// Which screen the board is showing, and the current layer's name, rendered
// onto the bar above the board. The name is an input rather than a label
// because renaming in place is one fewer mode than a separate edit button.
function renderLayerBar() {
  const bar = document.getElementById("layer-bar");
  if (!bar) return;
  const screens = getOledScreens();
  const screen  = screens[oledScreenIdx] ?? {};
  const layers  = getSavedLayers();

  const nameInp = document.getElementById("layer-name");
  const posEl   = document.getElementById("layer-pos");
  const onLayer = screen.type === "layer";

  if (onLayer) {
    const layer = layers.find(l => l.id === screen.layerId);
    // Never clobber what is being typed.
    if (document.activeElement !== nameInp) nameInp.value = layer?.name ?? "";
    nameInp.disabled = false;
    nameInp.placeholder = "Layer name…";
  } else {
    nameInp.value = screenDisplayName(screen);
    nameInp.disabled = true;   // only a layer has a name you can change
    // With no screens at all the field would be blank, disabled and unexplained
    // beside a panel showing just the logo. Say what the state is — the keys
    // and LEDs still work here, so it is not an error, just empty.
    nameInp.placeholder = screens.length ? "" : "No screens — add one with + Screen";
  }
  posEl.textContent = screens.length ? `${oledScreenIdx + 1} / ${screens.length}` : "";

  // Removing a layer is part of "Screen" now, and the last one cannot go:
  // zero layers is the state device reset exists to avoid.
  const delBtn = document.getElementById("layer-del-screen");
  delBtn.title = onLayer ? "Remove this layer" : "Remove this screen";
  delBtn.disabled = onLayer
    ? layers.length <= 1
    : !["timer", "countdown", "datetime", "pomodoro", "gif", "custom"].includes(screen.type);
}

function screenDisplayName(screen) {
  switch (screen?.type) {
    case "timer":     return "Timer";
    case "countdown": return "Countdown";
    case "datetime":  return "Date & Time";
    case "pomodoro":  return "Pomodoro";
    case "gif":       return "GIF / Image";
    case "custom":    return screen.title || "Custom Screen";
    default:          return "";
  }
}

// Jump the OLED nav to a specific layer's screen, so creating a layer lands you
// on it rather than leaving the bar showing the one you were on.
function goToLayerScreen(layerId) {
  const i = getOledScreens().findIndex(s => s.type === "layer" && s.layerId === layerId);
  if (i >= 0) {
    oledScreenIdx = i;
    oledSubMode = "nav";
    updateOledDisplay();
    renderOledPill();
  }
}

async function removeCurrentScreen() {
  const screens = getOledScreens();
  const screen  = screens[oledScreenIdx];
  if (!screen) return;

  // A layer is a screen in this model, so "remove this screen" removes it —
  // there is no separate delete button any more. Confirmed, because unlike a
  // timer screen a layer carries a whole keymap and LED profile.
  if (screen.type === "layer") {
    const layers = getSavedLayers();
    if (layers.length <= 1) return;
    const layer = layers.find(l => l.id === screen.layerId);
    const ok = await confirmModal({
      title: `Delete ${layer?.name || "this layer"}?`,
      body: "This layer's keymap, colours, icons and macros go with it. It "
          + "cannot be undone. Export from the device card on Home first if you "
          + "want to keep a copy.",
      confirmLabel: "Delete layer",
    });
    if (!ok) return;
    deleteSavedLayer(screen.layerId);
    oledScreenIdx = Math.max(0, Math.min(oledScreenIdx, getOledScreens().length - 1));
    // Deleting the ACTIVE layer left activeProfileId null with the deleted
    // layer's keymap and colours still in memory and on the keycaps: the OLED
    // and the bar moved on, the board did not, and it stayed that way until
    // something unrelated forced a render. Land on the screen we just moved to.
    if (applyScreenLocally(getOledScreens()[oledScreenIdx])) pushActiveScreenToBoard();
    updateOledDisplay();
    renderLayerBar();
    renderOledPill();
    return;
  }
  const wasLast = oledScreenIdx >= screens.length - 1;
  if (screen.type === "countdown") resetCountdown();
  oledCustomScreens = oledCustomScreens.filter(s => s.id !== screen.id);
  saveOledCustomScreens();
  if (wasLast) oledScreenIdx = Math.max(0, oledScreenIdx - 1);
  // Same as the layer branch: if the screen just deleted was the active one,
  // the board is still showing its profile.
  if (applyScreenLocally(getOledScreens()[oledScreenIdx])) pushActiveScreenToBoard();
  updateOledDisplay();
  renderLayerBar();
  renderOledPill();
  scheduleLiveSync("oled");
}

function renderOledPillNav() {
  const screens = getOledScreens();
  const screen  = screens[oledScreenIdx] ?? {};
  let name = "";
  switch (screen.type) {
    case "layer": {
      const layers = getSavedLayers();
      const layer  = layers.find(l => l.id === screen.layerId);
      const idx    = layers.indexOf(layer) + 1;
      name = `Layer ${String(idx).padStart(2,"0")}${oledSubMode === "keycycle" ? " — Present Keys" : ""}`;
      break;
    }
    case "timer":     name = "Timer";       break;
    case "countdown": name = "Countdown";   break;
    case "datetime":  name = "Date & Time"; break;
    case "pomodoro":  name = "Pomodoro";    break;
    case "gif":       name = "GIF / Image"; break;
    case "custom":    name = screen.title || "Custom Screen"; break;
  }
  const nameEl = document.getElementById("oled-screen-name");
  if (nameEl) nameEl.textContent = `${oledScreenIdx + 1} / ${screens.length} — ${name}`;

}

function renderOledPillContent() {
  const container = document.getElementById("oled-pill-content");
  if (!container) return;
  const screens = getOledScreens();
  const screen  = screens[oledScreenIdx] ?? {};

  switch (screen.type) {
    case "layer": {
      const layer = getSavedLayers().find(l => l.id === screen.layerId);
      const showTitle = layer?.showTitle !== false;
      container.innerHTML = `
        <div class="oled-pill-section">
          <span class="pill-label">TITLE</span>
          <input class="oled-title-inp" id="oled-title-inp" type="text"
            value="${layer?.name || ""}" placeholder="Layer name…" maxlength="${oledNameMax()}" />
        </div>
        <div class="oled-pill-hint">
          Layer name shown on OLED (max ${oledNameMax()} chars). Present Keys cycles through key assignments.
        </div>
        <div class="oled-pill-section" style="padding-bottom:6px">
          <span class="pill-label">SCREEN EVENTS</span>
        </div>
        ${eventRowHTML("presentKeys", "Present Keys")}
        ${sleepRowHTML()}`;
      document.getElementById("oled-title-inp")?.addEventListener("input", (e) => {
        if (layer) { renameSavedLayer(layer.id, e.target.value); updateOledDisplay(); }
      });
      wireEventRows(container);
      wireSleepRow(container);
      break;
    }
    case "timer": {
      container.innerHTML = `
        <div class="oled-pill-section oled-pill-hint">
          Timer resets when you navigate to another screen.
        </div>
        <div class="oled-pill-section" style="padding-bottom:6px">
          <span class="pill-label">SCREEN EVENTS</span>
        </div>
        ${eventRowHTML("timerStartStop", "Start / Stop")}
        ${eventRowHTML("timerReset", "Reset")}
        ${eventRowHTML("presentKeys", "Present Keys")}
        ${sleepRowHTML()}`;
      wireEventRows(container);
      wireSleepRow(container);
      break;
    }
    case "countdown": {
      container.innerHTML = `
        <div class="oled-pill-section oled-cd-setrow">
          <label class="oled-cd-field-lbl">H
            <input class="oled-cd-num" id="oled-cd-h" type="number" min="0" max="99" step="1" value="${oledCdH}" />
          </label>
          <span class="oled-cd-sep">:</span>
          <label class="oled-cd-field-lbl">M
            <input class="oled-cd-num" id="oled-cd-m" type="number" min="0" max="59" step="1" value="${oledCdM}" />
          </label>
          <span class="oled-cd-sep">:</span>
          <label class="oled-cd-field-lbl">S
            <input class="oled-cd-num" id="oled-cd-s" type="number" min="0" max="59" step="1" value="${oledCdS}" />
          </label>
        </div>
        <div class="oled-pill-hint">
          On the board, arrow keys pick a field and change it. Rotating the
          encoder moves between screens. Bind any key below to do the same.
        </div>
        <div class="oled-pill-section" style="padding-bottom:6px">
          <span class="pill-label">SCREEN EVENTS</span>
        </div>
        ${eventRowHTML("cdEvent", "Start / Stop")}
        ${eventRowHTML("cdLeft", "Field ←")}
        ${eventRowHTML("cdRight", "Field →")}
        ${eventRowHTML("cdUp", "Value +")}
        ${eventRowHTML("cdDown", "Value −")}
        ${eventRowHTML("presentKeys", "Present Keys")}
        ${sleepRowHTML()}`;
      document.getElementById("oled-cd-h")?.addEventListener("input", (e) => { oledCdH = Math.max(0, Math.min(99, parseInt(e.target.value, 10) || 0)); e.target.value = oledCdH; updateOledDisplay(); });
      document.getElementById("oled-cd-m")?.addEventListener("input", (e) => { oledCdM = Math.max(0, Math.min(59, parseInt(e.target.value, 10) || 0)); e.target.value = oledCdM; updateOledDisplay(); });
      document.getElementById("oled-cd-s")?.addEventListener("input", (e) => { oledCdS = Math.max(0, Math.min(59, parseInt(e.target.value, 10) || 0)); e.target.value = oledCdS; updateOledDisplay(); });
      wireEventRows(container);
      wireSleepRow(container);
      break;
    }
    case "pomodoro": {
      // Durations live on the BOARD (the pomodoro keeps counting with the app
      // closed), so these are push-only settings, not a live readout.
      const unsupported = oledPomoSupported === false
        ? `<div class="oled-pill-hint oled-pomo-unsupported">
             This board's firmware predates adjustable durations, so it is still
             running the built-in ${POMO_DEFAULTS.workMin}/${POMO_DEFAULTS.pauseMin} x ${POMO_DEFAULTS.cycles}.
             Values set here apply to the preview above; flash the current firmware to use them on the board.
           </div>`
        : "";
      // min="0" on purpose: 0 means "not set yet" while editing. The spinner
      // and the field have to agree with what the input handler allows, or the
      // arrows would refuse to go somewhere typing can reach.
      //
      // The unset warning renders empty and is filled in by
      // renderPomoUnsetHint(), which is called from the input handler. It has
      // to update IN PLACE: this whole pill is one innerHTML assignment, so
      // rebuilding it to refresh a hint destroys the field being typed into.
      container.innerHTML = `
        <div class="oled-pill-section oled-pomo-setrow">
          <label class="oled-cd-field-lbl">WORK
            <input class="oled-cd-num" id="oled-pomo-work" type="number"
              min="0" max="${POMO_MAX_MINUTES}" step="1" value="${oledPomo.workMin}" />
          </label>
          <label class="oled-cd-field-lbl">PAUSE
            <input class="oled-cd-num" id="oled-pomo-pause" type="number"
              min="0" max="${POMO_MAX_MINUTES}" step="1" value="${oledPomo.pauseMin}" />
          </label>
          <label class="oled-cd-field-lbl">CYCLES
            <input class="oled-cd-num" id="oled-pomo-cycles" type="number"
              min="0" max="${POMO_MAX_CYCLES}" step="1" value="${oledPomo.cycles}" />
          </label>
        </div>
        <div class="oled-pill-hint">
          Minutes, then how many work + pause rounds make a session. After the
          last one the board stops rather than looping. Changing a duration does
          not restart a running phase.
        </div>
        <div class="oled-pill-hint oled-pomo-unset" id="oled-pomo-unset"></div>
        ${unsupported}
        <div class="oled-pill-section" style="padding-bottom:6px">
          <span class="pill-label">SCREEN EVENTS</span>
        </div>
        ${eventRowHTML("pomoStartStop", "Start / Pause")}
        ${eventRowHTML("presentKeys", "Present Keys")}
        ${sleepRowHTML()}`;

      // Only the UPPER bound is enforced while typing. Clamping up to the
      // minimum on every keystroke is what made these fields unusable: an
      // emptied field refilled itself with 1 before the next digit arrived.
      // The lower bound is checked at Save to Board, where it can explain
      // itself instead of silently rewriting what was typed.
      const wirePomo = (id, key, max) => {
        document.getElementById(id)?.addEventListener("input", (e) => {
          const raw = e.target.value.trim();
          const v = Math.min(max, Math.max(0, parseInt(raw, 10) || 0));
          // Written back only when the text really was out of range or empty.
          // Assigning on every keystroke drags the caret to the end of the
          // field, which was the other half of the problem.
          if (raw !== String(v)) e.target.value = v;
          oledPomo[key] = v;
          savePomodoro();
          // In place, never renderOledPillContent(): that rebuilds the pill and
          // would blow away the field being typed into. It used to be called
          // here for the cycle count, which the hint stopped quoting at some
          // point, so it was costing focus for nothing.
          renderPomoUnsetHint();
          updateOledDisplay();
          scheduleLiveSync("oled");
        });
      };
      wirePomo("oled-pomo-work",   "workMin",  POMO_MAX_MINUTES);
      wirePomo("oled-pomo-pause",  "pauseMin", POMO_MAX_MINUTES);
      wirePomo("oled-pomo-cycles", "cycles",   POMO_MAX_CYCLES);
      renderPomoUnsetHint();
      wireEventRows(container);
      wireSleepRow(container);
      break;
    }
    case "datetime": {
      container.innerHTML = `
        <div class="oled-pill-section oled-pill-hint">
          Shows current time and date.
        </div>
        <div class="oled-pill-section" style="padding-bottom:6px">
          <span class="pill-label">SCREEN EVENTS</span>
        </div>
        ${eventRowHTML("presentKeys", "Present Keys")}
        ${sleepRowHTML()}`;
      wireEventRows(container);
      wireSleepRow(container);
      break;
    }
    case "gif": {
      const imgPreview = screen.imageDataUrl
        ? `<img class="oled-img-preview" src="${screen.imageDataUrl}" />`
        : `<div class="oled-img-placeholder">No image</div>`;
      container.innerHTML = `
        <div class="oled-pill-section oled-img-row">
          <div class="oled-img-thumb">${imgPreview}</div>
          <label class="oled-upload-btn">Upload Image / GIF
            <input type="file" id="oled-img-upload" accept="image/*" style="display:none" />
          </label>
          ${screen.imageDataUrl ? `<button class="oled-img-clear" id="oled-img-clear">✕</button>` : ""}
        </div>
        <div class="oled-pill-section" style="align-items:flex-start;flex-direction:column;gap:4px;padding-bottom:10px">
          <span class="oled-img-notice">Scaled to fit 128×128. GIFs are sampled to 8 frames,
          reduced to 16 colours, then uploaded once — the board animates it on its own, so it
          keeps playing with this app closed.</span>
          <span class="oled-img-notice">The board has one image buffer, so only one GIF screen
          can exist.</span>
        </div>
        <div class="oled-pill-section" style="padding-bottom:6px">
          <span class="pill-label">SCREEN EVENTS</span>
        </div>
        ${eventRowHTML("presentKeys", "Present Keys")}
        ${sleepRowHTML()}`;
      document.getElementById("oled-img-upload")?.addEventListener("change", async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        // No size gate: the QGF encoder scales to fit and samples long GIFs
        // down to 8 frames, so oversized input is fine.
        screen.imageDataUrl = await readFileAsDataUrl(file);
        saveOledCustomScreens(); renderOledPillContent(); updateOledDisplay();
        scheduleLiveSync("oled");
      });
      document.getElementById("oled-img-clear")?.addEventListener("click", () => {
        screen.imageDataUrl = null;
        saveOledCustomScreens(); renderOledPillContent(); updateOledDisplay();
        scheduleLiveSync("oled");
      });
      wireEventRows(container);
      wireSleepRow(container);
      break;
    }
    case "custom": {
      container.innerHTML = `
        <div class="oled-pill-section">
          <span class="pill-label">TITLE</span>
          <input class="oled-title-inp" id="oled-custom-title" type="text"
            value="${screen.title || ""}" placeholder="Screen title…" maxlength="${oledTitleMax()}" />
        </div>
        <div class="oled-pill-section" style="align-items:flex-start;flex-direction:column;gap:6px;padding-bottom:12px">
          <span class="pill-label">CONTEXT</span>
          <textarea class="oled-body-inp" id="oled-custom-body" placeholder="Body text shown below title…" maxlength="200">${screen.body || ""}</textarea>
        </div>
        <div class="oled-pill-section" style="padding-bottom:6px">
          <span class="pill-label">SCREEN EVENTS</span>
        </div>
        ${eventRowHTML("presentKeys", "Present Keys")}
        ${sleepRowHTML()}`;
      document.getElementById("oled-custom-title")?.addEventListener("input", (e) => {
        screen.title = e.target.value; saveOledCustomScreens(); updateOledDisplay();
      });
      document.getElementById("oled-custom-body")?.addEventListener("input", (e) => {
        screen.body = e.target.value; saveOledCustomScreens(); updateOledDisplay();
      });
      wireEventRows(container);
      wireSleepRow(container);
      break;
    }
    default:
      container.innerHTML = "";
  }

}

function renderOledPill() {
  renderOledPillNav();
  renderOledPillContent();
}

// `push` false for the boot-time call that just re-applies the stored choice.
// scheduleLiveSync() also auto-saves, and at boot there is no device selected
// yet — so syncing there wrote a stray kf-devcfg::default alongside the real
// per-device blob, and whichever one a reader found first won.
function applyOledFont(fontId, push = true) {
  oledFontId = fontId;
  localStorage.setItem("kf-oled-font", fontId);
  const font = getOledFont();
  document.documentElement.style.setProperty("--oled-lyr-font-size", font.previewPx);
  // The layer-bar name field is what feeds the OLED title, so it carries the
  // font's character limit.
  const nameInp = document.getElementById("layer-name");
  if (nameInp) nameInp.maxLength = font.nameMax;
  document.querySelectorAll(".oled-font-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.font === fontId);
  });
  updateOledDisplay();
  renderOledPillContent();
  // The board draws titles at this scale too. Without this the picker moved
  // the preview and nothing else — the panel stayed on its hardcoded size.
  if (push) scheduleLiveSync("oled");
}

function startOledAnim() {
  if (oledAnimFrame) cancelAnimationFrame(oledAnimFrame);
  oledAnimFrame = requestAnimationFrame(oledAnimTick);
}

function oledAnimTick(now) {
  // Countdown completion
  if (oledCdRunning && getCdRemaining() <= 0) {
    oledCdRunning = false; oledCdDone = true;
    // Red until the countdown is reset. The screen already says DONE, but only
    // if you happen to be looking at it.
    alertHold = true;
    updateOledDisplay(); flashBoard();
  }

  // Unconditional, like the firmware's pomo_tick(): phases must keep rolling
  // even while another screen is showing, or navigating away silently pauses it.
  pomoTick();

  // Throttle live updates to ~4fps (timers only update per-second anyway)
  const screens = getOledScreens();
  const s       = screens[oledScreenIdx];
  const live    = (s?.type === "timer" && oledTimerRunning)
               || (s?.type === "countdown" && oledCdRunning)
               || (s?.type === "pomodoro" && oledPomoRunning)
               || s?.type === "datetime";
  if (live && now - oledLastTick > 250) {
    oledLastTick = now;
    const screenEl = document.querySelector(".oled-screen");
    if (screenEl) renderOledScreenContent(screenEl);
    // Only update the OLED screen display; pill content (buttons) must not be
    // rebuilt on the animation tick — replacing button DOM nodes while the
    // user is clicking them swallows the click event.
  }

  oledAnimFrame = requestAnimationFrame(oledAnimTick);
}

// ── Key hover tooltip ─────────────────────────────────────────────────────
function buildTooltipHTML(idx) {
  const kc    = keymap?.layers[0]?.keys[idx] ?? "KC_NO";
  const kcDisp = (kc === "KC_NO" || kc === "KC_TRNS") ? null : kc.replace(/^KC_/, "");
  const led   = keyLedColors[idx];
  const hasLed = !!led;
  const icon  = keyIconImages[idx];
  const anim  = klAnimation;
  const macro = keyMacros[idx] ? findMacroById(keyMacros[idx]) : null;
  const layer = getSavedLayers().find(l => l.id === activeProfileId);

  let html = `<div class="ktt-kc">`;
  if (icon) html += `<img class="ktt-icon-img" src="${icon}" alt="" />`;
  html += kcDisp
    ? `<span>${kcDisp}</span>`
    : `<span class="ktt-empty">—</span>`;
  html += `</div><div class="ktt-divider"></div>`;

  if (hasLed) {
    html += `<div class="ktt-row">
      <span class="ktt-label">LED</span>
      <span class="ktt-swatch" style="background:${led};box-shadow:0 0 6px ${led}66"></span>
      <span class="ktt-val">${anim}</span>
    </div>`;
  }

  if (layer) {
    html += `<div class="ktt-row">
      <span class="ktt-label">LAYER</span>
      <span class="ktt-val">${layer.name}</span>
    </div>`;
  }


  if (macro) {
    html += `<div class="ktt-row">
      <span class="ktt-label">MACRO</span>
      <span class="ktt-val">${escapeHtml(macro.name)}</span>
    </div>`;
  }

  // What this key does on the screen currently showing. Worth its own row
  // rather than folding into KEYCODE: on this screen the binding swallows the
  // press, so the keycode above it does not fire at all — and that is exactly
  // the thing a tooltip listing the keycode would otherwise be lying about.
  const ttScreenKey = currentOledScreenKey();
  const ttEvents    = ttScreenKey ? (oledEventKeys[ttScreenKey] || {}) : {};
  const ttEvEntry   = Object.entries(ttEvents).find(([, v]) => evIdx(v) === idx);
  if (ttEvEntry) {
    html += `<div class="ktt-row">
      <span class="ktt-label">EVENT</span>
      <span class="ktt-val ktt-event">${escapeHtml(OLED_EVENT_LABELS[ttEvEntry[0]] ?? ttEvEntry[0])}</span>
    </div>`;
  }

  html += `<div class="ktt-row">
    <span class="ktt-label">KEY</span>
    <span class="ktt-val ktt-muted">#${idx}</span>
  </div>`;

  return html;
}

function showKeyTooltip(idx, el) {
  if (isDragging) return;
  if (selectedKeys.has(idx) && document.getElementById("key-pills").classList.contains("visible")) return;
  const tt = document.getElementById("key-tooltip");
  if (!tt) return;

  tt.innerHTML = buildTooltipHTML(idx);
  tt.classList.add("visible");

  const keyRect = el.getBoundingClientRect();
  tt.style.left = "0";
  tt.style.top  = "0";
  const ttW = tt.offsetWidth;
  const ttH = tt.offsetHeight;

  let x = keyRect.left + keyRect.width / 2 - ttW / 2;
  let y = keyRect.top - ttH - 8;
  if (y < 8) y = keyRect.bottom + 8;
  x = Math.max(8, Math.min(x, window.innerWidth - ttW - 8));

  tt.style.left = x + "px";
  tt.style.top  = y + "px";
}

function hideKeyTooltip() {
  document.getElementById("key-tooltip")?.classList.remove("visible");
}

function flashKey(idx) {
  const el = document.getElementById("key-" + idx);
  if (!el) return;
  el.classList.add("sel-flash");
  el.addEventListener("animationend", () => el.classList.remove("sel-flash"), { once: true });
}

function hexToRgbTriple(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `${r}, ${g}, ${b}`;
}

function applyCornerColors() {
  for (let i = 0; i < 4; i++) {
    const hex = cornerColors[i];
    const corner = document.getElementById(`ug-c${i}`);
    if (corner) {
      corner.querySelector(".ug-dot").style.background = hex;
      corner.querySelector(".ug-corner-inp").value     = hex;
    }
    document.documentElement.style.setProperty(`--ug-c${i}`, hexToRgbTriple(hex));
  }
  updateCornerButtons();
  updateUgColorSwatch();
}

function updateCornerButtons() {
  for (let i = 0; i < 4; i++) {
    const btn = document.getElementById(`ug-cb-${i}`);
    if (!btn) continue;
    btn.classList.toggle("selected", selectedCorners.has(i));
    btn.querySelector(".ug-c-dot").style.background = cornerColors[i];
  }
}

function updateUgColorSwatch() {
  const sel = [...selectedCorners];
  if (sel.length === 0) return;
  const colors  = sel.map(i => cornerColors[i]);
  const allSame = colors.every(c => c === colors[0]);
  const inp = document.getElementById("underglow-color");
  if (inp) inp.value = allSame ? colors[0] : "#000000";
}

function applyUnderglowHex(hex) {
  document.documentElement.style.setProperty("--ug-color", hexToRgbTriple(hex));
  const inp = document.getElementById("underglow-color");
  if (inp) inp.value = hex;
  for (const i of (selectedCorners.size > 0 ? selectedCorners : new Set([0,1,2,3]))) {
    cornerColors[i] = hex;
  }
  localStorage.setItem(UG_CORNERS_KEY, JSON.stringify(cornerColors));
  applyCornerColors();
  scheduleLiveSync("leds");
  // Picking a color directly means "set this color" — force Solid
  if (ugAnimation !== "solid") {
    ugAnimation = "solid";
    ugAnimStart = 0;
    saveAdvancedState();
    renderAnimChips();
  }
}

function saveAdvancedState() {
  localStorage.setItem(UG_ADVANCED_KEY, JSON.stringify({
    animation: ugAnimation, rate: ugRate, intensity: ugIntensity,
  }));
}

// White, matching the per-key default. This replaces the 2026-06-29 choice of
// orange (#ff6e14, the board's out-of-box underglow): a new layer should start
// from one neutral default everywhere rather than two different ones, so
// "untouched" looks the same on the keys and the corners.
const DEFAULT_CORNER_COLORS = ["#ffffff", "#ffffff", "#ffffff", "#ffffff"];

function currentUnderglowSnapshot() {
  return {
    animation:    ugAnimation,
    rate:         ugRate,
    intensity:    ugIntensity,
    palette:      [...ugPalette],
    cornerColors: [...cornerColors],
  };
}

function syncUnderglowUI() {
  document.getElementById("ug-rate").value      = ugRate;
  document.getElementById("ug-intensity").value = ugIntensity;
  applyCornerColors();
  renderAnimChips();
  renderPalette("ug-palette", () => ugPalette, (v) => { ugPalette = v; }, UG_PALETTE_KEY, () => {});
  updateUgPaletteDisabled();
}

function applyUnderglowSnapshot(ug) {
  ugAnimation  = ug?.animation    ?? "solid";
  ugRate       = ug?.rate         ?? 128;
  ugIntensity  = ug?.intensity    ?? 180;
  ugPalette    = ug?.palette      ? [...ug.palette]      : [];
  cornerColors = ug?.cornerColors ? [...ug.cornerColors] : [...DEFAULT_CORNER_COLORS];
  syncUnderglowUI();
}

function saveKlAdvancedState() {
  localStorage.setItem(KL_ADVANCED_KEY, JSON.stringify({
    animation: klAnimation, rate: klRate,
  }));
  saveCurrentKeyAnimState();
}

// Animation is GLOBAL, not per-key: QMK's RGB matrix runs one effect for the
// whole board, so there is no wire representation for "breathe on key 3, sparkle
// on key 7". The editor mirrors the board's shape deliberately — the preview
// must not promise something the hardware cannot reproduce. Per-key COLOUR is
// unaffected and still exact.
function saveCurrentKeyAnimState() {
  localStorage.setItem(KL_PER_KEY, JSON.stringify({
    animation: klAnimation, rate: klRate, palette: [...klPalette],
  }));
  updateKlColorVars();
  scheduleLiveSync("anim");
}

function updateKlColorVars() {
  const hex = document.getElementById("kl-color")?.value || "#ffffff";
  document.documentElement.style.setProperty("--kl-color", hexToRgbTriple(hex));
  const cycleHex = klPalette.length > 0 ? klPalette[0] : hex;
  document.documentElement.style.setProperty("--kl-cycle-color", hexToRgbTriple(cycleHex));
  const dur = rateToDuration(klRate).toFixed(2);
  document.documentElement.style.setProperty("--kl-anim-dur", dur + "s");
}

// Put every control in the SCREEN LED THEME pill back in step with the state.
//
// Must be called by anything that reassigns the theme variables —
// `applyAnimState()` is the one that does, on layer switch, screen switch,
// device load and reset. Missing it is what made a reset look like it had not
// happened: the variables really were back to solid with no cycle colours, but
// the chips, the rate slider and the swatches were still drawing the old ones,
// and the swatches were still wired to the old palette array.
//
// The underglow pill has had this all along as syncUnderglowUI(); the key side
// only had the chips, which is why exactly the parts it missed are the parts
// that went stale.
function syncKeyLedThemeUI() {
  const rateEl = document.getElementById("kl-rate");
  if (rateEl) rateEl.value = klRate;
  renderKlAnimChips();
  updatePaletteDisabled();
  renderPalette("kl-palette", () => klPalette, (v) => { klPalette = v; }, KL_PALETTE_KEY, saveCurrentKeyAnimState);
  updateKlColorVars();
}

function renderAnimChips() {
  const container = document.getElementById("ug-anims");
  if (!container) return;
  container.innerHTML = "";
  const eligible = ANIMATIONS.filter(a => !a.keyOnly);
  const makeRow = (anims) => {
    const row = document.createElement("div");
    row.className = "kl-anim-row";
    for (const anim of anims) {
      const chip = document.createElement("button");
      chip.className = "ug-anim-chip" + (ugAnimation === anim.id ? " active" : "");
      const preview = document.createElement("span");
      preview.className = `ug-anim-preview ${anim.id}`;
      chip.appendChild(preview);
      chip.appendChild(document.createTextNode(anim.label));
      chip.addEventListener("click", (e) => {
        e.stopPropagation();
        ugAnimation = anim.id;
        ugAnimStart = 0;
        saveAdvancedState();
        renderAnimChips();
      });
      row.appendChild(chip);
    }
    return row;
  };
  container.appendChild(makeRow(eligible.filter(a =>  a.noCycle)));
  container.appendChild(makeRow(eligible.filter(a => !a.noCycle)));
  updateUgPaletteDisabled();
}

function updatePaletteDisabled() {
  const off = ANIMATIONS.find(a => a.id === klAnimation)?.noCycle ?? false;
  document.getElementById("kl-palette").classList.toggle("disabled", off);
}

function updateUgPaletteDisabled() {
  const off = ANIMATIONS.find(a => a.id === ugAnimation)?.noCycle ?? false;
  document.getElementById("ug-palette").classList.toggle("disabled", off);
}

function renderEncoderOpts() {
  document.querySelectorAll(".enc-opt").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.mode === encoderMode);
  });
}

// Cycle Colors swatches.
//
// `get`/`set` rather than the array itself, and this is load-bearing. The
// palette variables are REASSIGNED, not mutated — `applyAnimState()` does
// `klPalette = [...]` on every layer switch, screen switch, device load and
// reset. A render that captured the array kept editing the copy that was live
// when it drew, so after any of those the swatches were wired to an orphan:
// clicking one mutated a detached array and wrote it to localStorage, while
// `onChange()` serialised the CURRENT klPalette (unchanged) and pushed that to
// the board. That is the "sometimes setting Cycle Colors does nothing" bug —
// "sometimes" being "after anything that reloaded the theme".
//
// Every edit now reads through `get()` and writes a NEW array through `set()`,
// so there is no aliasing to go stale in the first place.
function renderPalette(containerId, get, set, storageKey, onChange) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = "";

  const palette = get();

  // One commit path for add / edit / delete, so none of them can forget a step.
  const commit = (next) => {
    set(next);
    localStorage.setItem(storageKey, JSON.stringify(next));
    renderPalette(containerId, get, set, storageKey, onChange);
    onChange();
    scheduleLiveSync("anim");
  };

  const addEl = document.createElement("label");
  addEl.className = "palette-add" + (palette.length >= 20 ? " at-max" : "");
  addEl.title = palette.length >= 20 ? "Maximum 20 colors" : "Add color";
  addEl.textContent = "+";
  if (palette.length < 20) {
    const addInp = document.createElement("input");
    addInp.type = "color";
    addInp.value = "#ff0000";
    addInp.style.cssText = "position:absolute;opacity:0;width:0;height:0;pointer-events:none";
    addInp.addEventListener("change", (e) => {
      e.stopPropagation();
      commit([...get(), e.target.value]);
    });
    addEl.appendChild(addInp);
  }
  container.appendChild(addEl);

  palette.forEach((color, i) => {
    const swatch = document.createElement("label");
    swatch.className = "palette-swatch";
    swatch.style.background = color;
    swatch.title = color;

    const withColorAt = (v) => get().map((c, j) => (j === i ? v : c));

    const inp = document.createElement("input");
    inp.type = "color";
    inp.value = color;
    inp.style.cssText = "position:absolute;opacity:0;width:0;height:0;pointer-events:none";
    // Dragging the picker: update live but do not re-render, or the element
    // being dragged is destroyed mid-gesture. No storage write either — the
    // `change` below lands once when the picker closes.
    inp.addEventListener("input", (e) => {
      e.stopPropagation();
      set(withColorAt(e.target.value));
      swatch.style.background = e.target.value;
      onChange();
    });
    inp.addEventListener("change", (e) => {
      e.stopPropagation();
      commit(withColorAt(e.target.value));
    });
    swatch.appendChild(inp);

    const del = document.createElement("span");
    del.className = "ps-del";
    del.textContent = "×";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      commit(get().filter((_, j) => j !== i));
    });
    swatch.appendChild(del);

    container.appendChild(swatch);
  });
}

function renderKlAnimChips() {
  const container = document.getElementById("kl-anims");
  if (!container) return;
  container.innerHTML = "";
  const makeRow = (anims, previewClass) => {
    const row = document.createElement("div");
    row.className = "kl-anim-row";
    for (const anim of anims) {
      const chip = document.createElement("button");
      chip.className = "ug-anim-chip" + (klAnimation === anim.id ? " active" : "");
      const preview = document.createElement("span");
      preview.className = `${previewClass} ${anim.id}`;
      chip.appendChild(preview);
      chip.appendChild(document.createTextNode(anim.label));
      chip.addEventListener("click", (e) => {
        e.stopPropagation();
        klAnimation = anim.id;
        saveKlAdvancedState();
        renderKlAnimChips();
        // Animation decides whether the board shows our colours or its own
        // effect, so the LED SOURCE indicator has to follow it.
        renderOverlayBtn();
      });
      row.appendChild(chip);
    }
    return row;
  };
  container.appendChild(makeRow(ANIMATIONS.filter(a =>  a.noCycle), "kl-anim-preview"));
  container.appendChild(makeRow(ANIMATIONS.filter(a => !a.noCycle), "kl-cycle-preview"));
  updatePaletteDisabled();
}

// ── Underglow animation engine ────────────────────────────────────────────
function hexToRgb(hex) {
  return { r: parseInt(hex.slice(1,3),16), g: parseInt(hex.slice(3,5),16), b: parseInt(hex.slice(5,7),16) };
}
function hslToRgb(h, s, l) {
  if (s === 0) { const v = Math.round(l * 255); return { r: v, g: v, b: v }; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const h2r = (t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  };
  return { r: Math.round(h2r(h+1/3)*255), g: Math.round(h2r(h)*255), b: Math.round(h2r(h-1/3)*255) };
}
let ugAnimFrame = null;
let ugAnimStart = 0;
let lastKeyClickTime = 0;

function applyCornerGlow(tl, tr, bl, br) {
  // Radial gradients on the board-ring: each corner is a point source that fades to
  // transparent at ~60% of the way across, so colors only blend near the midpoints.
  const ring = document.getElementById("board-ring");
  if (ring) {
    const rg = (c, pos, scale) =>
      `radial-gradient(ellipse at ${pos}, rgba(${c.rgb},${Math.min(0.99, c.opacity * scale).toFixed(3)}) 0%, transparent 58%)`;
    ring.style.background = [
      rg(tl, "top left",     0.85),
      rg(tr, "top right",    0.85),
      rg(bl, "bottom left",  0.90),
      rg(br, "bottom right", 0.90),
    ].join(", ");
  }

  // Outer halo: box-shadow on the board spills beyond the ring into the dark background.
  // Corner-biased offsets keep each colour near its corner; large blur creates the fade.
  const board = document.getElementById("board");
  const h = (c, scale) => `rgba(${c.rgb},${Math.min(0.99, c.opacity * scale).toFixed(3)})`;
  if (board) board.style.boxShadow = [
    // Outer halo — large blur, zero spread, low opacity so it fades smoothly into the background
    `-28px -14px 200px 0px ${h(tl, 0.85)}`,
    ` 28px -14px 200px 0px ${h(tr, 0.85)}`,
    `-28px  28px 220px 0px ${h(bl, 0.90)}`,
    ` 28px  28px 220px 0px ${h(br, 0.90)}`,
    `0 8px 32px rgba(0,0,0,0.55)`,
  ].join(", ");
}

function computeCornerStates(elapsed) {
  // The same mapping the keys use. The underglow renderer is still separate on
  // the board (QMK has one effect for all 25 LEDs, so the corners have to be
  // drawn by hand), but it now derives its period from the same rate chain —
  // so at equal rates the corners and the keys are in lockstep, not merely
  // near each other.
  const duration = ugRateToDuration(ugRate);
  const t        = (elapsed % duration) / duration;
  const maxOp    = (0.15 + (ugIntensity / 255) * 0.85) * (0.12 + (ledBrightness / 255) * 0.88);
  // Palette: time-based — all corners advance through colors together each cycle
  const usePalette = ugPalette.length > 0 && ugAnimation !== "solid" && ugAnimation !== "rainbow";
  const paletteIdx = usePalette ? Math.floor(elapsed / duration) % ugPalette.length : -1;
  const bases      = [0,1,2,3].map(i => paletteIdx >= 0 ? ugPalette[paletteIdx] : cornerColors[i]);

  switch (ugAnimation) {
    case "solid":
      return cornerColors.map(hex => {
        const {r,g,b} = hexToRgb(hex); return { rgb:`${r},${g},${b}`, opacity: maxOp * 0.7 };
      });

    case "breathe": {
      // Same sin^2 as the keys, and the firmware's ug_breathe() now matches it
      // too — it was a triangle before, which has no dwell at either end, so
      // the corners crossed straight through the dark instant the keys sat in.
      const op = maxOp * (0.5 - 0.5 * Math.cos(t * Math.PI * 2));
      return bases.map(hex => {
        const {r,g,b} = hexToRgb(hex); return { rgb:`${r},${g},${b}`, opacity: op };
      });
    }

    case "rainbow": {
      // Generates its own spectrum rather than hue-shifting the corner colours.
      // shiftHue() preserves saturation, so a white or grey corner had no hue
      // to rotate and stayed exactly as it was — the animation silently did
      // nothing once the default became white. This matches the per-key rainbow
      // and the 2026-06-25 decision that rainbow ignores the configured colours
      // and produces its own HSL spectrum.
      const phaseShift = [0, 0.25, 0.75, 0.5]; // TL, TR, BR, BL around the board
      return phaseShift.map((phase) => {
        const { r, g, b } = hslToRgb((t + phase) % 1, 1, 0.5);
        return { rgb: `${r},${g},${b}`, opacity: maxOp * 0.75 };
      });
    }

    case "wave": {
      const phaseOff = [0, 0.25, 0.75, 0.5];
      return bases.map((hex, i) => {
        const {r,g,b} = hexToRgb(hex);
        const pt = (t + phaseOff[i]) % 1;
        return { rgb:`${r},${g},${b}`, opacity: maxOp * (0.5 - 0.5 * Math.cos(pt * Math.PI * 2)) };
      });
    }

    case "reactive": {
      const age = (performance.now() - lastKeyClickTime) / 1000;
      const op  = age < 0.8 ? maxOp * Math.pow(1 - age / 0.8, 1.5) : maxOp * 0.08;
      return bases.map(hex => {
        const {r,g,b} = hexToRgb(hex); return { rgb:`${r},${g},${b}`, opacity: op };
      });
    }

    case "sparkle": {
      const freqs  = [2.3, 3.7, 1.9, 4.1];
      const phases = [0,   1.2, 2.5, 0.8];
      return bases.map((hex, i) => {
        const {r,g,b} = hexToRgb(hex);
        const v  = Math.sin(t * Math.PI * 2 * freqs[i] + phases[i]);
        return { rgb:`${r},${g},${b}`, opacity: maxOp * Math.max(0.04, Math.pow(Math.max(0, v), 2)) };
      });
    }

    default:
      return bases.map(hex => {
        const {r,g,b} = hexToRgb(hex); return { rgb:`${r},${g},${b}`, opacity: 0.5 };
      });
  }
}

function ugAnimTick(now) {
  if (!ugAnimStart) ugAnimStart = now;
  const elapsed = (now - ugAnimStart) / 1000;
  const [tl, tr, bl, br] = computeCornerStates(elapsed);

  applyCornerGlow(tl, tr, bl, br);

  // Keep --ug-color current so flash keyframes and anim-preview chips track the animation
  document.documentElement.style.setProperty("--ug-color", tl.rgb);

  // Pulse the corner pips when the pill is open
  if (document.getElementById("board-ring")?.classList.contains("ug-active")) {
    [tl, tr, bl, br].forEach((c, i) => {
      const dot = document.getElementById(`ug-c${i}`)?.querySelector(".ug-dot");
      if (dot) dot.style.boxShadow = `0 0 8px 2px rgba(${c.rgb},${Math.min(0.99, c.opacity * 2).toFixed(3)})`;
    });
  }

  ugAnimFrame = requestAnimationFrame(ugAnimTick);
}

function startUgAnimation() {
  if (ugAnimFrame) cancelAnimationFrame(ugAnimFrame);
  ugAnimStart = 0; // let first tick set the reference time
  ugAnimFrame = requestAnimationFrame(ugAnimTick);
}

// ── Key LED animation engine ─────────────────────────────────────────────

let klAnimFrame   = null;
let klAnimStart   = 0;
let keyClickTimes = Array(21).fill(0);

// Sparkle: stable per-key frequencies and phases so each key blinks independently
const KL_SPARKLE_FREQS  = [2.3, 4.7, 3.1, 5.3, 2.7, 3.9, 4.3, 2.1, 3.7, 5.1,
                            2.9, 4.1, 3.3, 5.7, 2.5, 4.5, 3.5, 5.9, 2.3, 4.9, 3.3];
const KL_SPARKLE_PHASES = [0.10, 0.70, 0.30, 0.90, 0.50, 0.20, 0.80, 0.40, 0.60, 0.15,
                            0.85, 0.35, 0.65, 0.25, 0.75, 0.45, 0.55, 0.05, 0.95, 0.12, 0.62];

function computeKeyLedColor(idx, row, col, elapsed) {
  // One global animation for every key — this simulates what the board will
  // actually render, since QMK has a single board-wide effect. Selection does
  // not enter into it: the old `isSel` parameter was already dead (never read
  // in this body) and the comment claiming selected keys used live panel state
  // had not been true for some time.
  const animation = klAnimation, rate = klRate, palette = klPalette;

  const duration = rateToDuration(rate);
  const t        = (elapsed % duration) / duration;
  // Was scaled by a per-theme INTENSITY slider. That slider had no wire
  // representation at all — `buildAnimState()` sends name/speed/colour and
  // nothing else — so it dimmed the PREVIEW only, and the board ignored it.
  // A control that makes the app disagree with the hardware is worse than no
  // control. Brightness, which does reach the board, is the real one.
  const maxOp    = 1;
  const ownColor = keyLedColors[idx] || "#ffffff";
  // Palette cycling is a group effect — only active while the key is selected
  const usePalette = palette.length > 0 && animation !== "solid" && animation !== "rainbow";
  const paletteIdx = usePalette ? Math.floor(elapsed / duration) % palette.length : 0;
  const baseHex  = usePalette ? palette[paletteIdx] : ownColor;
  const hasColor = !!baseHex;

  switch (animation) {
    case "solid": {
      if (!hasColor) return null;
      const { r, g, b } = hexToRgb(baseHex);
      return { rgb: `${r},${g},${b}`, opacity: maxOp * 0.7 };
    }

    case "breathe": {
      if (!hasColor) return null;
      // `0.5 - 0.5*cos(2*pi*t)` is sin^2(pi*t), and this is the REFERENCE the
      // firmware was changed to match, not the other way round. QMK's stock
      // BREATHING draws sin(pi*t), which spends 0.8% of the cycle below 2%
      // brightness against this curve's 9% — so the palette swap, which lands
      // at t=0 on both, arrived while the board was still visibly lit. The
      // board now runs KF_BREATHING (rgb_matrix_kb.inc), which squares it.
      // Changing this line means changing that file too.
      const op = maxOp * (0.5 - 0.5 * Math.cos(t * Math.PI * 2));
      const { r, g, b } = hexToRgb(baseHex);
      return { rgb: `${r},${g},${b}`, opacity: op };
    }

    case "rainbow": {
      const { r, g, b } = hslToRgb((t + idx / 21 * 0.3) % 1, 1, 0.5);
      return { rgb: `${r},${g},${b}`, opacity: maxOp * 0.8 };
    }

    case "wave": {
      if (!hasColor) return null;
      const posOffset = (col - 1) / 4 * 0.4 + (row - 1) / 5 * 0.25;
      const op = maxOp * (0.5 - 0.5 * Math.cos(((t + posOffset) % 1) * Math.PI * 2));
      const { r, g, b } = hexToRgb(baseHex);
      return { rgb: `${r},${g},${b}`, opacity: op };
    }

    case "reactive": {
      const age = (performance.now() - keyClickTimes[idx]) / 1000;
      if (age > 0.8) {
        // Idle: show dim solid glow so the key doesn't go dark when deselected
        if (!hasColor) return null;
        const { r, g, b } = hexToRgb(baseHex);
        return { rgb: `${r},${g},${b}`, opacity: maxOp * 0.5 };
      }
      const op = maxOp * Math.pow(1 - age / 0.8, 1.5);
      const { r, g, b } = hexToRgb(hasColor ? baseHex : "#ffffff");
      return { rgb: `${r},${g},${b}`, opacity: op };
    }

    case "sparkle": {
      if (!hasColor) return null;
      const v  = Math.sin(t * Math.PI * 2 * KL_SPARKLE_FREQS[idx] + KL_SPARKLE_PHASES[idx] * Math.PI * 2);
      const op = maxOp * Math.max(0, Math.pow(Math.max(0, v), 2));
      const { r, g, b } = hexToRgb(baseHex);
      return { rgb: `${r},${g},${b}`, opacity: op };
    }

    case "snake": {
      // Snake is a group animation — only runs while the key is part of the active selection;
      // when deselected, fall back to a dim solid glow so the key's color is still visible
      if (!isSel || keySelectionOrder.length === 0) {
        if (!hasColor) return null;
        const { r, g, b } = hexToRgb(ownColor);
        return { rgb: `${r},${g},${b}`, opacity: maxOp * 0.6 };
      }
      const N = keySelectionOrder.length;
      const speed = 1.5 + (rate / 255) * 8.5;
      const tailLen = Math.max(2, Math.ceil(N * 0.5));
      const headPos = Math.floor(elapsed * speed) % N;
      const myPos = keySelectionOrder.indexOf(idx);
      if (myPos === -1) return null;
      const dist = (headPos - myPos + N) % N;
      if (dist >= tailLen) return null;
      const snakeIntensity = Math.pow(1 - dist / tailLen, 0.6);
      const snakeCol = ownColor || "#ffffff";
      const { r: sr, g: sg, b: sb } = hexToRgb(snakeCol);
      return { rgb: `${sr},${sg},${sb}`, opacity: maxOp * snakeIntensity };
    }

    default: return null;
  }
}

function klAnimTick(now) {
  if (!klAnimStart) klAnimStart = now;
  const elapsed = (now - klAnimStart) / 1000;

  // Step the cycle-preview chip through the palette at the current rate
  if (klPalette.length > 1) {
    const dur = rateToDuration(klRate);
    const pi  = Math.floor(elapsed / dur) % klPalette.length;
    document.documentElement.style.setProperty("--kl-cycle-color", hexToRgbTriple(klPalette[pi]));
  }

  // An alert owns the whole board while it is up: red, on/off, over every
  // other LED layer including the underglow. Same square wave the firmware
  // renders, so the two read identically.
  const alertOn = alertPhase(now);
  if (alertOn !== null) {
    const border = alertOn ? "rgba(255,40,40,0.95)" : "rgba(255,40,40,0.10)";
    const glow   = alertOn ? "0 0 16px rgba(255,40,40,0.85)" : "none";
    for (const pos of BOARD_POSITIONS) {
      const el = document.getElementById("key-" + pos.idx);
      if (!el) continue;
      // !important, because a screen-event key's own border colour is declared
      // !important in the stylesheet and a plain inline style loses to it —
      // those keys simply would not join the alert. An alarm with holes in it
      // is not an alarm.
      el.style.setProperty("border-color", border, "important");
      el.style.setProperty("box-shadow", glow, "important");
      el.style.color = "";
    }
    for (const dot of document.querySelectorAll(".ug-dot")) {
      dot.style.background = alertOn ? "#ff2828" : "#2a0808";
    }
    alertWasPainting = true;
    klAnimFrame = requestAnimationFrame(klAnimTick);
    return;
  }
  // Hand everything back. The !important properties have to be REMOVED, not
  // overwritten — the normal per-frame path assigns plain inline styles, which
  // would lose to them exactly as the stylesheet did. The corner dots are set
  // by applyCornerColors() rather than recomputed per frame, so they need the
  // same explicit restore.
  if (alertWasPainting) {
    alertWasPainting = false;
    for (const pos of BOARD_POSITIONS) {
      const el = document.getElementById("key-" + pos.idx);
      if (!el) continue;
      el.style.removeProperty("border-color");
      el.style.removeProperty("box-shadow");
    }
    applyCornerColors();
  }

  for (const pos of BOARD_POSITIONS) {
    const el = document.getElementById("key-" + pos.idx);
    if (!el) continue;

    const result = computeKeyLedColor(pos.idx, pos.row, pos.col, elapsed);

    if (!result) {
      el.style.borderColor = "";
      el.style.boxShadow   = "";
      el.style.color       = "";
      continue;
    }

    // The board scales every channel by brightness (kf_led_overlay_render),
    // so the preview has to as well or the slider looks like it only moves the
    // underglow. Floored a little above zero: at 0 the board really is dark,
    // but a keycap with no outline at all reads as "not selected" rather than
    // "unlit", and the editor still has to be usable.
    const bScale = 0.12 + (ledBrightness / 255) * 0.88;
    const { rgb } = result;
    const opacity = result.opacity * bScale;
    // Every key renders its own LED the same way, selected or not. Selection is
    // the corner dot and nothing else, so the preview shows the lighting the
    // board will actually produce rather than a brightened editing state.
    el.style.borderColor = `rgba(${rgb},${Math.min(0.99, opacity).toFixed(3)})`;
    el.style.boxShadow   = `0 0 8px rgba(${rgb},${(opacity * 0.6).toFixed(3)})`;
    el.style.color       = "";
  }

  klAnimFrame = requestAnimationFrame(klAnimTick);
}

function startKlAnimation() {
  if (klAnimFrame) cancelAnimationFrame(klAnimFrame);
  klAnimStart = 0;
  klAnimFrame = requestAnimationFrame(klAnimTick);
}

// ── Window controls ────────────────────────────────────────────────────────
async function winMinimize() {
  if (!hasTauri) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  getCurrentWindow().minimize();
}
async function winToggleMax() {
  if (!hasTauri) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  getCurrentWindow().toggleMaximize();
}
async function winClose() {
  if (!hasTauri) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  getCurrentWindow().close();
}

async function init() {
  document.getElementById("btn-min").onclick   = winMinimize;
  document.getElementById("btn-max").onclick   = winToggleMax;
  document.getElementById("btn-close").onclick = winClose;

  document.getElementById("btn-save-board").addEventListener("click", async () => {
    const btn = document.getElementById("btn-save-board");
    // Checked before the button changes state, so backing out leaves no trace.
    // Save to Board is where a draft stops being a draft, which is why the
    // checks that would nag on every edit live here instead.
    if (committedFrameIsDark() && !(await confirmDarkSave())) return;
    const pomoUnset = pomoSaveWarning();
    if (pomoUnset && !(await confirmPomoUnset(pomoUnset))) return;
    btn.textContent = "Saving…";
    btn.disabled = true;
    // The board shows the Orbit mark and "Saving ..." for the duration. Not
    // decoration: a save is a dozen commands and every OLED one dirtied the
    // panel, so it cleared and fully redrew each time — which is what read as
    // flickering, or as a dead screen while a large image upload starved the
    // display task. The splash suppresses those redraws.
    await invoke("set_oled_busy", { on: true }).catch(() => {});
    try {
      // Push first, THEN commit. eeprom_commit only persists the LED block the
      // board already holds in RAM, so committing without pushing just re-saves
      // stale state — and it never touches the keymap or the OLED at all.
      await pushStateToBoard();
      await invoke("eeprom_commit");
      btn.textContent = "Saved ✓";
    } catch (e) {
      logError(e, "saveToBoard");
      btn.textContent = _wasConnected ? "Failed" : "No Board";
    } finally {
      // In the finally, so a failed save does not leave the panel stuck on the
      // splash. The board also times out on its own after 15 s, for the case
      // where this never runs at all — a crash, or the cable pulled mid-save.
      await invoke("set_oled_busy", { on: false }).catch(() => {});
      setTimeout(() => { btn.textContent = "Save to Board"; btn.disabled = false; }, 1500);
    }
  });

  // ── Home page ─────────────────────────────────────────────────────────────
  document.getElementById("home-add")?.addEventListener("click", scanForDevices);
  document.getElementById("devices-export")?.addEventListener("click", exportDevicesToFile);
  document.getElementById("devices-import-btn")?.addEventListener("click", () =>
    document.getElementById("devices-import").click());
  document.getElementById("devices-import")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // so re-picking the same file fires change again
    if (file) await importDevicesFromFile(file);
  });

  // ── Log panel ─────────────────────────────────────────────────────────────
  loadLog();
  const logPanel = document.getElementById("log-panel");
  document.getElementById("log-toggle")?.addEventListener("click", () => {
    const open = logPanel.classList.toggle("open");
    document.getElementById("log-caret").innerHTML = open ? "&#9662;" : "&#9656;";
  });
  document.getElementById("log-clear")?.addEventListener("click", clearLog);
  document.getElementById("log-copy")?.addEventListener("click", async () => {
    const btn = document.getElementById("log-copy");
    try {
      await navigator.clipboard.writeText(logAsText());
      btn.textContent = "Copied";
    } catch {
      btn.textContent = "Failed";
    }
    setTimeout(() => { btn.textContent = "Copy"; }, 1200);
  });

  // Anything that escapes a handler still lands in the log rather than only in
  // devtools, which is where the last round of silent failures went to die.
  window.addEventListener("error", (e) => {
    logError(e.message || "uncaught error", `${e.filename || "app"}:${e.lineno || "?"}`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    logError(e.reason?.message ?? e.reason ?? "unhandled rejection", "promise");
  });
  renderLogPanel();
  document.getElementById("app-home")?.addEventListener("click", () => {
    if (document.body.classList.contains("editor")) leaveEditor();
  });
  renderDeviceList();

  // ── Macro libraries ───────────────────────────────────────────────────────
  // The per-level buttons are wired in renderMacroList/renderLibraryTiles,
  // since they are rebuilt whenever the level changes. Only the level-agnostic
  // ones are bound here.
  document.getElementById("macro-test-stop")?.addEventListener("click", stopMacroTest);
  document.getElementById("macro-test-close")?.addEventListener("click", stopMacroTest);
  document.getElementById("lib-import")?.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (file) await importMacroLibrary(file);
    e.target.value = ""; // let the same file be picked again
  });
  document.getElementById("macro-kind-keys")?.addEventListener("click", () => setMacroEditorKind("keys"));
  document.getElementById("macro-kind-shell")?.addEventListener("click", () => setMacroEditorKind("shell"));
  const scriptTa = document.getElementById("macro-script");
  scriptTa?.addEventListener("input", updateTermGutter);
  // Keep the gutter locked to the textarea's scroll, or the numbers drift.
  scriptTa?.addEventListener("scroll", () => {
    const g = document.getElementById("term-gutter");
    if (g) g.scrollTop = scriptTa.scrollTop;
  });
  // Tab indents instead of leaving the field — this is a code editor.
  scriptTa?.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    e.preventDefault();
    const { selectionStart: a, selectionEnd: b, value } = scriptTa;
    scriptTa.value = value.slice(0, a) + "  " + value.slice(b);
    scriptTa.selectionStart = scriptTa.selectionEnd = a + 2;
    updateTermGutter();
  });
  document.getElementById("macro-save")?.addEventListener("click", saveMacroFromEditor);
  document.getElementById("macro-cancel")?.addEventListener("click", closeMacroEditor);
  document.getElementById("macro-close")?.addEventListener("click", closeMacroEditor);
  // ── Macro recorder ────────────────────────────────────────────────────────
  // A webview reload does not restart the Rust side, so a hook can survive one.
  // Clear it on load: no UI is attached to it any more, and nothing should be
  // listening to the keyboard that the user cannot see.
  invoke("is_key_recording")
    .then((on) => { if (on) return invoke("stop_key_recording"); })
    .catch((e) => logError(e, "recorder cleanup"));

  document.getElementById("macro-rec")?.addEventListener("click", toggleMacroRecording);
  // Repaint at once rather than waiting for the next poll, so a changed delay
  // shows its effect on what is already captured.
  document.getElementById("macro-rec-ms")?.addEventListener("input", () => {
    if (macroRecording) {
      invoke("peek_key_recording").then(renderMacroRecPreview)
        .catch((e) => logError(e, "peek_key_recording"));
    }
  });

  document.getElementById("macro-editor")?.addEventListener("click", (e) => {
    // Backdrop click closes; clicks inside the modal must not.
    if (e.target.id === "macro-editor") closeMacroEditor();
  });
  renderMacroList();

  // ── Global board LED controls (brightness 0xF0, overlay 0xF1/0xF2) ────────
  const savedBrightness = localStorage.getItem(BRIGHTNESS_KEY);
  if (savedBrightness !== null) {
    const v = parseInt(savedBrightness, 10);
    if (Number.isFinite(v)) ledBrightness = Math.min(255, Math.max(0, v));
  }
  const brightInp = document.getElementById("led-brightness");
  brightInp.value = String(ledBrightness);
  renderBrightness();
  brightInp.addEventListener("input", (e) => {
    ledBrightness = parseInt(e.target.value, 10) || 0;
    localStorage.setItem(BRIGHTNESS_KEY, String(ledBrightness));
    renderBrightness();
    applyCornerColors();
    scheduleLiveSync("leds");
  });

  renderOverlayBtn();

  const status  = await invoke("board_status");
  _wasConnected = !!status?.connected;
  renderConnPill(_wasConnected);
  // renderDeviceList() above drew last session's saved dots. Nothing guarantees
  // they survived the app being closed, so settle them against reality before
  // the user can read them as current.
  await syncDeviceListConnection(_wasConnected);

  // Backend events: inbound HOST(n) results, and board attach/detach. The
  // attach/detach event is what makes plugging a board in mid-session work —
  // the backend supervises USB for the whole run, not just at startup.
  if (hasTauri) {
    try {
      const { listen } = await import("@tauri-apps/api/event");
      // Into the app log, not just the console. A HOST(n) press is the one
      // action with no on-screen result of its own, so a macro that half-worked
      // — a keystroke step with no host mapping, a script that exited non-zero —
      // would otherwise be indistinguishable from one that did nothing.
      await listen("host-cmd", (e) => {
        const p = e.payload || {};
        if (!p.ok) { logError(`HOST(${p.index}) failed: ${p.error || "unknown error"}`, "host-cmd"); return; }
        const warn = (p.stderr || "").trim();
        if (warn) logWarn(`HOST(${p.index}): ${warn}`, "host-cmd");
        else logInfo(`HOST(${p.index}) ok — ${(p.stdout || "").trim().split("\n")[0]}`, "host-cmd");
      });
      await listen("board-connection", (e) => {
        const connected = !!e.payload?.connected;
        console.log("board-connection", connected ? "attached" : "detached");
        onConnectionChange(connected);
      });
    } catch (e) { logError(e, "backendEvents"); }
  }

  // Restore underglow + corner + advanced settings from localStorage
  const savedCorners = localStorage.getItem(UG_CORNERS_KEY);
  if (savedCorners) try { cornerColors = JSON.parse(savedCorners); } catch {}
  const savedUgSelected = localStorage.getItem(UG_SELECTED_KEY);
  if (savedUgSelected) try {
    const arr = JSON.parse(savedUgSelected);
    selectedCorners = new Set(arr.filter(i => i >= 0 && i < 4));
  } catch {}
  document.documentElement.style.setProperty("--ug-color", hexToRgbTriple(cornerColors[0]));
  applyCornerColors();
  const savedAdv = localStorage.getItem(UG_ADVANCED_KEY);
  if (savedAdv) try {
    const a = JSON.parse(savedAdv);
    ugAnimation = a.animation ?? ugAnimation;
    ugRate      = a.rate      ?? ugRate;
    ugIntensity = a.intensity ?? ugIntensity;
  } catch {}
  renderAnimChips();
  document.getElementById("ug-rate").value      = ugRate;
  document.getElementById("ug-intensity").value = ugIntensity;

  const savedKlAdv = localStorage.getItem(KL_ADVANCED_KEY);
  if (savedKlAdv) try {
    const a = JSON.parse(savedKlAdv);
    klAnimation = a.animation ?? klAnimation;
    klRate      = a.rate      ?? klRate;
  } catch {}
  renderKlAnimChips();
  document.getElementById("kl-rate").value      = klRate;

  const savedKlPalette = localStorage.getItem(KL_PALETTE_KEY);
  if (savedKlPalette) try { klPalette = JSON.parse(savedKlPalette); } catch {}
  renderPalette("kl-palette", () => klPalette, (v) => { klPalette = v; }, KL_PALETTE_KEY, saveCurrentKeyAnimState);

  const savedPerKey = localStorage.getItem(KL_PER_KEY);
  if (savedPerKey) try {
    const loaded = JSON.parse(savedPerKey);
    if (loaded) applyAnimState(animFromStored(loaded));
  } catch {}

  const savedUgPalette = localStorage.getItem(UG_PALETTE_KEY);
  if (savedUgPalette) try { ugPalette = JSON.parse(savedUgPalette); } catch {}
  renderPalette("ug-palette", () => ugPalette, (v) => { ugPalette = v; }, UG_PALETTE_KEY, () => {});

  const savedEnc = localStorage.getItem(ENC_KEY);
  if (savedEnc) try { const e = JSON.parse(savedEnc); encoderMode = e.mode ?? encoderMode; } catch {}
  renderEncoderOpts();
  document.querySelectorAll(".enc-opt").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      encoderMode = btn.dataset.mode;
      localStorage.setItem(ENC_KEY, JSON.stringify({ mode: encoderMode }));
      renderEncoderOpts();
    });
  });

  keymap = await invoke("get_keymap");

  // Seed Layer 01 if this is a fresh install with no saved layers
  if (getSavedLayers().length === 0) {
    saveCurrentAsLayer("Layer 01");
  }

  // Always boot into the first saved layer
  const bootLayer = getSavedLayers()[0];
  keymap         = sanitizeKeymap(structuredClone(bootLayer.keymap));
  keyLedColors   = [...bootLayer.leds];
  keyIconImages  = bootLayer.iconImages ? [...bootLayer.iconImages] : Array(21).fill(null);
  keyIconBits    = bootLayer.iconBits ? [...bootLayer.iconBits] : Array(21).fill(null);
  if (bootLayer.animStates) {
    try { applyAnimState(animFromStored(bootLayer.animStates)); } catch {}
  }
  if (bootLayer.underglow) applyUnderglowSnapshot(bootLayer.underglow);
  activeProfileId = bootLayer.id;
  await invoke("set_keymap", { map: keymap });

  // Restore OLED custom screens + back key. The countdown deliberately does NOT
  // restore: it always opens at 00:00:00. A duration is set for one use, and
  // reopening to a stale 00:45:00 from days ago reads as the timer already
  // being armed.
  try { oledCustomScreens = JSON.parse(localStorage.getItem(OLED_CUSTOM_KEY) || "[]"); } catch {}
  try { oledSleepScreens = JSON.parse(localStorage.getItem(OLED_SLEEP_KEY)) || {}; } catch { oledSleepScreens = {}; }
  resetCountdown();
  try {
    const raw = JSON.parse(localStorage.getItem(OLED_EVENT_KEYS_KEY) || "{}");
    // Discard the old pre-per-screen flat format (top-level values were numbers)
    if (Object.values(raw).some(v => typeof v === "number")) {
      oledEventKeys = {};
    } else {
      oledEventKeys = {};
      for (const [sk, evMap] of Object.entries(raw)) {
        if (!evMap || typeof evMap !== "object") continue;
        oledEventKeys[sk] = {};
        for (const [evName, v] of Object.entries(evMap)) {
          if (typeof v === "number") {
            oledEventKeys[sk][evName] = { idx: v, color: "#ff6e14" }; // migrate
          } else if (v && typeof v.idx === "number") {
            oledEventKeys[sk][evName] = v;
          }
        }
      }
    }
  } catch {}

  renderBoard();
  startUgAnimation();
  startKlAnimation();
  startOledAnim();

  // ── Layer bar ─────────────────────────────────────────────────────────────
  // The board's own switcher. Replaces the top-right Saved Layers dropdown:
  // switching screens is the common action, so it belongs on the board rather
  // than behind a hover menu in a corner. Everything that acts on the CURRENT
  // layer sits with its name; export/import are per-device and moved to the
  // Home device card.
  document.getElementById("layer-prev").addEventListener("click", (e) => {
    e.stopPropagation(); oledScreenNav(-1); renderLayerBar(); renderOledPill();
  });
  document.getElementById("layer-next").addEventListener("click", (e) => {
    e.stopPropagation(); oledScreenNav(1); renderLayerBar(); renderOledPill();
  });

  document.getElementById("layer-add-screen").addEventListener("click", (e) => {
    e.stopPropagation();
    openScreenPicker();
  });
  document.getElementById("layer-led-theme").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleScreenLedPill();
  });
  document.getElementById("layer-copy-screen").addEventListener("click", (e) => {
    e.stopPropagation();
    // Snapshot BEFORE the picker opens: the source is the screen on show now.
    saveCurrentLayerState();
    openScreenPicker(currentScreenCopy());
  });
  document.getElementById("layer-del-screen").addEventListener("click", (e) => {
    e.stopPropagation();
    removeCurrentScreen();
  });

  // ── Underglow ring click ───────────────────────────────────────────────────
  document.getElementById("board-ring").addEventListener("click", (e) => {
    // A sweep that starts on a key and ends on the ring fires `click` on the
    // ring, their common ancestor — without this the drag would toggle the
    // underglow pill. Read but not cleared: the document handler below owns
    // resetting the flag, and it runs after this one on the way up.
    if (wasDragging) return;
    if (e.target.closest(".key, .encoder-knob, .oled-panel, .ug-corner, .board")) return;
    const isOpen = document.getElementById("underglow-pill").classList.contains("visible");
    if (isOpen) {
      closeUnderglowPill();
    } else {
      openUnderglowPill();
    }
  });

  // ── Drag multi-select ────────────────────────────────────────────────────
  // On window, not the board: a sweep that runs off the edge of the board still
  // has to end, or the next click would be treated as part of the drag.
  window.addEventListener("mousemove", updateDragSelect);
  window.addEventListener("mouseup", endDragSelect);

  // ── Close pills when clicking outside board-ring / pill ──────────────────
  document.addEventListener("click", (e) => {
    if (wasDragging) { wasDragging = false; return; }
    if (clickStartedInKeyPill) { clickStartedInKeyPill = false; return; }
    if (e.target.closest("#board-ring, #underglow-pill, #key-pills, #oled-pill, #screen-led-pill, #layer-led-theme")) return;
    closeUnderglowPill();
    closeScreenLedPill();
    if (document.getElementById("key-pills").classList.contains("visible")) {
      keySelectionOrder = [];
      selectedKeys.clear();
      closeKeyLedPill();
      renderBoard();
    }
    closeOledPill();
  });

  // ── Corner LED pickers (board-ring pips + main-row selection toggles) ────
  for (let i = 0; i < 4; i++) {
    // Board-ring pip — opens native color picker, updates individual corner
    const corner = document.getElementById(`ug-c${i}`);
    const pip    = corner.querySelector(".ug-corner-inp");
    corner.addEventListener("click", (e) => { e.stopPropagation(); pip.click(); });
    pip.addEventListener("input", (e) => {
      cornerColors[i] = e.target.value;
      localStorage.setItem(UG_CORNERS_KEY, JSON.stringify(cornerColors));
      applyCornerColors();
      scheduleLiveSync("leds");
    });

    // Main-row button — toggle corner selection
    document.getElementById(`ug-cb-${i}`).addEventListener("click", (e) => {
      e.stopPropagation();
      if (selectedCorners.has(i)) selectedCorners.delete(i);
      else selectedCorners.add(i);
      localStorage.setItem(UG_SELECTED_KEY, JSON.stringify([...selectedCorners]));
      updateCornerButtons();
      updateUgColorSwatch();
    });
  }

  // The Key LED pill's own Advanced toggle is gone — colour and keycode share
  // one pill and one drawer now (kc-adv-btn below).

  document.getElementById("kl-rate").addEventListener("input", (e) => {
    klRate = Number(e.target.value); saveKlAdvancedState();
  });
  // No kl-intensity handler: the slider is gone. It scaled the preview's
  // opacity and nothing else — there is no intensity field in the key
  // animation payload, so the board never saw it.

  // ── Keycode Advanced toggle ────────────────────────────────────────────────
  document.getElementById("kc-adv-btn").addEventListener("click", async (e) => {
    e.stopPropagation();
    const adv     = document.getElementById("kc-advanced");
    const arrow   = document.getElementById("kc-adv-arrow");
    const btn     = document.getElementById("kc-adv-btn");
    const opening = !adv.classList.contains("open");
    adv.classList.toggle("open", opening);
    btn.classList.toggle("open", opening);
    arrow.textContent = opening ? "▾" : "▸";
    if (opening) {
      renderKcPalette();
      if (selectedKeys.size === 1) updateIconPreview([...selectedKeys][0]);
    }
  });

  document.getElementById("kc-search").addEventListener("input", (e) => renderKcPalette(e.target.value));

  // ── Underglow Advanced toggle ─────────────────────────────────────────────
  document.getElementById("ug-adv-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    const adv     = document.getElementById("ug-advanced");
    const arrow   = document.getElementById("ug-adv-arrow");
    const btn     = document.getElementById("ug-adv-btn");
    const opening = !adv.classList.contains("open");
    adv.classList.toggle("open", opening);
    btn.classList.toggle("open", opening);
    arrow.textContent = opening ? "▾" : "▸";
  });

  // ── Per-key macro binding ─────────────────────────────────────────────────
  document.getElementById("kc-macro-select")?.addEventListener("change", (e) => {
    const [idx] = selectedKeys;
    if (idx === undefined) return;
    bindMacroToKey(idx, e.target.value || null);
  });

  // ── Animation rate + intensity ────────────────────────────────────────────
  document.getElementById("ug-rate").addEventListener("input", (e) => {
    ugRate = Number(e.target.value); saveAdvancedState();
  });
  document.getElementById("ug-intensity").addEventListener("input", (e) => {
    ugIntensity = Number(e.target.value); saveAdvancedState();
  });

  document.getElementById("underglow-color").addEventListener("input", (e) => {
    applyUnderglowHex(e.target.value);
  });

  document.getElementById("kl-color").addEventListener("input", (e) => {
    for (const idx of selectedKeys) keyLedColors[idx] = e.target.value;
    updateKlColorVars();
    renderBoard();
    scheduleLiveSync("leds");
  });

  document.getElementById("kl-kc").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const val = normalizeKeycode(e.target.value);
      for (const idx of selectedKeys) keymap.layers[0].keys[idx] = val;
      renderBoard();
      scheduleLiveSync("keymap");
    }
  });

  document.getElementById("kl-icon-file")?.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = "";
    // PNG and SVG only. Both rasterise cleanly to the board's 1-bit mask, and
    // an animated format could not be one anyway — the board draws a still.
    const isPng = file.type === "image/png" || /\.png$/i.test(file.name);
    const isSvg = file.type === "image/svg+xml" || /\.svg$/i.test(file.name);
    if (!isPng && !isSvg) {
      logWarn(`Rejected icon ${file.name}: not PNG or SVG`, "icon-upload");
      alert("Icons must be a PNG or an SVG.");
      return;
    }
    const url = await readFileAsDataUrl(file);
    const ok  = await checkImageSize(url);
    if (!ok) { alert("Image must be 128×128 pixels or smaller."); return; }
    let bits = null;
    try {
      bits = await rasterizeIconMask(url);
    } catch (err) {
      // The app can still show the icon; only the board loses it. Say so
      // rather than failing the upload outright.
      logError(`Could not rasterise ${file.name} for the board: ${err?.message ?? err}`, "icon-upload");
    }
    for (const idx of selectedKeys) {
      keyIconImages[idx] = url;
      keyIconBits[idx]   = bits;
    }
    if (selectedKeys.size === 1) updateIconPreview([...selectedKeys][0]);
    renderBoard();
    // Icons are host-side state, so they never reach scheduleLiveSync — they
    // need saving explicitly or they are lost on restart.
    scheduleAutoSave();
  });

  document.getElementById("kc-icon-clear")?.addEventListener("click", () => {
    for (const idx of selectedKeys) {
      keyIconImages[idx] = null;
      keyIconBits[idx]   = null;
    }
    if (selectedKeys.size === 1) updateIconPreview([...selectedKeys][0]);
    renderBoard();
    scheduleAutoSave();
  });

  // Screen navigation and add/remove live on the layer bar above the board now.

  // OLED font picker
  document.getElementById("oled-font-btns").addEventListener("click", (e) => {
    const btn = e.target.closest(".oled-font-btn");
    if (btn) { e.stopPropagation(); applyOledFont(btn.dataset.font); }
  });
  applyOledFont(oledFontId, false);
}

function evIdx(v)   { return typeof v === "number" ? v : (v?.idx ?? null); }
function evColor(v) { return typeof v === "number" ? "#ff6e14" : (v?.color ?? "#ff6e14"); }

function openLedSettingsForKey(keyIdx) {
  for (const prev of selectedKeys) {
    const prevEl = document.getElementById("key-" + prev);
    if (prevEl) prevEl.classList.remove("sel");
  }
  keySelectionOrder = [keyIdx];
  selectedKeys.clear();
  selectedKeys.add(keyIdx);
  const el = document.getElementById("key-" + keyIdx);
  if (el) el.classList.add("sel");
  syncKeyLedThemeUI();
  closeUnderglowPill();
  closeOledPill();
  syncKeyLedPill();
  openKeyLedPill();
  flashKey(keyIdx);
}

// ── Board render ───────────────────────────────────────────────────────────
function renderBoard() {
  const el = document.getElementById("board");
  el.innerHTML = "";

  const layers = getSavedLayers();
  const active = layers.find(l => l.id === activeProfileId);
  const activeIdx = active
    ? String(layers.indexOf(active) + 1).padStart(2, "0")
    : "--";

  const oledPanel = document.createElement("div");
  oledPanel.className = "oled-panel";
  oledPanel.title = "";
  const oledScreen = document.createElement("div");
  oledScreen.className = "oled-screen";
  oledScreen.title = "Click to open OLED designer";
  renderOledScreenContent(oledScreen);
  oledPanel.appendChild(oledScreen);
  oledPanel.addEventListener("click", (e) => {
    if (!e.target.closest(".oled-screen")) return;
    e.stopPropagation();
    selectedKeys.clear();
    closeKeyLedPill();
    closeUnderglowPill();
    renderBoard();
    openOledPill();
  });
  el.appendChild(oledPanel);

  for (const pos of BOARD_POSITIONS) {
    const kc = keymap.layers[0].keys[pos.idx] ?? "KC_NO";
    const isSel = selectedKeys.has(pos.idx);
    const ledColor = keyLedColors[pos.idx];

    if (pos.type === "encoder") {
      const encWrap = document.createElement("div");
      encWrap.className = "encoder-wrap";
      encWrap.style.cssText = `grid-row:${pos.row};grid-column:${pos.col}`;

      const encCycleActive = oledSubMode === "keycycle" && BOARD_POSITIONS[oledKeyCycleIdx]?.idx === pos.idx;
      const encEvMapBsk    = currentOledScreenKey();
      const encEvMap       = encEvMapBsk ? (oledEventKeys[encEvMapBsk] || {}) : {};
      const encEvEntry     = Object.values(encEvMap).find(v => evIdx(v) === pos.idx);
      const isEncEventKey  = !!encEvEntry;
      const enc = document.createElement("button");
      enc.id = "key-" + pos.idx;
      enc.title = "";
      enc.className = "encoder-knob" + (isSel ? " sel" : "") + (encCycleActive ? " oled-key-active" : "") + (isEncEventKey ? " oled-event-key" : "");
      if (isEncEventKey) {
        const { r, g, b } = hexToRgb(evColor(encEvEntry));
        enc.style.setProperty("--oled-ev-color", `rgba(${r},${g},${b},0.75)`);
      }
      enc.textContent = "◉";
      enc.addEventListener("mousedown", (e) => { e.preventDefault(); beginDragSelect(e); onKeyDown(pos.idx); });
      enc.addEventListener("mouseenter", (e) => { onKeyEnter(pos.idx); showKeyTooltip(pos.idx, e.currentTarget); });
      enc.addEventListener("mouseleave", hideKeyTooltip);
      encWrap.appendChild(enc);

      const cwBtn = document.createElement("button");
      cwBtn.className = "enc-rotate-btn enc-cw";
      cwBtn.textContent = "↻";
      cwBtn.title = "Rotate CW";
      cwBtn.addEventListener("click", (e) => { e.stopPropagation(); onEncoderCW(); });
      encWrap.appendChild(cwBtn);

      const ccwBtn = document.createElement("button");
      ccwBtn.className = "enc-rotate-btn enc-ccw";
      ccwBtn.textContent = "↺";
      ccwBtn.title = "Rotate CCW";
      ccwBtn.addEventListener("click", (e) => { e.stopPropagation(); onEncoderCCW(); });
      encWrap.appendChild(ccwBtn);

      el.appendChild(encWrap);
    } else {
      const k = document.createElement("button");
      k.id = "key-" + pos.idx;
      k.title = "";
      const isEmpty = kc === "KC_NO" || kc === "KC_TRNS";
      const isCycleActive  = oledSubMode === "keycycle" && pos.idx === (BOARD_POSITIONS[oledKeyCycleIdx]?.idx);
      const bsk            = currentOledScreenKey();
      const bScreenEvMap   = bsk ? (oledEventKeys[bsk] || {}) : {};
      // entries(), not values(): the event's NAME is what selects its icon.
      const evPair         = Object.entries(bScreenEvMap).find(([, v]) => evIdx(v) === pos.idx);
      const evName         = evPair?.[0] ?? null;
      const evEntry        = evPair?.[1] ?? null;
      const isEventKey     = !!evEntry;
      const isAssigning    = pendingEventAssign !== null && !isEventKey;
      // While Present Keys is up the board owns the whole key field: every key
      // goes plain white, the focused one blinks 2 Hz and the screen's event
      // keys blink RED at 4 Hz. Mirrored here so the two views agree about
      // which keys are lit and why.
      const inPresent = oledSubMode === "keycycle";
      k.className = "key"
        + (isSel ? " sel" : "")
        + (isEmpty ? " empty" : "")
        + (isCycleActive ? " oled-key-active" : "")
        + (inPresent && isCycleActive ? " oled-present-focus" : "")
        + (isEventKey ? " oled-event-key" : "")
        + (inPresent && isEventKey && !isCycleActive ? " oled-present-event" : "")
        + (isAssigning ? " oled-assigning" : "");
      k.style.cssText = `grid-row:${pos.row};grid-column:${pos.col}`;
      if (isEventKey && !inPresent) {
        const { r, g, b } = hexToRgb(evColor(evEntry));
        k.style.setProperty("--oled-ev-color", `rgba(${r},${g},${b},0.75)`);
      }
      const imgSrc  = keyIconImages[pos.idx];
      const evIconH = isEventKey && !inPresent ? oledEventIconSVG(evName) : null;
      if (!imgSrc && evIconH) {
        // Below an explicit user icon, above the macro name and the keycode: an
        // uploaded icon is still a deliberate statement about this key, but a
        // bare keycode says nothing that the screen action does not say better.
        const wrap = document.createElement("span");
        wrap.className = "key-event-icon-wrap";
        wrap.innerHTML = evIconH;
        wrap.title = OLED_EVENT_LABELS[evName] ?? evName;
        k.appendChild(wrap);
      } else if (imgSrc) {
        // Label priority: icon > macro name > keycode. An icon is an explicit
        // choice about how this key should read, so it outranks the macro name
        // even when a macro is bound. Same rule the board applies.
        const imgEl = document.createElement("img");
        imgEl.src = imgSrc;
        imgEl.className = "key-icon-img";
        k.appendChild(imgEl);
      } else {
        const macroName = keyMacros[pos.idx]
          ? (findMacroById(keyMacros[pos.idx])?.name ?? null)
          : null;
        const label = document.createElement("span");
        // Macro names are free text and far longer than a keycode, so they get
        // the smaller, wrapping treatment.
        label.className = "key-label" + (macroName ? " macro" : "");
        label.textContent = macroName || (isEmpty ? "·" : kc.replace(/^KC_/, ""));
        k.appendChild(label);
      }
      k.addEventListener("mousedown", (e) => { e.preventDefault(); beginDragSelect(e); onKeyDown(pos.idx); });
      k.addEventListener("mouseenter", (e) => { onKeyEnter(pos.idx); showKeyTooltip(pos.idx, e.currentTarget); });
      k.addEventListener("mouseleave", hideKeyTooltip);
      el.appendChild(k);
    }
  }
}

function flashBoard() {
  const board = document.getElementById("board");
  board.classList.remove("flash");
  void board.offsetWidth;
  board.classList.add("flash");
  board.addEventListener("animationend", () => board.classList.remove("flash"), { once: true });
}

function onKeyDown(idx) {
  // Assign mode: bind this key to the pending OLED event
  if (pendingEventAssign !== null) {
    const sk = currentOledScreenKey();
    if (sk) {
      oledEventKeys[sk] = oledEventKeys[sk] || {};
      oledEventKeys[sk][pendingEventAssign] = { idx, color: "#ff6e14" };
    }
    saveOledEventKeys();
    pendingEventAssign = null;
    renderOledPillContent(); renderBoard();
    return;
  }

  // A key can also be bound to an OLED event, or be the back key. Both used to
  // `return` here, which meant such a key could never be SELECTED — and so
  // never configured: no keycode, LED, icon or macro. Having a role must not
  // cost the key its settings, so the OLED behaviour is noted and fired at the
  // end, after the normal selection has happened.
  const sk          = currentOledScreenKey();
  const screenEvMap = sk ? (oledEventKeys[sk] || {}) : {};
  const eventHit    = Object.entries(screenEvMap).find(([, v]) => evIdx(v) === idx);

  hideKeyTooltip();
  lastKeyClickTime = performance.now();
  keyClickTimes[idx] = performance.now();

  // Deselect previously selected keys without a full board rebuild
  for (const prev of selectedKeys) {
    const prevEl = document.getElementById("key-" + prev);
    if (prevEl) prevEl.classList.remove("sel");
  }

  keySelectionOrder = [idx];
  selectedKeys.clear();
  selectedKeys.add(idx);

  const el = document.getElementById("key-" + idx);
  if (el) el.classList.add("sel");

  syncKeyLedThemeUI();
  closeUnderglowPill();
  closeOledPill();
  syncKeyLedPill();
  openKeyLedPill();
  flashKey(idx);

  // Fire the OLED role AFTER selecting, so the key is configurable either way.
  // Back-key exit wins over an event binding: leaving a sub-mode is the more
  // specific intent when a key happens to be both.
  if (handleCountdownArrow(idx)) {
    // Consumed by the countdown screen. Nothing else to do — the key stays
    // selected so it is still configurable while doubling as a control.
  } else if (eventHit) {
    triggerOledEvent(eventHit[0]);
    document.getElementById("key-" + idx)?.classList.add("sel");
  }
}

// ── Drag multi-select ───────────────────────────────────────────────────────
// Press on a key and sweep across others to add them to the selection.
//
// The threshold is why this is three flags rather than one. A plain click also
// produces mousedown/mouseup, so arming on mousedown alone would make every
// click look like a finished drag and the trailing `click` event would be
// swallowed by the handler in init() that closes the pills. `isDragging` is
// therefore only armed once the pointer has actually travelled DRAG_PX from
// where the button went down, and `wasDragging` carries that fact to the click
// handler, which fires after mouseup.
const DRAG_PX = 5;

function beginDragSelect(e) {
  dragFromKey  = true;
  dragStartPos = { x: e.clientX, y: e.clientY };
  isDragging   = false; // armed by movement, not by the press itself
}

function updateDragSelect(e) {
  if (!dragFromKey || isDragging || !dragStartPos) return;
  const dx = e.clientX - dragStartPos.x;
  const dy = e.clientY - dragStartPos.y;
  if (dx * dx + dy * dy >= DRAG_PX * DRAG_PX) {
    isDragging = true;
    hideKeyTooltip(); // the tooltip guard only covers keys entered from here on
  }
}

function endDragSelect() {
  if (!dragFromKey) return;
  // Only claim a drag happened if one really did; otherwise a click that merely
  // jittered would eat the next click and leave the pills open.
  if (isDragging) wasDragging = true;
  dragFromKey  = false;
  isDragging   = false;
  dragStartPos = null;
}

function onKeyEnter(idx) {
  if (!isDragging) return;
  if (selectedKeys.has(idx)) return;
  selectedKeys.add(idx);
  keySelectionOrder.push(idx);
  // Toggle class directly — no full board rebuild needed during drag
  const el = document.getElementById("key-" + idx);
  if (el) el.classList.add("sel");
  syncKeyLedPill();
  flashKey(idx);
}

function syncKeyLedPill() {
  const n          = selectedKeys.size;
  const encOnly    = n === 1 && selectedKeys.has(ENCODER_IDX);
  document.getElementById("kl-count").textContent = encOnly ? "encoder" : n === 1 ? "1 key" : `${n} keys`;
  document.getElementById("encoder-section").classList.toggle("visible", encOnly);
  if (n === 1) {
    const [idx] = selectedKeys;
    const kc = keymap.layers[0].keys[idx] ?? "KC_NO";
    document.getElementById("kl-kc").value   = kc === "KC_NO" ? "" : kc;
    const col = keyLedColors[idx];
    document.getElementById("kl-color").value = col || "#ffffff";
    updateIconPreview(idx);
  } else {
    document.getElementById("kl-kc").value   = "";
    const colors = [...selectedKeys].map(i => keyLedColors[i]).filter(c => !!c);
    document.getElementById("kl-color").value =
      (colors.length && colors.every(c => c === colors[0])) ? colors[0] : "#ffffff";
    updateIconPreview(null);
  }
  updateKlColorVars();
  // The MACRO dropdown is per-key: it has to be rebuilt whenever the selection
  // changes, or it shows the previous key's binding (or nothing at all).
  renderKeyMacroRow();
}

function updateIconPreview(idx) {
  const wrap = document.getElementById("kc-icon-thumb-wrap");
  const thumb = document.getElementById("kc-icon-thumb");
  const clearBtn = document.getElementById("kc-icon-clear");
  if (!wrap) return;
  const src = (idx !== null && idx !== undefined) ? keyIconImages[idx] : null;
  wrap.style.display = src ? "" : "none";
  if (thumb) thumb.src = src || "";
  if (clearBtn) clearBtn.style.display = src ? "" : "none";
}

// ── Saved Layers storage ───────────────────────────────────────────────────
const LAYERS_KEY = "kf-saved-layers";

function getSavedLayers() {
  try {
    const scoped = localStorage.getItem(layersKeyScoped());
    if (scoped !== null) return JSON.parse(scoped);
    // First run for this device after the per-device split: adopt the old
    // global list rather than appearing to have lost every saved layer.
    return JSON.parse(localStorage.getItem(LAYERS_KEY) || "[]");
  } catch { return []; }
}

// A PROFILE is everything a screen owns: its keymap, per-key colours, icons,
// macros, LED animation and underglow. Saved layers always had one; custom
// screens did not, so navigating to a Pomodoro screen left the previous
// layer's keys and LEDs in place — a macro bound on one screen appeared to
// follow you to the next, and its animation kept running. Every screen owns
// one now, and a screen without a stored profile starts at the same defaults a
// blank layer does: no keycodes, white keys, white underglow, solid.
function captureProfile() {
  return {
    keymap:     structuredClone(keymap),
    leds:       [...keyLedColors],
    iconImages: [...keyIconImages],
    iconBits:   [...keyIconBits],
    // Kept with the profile: it owns the keymap, and HOST(n) keycodes are
    // meaningless without the bindings that produced them.
    keyMacros:  [...keyMacros],
    animStates: currentAnimState(),
    underglow:  currentUnderglowSnapshot(),
  };
}

function applyProfile(p) {
  keymap = p?.keymap
    ? sanitizeKeymap(structuredClone(p.keymap))
    : { layers: Array.from({ length: 4 }, () => ({ keys: Array(21).fill("KC_NO") })) };
  keyLedColors  = p?.leds       ? [...p.leds]       : Array.from({ length: 21 }, () => "#ffffff");
  keyIconImages = p?.iconImages ? [...p.iconImages] : Array(21).fill(null);
  keyIconBits   = p?.iconBits   ? [...p.iconBits]   : Array(21).fill(null);
  keyMacros     = p?.keyMacros  ? [...p.keyMacros]  : Array(21).fill(null);
  // Both of these already fall back to the defaults on null/undefined.
  applyAnimState(animFromStored(p?.animStates));
  applyUnderglowSnapshot(p?.underglow ?? null);
}

/// The id of whatever screen a profile belongs to.
function screenProfileId(screen) {
  if (!screen) return null;
  return screen.type === "layer" ? screen.layerId : screen.id;
}

function profileForScreen(screen) {
  if (!screen) return null;
  return screen.type === "layer"
    ? getSavedLayers().find(l => l.id === screen.layerId)
    : screen.profile;
}

// Write the live state back to whichever screen it belongs to. Replaces the
// layer-only version: activeProfileId can now name a custom screen too.
function saveCurrentProfile() {
  if (!activeProfileId) return;
  const layers = getSavedLayers();
  const layer  = layers.find(l => l.id === activeProfileId);
  if (layer) {
    Object.assign(layer, captureProfile());
    localStorage.setItem(layersKeyScoped(), JSON.stringify(layers));
    return;
  }
  const scr = oledCustomScreens.find(x => x.id === activeProfileId);
  if (scr) {
    scr.profile = captureProfile();
    saveOledCustomScreens();
    scheduleAutoSave();
  }
}

// Move the board onto a screen's own profile. Silent by default because this
// runs on every navigation; the layer bar handles its own focus.
// Split deliberately. Everything the user can SEE is applied synchronously
// here; the board push is a separate step that nothing on screen waits for.
//
// They used to be one `await`-ing function, which is what made switching or
// deleting a layer feel like it updated in its own time: callers awaited the
// whole thing, so the layer bar — the screen's name and position — only
// repainted once `set_keymap` had made a full HID round trip, and longer still
// when the board was slow to answer or absent. The keycaps repainted at once
// and the title lagged behind them.
//
// Returns false when there is nothing to switch to, so callers can tell "already
// here" from "switched".
function applyScreenLocally(screen) {
  const id = screenProfileId(screen);
  if (!id || id === activeProfileId) return false;
  saveCurrentProfile();
  applyProfile(profileForScreen(screen));
  activeProfileId = id;
  keySelectionOrder = [];
  selectedKeys.clear();
  closeKeyLedPill();
  // The pills read the profile's animation state, so they have to be rebuilt
  // too — switching layers never did this either, leaving the previous
  // screen's animation highlighted while a different one actually ran.
  renderKlAnimChips();
  renderBoard();
  return true;
}

// Fire-and-forget by design: the UI is already correct by the time this runs,
// and a board that is slow, busy or unplugged must not hold it up. Errors go to
// the log rather than surfacing, same as before.
function pushActiveScreenToBoard() {
  return invoke("set_keymap", { map: keymap })
    .then(() => { scheduleLiveSync("leds"); scheduleLiveSync("anim"); })
    .catch((e) => logError(e, "switchToScreen"));
}

async function switchToScreen(screen) {
  if (!applyScreenLocally(screen)) return;
  await pushActiveScreenToBoard();
}

function saveCurrentLayerState() {
  saveCurrentProfile();
}

// A blank layer record, built from the defaults rather than from whatever is in
// memory — resetDevice() writes one for a device whose editor may never have
// been opened, so there is no current state to snapshot.
function defaultLayerRecord(name) {
  return {
    id: Date.now().toString(),
    name,
    keymap:     { layers: Array.from({ length: 4 }, () => ({ keys: Array(21).fill("KC_NO") })) },
    leds:       Array.from({ length: 21 }, () => "#ffffff"),
    icons:      Array(21).fill(""),
    iconImages: Array(21).fill(null),
    keyMacros:  Array(21).fill(null),
    animStates: { animation: "solid", rate: 128, intensity: 180, palette: [] },
    underglow:  {
      animation: "solid", rate: 128, intensity: 180, palette: [],
      cornerColors: [...DEFAULT_CORNER_COLORS],
    },
  };
}

function saveCurrentAsLayer(name) {
  const layers = getSavedLayers();
  const id = Date.now().toString();
  layers.push({
    id, name,
    keymap:     structuredClone(keymap),
    leds:       [...keyLedColors],
    iconImages: [...keyIconImages],
    iconBits:   [...keyIconBits],
    keyMacros:  [...keyMacros],
    animStates: currentAnimState(),
    underglow:  currentUnderglowSnapshot(),
  });
  localStorage.setItem(layersKeyScoped(), JSON.stringify(layers));
  activeProfileId = id;
}

function renameSavedLayer(id, name) {
  const layers = getSavedLayers();
  const layer = layers.find(l => l.id === id);
  if (layer) {
    layer.name = name;
    localStorage.setItem(layersKeyScoped(), JSON.stringify(layers));
  }
}

function deleteSavedLayer(id) {
  const layers = getSavedLayers().filter(l => l.id !== id);
  localStorage.setItem(layersKeyScoped(), JSON.stringify(layers));
  if (activeProfileId === id) activeProfileId = null;

  if (layers.length === 0) {
    // No layers left — blank the device: all KC_NO, all LEDs off
    activeProfileId = null;
    keymap = { layers: keymap.layers.map(() => ({ keys: Array(21).fill("KC_NO") })) };
    keyLedColors = Array(21).fill("#ffffff");
    invoke("set_keymap", { map: keymap });
    // Colours are all-zero here, but the brightness byte still has to carry the
    // user's global setting — hardcoding 255 would leave the board's brightness
    // contradicting the slider until the next push.
    invoke("set_leds", { leds: { keys: Array(21).fill([0, 0, 0]), underglow: Array(4).fill([0, 0, 0]), brightness: ledBrightness } });
    invoke("set_anim", { anim: buildAnimState() });
  }

  renderLayerBar();
  renderBoard();
}

// ── Saving a file ───────────────────────────────────────────────────────────
// Every export in the app goes through here.
//
// This is NOT a browser download. All three exporters used to build an <a
// download> and click it, which is silently dead in a Tauri webview: WebView2
// raises a download request, nothing is registered to handle it, and it is
// cancelled — no file, no error, no console message. That is why Export looked
// like a button that did nothing (2026-08-16), and why the same bug sat unseen
// in device and layer export too.
//
// The native dialog picks the path and Rust writes it (`write_text_file`), so
// the app needs no blanket filesystem permission — just the path the user chose.
async function saveJsonFile(filename, data) {
  const path = await save({
    defaultPath: filename,
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (!path) return false; // user cancelled the dialog
  await invoke("write_text_file", {
    path,
    contents: JSON.stringify(data, null, 2),
  });
  return true;
}

// Every layer this device owns, as one document. Reading the scoped key
// directly rather than getSavedLayers(), which is relative to whichever device
// is active — Home can export a device whose editor was never opened.
async function exportDeviceLayers(device) {
  const scope = deviceKey(device);
  let layers = [];
  try { layers = JSON.parse(localStorage.getItem(`${LAYERS_KEY}::${scope}`)) || []; } catch {}
  const doc = {
    kind: "keyfigurator-layers",
    version: 1,
    device: { product_id: device.product_id, hardware: device.hardware },
    exportedAt: new Date().toISOString(),
    layers,
  };
  await saveJsonFile(`${(device.product_name || "device").replace(/\s+/g, "-")}-layers.json`, doc);
}

// Appends rather than replaces, and re-ids on the way in so importing a file
// exported from this same device cannot collide with what is already here.
async function importDeviceLayers(device, file) {
  const scope = deviceKey(device);
  let text;
  try { text = await file.text(); } catch { return; }
  let incoming;
  try {
    const doc = JSON.parse(text);
    incoming = Array.isArray(doc) ? doc : (doc.layers || []);
  } catch {
    await confirmModal({
      title: "Could not read that file",
      body: "It is not valid JSON, so there is nothing to import.",
      confirmLabel: "OK",
    });
    return;
  }
  if (!incoming.length) return;

  let existing = [];
  try { existing = JSON.parse(localStorage.getItem(`${LAYERS_KEY}::${scope}`)) || []; } catch {}
  const stamped = incoming.map((l, i) => ({ ...l, id: `${Date.now()}-${i}` }));
  localStorage.setItem(`${LAYERS_KEY}::${scope}`, JSON.stringify([...existing, ...stamped]));
  if (activeDevice && deviceKey(activeDevice) === scope) renderLayerBar();
  renderDeviceList();
}

async function exportLayer(layer) {
  await saveJsonFile(
    `${layer.name.replace(/\s+/g, "-").toLowerCase()}-config.json`,
    { ...layer, exportedAt: new Date().toISOString() });
}

function importLayer(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target.result);
      if (!data.keymap || !data.leds) throw new Error("Invalid layer file");
      const id = Date.now().toString();
      const layers = getSavedLayers();
      layers.push({
        id,
        name: data.name || "Imported",
        keymap: sanitizeKeymap(data.keymap),
        leds:   data.leds,
        icons:      data.icons || Array(21).fill(""),
        iconImages: data.iconImages || Array(21).fill(null),
      });
      localStorage.setItem(layersKeyScoped(), JSON.stringify(layers));
      renderLayerBar();
    } catch (err) {
      alert("Could not import: " + err.message);
    }
  };
  reader.readAsText(file);
}

function reorderLayers(srcId, dstId) {
  const layers = getSavedLayers();
  const srcIdx = layers.findIndex(l => l.id === srcId);
  const dstIdx = layers.findIndex(l => l.id === dstId);
  if (srcIdx === -1 || dstIdx === -1 || srcIdx === dstIdx) return;
  const [moved] = layers.splice(srcIdx, 1);
  layers.splice(dstIdx, 0, moved);
  localStorage.setItem(layersKeyScoped(), JSON.stringify(layers));
}

async function switchToLayer(id, { silent = false } = {}) {
  const layer = getSavedLayers().find(l => l.id === id);
  if (!layer) return;
  // Paint first, talk to the board after. The bar is what visibly lagged.
  const switched = applyScreenLocally({ type: "layer", layerId: id });
  flashBoard();
  renderLayerBar();
  if (switched) pushActiveScreenToBoard();
  if (!silent) {
    // The bar's name field is always editable, so "selected for rename" is the
    // whole interaction — no row to open.
    const nameInp = document.getElementById("layer-name");
    if (nameInp && !nameInp.disabled) { nameInp.select(); nameInp.focus(); }
  }
}

// A new layer starts from the SAME default state in every respect: no
// keycodes, white keys, white underglow, solid animation, no icons or macros.
// `keyIconImages` was missing here once, so a new blank layer silently inherited
// the previous layer's icons — the one array that was not being cleared.
function switchToBlankLayer() {
  saveCurrentLayerState();
  keymap         = { layers: Array.from({ length: 4 }, () => ({ keys: Array(21).fill("KC_NO") })) };
  keyLedColors   = Array.from({ length: 21 }, () => "#ffffff");
  keyIconImages  = Array(21).fill(null);
  keyIconBits    = Array(21).fill(null);
  keyMacros      = Array(21).fill(null);
  applyAnimState(mkKeyAnim());
  applyUnderglowSnapshot(null);
  activeProfileId = null;
  keySelectionOrder = [];
  selectedKeys.clear();
  closeKeyLedPill();
  renderBoard();
  flashBoard();
}

function openKeyLedPill()  {
  closeScreenLedPill(); // shares the slot under the board
  document.getElementById("key-pills").classList.add("visible");
}
function closeKeyLedPill() {
  document.getElementById("key-pills").classList.remove("visible");
  // One drawer to reset since the two pills merged.
  document.getElementById("kc-advanced").classList.remove("open");
  document.getElementById("kc-adv-btn").classList.remove("open");
  document.getElementById("kc-adv-arrow").textContent = "▸";
}
function openOledPill()    { document.getElementById("oled-pill").classList.add("visible"); renderOledPill(); }
function closeOledPill() {
  document.getElementById("oled-pill").classList.remove("visible");
  if (pendingEventAssign !== null) { pendingEventAssign = null; renderBoard(); }
}

// The profile behind whatever screen is showing. Mirrors the live-vs-stored
// rule in buildScreenLeds(): the screen being edited has not been captured to
// storage yet, so reading its stored copy would hand back a stale one.
function currentScreenProfile() {
  const scr = getOledScreens()[oledScreenIdx];
  if (!scr) return captureProfile();
  if (scr.type === "layer") {
    if (scr.layerId === activeProfileId) return captureProfile();
    const stored = getSavedLayers().find(l => l.id === scr.layerId);
    return stored ? structuredClone(stored) : captureProfile();
  }
  // A custom screen carries a profile only once something has been copied into
  // it; before that it simply shows whatever layer is active.
  return scr.profile ? structuredClone(scr.profile) : captureProfile();
}

// What "Copy + New Screen" carries: the LED/key profile, the source screen's
// event-key bindings, and the source's type.
function currentScreenCopy() {
  const scr = getOledScreens()[oledScreenIdx];
  const sk  = currentOledScreenKey();
  return {
    profile: currentScreenProfile(),
    events:  sk ? structuredClone(oledEventKeys[sk] || {}) : {},
    type:    scr?.type ?? null,
  };
}

// Which event bindings survive a copy onto a screen of type `toType`.
//
// Present Keys is offered by every screen type, so it always travels — that is
// the binding people actually rebuild by hand each time. The rest are specific
// to the screen that owns them: carrying `timerStartStop` onto a pomodoro
// screen would occupy a key with an event that screen never fires. So they come
// along only when copying to the same type.
function eventsForCopy(copyFrom, toType) {
  const src = copyFrom?.events || {};
  if (copyFrom?.type && copyFrom.type === toType) return structuredClone(src);
  return src.presentKeys ? { presentKeys: structuredClone(src.presentKeys) } : {};
}

// `copyFrom` seeds every screen created in this session of the picker. Custom
// screens gain a `profile` field, which buildScreenLeds() already knows how to
// push (slot 4+); layers are duplicated outright. The screen TITLE is never
// copied — it comes from the type that was picked, which is the whole point of
// "Copy + New Screen" over a plain duplicate.
function openScreenPicker(copyFrom = null) {
  if (document.getElementById("oled-screen-picker")) return;
  const existing = new Set(oledCustomScreens.map(s => s.type));

  const TYPES = [
    // A layer IS a screen in this model — the OLED list is layers followed by
    // custom screens — so adding one belongs here rather than behind a separate
    // "+" button. Always offered: unlike the custom types there is no limit of
    // one, and it is not filtered by `existing` below.
    {
      type: "layer", label: "Layer", desc: "A new keymap + LED profile",
      preview: `<div style="color:#ffb454;font-family:monospace;text-align:center">
        <div style="font-size:7px;font-weight:bold;letter-spacing:.08em">LAYER 02</div>
        <div style="font-size:6px;opacity:.35;margin-top:3px">blank keymap</div>
        <div style="font-size:6px;opacity:.25">white LEDs</div></div>`,
    },
    {
      type: "timer", label: "Timer", desc: "Stopwatch",
      preview: `<div style="color:#ffb454;font-family:monospace;text-align:center">
        <div style="font-size:6px;opacity:.4;letter-spacing:.1em">TIMER</div>
        <div style="font-size:14px;font-weight:bold">00:00</div>
        <div style="font-size:6px;opacity:.25">↓ start</div></div>`,
    },
    {
      type: "countdown", label: "Countdown", desc: "Counts down to zero",
      preview: `<div style="color:#ffb454;font-family:monospace;text-align:center">
        <div style="font-size:6px;opacity:.4;letter-spacing:.1em">COUNTDOWN</div>
        <div style="font-size:13px;font-weight:bold">01:00</div>
        <div style="font-size:6px;opacity:.25">←→ field · ↑↓ set</div></div>`,
    },
    {
      type: "datetime", label: "Date & Time", desc: "Live clock + date",
      preview: `<div style="color:#ffb454;font-family:monospace;text-align:center">
        <div style="font-size:13px;font-weight:bold">12:00</div>
        <div style="font-size:7px;opacity:.5">SUN JUN 29</div></div>`,
    },
    {
      type: "pomodoro", label: "Pomodoro", desc: "25/5 work-break cycles",
      preview: `<div style="color:#ffb454;font-family:monospace;text-align:center">
        <div style="font-size:6px;opacity:.4;letter-spacing:.1em">POMODORO</div>
        <div style="font-size:13px;font-weight:bold">25:00</div>
        <div style="font-size:6px;opacity:.5">DONE 0</div>
        <div style="font-size:6px;opacity:.25">↓ start</div></div>`,
    },
    // Its own screen type rather than an image bolted onto a Custom screen, so
    // the board's one-image limit is visible in the UI: the picker already
    // hides any non-"custom" type that already exists, which gives us
    // "only one GIF screen" for free instead of a surprise at upload time.
    {
      type: "gif", label: "GIF / Image", desc: "Animated image — one per board",
      preview: `<div style="color:#ffb454;font-family:monospace;text-align:center">
        <div style="font-size:6px;opacity:.4;letter-spacing:.1em">GIF</div>
        <div style="font-size:16px">🖼</div>
        <div style="font-size:6px;opacity:.25">plays on the board</div></div>`,
    },
    {
      type: "custom", label: "Custom", desc: "Title + body text",
      preview: `<div style="color:#ffb454;font-family:monospace;text-align:center;padding:2px;width:100%">
        <div style="font-size:8px;font-weight:bold;border-bottom:1px solid rgba(255,180,84,.25);padding-bottom:2px;margin-bottom:3px">TITLE</div>
        <div style="font-size:6px;opacity:.5">body text here</div></div>`,
    },
  ];

  const available = TYPES.filter(t => t.type === "custom" || !existing.has(t.type));
  if (!available.length) return;

  const overlay = document.createElement("div");
  overlay.id = "oled-screen-picker";
  overlay.className = "oled-picker-overlay";

  const selected = new Set();

  overlay.innerHTML = `
    <div class="oled-picker-modal">
      <div class="oled-picker-heading">Add Screen</div>
      <div class="oled-picker-grid">
        ${available.map(t => `
          <button class="oled-picker-card" data-type="${t.type}">
            <div class="oled-picker-thumb">${t.preview}</div>
            <div class="oled-picker-label">${t.label}</div>
            <div class="oled-picker-desc">${t.desc}</div>
          </button>`).join("")}
      </div>
      <div class="oled-picker-actions">
        <button class="oled-picker-cancel">Cancel</button>
        <button class="oled-picker-add" disabled>Add</button>
      </div>
    </div>`;

  const addBtn = overlay.querySelector(".oled-picker-add");

  const close = () => closeScreenPicker();
  overlay.querySelector(".oled-picker-cancel").addEventListener("click", close);
  overlay.addEventListener("click", e => { if (e.target === overlay) close(); });
  const onKey = e => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  overlay._removeKey = () => document.removeEventListener("keydown", onKey);

  overlay.querySelectorAll(".oled-picker-card").forEach(btn => {
    btn.addEventListener("click", () => {
      const type = btn.dataset.type;
      if (selected.has(type)) {
        selected.delete(type);
        btn.classList.remove("selected");
      } else {
        selected.add(type);
        btn.classList.add("selected");
      }
      addBtn.disabled = selected.size === 0;
      addBtn.textContent = selected.size > 1 ? `Add (${selected.size})` : "Add";
    });
  });

  addBtn.addEventListener("click", () => {
    let i = 0;
    let newLayerId = null;
    for (const type of selected) {
      // A layer is not a custom screen — it is a whole profile, and its screen
      // is derived from the saved-layer list rather than stored alongside the
      // others. Creating it has to go through the same path the old "+" used.
      if (type === "layer") {
        const name = `Layer ${String(getSavedLayers().length + 1).padStart(2, "0")}`;
        // Copying starts from the source profile instead of a blank one; the
        // new layer is otherwise created down the same path.
        if (copyFrom) applyProfile(copyFrom.profile); else switchToBlankLayer();
        saveCurrentAsLayer(name);
        newLayerId = activeProfileId;
        if (copyFrom) {
          const ev = eventsForCopy(copyFrom, "layer");
          if (Object.keys(ev).length) oledEventKeys[newLayerId] = ev;
        }
        continue;
      }
      const s = { id: `${Date.now()}-${i++}`, type };
      if (type === "custom") { s.title = ""; s.body = ""; s.imageDataUrl = null; }
      if (type === "gif")    { s.imageDataUrl = null; }
      // Keys are not copied onto a custom screen: the board has four hardware
      // layers and a custom screen is not one of them, so it types whatever the
      // active layer types. LEDs, animation and underglow ARE per-screen on the
      // board (SET_SCREEN_LEDS, slot 4+), so those carry over.
      if (copyFrom) {
        s.profile = structuredClone(copyFrom.profile);
        const ev = eventsForCopy(copyFrom, type);
        if (Object.keys(ev).length) oledEventKeys[s.id] = ev;
      }
      oledCustomScreens.push(s);
    }
    saveOledCustomScreens();
    if (copyFrom) saveOledEventKeys();
    close();
    // Land on what was just created. A new layer wins if both were added, since
    // that is the one with a name waiting to be typed.
    if (newLayerId) {
      goToLayerScreen(newLayerId);
      renderLayerBar();
      document.getElementById("layer-name")?.select();
    } else {
      oledScreenIdx = getOledScreens().length - 1;
      updateOledDisplay();
      renderLayerBar();
      renderOledPill();
    }
  });

  document.body.appendChild(overlay);
}

function closeScreenPicker() {
  const el = document.getElementById("oled-screen-picker");
  if (!el) return;
  if (el._removeKey) el._removeKey();
  el.remove();
}

// The screen's LED theme. Opened from the layer bar rather than from a key,
// because it applies to the whole screen — see the markup note in index.html.
function openScreenLedPill() {
  // Same slot under the board as the underglow and key pills, so only one of
  // the three can be up at a time.
  closeUnderglowPill();
  closeOledPill();
  closeKeyLedPill();
  document.getElementById("screen-led-pill").classList.add("visible");
}
function closeScreenLedPill() {
  document.getElementById("screen-led-pill")?.classList.remove("visible");
}
function toggleScreenLedPill() {
  const el = document.getElementById("screen-led-pill");
  if (el.classList.contains("visible")) closeScreenLedPill(); else openScreenLedPill();
}

function openUnderglowPill() {
  keySelectionOrder = [];
  selectedKeys.clear();
  closeKeyLedPill();
  closeOledPill();
  closeScreenLedPill();
  renderBoard();
  document.getElementById("underglow-pill").classList.add("visible");
  document.getElementById("board-ring").classList.add("ug-active");
}
function closeUnderglowPill() {
  document.getElementById("underglow-pill").classList.remove("visible");
  document.getElementById("board-ring").classList.remove("ug-active");
  document.getElementById("ug-advanced").classList.remove("open");
  document.getElementById("ug-adv-btn").classList.remove("open");
  document.getElementById("ug-adv-arrow").textContent = "▸";
}

function renderKcPalette(filter = "") {
  const list = document.getElementById("kc-palette-list");
  if (!list) return;
  const q = filter.trim().toUpperCase();

  list.innerHTML = "";
  const cats = q
    ? [{ label: "Results", keys: KC_ALL_FLAT.filter(k => k.toUpperCase().includes(q)) }]
    : KC_CATEGORIES;

  for (const cat of cats) {
    if (!cat.keys.length) continue;
    const section = document.createElement("div");
    section.className = "kc-cat";
    const lbl = document.createElement("div");
    lbl.className = "kc-cat-lbl";
    lbl.textContent = cat.label;
    section.appendChild(lbl);
    const chips = document.createElement("div");
    chips.className = "kc-chips";
    for (const kc of cat.keys) {
      const chip = document.createElement("button");
      chip.className = "kc-chip";
      chip.textContent = kc.replace(/^KC_/, "");
      chip.title = kc;
      chip.addEventListener("click", () => {
        const inp = document.getElementById("kl-kc");
        if (inp) inp.value = kc;
        for (const idx of selectedKeys) keymap.layers[0].keys[idx] = kc;
        renderBoard();
        scheduleLiveSync("keymap");
      });
      chips.appendChild(chip);
    }
    section.appendChild(chips);
    list.appendChild(section);
  }

  if (q && !cats[0].keys.length) {
    list.innerHTML = `<div class="kc-no-results">No keycodes matching "${filter}"</div>`;
  }
}


// ── Board protocol payloads (must match src-tauri model.rs / kf_protocol.rs) ──

// Normalize a raw keycode string so the app never sends garbage over the wire
// and the stored form always matches what the palette produces. Bare names get
// their KC_ prefix ("a" -> "KC_A", "enter" -> "KC_ENTER"); parametric and hex
// forms pass through; anything unrecognised is upper-cased and left for the
// backend codec, which heals what it can and warns on the rest.
function normalizeKeycode(raw) {
  const up = (raw || "").trim().toUpperCase();
  if (!up) return "KC_NO";
  if (KC_ALL_FLAT.includes(up)) return up;
  if (/^(MO|TO|TG|DF|OSL|HOST)\(\d+\)$/.test(up)) return up;
  if (/^0X[0-9A-F]{1,4}$/.test(up)) return up;
  if (KC_ALL_FLAT.includes("KC_" + up)) return "KC_" + up;
  if (/^[A-Z0-9]$/.test(up)) return "KC_" + up;
  return up;
}

// Heal a keymap coming from anywhere we don't control the spelling of: saved
// layers in localStorage (some predate normalizeKeycode) and imported layer
// files. Without this a stored bare "A" reaches the backend as an unknown
// keycode, becomes KC_NO, and silently blanks that key on the board — while the
// UI still renders "A", because it strips the KC_ prefix for display either way.
function sanitizeKeymap(map) {
  if (!map || !Array.isArray(map.layers)) {
    return { layers: Array.from({ length: 4 }, () => ({ keys: Array(21).fill("KC_NO") })) };
  }
  return {
    layers: map.layers.map(l => ({
      keys: Array.from({ length: 21 }, (_, i) => normalizeKeycode(l?.keys?.[i] ?? "KC_NO")),
    })),
  };
}

function hexToRgbArr(hex) {
  const { r, g, b } = hexToRgb(hex || "#000000");
  return [r, g, b];
}

// LedState: 21 per-key colors (0..20, encoder at 20) + 4 underglow corners
// (TL, TR, BR, BL = firmware LED slots 21..24) + global brightness.
// AnimState: the ONE global animation. `color` is the tint the board's effect
// runs in — the firmware converts it to QMK's HSV. For "solid" the board shows
// the per-key colours instead and this tint is unused.
function buildAnimState() {
  const tint = klPalette.length > 0
    ? klPalette[0]
    : (document.getElementById("kl-color")?.value || "#ffb454");
  return { name: klAnimation, speed: klRate, color: hexToRgbArr(tint) };
}

// The underglow's own animation. No colour: the firmware reuses the corner
// colours SET_LEDS already pushed, and rainbow generates its own spectrum —
// exactly like the app preview does.
// Cycle Colors, per target. The board ignores it while the target's animation
// is Solid or Rainbow, matching `noCycle` in ANIMATIONS — so the app does not
// need to filter here, and the two cannot disagree about when it is live.
function buildKeyPalette() {
  return { colors: klPalette.map(hexToRgbArr), rate: klRate };
}
function buildUgPalette() {
  return { colors: ugPalette.map(hexToRgbArr), rate: ugRate };
}

function buildUgAnimState() {
  return { name: ugAnimation, speed: ugRate, intensity: ugIntensity };
}

// The app lays the corners out reading-order (TL, TR, BL, BR) because that is
// how they sit on screen; the firmware's LED slots 21..24 run around the board
// (TL, TR, BR, BL). Indices 2 and 3 therefore swap on the way out — without
// this the bottom two corners are crossed on the hardware.
const UG_APP_TO_WIRE = [0, 1, 3, 2];

function buildLedState() {
  return {
    keys: keyLedColors.map(hexToRgbArr),
    underglow: UG_APP_TO_WIRE.map(i => hexToRgbArr(cornerColors[i])),
    brightness: ledBrightness,
  };
}

// Would committing right now leave the board rendering nothing at all?
//
// "Save to Board" persists overlay_on alongside the colours, and the firmware
// re-asserts it on every boot (kf_hid_init -> kf_apply_anim). With the overlay
// on, kf_led_overlay_render() returns false, so QMK's animations never run. A
// committed all-black frame therefore boots dark AND stays dark, which is
// indistinguishable from a dead LED chain, and no control on the board can
// clear it. Only this app can.
//
// A solid save with actual colour in it is the intended feature and must not
// nag, so the test is specifically "renders nothing", not "is solid".
//
// The arithmetic mirrors kf_led_overlay_render() byte for byte, integer divide
// included: what shows up is decided by those bytes, not by whether the hex
// looked dark in the picker. `1` at brightness `1` floors to `0`.
function committedFrameIsDark() {
  // A real animation is its own way out: the board keeps running it on boot.
  if (!isAppDrivingLeds()) return false;
  const { keys, underglow, brightness } = buildLedState();
  return [...keys, ...underglow].every(([r, g, b]) =>
    Math.floor((r * brightness) / 255) === 0 &&
    Math.floor((g * brightness) / 255) === 0 &&
    Math.floor((b * brightness) / 255) === 0);
}

// Resolves true if the user still wants to commit. Deliberately a real dialog
// rather than window.confirm: a native modal blocks the webview, and this needs
// to explain a firmware behaviour rather than just ask a yes/no.
// One confirm dialog for anything that needs a deliberate yes. Deliberately a
// real dialog rather than window.confirm: a native modal blocks the webview,
// and these need room to explain a consequence rather than just ask.
//
// Backdrop and Escape both resolve false — the safe answer is the easy one.
function confirmModal({ title, body, confirmLabel = "Confirm" }) {
  const el = document.getElementById("confirm-dialog");
  if (!el) return Promise.resolve(true);

  document.getElementById("confirm-title").textContent = title;
  document.getElementById("confirm-body").textContent  = body;
  const ok = document.getElementById("confirm-ok");
  ok.textContent = confirmLabel;

  return new Promise((resolve) => {
    const cancel = document.getElementById("confirm-cancel");

    const close = (answer) => {
      el.classList.remove("open");
      cancel.removeEventListener("click", onCancel);
      ok.removeEventListener("click", onOk);
      el.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onKey);
      resolve(answer);
    };
    const onCancel   = () => close(false);
    const onOk       = () => close(true);
    const onBackdrop = (e) => { if (e.target === el) close(false); };
    const onKey      = (e) => { if (e.key === "Escape") close(false); };

    cancel.addEventListener("click", onCancel);
    ok.addEventListener("click", onOk);
    el.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onKey);
    el.classList.add("open");
  });
}

// Same dialog as confirmModal, with a text field. Adding this rather than
// leaving createLibrary() on window.prompt(): a native prompt is unstyled,
// looks nothing like the macro editor beside it, and blocks the webview.
// Resolves null on cancel, the trimmed string otherwise.
function promptModal({ title, label, value = "", placeholder = "", confirmLabel = "Create" }) {
  const el = document.getElementById("confirm-dialog");
  if (!el) return Promise.resolve(null);

  document.getElementById("confirm-title").textContent = title;
  const body = document.getElementById("confirm-body");
  body.innerHTML = `
    <label class="prompt-field">
      <span class="pill-label">${escapeHtml(label)}</span>
      <input type="text" id="confirm-input" class="macro-name-inp"
             placeholder="${escapeHtml(placeholder)}" maxlength="40" />
    </label>`;
  const inp = document.getElementById("confirm-input");
  inp.value = value;

  const ok = document.getElementById("confirm-ok");
  ok.textContent = confirmLabel;

  return new Promise((resolve) => {
    const cancel = document.getElementById("confirm-cancel");
    const finish = (answer) => {
      el.classList.remove("open");
      body.innerHTML = "";
      cancel.removeEventListener("click", onCancel);
      ok.removeEventListener("click", onOk);
      el.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onKey);
      resolve(answer);
    };
    const onCancel   = () => finish(null);
    const onOk       = () => finish(inp.value.trim() || null);
    const onBackdrop = (e) => { if (e.target === el) finish(null); };
    const onKey      = (e) => {
      if (e.key === "Escape") finish(null);
      if (e.key === "Enter" && document.activeElement === inp) onOk();
    };
    cancel.addEventListener("click", onCancel);
    ok.addEventListener("click", onOk);
    el.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onKey);
    el.classList.add("open");
    inp.focus();
  });
}

// Is there a pomodoro screen with a value still at 0?
//
// Scoped to boards that actually have one: warning about pomodoro durations on
// a config with no pomodoro screen is noise, and noise on a confirm dialog is
// how a user learns to click through the one that matters.
function pomoSaveWarning() {
  const hasPomodoro = getOledScreens().some(s => s.type === "pomodoro");
  if (!hasPomodoro) return null;
  const unset = pomoUnsetFields();
  return unset.length ? unset : null;
}

// Resolves true if the user still wants to commit with an unset duration.
// Unlike the dark-save guard this one is recoverable on the board, so it is
// phrased as a mismatch to fix rather than a trap to avoid.
function confirmPomoUnset(unset) {
  const eff  = effectivePomo();
  const many = unset.length > 1;
  return confirmModal({
    title: many ? "Save with unset pomodoro values?" : "Save with an unset pomodoro value?",
    body: `${unset.join(" and ")} ${many ? "are" : "is"} still 0, and a pomodoro `
        + `cannot run on that. The board clamps anything below 1 up to it, so it `
        + `would run ${eff.workMin}/${eff.pauseMin} x ${eff.cycles} while this app `
        + `shows 0. Nothing breaks, but the two stop agreeing until `
        + `${many ? "those fields are" : "that field is"} set.`,
    confirmLabel: "Save anyway",
  });
}

function confirmDarkSave() {
  const tail = ledBrightness === 0
    ? "Raise the brightness, or pick an animation, or save anyway."
    : "Set a colour, or pick an animation, or save anyway.";
  const lead = ledBrightness === 0
    ? "Brightness is 0, so every LED comes out black."
    : "All 25 LEDs come out black at this brightness.";
  return confirmModal({
    title: "Save a board that lights up nothing?",
    body: `${lead} Saving also stores "show the app's colours" as the power-on `
        + "state, so the board will boot with its lights off and its own "
        + "animations disabled. That looks the same as a hardware fault, and no "
        + `button on the board can undo it. Only this app can. ${tail}`,
    confirmLabel: "Save anyway",
  });
}

// OledConfig: per-layer titles + ordered custom screens + one countdown.
// RAM-only on the board, so we re-push it on every apply/reconnect.
function buildOledConfig() {
  return {
    layers: getSavedLayers().slice(0, 4).map(l => ({
      name: l.name || "",
      show_title: l.showTitle !== false,
    })),
    screens: oledCustomScreens.slice(0, 6).map(s => ({
      // "gif" is the app's name for it; the wire/firmware call it an IMAGE
      // screen (KF_SCREEN_IMAGE).
      kind: s.type === "gif" ? "image" : (s.type || "custom"),
      title: s.title || "",
      body: s.body || "",
    })),
    countdown: [oledCdH, oledCdM, oledCdS],
    // Bitmap over the board's nav-index space: bits 0..3 the four hardware
    // layer screens, 4..9 the custom screens in order. Uses the same
    // first-4-saved-layers convention as `layers` above — the open question of
    // how an arbitrary-count profile list maps onto four fixed hardware layers
    // is unchanged here, this just does not invent a second answer to it.
    // Which key triggers which screen action, in the board's nav-index space.
    // Without these the board can only reach a screen's actions through the
    // encoder push, which hardware revision 1.0.0 does not have soldered.
    event_keys: buildEventKeys(),
    // Present Keys on the board shows these; it cannot derive either the macro
    // title or a short keycode name for itself.
    key_info: buildKeyInfo(),
    // The icon masks. Separate from key_info because they are pixels, not text:
    // the board renders a 32x32 1-bit mask in its own amber, and picks it over
    // both text fields when a key has one.
    key_icons: buildKeyIcons(),
    // Title size. The board has one font drawn at integer scales, so this is
    // the whole of what the font picker can mean there.
    font_scale: getOledFont().scale,
    // Each screen's own colours and animations, so navigating on the board
    // changes the LEDs the way navigating in the app does — with the app closed
    // too, which is the whole point of the board holding them.
    screen_leds: buildScreenLeds(),
    sleep_mask: buildSleepMask(),
    sleep_timeout_s: OLED_SLEEP_TIMEOUT_S,
    // Effective, not raw. A 0 here means "not set yet" in the editor, and the
    // firmware would clamp it to its minimum anyway — sending the clamped value
    // means the app knows what the board is running rather than inferring it.
    pomodoro: (() => {
      const p = effectivePomo();
      return { work_min: p.workMin, pause_min: p.pauseMin, cycles: p.cycles };
    })(),
  };
}

// Per device, not global: two boards can reasonably want different phase
// lengths, and the durations live on the board they were set for.
function savePomodoro() {
  scheduleAutoSave();
}

// oled_push reports whether the board took the pomodoro durations. Record it so
// the settings pill can be honest about firmware that predates the command
// rather than showing four inputs that quietly do nothing.
function notePomodoroSupport(accepted) {
  if (typeof accepted !== "boolean" || oledPomoSupported === accepted) return;
  oledPomoSupported = accepted;
  // Only on a real change, and never over a focused field — rebuilding the pill
  // destroys the focused element, the same rule updateOledDisplay() follows.
  const pill = document.getElementById("oled-pill");
  if (pill?.classList.contains("visible") && !pill.querySelector("input:focus, textarea:focus")) {
    renderOledPillContent();
  }
}

// The board has ONE image buffer, which is why the picker allows only one GIF
// screen. Returns it if it exists and actually has an image loaded.
function firstImageScreen() {
  return oledCustomScreens.find(s => s.type === "gif" && !!s.imageDataUrl) ?? null;
}

// An upload is tens of KB over 26-byte reports — seconds, not milliseconds. Live
// sync fires on every edit, so re-sending an unchanged image would make the
// editor unusable. Remember what the board already holds and skip if it matches.
let _uploadedImageKey = null;

async function pushImageToBoard(force = false) {
  const screen = firstImageScreen();
  if (!screen) { _uploadedImageKey = null; return; }
  const key = screen.imageDataUrl;
  if (!force && key === _uploadedImageKey) return;
  try {
    const r = await invoke("oled_push_image", { dataUrl: key });
    _uploadedImageKey = key;
    console.log(`oled image uploaded: ${r.width}x${r.height}, ${r.frames} frame(s), ${r.bytes} bytes`);
  } catch (e) {
    // Leave the key unset so the next sync retries rather than assuming success.
    _uploadedImageKey = null;
    logError(e, "oledImageUpload");
  }
}

async function syncBoardTime() {
  const d = new Date();
  try {
    await invoke("sync_time", {
      year2000: d.getFullYear() - 2000,
      month: d.getMonth() + 1,
      day: d.getDate(),
      hour: d.getHours(),
      min: d.getMinutes(),
      sec: d.getSeconds(),
      weekday: d.getDay(),
    });
  } catch {}
}

// Push everything the editor currently holds into board RAM. This is the only
// thing that makes the board reflect the editor — eeprom_commit does NOT pull
// state from the host, it just persists the LED block the board already has.
// No activeProfileId guard: "Save to Board" has to work on an unsaved layer too.
async function pushStateToBoard() {
  if (!keymap) return;
  await invoke("set_keymap", { map: keymap });
  await invoke("set_leds", { leds: buildLedState() });
  // Order matters: colours first, then the animation. set_anim decides whether
  // the board shows those colours (solid) or runs its own effect, so sending it
  // last means the mode always wins.
  await invoke("set_anim", { anim: buildAnimState() });
  await invoke("set_ug_anim", { ug: buildUgAnimState() });
  await invoke("set_palette", { target: 0, palette: buildKeyPalette() });
  await invoke("set_palette", { target: 1, palette: buildUgPalette() });
  // NOT wrapped in a catch. It used to be, so that a board too old for the
  // pomodoro command could not break the rest of the push — but that case is
  // handled inside push_oled now, and the catch went on to hide a payload the
  // backend was rejecting outright. Save reported success while nothing OLED
  // ever reached the board. Let it throw; the Save button says "Failed".
  notePomodoroSupport(await invoke("oled_push", { config: buildOledConfig() }));
  // Force: a full push follows a reconnect or a Save, where the board's buffer
  // may have been lost, so the cache cannot be trusted.
  await pushImageToBoard(true);
  await syncBoardTime();
}

async function applyActiveProfileToBoard() {
  if (!activeProfileId) return;
  await pushStateToBoard();
}

// ── Live sync ───────────────────────────────────────────────────────────────
// Edits reach board RAM as they happen. Two things this deliberately is NOT:
// it does not persist (that is still "Save to Board" → eeprom_commit), and it
// does not push everything on every edit — a colour drag fires continuously and
// re-sending the keymap + OLED bundle each tick would swamp the link. Mutation
// points name the part they dirtied and a trailing debounce coalesces bursts.
const LIVE_SYNC_MS = 120;
const _liveSyncPending = new Set();
let _liveSyncTimer = null;
let _liveSyncInFlight = false;

function scheduleLiveSync(...parts) {
  for (const p of parts) _liveSyncPending.add(p);
  clearTimeout(_liveSyncTimer);
  _liveSyncTimer = setTimeout(runLiveSync, LIVE_SYNC_MS);
  // Anything worth pushing to the board is worth saving locally. Hooking here
  // means a new mutation point cannot be added that syncs but silently fails
  // to persist — the failure mode this whole mechanism exists to prevent.
  scheduleAutoSave();
}

async function runLiveSync() {
  // Each push is several round trips over one serialized link. Overlapping runs
  // would interleave frames, so a run that lands mid-flight just re-arms —
  // _liveSyncPending is left intact for the next pass to pick up.
  if (_liveSyncInFlight) { scheduleLiveSync(); return; }
  if (!_liveSyncPending.size) return;
  const parts = new Set(_liveSyncPending);
  _liveSyncPending.clear();
  _liveSyncInFlight = true;
  try {
    if (parts.has("keymap") && keymap) await invoke("set_keymap", { map: keymap });
    if (parts.has("leds")) await invoke("set_leds", { leds: buildLedState() });
    // After leds, for the same reason pushStateToBoard sends it last.
    if (parts.has("anim")) {
      await invoke("set_anim", { anim: buildAnimState() });
      await invoke("set_ug_anim", { ug: buildUgAnimState() });
      await invoke("set_palette", { target: 0, palette: buildKeyPalette() });
      await invoke("set_palette", { target: 1, palette: buildUgPalette() });
    }
    if (parts.has("oled")) {
      notePomodoroSupport(await invoke("oled_push", { config: buildOledConfig() }));
      // Not forced: skips the multi-second transfer unless the image changed.
      await pushImageToBoard(false);
    }
  } catch (e) {
    logError(e, "liveSync");
    // Put the work back so the next edit retries it rather than dropping it.
    for (const p of parts) _liveSyncPending.add(p);
  } finally {
    _liveSyncInFlight = false;
  }
}

// Tracks whether a PHYSICAL board is attached (the mock standing in reads as
// false), so attaching one mid-session triggers exactly one profile re-apply.
let _wasConnected = false;

// ── Home page — device list ─────────────────────────────────────────────────
// The app opens here rather than straight into the editor, so the editor always
// runs against a known product + hardware revision instead of assuming one.
// Devices persist so the list is not empty when nothing is plugged in.
const DEVICES_KEY = "kf-devices";

function getSavedDevices() {
  try { return JSON.parse(localStorage.getItem(DEVICES_KEY)) || []; }
  catch { return []; }
}

function saveDevices(list) {
  localStorage.setItem(DEVICES_KEY, JSON.stringify(list));
}

// Identity is the key, not the transport: the same board on a different port is
// still the same device.
function deviceKey(d) {
  return `${d.product_id}:${d.hardware}`;
}

// ── Whole-app device backup ─────────────────────────────────────────────────
// A device's state lives in TWO localStorage keys, and it is the second one
// that makes this worth having:
//
//   kf-saved-layers::<scope>  the named profiles
//   kf-devcfg::<scope>        the live working state — keymap, LED colours,
//                             icons, macros, brightness, AND every OLED screen,
//                             event key, countdown and pomodoro setting
//
// The per-device card export writes only the layers, so anything held in devcfg
// — the OLED screens above all — does not survive an export/reset/import round
// trip. Both keys are carried here, which is what makes this a real backup.
//
// Macro libraries are deliberately NOT included: they are global and shared
// between devices (see the reset dialog, which keeps them for the same reason)
// and they already have their own export on the Macro Libraries header.
const DEVICES_FORMAT   = "keyfigurator.devices";
const DEVICES_FORMAT_V = 1;

function exportAllDevices() {
  const devices = getSavedDevices();
  return {
    format: DEVICES_FORMAT,
    version: DEVICES_FORMAT_V,
    exportedAt: new Date().toISOString(),
    devices: devices.map((d) => {
      const scope = deviceKey(d);
      const read = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
      return {
        device: d,
        config: read(`${DEVCFG_PREFIX}::${scope}`),
        layers: read(`${LAYERS_KEY}::${scope}`) || [],
      };
    }),
  };
}

async function exportDevicesToFile() {
  const doc = exportAllDevices();
  if (doc.devices.length === 0) {
    await confirmModal({
      title: "Nothing to export",
      body: "There are no devices yet, so there is nothing to put in a backup file.",
      confirmLabel: "OK",
    });
    return;
  }
  try {
    await saveJsonFile("orbit-devices.json", doc);
  } catch (e) {
    logError(`device export failed: ${e?.message || e}`, "export");
    await confirmModal({
      title: "Export failed",
      body: String(e?.message || e),
      confirmLabel: "OK",
    });
  }
}

// Restore, not merge. The point of this file is "put it back the way it was",
// and the round trip it exists for is export -> reset device -> import: merging
// would leave the reset's blank seed layer sitting alongside the real ones.
// Devices in the file that are not installed get added; devices that are
// installed but absent from the file are left alone rather than deleted.
async function importDevicesFromFile(file) {
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch (e) {
    await confirmModal({ title: "Import failed", body: `Not valid JSON: ${e.message}`, confirmLabel: "OK" });
    return;
  }
  if (parsed?.format !== DEVICES_FORMAT) {
    await confirmModal({
      title: "Import failed",
      body: "That is not an Orbit device backup. Macro library files go through Import on the Macro Libraries header instead.",
      confirmLabel: "OK",
    });
    return;
  }
  if (parsed.version > DEVICES_FORMAT_V) {
    await confirmModal({
      title: "Import failed",
      body: `That file is version ${parsed.version} and this app understands ${DEVICES_FORMAT_V}.`,
      confirmLabel: "OK",
    });
    return;
  }

  const incoming = Array.isArray(parsed.devices) ? parsed.devices : [];
  const names = incoming.map((e) => e.device?.product_name || deviceKey(e.device || {})).join(", ");
  const ok = await confirmModal({
    title: "Import devices",
    body: `This replaces all settings for ${incoming.length} device(s) — ${names} — with what is in the file, `
        + "including their layers and OLED screens. Devices not in the file are left alone. "
        + "Macro libraries are not touched. This cannot be undone.",
    confirmLabel: "Import",
  });
  if (!ok) return;

  // A pending auto-save holds the state we are about to overwrite and would
  // write it back a moment later — same trap as resetDevice().
  clearTimeout(_autoSaveTimer);

  const devices = getSavedDevices();
  for (const entry of incoming) {
    if (!entry?.device) continue;
    const scope = deviceKey(entry.device);
    if (entry.config) localStorage.setItem(`${DEVCFG_PREFIX}::${scope}`, JSON.stringify(entry.config));
    localStorage.setItem(`${LAYERS_KEY}::${scope}`, JSON.stringify(entry.layers || []));
    if (!devices.some((d) => deviceKey(d) === scope)) devices.push(entry.device);
  }
  saveDevices(devices);

  // In-memory state is global and now stale for whichever device is open.
  // Reloading is the honest way to re-enter from storage: it is the same path
  // the app takes on a cold start, so there is no second restore path to keep
  // in step with this one.
  location.reload();
}

const TRANSPORT_ICON = { usb: "🔌", bluetooth: "🔵" };

function renderDeviceList() {
  const list  = document.getElementById("home-list");
  const empty = document.getElementById("home-empty");
  if (!list || !empty) return;

  const devices = getSavedDevices();
  empty.style.display = devices.length ? "none" : "";
  list.innerHTML = "";

  for (const d of devices) {
    const card = document.createElement("div");
    card.className = "device-card" + (d.known_product ? "" : " unknown");
    card.title = d.connected ? "Open editor" : "Not connected — open editor anyway";

    const caps = d.capabilities;
    // Only surface a limitation when we actually know of one. Silence here
    // means "no known limits", not "we did not check".
    const warn = caps && caps.encoder_push === false
      ? `<div class="device-warn">No encoder push on this revision — assign a key to each screen's OLED events</div>`
      : (d.known_product ? "" : `<div class="device-warn">Unknown product/revision — capabilities assumed</div>`);

    card.innerHTML = `
      <div class="device-dot${d.connected ? " ok" : ""}"></div>
      <div>
        <div class="device-name">${d.product_name || "Unknown device"}</div>
        <div class="device-meta">
          <span>Product <b>0x${(d.product_id ?? 0).toString(16).padStart(2, "0").toUpperCase()}</b></span>
          <span>Hardware <b>${d.hardware}</b></span>
          <span>Firmware <b>${d.firmware}</b></span>
        </div>
        ${warn}
      </div>
      <div class="device-actions">
        <div class="device-transport">
          <span>${TRANSPORT_ICON[d.transport] ?? "🔌"}</span>
          <span>${(d.transport || "usb").toUpperCase()}</span>
        </div>
        <button class="device-io" data-io="export" title="Export this device's layers to a file">↓</button>
        <label class="device-io" title="Import layers into this device">↑
          <input type="file" class="device-import" accept=".json,application/json" style="display:none" />
        </label>
        <button class="device-reset" title="Reset this device to defaults">Reset</button>
        <button class="device-del" title="Remove this device from the list">✕</button>
      </div>`;
    card.addEventListener("click", () => enterEditor(d));
    // stopPropagation, or these buttons would also open the editor.
    card.querySelector(".device-del").addEventListener("click", (e) => {
      e.stopPropagation();
      removeDevice(d);
    });
    card.querySelector(".device-reset").addEventListener("click", (e) => {
      e.stopPropagation();
      resetDevice(d);
    });
    // Layer export/import are per-device: they move whole sets of layers
    // between boards, which is a device-level action rather than one that
    // belongs beside a single layer's name.
    card.querySelector('[data-io="export"]').addEventListener("click", (e) => {
      e.stopPropagation();
      exportDeviceLayers(d);
    });
    const imp = card.querySelector(".device-import");
    imp.addEventListener("click", (e) => e.stopPropagation());
    imp.addEventListener("change", (e) => {
      const f = e.target.files?.[0];
      if (f) importDeviceLayers(d, f);
      e.target.value = "";
    });
    list.appendChild(card);
  }
}

// Wipe one device's configuration back to factory defaults.
//
// Everything a device owns lives under two keys scoped to its identity, so a
// reset is exactly "delete those two". Macro libraries are deliberately NOT
// touched: they are global documents meant to be shared between devices and
// exported, so losing them to a per-device reset would be a nasty surprise.
//
// When the board being reset is the one attached, the defaults are pushed to it
// and committed as well, so "reset" means the same thing on both sides rather
// than leaving the hardware carrying the old configuration. The dialog says
// which of the two is about to happen — those are materially different actions
// and the wording must not promise the one that is not going to run.
async function resetDevice(device) {
  const name = device.product_name || "this device";
  // Only the attached board can be reset, and only if it IS this device —
  // pushing defaults into some other board would be worse than doing nothing.
  const alsoBoard = device.connected === true;
  const ok = await confirmModal({
    title: `Reset ${name}?`,
    body: "This deletes every setting saved for this device: its keymap, per-key "
        + "colours and icons, LED animation, underglow, OLED screens and their "
        + "events, and all of its saved layers. It cannot be undone. Macro "
        + "libraries are shared between devices and are kept. "
        + (alsoBoard
            ? "The board is connected, so factory defaults are also written to it "
              + "and committed — the same as pushing a blank configuration with "
              + "Save to Board. Its keys will type nothing until you map them."
            : "The board is not connected, so only this app is cleared. Whatever "
              + "was last written to the board with Save to Board stays on it."),
    confirmLabel: "Reset device",
  });
  if (!ok) return;

  const scope = deviceKey(device);
  // Any pending auto-save is holding the state we are about to delete, and
  // would write it straight back a moment later.
  clearTimeout(_autoSaveTimer);
  localStorage.removeItem(`${DEVCFG_PREFIX}::${scope}`);

  // The LED theme also lives in these, which are NOT device-scoped — they
  // predate the per-device config and are read straight into the theme
  // variables at startup. Removing only the scoped config left them behind, so
  // a reset device came back up on the last theme that had been set on ANY
  // device: reported as "reset, but it was still Breathe with the cycle
  // colours remembered".
  //
  // They are cleared rather than rewritten with defaults, because absent is
  // what the load path already treats as "use the defaults".
  for (const k of [KL_ADVANCED_KEY, KL_PER_KEY, KL_PALETTE_KEY,
                   UG_ADVANCED_KEY, UG_PALETTE_KEY, UG_CORNERS_KEY, UG_SELECTED_KEY]) {
    localStorage.removeItem(k);
  }

  // One default layer rather than none. Zero layers is a state nothing else in
  // the app produces: the OLED has no layer screen to show, and the Saved
  // Layers list reads "No saved layers yet" as if the device were brand new but
  // somehow already in use. A single blank layer is what a fresh device looks
  // like, which is what "reset" should mean.
  const seed = defaultLayerRecord("Layer 01");
  localStorage.setItem(`${LAYERS_KEY}::${scope}`, JSON.stringify([seed]));

  // In-memory state is global, so it has to be cleared whether or not this
  // device is the active one — otherwise it survives the reset and gets shown
  // (and re-saved) the next time this device is opened.
  resetInMemoryState();
  activeProfileId = seed.id;

  if (activeDevice && deviceKey(activeDevice) === scope) {
    // The theme pills too, not just the board and the layer bar. resetInMemoryState()
    // puts the variables back to solid/no-palette/default-rate, but the chips,
    // sliders and swatches are separate DOM that only these calls redraw —
    // without them the reset was invisible in the one panel the user was
    // looking at. applyAnimState() now syncs the key side itself; the
    // underglow's brightness control is the piece neither covers.
    syncKeyLedThemeUI();
    syncUnderglowUI();
    renderOverlayBtn();
    renderBrightness();
    const brightInp = document.getElementById("led-brightness");
    if (brightInp) brightInp.value = String(ledBrightness);
    renderLayerBar();
    renderOledPill();
    renderBoard();
  }
  renderDeviceList();

  if (alsoBoard) await pushDefaultsToBoard();
}

// Write factory defaults to the attached board and commit them.
//
// Built explicitly rather than routed through pushStateToBoard(), which sends
// whatever is in memory: Reset can be pressed from Home for a device whose
// editor was never opened, so in-memory state might belong to a different
// device entirely. These literals ARE the defaults — keep them in step with
// switchToBlankLayer() and the DEFAULT_* constants above.
async function pushDefaultsToBoard() {
  const white = [255, 255, 255];
  try {
    await invoke("set_keymap", {
      map: { layers: Array.from({ length: 4 }, () => ({ keys: Array(21).fill("KC_NO") })) },
    });
    await invoke("set_leds", {
      leds: { keys: Array(21).fill(white), underglow: Array(4).fill(white), brightness: 255 },
    });
    // After the colours, for the same reason pushStateToBoard sends it last:
    // the animation decides whether those colours are what the board shows.
    await invoke("set_anim", { anim: { name: "solid", speed: 128, color: [255, 180, 84] } });
    await invoke("set_ug_anim", { ug: { name: "solid", speed: 128, intensity: 180 } });
    await invoke("set_palette", { target: 0, palette: { colors: [], rate: 128 } });
    await invoke("set_palette", { target: 1, palette: { colors: [], rate: 128 } });
    await invoke("oled_push", {
      config: {
        layers: [], screens: [], countdown: [0, 0, 0],
        sleep_mask: 0, sleep_timeout_s: OLED_SLEEP_TIMEOUT_S,
        pomodoro: {
          work_min:  POMO_DEFAULTS.workMin,
          pause_min: POMO_DEFAULTS.pauseMin,
          cycles:    POMO_DEFAULTS.cycles,
        },
      },
    });
    // Commit, or the board reverts to the old configuration on the next power
    // cycle and the reset would look like it half worked. Safe against the
    // dark-commit trap by construction: white at full brightness renders.
    await invoke("eeprom_commit");
  } catch (e) {
    logError(e, "resetDevice:pushDefaults");
  }
}

// Reconcile the SAVED device list against the live link.
//
// The home cards render `d.connected` out of localStorage, which only an
// explicit scan used to write. So unplugging while sitting on Home left every
// dot green until the user pressed New Device again, and a restart with nothing
// attached restored last session's dots as if the board were still there.
//
// Called on connect/disconnect transitions and once at startup.
async function syncDeviceListConnection(connected) {
  let devices = getSavedDevices();
  if (!devices.length) return;

  if (connected) {
    // board_status says *something* is attached but carries no identity, so ask
    // which device it is rather than guessing it is the one already marked.
    let found = [];
    try { found = await invoke("scan_devices"); }
    catch (e) { logError(e, "identifyOnConnect"); return; }
    // A board that has never been seen belongs in the list, not ignored.
    for (const f of found) devices = upsertDevice(f);
    const live = new Set(found.map(deviceKey));
    for (const d of devices) d.connected = live.has(deviceKey(d));
  } else {
    // The transport serves one board at a time, so losing the link means
    // nothing is attached — not merely that one particular device left.
    for (const d of devices) d.connected = false;
  }

  saveDevices(devices);
  // No point rebuilding a list the editor is covering; leaveEditor() re-renders
  // from this same saved state on the way back.
  if (!document.body.classList.contains("editor")) renderDeviceList();
}

// Merge a scan result into the saved list, keyed on identity so re-scanning
// refreshes a device rather than duplicating it.
function upsertDevice(found) {
  const devices = getSavedDevices();
  const i = devices.findIndex(d => deviceKey(d) === deviceKey(found));
  if (i >= 0) devices[i] = { ...devices[i], ...found };
  else devices.push(found);
  saveDevices(devices);
  return devices;
}

// Forgets a device from the list. Purely local bookkeeping — nothing is written
// to the board, and re-scanning finds it again if it is still plugged in.
function removeDevice(device) {
  saveDevices(getSavedDevices().filter(d => deviceKey(d) !== deviceKey(device)));
  if (activeDevice && deviceKey(activeDevice) === deviceKey(device)) {
    activeDevice = null;
    leaveEditor();
  }
  renderDeviceList();
}

function showScanNotice(kind, html) {
  const el = document.getElementById("scan-notice");
  if (!el) return;
  el.className = `scan-notice show ${kind}`;
  el.innerHTML = html;
  el.querySelector(".scan-notice-close")?.addEventListener("click", () => {
    el.className = "scan-notice";
  });
  el.querySelector("#scan-use-demo")?.addEventListener("click", () => {
    el.className = "scan-notice";
    enterEditor(DEMO_DEVICE);
  });
}

function clearScanNotice() {
  const el = document.getElementById("scan-notice");
  if (el) el.className = "scan-notice";
}

// The no-hardware path. MockHid means the editor works with no board attached,
// and that stays available — but it is labelled as a demo rather than smuggled
// into the list as if it were a real device.
const DEMO_DEVICE = {
  product_id: 0x01,
  product_name: "Lunar x MacroPad (demo)",
  hardware: "1.0.0",
  firmware: "0.2.0",
  transport: "usb",
  connected: false,
  known_product: true,
  capabilities: { encoder_push: false, key_count: 21, led_count: 25, layer_count: 4, has_oled: true, has_underglow: true },
};

async function scanForDevices() {
  const btn = document.getElementById("home-add");
  clearScanNotice();
  if (btn) { btn.textContent = "Scanning…"; btn.disabled = true; }
  try {
    const found = await invoke("scan_devices");
    for (const d of found) upsertDevice(d);
    renderDeviceList();

    if (found.length) {
      const names = found.map(d => `${d.product_name} (hw ${d.hardware}, fw ${d.firmware})`).join(", ");
      showScanNotice("ok", `
        <div class="scan-notice-title">Found ${found.length} device${found.length === 1 ? "" : "s"}</div>
        <div>${escapeHtml(names)}</div>
        <div class="scan-notice-actions"><button class="scan-notice-close">Dismiss</button></div>`);
    } else {
      showScanNotice("warn", `
        <div class="scan-notice-title">No connected devices found</div>
        <div>Nothing is answering on the KeyFigurator interface. Worth checking:</div>
        <ul>
          <li>The board is plugged in, and the cable carries data (not charge-only)</li>
          <li>It is not sitting in the <code>RPI-RP2</code> bootloader — that is a
              flashing drive, not a keyboard, and will not answer a scan</li>
          <li>Firmware is flashed and running</li>
        </ul>
        <div class="scan-notice-actions">
          <button class="home-add ghost" id="scan-use-demo">Open editor without a device</button>
          <button class="scan-notice-close">Dismiss</button>
        </div>`);
    }
  } catch (e) {
    logError(e, "scanDevices");
    showScanNotice("warn", `
      <div class="scan-notice-title">Scan failed</div>
      <div>${escapeHtml(String(e))}</div>
      <div class="scan-notice-actions"><button class="scan-notice-close">Dismiss</button></div>`);
  } finally {
    if (btn) { btn.textContent = "+ New Device"; btn.disabled = false; }
  }
}

// The device whose editor is open. Its capabilities gate what the editor offers.
let activeDevice = null;

// Everything the editor holds, back to factory defaults. One definition, so
// "a device with no saved config" and "a device that was just reset" cannot
// drift apart — they are the same state by construction.
function resetInMemoryState() {
  keymap        = { layers: Array.from({ length: 4 }, () => ({ keys: Array(21).fill("KC_NO") })) };
  keyLedColors  = Array.from({ length: 21 }, () => "#ffffff");
  keyIconImages = Array(21).fill(null);
  keyIconBits   = Array(21).fill(null);
  keyMacros     = Array(21).fill(null);
  applyAnimState(mkKeyAnim());
  applyUnderglowSnapshot(null);
  ledBrightness = 255;
  selectedCorners = new Set([0, 1, 2, 3]);

  oledCustomScreens = [];
  oledEventKeys     = {};
  oledSleepScreens  = {};
  oledPomo          = { ...POMO_DEFAULTS };
  oledScreenIdx     = 0;
  oledSubMode       = "nav";
  resetCountdown();

  keySelectionOrder = [];
  selectedKeys.clear();
}

function enterEditor(device) {
  activeDevice = device;
  // Load BEFORE anything renders, so the editor never shows another device's
  // configuration for a frame.
  //
  // A device with nothing saved has to be reset to defaults explicitly:
  // loadDeviceState() returns false without touching anything, and these are
  // module globals, so without this the editor opened on whatever the LAST
  // device left behind. That is what made a reset look like it did nothing —
  // the storage really was cleared, then the stale in-memory copy was shown
  // over the top of it and auto-saved straight back.
  if (!loadDeviceState()) resetInMemoryState();
  document.body.classList.add("editor");
  applyDeviceCapabilities(device);
  renderActiveDeviceInfo();
  syncUnderglowUI();
  // The whole theme pill, not just the chips. applyAnimState() syncs it too,
  // but loadDeviceState() only calls that when the stored blob HAS an `anim`
  // field — an older one without it would have left the previous device's
  // swatches and rate on screen.
  syncKeyLedThemeUI();
  renderOverlayBtn();
  renderBrightness();
  const brightInp = document.getElementById("led-brightness");
  if (brightInp) brightInp.value = String(ledBrightness);
  // Before the first render, so the keycaps never show a stale slot. This also
  // heals a config saved while keystroke macros were still bound as MACRO(n) —
  // the board runs an empty body for those, which is the whole bug they moved
  // to HOST(n) to escape. Only syncs when something actually changed.
  if (applyMacroKeycodes()) scheduleLiveSync("keymap");
  renderLayerBar();
  renderOledPill();
  renderBoard();
  // Bindings live in backend memory, not on disk — re-push this device's on
  // entry so a restart does not leave HOST(n) keys pointing at nothing.
  syncHostBindings();
}

function leaveEditor() {
  // Flush immediately rather than leaving the debounce in flight — the config
  // is about to stop being the active one.
  clearTimeout(_autoSaveTimer);
  persistDeviceState();
  activeDevice = null;
  document.body.classList.remove("editor");
  renderDeviceList();
}

// Reflect hardware limits in the editor. Kept in one place so a new limitation
// has an obvious home rather than being scattered through the UI.
// The active device's identity under the Home link — same facts as its home
// page card, so there is never a question which board is being edited.
function renderActiveDeviceInfo() {
  const el = document.getElementById("app-device");
  if (!el) return;
  const d = activeDevice;
  if (!d) { el.innerHTML = ""; return; }

  const caps = d.capabilities;
  const warn = caps && caps.encoder_push === false
    ? `<div class="app-device-warn">No encoder push — use each screen's OLED events</div>`
    : (d.known_product ? "" : `<div class="app-device-warn">Unknown revision — capabilities assumed</div>`);

  el.innerHTML = `
    <div class="app-device-name">
      <span class="device-dot${d.connected ? " ok" : ""}"></span>
      ${escapeHtml(d.product_name || "Unknown device")}
    </div>
    <div class="app-device-meta">
      <span>0x${(d.product_id ?? 0).toString(16).padStart(2, "0").toUpperCase()}</span>
      <span class="sep">·</span>
      <span>HW <b>${escapeHtml(d.hardware ?? "?")}</b></span>
      <span class="sep">·</span>
      <span>FW <b>${escapeHtml(d.firmware ?? "?")}</b></span>
      <span class="sep">·</span>
      <span>${TRANSPORT_ICON[d.transport] ?? "🔌"} ${(d.transport || "usb").toUpperCase()}</span>
    </div>
    ${warn}`;
}

function applyDeviceCapabilities(device) {
  const caps = device?.capabilities;
  const noPush = caps && caps.encoder_push === false;
  // Kept as a body class so the UI can still say "this revision has no push";
  // nothing stands in for it any more, the per-screen events cover it.
  document.body.classList.toggle("no-encoder-push", !!noPush);
}

// ── Per-key macro binding ───────────────────────────────────────────────────
// A key can carry one macro from the Home page libraries. Binding does two
// things: it reserves one of the board's 16 HOST(n) slots for that macro, and
// it sets the key's keycode to HOST(slot).
//
// Slots are DERIVED from the current bindings rather than stored, so they can
// never drift out of step with what is actually assigned. The cost is that
// slot numbers can shift when a binding is removed — which is fine, because the
// keycodes are recomputed in the same pass.
//
// BOTH macro kinds ride HOST(n). Keystroke macros used to be bound as MACRO(n)
// and driven by the board's own macro engine, but the CONTENT never reached the
// board — writing it needs VIA's dynamic_keymap_macro buffer commands
// (0x0B/0x0C), which are plain VIA ids with no 0xC0 magic and have no route
// through this channel. So a MACRO(n) key was bound to an empty body and did
// nothing. Inverted instead: the board sends an index for either kind, and the
// app performs it — keystrokes through SendInput (`keyplay.rs`), scripts
// through a shell (`runner.rs`). One slot space, because one keycode.
const MACRO_SLOT_COUNT = 16;

let keyMacros = Array(21).fill(null); // macro id per key index, null = none

// Every macro across every library, flattened with its library name.
function allMacrosFlat() {
  return getLibraries().flatMap(lib =>
    (lib.macros || []).map(m => ({ ...m, libName: lib.name, libId: lib.id })));
}

function findMacroById(id) {
  return allMacrosFlat().find(m => m.id === id) ?? null;
}

// macro id -> slot, in first-assigned order across the key indices.
//
// ONE slot space for both kinds, because both are bound as HOST(n) and the
// board reports the same index for either. They used to be counted separately
// (keystrokes as MACRO(n), scripts as HOST(n)); with keystrokes moved onto
// HOST(n) two counters would hand out the same index twice, and the second
// binding would silently replace the first in the runner's table.
//
// The kind is still carried, because the backend needs to know which field of
// the binding to fill and the UI still describes them differently.
function macroSlotMap() {
  const map = new Map();
  let next = 0;
  for (const id of keyMacros) {
    if (!id || map.has(id)) continue;
    const m = findMacroById(id);
    if (!m) continue;
    if (next >= MACRO_SLOT_COUNT) continue;
    map.set(id, { kind: macroKind(m), slot: next++ });
  }
  return map;
}

// Push the derived slots back into the keymap. Called after any binding change
// so the keycodes and the slot allocation are always consistent.
//
// Returns whether it changed anything, which is how a config saved before
// keystroke macros moved to HOST(n) gets healed: those keys are still stored as
// MACRO(n), and a MACRO(n) pushed to the board runs an empty body.
function applyMacroKeycodes() {
  if (!keymap) return false;
  const slots = macroSlotMap();
  let changed = false;
  keyMacros.forEach((id, idx) => {
    if (!id) return;
    const s = slots.get(id);
    if (!s) return; // over the slot limit, or the macro is gone; left unbound
    const kc = `HOST(${s.slot})`;
    if (keymap.layers[0].keys[idx] === kc) return;
    keymap.layers[0].keys[idx] = kc;
    changed = true;
  });
  return changed;
}

// Hand every macro bound to a key to the backend, so a physical HOST(n) press
// has something to perform. The board only ever sends an index — this is what
// gives that index meaning.
//
// A binding carries exactly one of `keys` or `script`; the other is left empty
// so a macro changed from one kind to the other cannot leave the old content
// behind as something still executable.
async function syncHostBindings() {
  const slots = macroSlotMap();
  const bindings = [];
  for (const [id, s] of slots) {
    const m = findMacroById(id);
    if (!m) continue;
    const shell = s.kind === "shell";
    bindings.push({
      index: s.slot,
      label: m.name || "Macro",
      command: [],
      script: shell ? (m.script || "") : "",
      keys:   shell ? [] : (m.actions || []),
      cwd:    shell ? (m.cwd || null) : null,
    });
  }
  try { await invoke("set_bindings", { bindings }); }
  catch (e) { logError(e, "syncHostBindings"); }
}

function bindMacroToKey(idx, macroId) {
  const previous = keyMacros[idx];
  keyMacros[idx] = macroId || null;

  if (!macroId) {
    // Clearing the macro should clear the keycode it owned, but must not stomp
    // a keycode the user set by hand afterwards. MACRO(n) is still matched:
    // keystroke macros were bound that way before they moved onto HOST(n), and
    // a key bound back then must still unbind cleanly.
    const kc = keymap?.layers[0]?.keys[idx] ?? "";
    if (previous && /^(MACRO|HOST)\(\d+\)$/.test(kc)) keymap.layers[0].keys[idx] = "KC_NO";
  }
  applyMacroKeycodes();
  renderKeyMacroRow();
  renderBoard();
  scheduleLiveSync("keymap");
  // The backend must learn about a newly bound shell macro before the key can
  // ever be pressed.
  syncHostBindings();
}

// The picker, grouped by library so the same macro name in two libraries is
// still distinguishable.
function renderKeyMacroRow() {
  const row = document.getElementById("kc-macro-row");
  const sel = document.getElementById("kc-macro-select");
  const slotEl = document.getElementById("kc-macro-slot");
  const note = document.getElementById("kc-macro-note");
  if (!row || !sel) return;

  const single = selectedKeys.size === 1;
  row.style.display = single ? "" : "none";
  if (note) note.style.display = single ? "" : "none";
  if (!single) return;

  const [idx] = selectedKeys;
  const libs = getLibraries();
  const bound = keyMacros[idx];

  sel.innerHTML = `<option value="">— none —</option>` + libs.map(lib => {
    const opts = (lib.macros || []).map(m =>
      `<option value="${escapeHtml(m.id)}"${m.id === bound ? " selected" : ""}>${escapeHtml(m.name)}</option>`
    ).join("");
    return opts ? `<optgroup label="${escapeHtml(lib.name)}">${opts}</optgroup>` : "";
  }).join("");

  const slots = macroSlotMap();
  const s = bound ? slots.get(bound) : undefined;
  const boundMacro = bound ? findMacroById(bound) : null;
  if (slotEl) slotEl.textContent = s ? `HOST(${s.slot})` : "";

  if (note) {
    note.className = "kc-macro-note";
    if (!libs.some(l => (l.macros || []).length)) {
      note.textContent = "No macros yet — create one in the Macro Library on the Home page.";
    } else if (bound && !s) {
      note.className = "kc-macro-note warn";
      note.textContent = `Over the ${MACRO_SLOT_COUNT}-slot limit, so this one is not assigned.`;
    } else if (bound && macroKind(boundMacro) === "shell") {
      note.textContent = "Runs its script on this computer when pressed. The board sends the binding index and Orbit executes it.";
    } else if (bound) {
      note.textContent = "Orbit types the keys when pressed. The board sends the binding index, so this needs Orbit running.";
    } else {
      note.textContent = "";
    }
  }
}

// ── Per-device config persistence ───────────────────────────────────────────
// Everything the editor holds is saved automatically, scoped to the device it
// belongs to. Three problems this exists to fix:
//
//   1. `keyLedColors`, `keyIconImages` and `keymap` only ever
//      reached storage through saveCurrentLayerState(), which returns early
//      when there is no active saved layer — the default state. Key colours,
//      icons and keycode edits were simply lost on restart.
//   2. Even with a layer active, that function ran only on layer switch, so
//      edits made and then closed were lost since the last switch.
//   3. Every setting was stored under one global key, so two different boards
//      would overwrite each other's configuration.
//
// One blob per device, written debounced from every mutation point. Macro
// libraries and the device list stay global on purpose — a library is meant to
// be shared across devices.
const DEVCFG_PREFIX = "kf-devcfg";

function deviceScopeId() {
  return activeDevice ? deviceKey(activeDevice) : "default";
}
function deviceCfgKey() {
  return `${DEVCFG_PREFIX}::${deviceScopeId()}`;
}
// Saved layers are a device's profiles, so they are scoped too.
function layersKeyScoped() {
  return `${LAYERS_KEY}::${deviceScopeId()}`;
}

function snapshotDeviceState() {
  return {
    v: 1,
    keymap,
    keyLedColors:   [...keyLedColors],
    keyIconImages:  [...keyIconImages],
    keyIconBits:    [...keyIconBits],
    keyMacros:      [...keyMacros],
    anim:           currentAnimState(),
    underglow:      currentUnderglowSnapshot(),
    selectedCorners: [...selectedCorners],
    encoderMode,
    ledBrightness,
    activeProfileId,
    oled: {
      customScreens: oledCustomScreens,
      countdown:     { h: oledCdH, m: oledCdM, s: oledCdS },
      pomodoro:      { ...oledPomo },
      sleepScreens:  { ...oledSleepScreens },
      eventKeys:     oledEventKeys,
    },
  };
}

function persistDeviceState() {
  try {
    localStorage.setItem(deviceCfgKey(), JSON.stringify(snapshotDeviceState()));
  } catch (e) {
    // Quota is the realistic failure here — icon images are data URLs.
    logError(e, "persistDeviceState");
  }
}

// Debounced: colour drags and typing fire continuously, and this serialises the
// whole config including image data URLs.
let _autoSaveTimer = null;
function scheduleAutoSave() {
  clearTimeout(_autoSaveTimer);
  _autoSaveTimer = setTimeout(persistDeviceState, 400);
}

function loadDeviceState() {
  let s;
  try { s = JSON.parse(localStorage.getItem(deviceCfgKey())); } catch { s = null; }
  if (!s) return false;

  if (s.keymap)          keymap          = sanitizeKeymap(s.keymap);
  if (s.keyLedColors)    keyLedColors    = [...s.keyLedColors];
  if (s.keyIconImages)   keyIconImages   = [...s.keyIconImages];
  if (s.keyIconBits)     keyIconBits     = [...s.keyIconBits];
  if (Array.isArray(s.keyMacros)) {
    keyMacros = [...s.keyMacros];
    // A macro deleted from its library since the last save leaves a dangling
    // binding — drop it rather than showing a key bound to nothing.
    const live = new Set(allMacrosFlat().map(m => m.id));
    keyMacros = keyMacros.map(id => (id && live.has(id) ? id : null));
  }
  if (s.anim)            applyAnimState(s.anim);
  if (s.underglow)       applyUnderglowSnapshot(s.underglow);
  if (Array.isArray(s.selectedCorners)) selectedCorners = new Set(s.selectedCorners);
  if (typeof s.encoderMode === "string") encoderMode = s.encoderMode;
  if (Number.isFinite(s.ledBrightness))  ledBrightness = s.ledBrightness;
  // s.specialEnterIdx is ignored: older blobs still carry it, but the role no
  // longer exists. Nothing to migrate — the per-screen events replaced it.
  if (s.activeProfileId !== undefined)   activeProfileId = s.activeProfileId;

  if (s.oled) {
    if (Array.isArray(s.oled.customScreens)) oledCustomScreens = s.oled.customScreens;
    // s.oled.countdown is deliberately NOT restored — the countdown always
    // opens at 00:00:00. Older blobs still carry the field; it is ignored
    // rather than migrated, since there is nothing to preserve.
    resetCountdown();
    // Bounded on the way in, not just on input, so a hand-edited or older blob
    // cannot carry a nonsense duration. The LOWER bound is 0, not 1: a value
    // left unset is restored as it was left rather than quietly healing to 1
    // behind the user's back. Nothing downstream reads these raw — the preview
    // and the push both go through effectivePomo().
    if (s.oled.pomodoro) {
      const p = s.oled.pomodoro;
      const min = (v, d, lo, hi) =>
        Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d;
      // Older blobs carry shortBreakMin/longBreakMin/longEvery. pauseMin falls
      // back to the old short break, which is what it replaced; the long break
      // has no successor and is simply dropped.
      oledPomo = {
        workMin:  min(p.workMin,  POMO_DEFAULTS.workMin,  0, POMO_MAX_MINUTES),
        pauseMin: min(p.pauseMin ?? p.shortBreakMin, POMO_DEFAULTS.pauseMin, 0, POMO_MAX_MINUTES),
        cycles:   min(p.cycles   ?? p.longEvery,     POMO_DEFAULTS.cycles,   0, POMO_MAX_CYCLES),
      };
    } else {
      oledPomo = { ...POMO_DEFAULTS };
    }
    oledSleepScreens = (s.oled.sleepScreens && typeof s.oled.sleepScreens === "object")
      ? { ...s.oled.sleepScreens } : {};
    if (s.oled.eventKeys)                oledEventKeys  = s.oled.eventKeys;
  }
  return true;
}

// ── Macro library ───────────────────────────────────────────────────────────
// Macros are stored in a documented, versioned shape so a library is portable:
// export from one machine, import on another, or publish it.
//
//   { "format": "keyfigurator.macro-library", "version": 1,
//     "macros": [ { "id", "name", "description", "actions": [...] } ] }
//
// An action is one of:
//   { "type": "tap"  , "key": "KC_A"   }   press and release
//   { "type": "down" , "key": "KC_LCTL"}   hold
//   { "type": "up"   , "key": "KC_LCTL"}   release
//   { "type": "delay", "ms": 100       }   pause
//   { "type": "text" , "value": "hi"   }   type a literal string
//
// This is the shape `model.rs::MacroAction` deserializes, so a macro goes from
// the editor to playback without a translation layer. It also still maps onto
// QMK's own primitives (SS_TAP / SS_DOWN / SS_UP / delay / string), which keeps
// the format translatable if macro content ever does reach the board.
// Libraries are browsed like folders: tiles at the top level, macros inside.
// The LIBRARY is the shareable unit — it is what export writes and import reads.
const MACROS_KEY     = "kf-macro-libraries";
const MACROS_KEY_V1  = "kf-macro-library"; // pre-library flat list, migrated below
const MACRO_FORMAT   = "keyfigurator.macro-library";
const MACRO_FORMAT_V = 1;

let macroSelection  = new Set();
let editingMacroId  = null;
// null = showing library tiles; an id = browsing inside that library.
let activeLibraryId = null;

function getLibraries() {
  let libs;
  try { libs = JSON.parse(localStorage.getItem(MACROS_KEY)); } catch { libs = null; }
  if (Array.isArray(libs)) return libs;

  // Migrate the flat pre-library list into a single "My Macros" library rather
  // than dropping macros someone already wrote.
  try {
    const flat = JSON.parse(localStorage.getItem(MACROS_KEY_V1));
    if (Array.isArray(flat) && flat.length) {
      const migrated = [{ id: `lib${Date.now()}`, name: "My Macros", description: "", macros: flat }];
      localStorage.setItem(MACROS_KEY, JSON.stringify(migrated));
      localStorage.removeItem(MACROS_KEY_V1);
      return migrated;
    }
  } catch { /* nothing to migrate */ }
  return [];
}

function saveLibraries(list) {
  localStorage.setItem(MACROS_KEY, JSON.stringify(list));
}

function activeLibrary() {
  return getLibraries().find(l => l.id === activeLibraryId) ?? null;
}

// Macros of the library currently open, or [] at the tile level.
function getMacros() {
  return activeLibrary()?.macros ?? [];
}

// Write macros back into the open library.
function saveMacros(macros) {
  const libs = getLibraries();
  const i = libs.findIndex(l => l.id === activeLibraryId);
  if (i < 0) return;
  libs[i] = { ...libs[i], macros };
  saveLibraries(libs);
}

// ── Action text <-> structured actions ──────────────────────────────────────
const DELAY_MAX_MS = 600000;

// The editor is line-based because a drag-and-drop action builder is a lot of
// UI for something that reads perfectly well as text. Storage stays structured
// either way, which is what makes the format shareable.
function parseActions(text) {
  const actions = [];
  const errors  = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const sp   = line.indexOf(" ");
    const verb = (sp === -1 ? line : line.slice(0, sp)).toUpperCase();
    const rest = sp === -1 ? "" : line.slice(sp + 1).trim();
    const ln   = i + 1;

    switch (verb) {
      case "TAP": case "DOWN": case "UP": {
        if (!rest) { errors.push(`line ${ln}: ${verb} needs a keycode`); return; }
        actions.push({ type: verb.toLowerCase(), key: normalizeKeycode(rest) });
        break;
      }
      case "DELAY": {
        const ms = parseInt(rest, 10);
        if (!Number.isFinite(ms) || ms < 0) { errors.push(`line ${ln}: DELAY needs milliseconds`); return; }
        // Bounded because the backend takes this as a u32: a value past that
        // fails to deserialize, and set_bindings is all-or-nothing, so one
        // mistyped delay would leave EVERY key bound to nothing. Playback
        // clamps to 10 s anyway, so nothing usable is being refused here.
        if (ms > DELAY_MAX_MS) { errors.push(`line ${ln}: DELAY is capped at ${DELAY_MAX_MS} ms`); return; }
        actions.push({ type: "delay", ms });
        break;
      }
      case "TEXT": {
        if (!rest) { errors.push(`line ${ln}: TEXT needs something to type`); return; }
        // Sliced from `line`, not `rest` — `rest` is trimmed, and trailing
        // spaces in text a macro types are meaningful.
        actions.push({ type: "text", value: line.slice(sp + 1) });
        break;
      }
      default:
        errors.push(`line ${ln}: unknown action "${verb}"`);
    }
  });
  return { actions, errors };
}

// ── Recorder control ────────────────────────────────────────────────────────
// The hook is armed only between these two calls. Stop is a mouse target
// deliberately: any keyboard shortcut for it would be captured by the very
// recording it is meant to end.
let macroRecording  = false;
let macroRecTimer   = null;
let macroRecBaseline = "";   // editor contents before recording started

// Live preview. Polled rather than pushed from the hook: the hook callback runs
// for every key on the system and has to stay cheap, so emitting a Tauri event
// from inside it would put IPC on the critical path of the whole desktop's
// typing. 150 ms is well under the threshold where the preview feels laggy.
const MACRO_REC_POLL_MS = 150;

// One fixed delay between steps. The "natural" and "none" modes are gone:
// natural recorded typing hesitation as part of the macro, which is almost never
// wanted, and none is just this with the box set to 0.
// Plain text input, so the value is whatever was typed. Non-numeric or empty
// falls back to 0 rather than NaN, which would otherwise reach `DELAY NaN` and
// fail parsing on the way back in.
function macroRecFixedMs() {
  const raw = document.getElementById("macro-rec-ms")?.value ?? "";
  const n = parseInt(String(raw).replace(/[^\d]/g, ""), 10);
  return Number.isFinite(n) ? Math.min(5000, Math.max(0, n)) : 0;
}

function setMacroRecState(text, isErr = false) {
  const el = document.getElementById("macro-rec-state");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("err", isErr);
}

// Baseline + what has been captured so far. Recording appends, so the text the
// macro already had has to survive every repaint.
function renderMacroRecPreview(events) {
  const ta = document.getElementById("macro-actions");
  if (!ta) return 0;
  const actions = recordingToActions(events, "fixed", macroRecFixedMs());
  const added   = actionsToText(actions);
  ta.value = macroRecBaseline
    ? (added ? `${macroRecBaseline}\n${added}` : macroRecBaseline)
    : added;
  ta.scrollTop = ta.scrollHeight; // keep the newest line in view
  return actions.length;
}

async function toggleMacroRecording() {
  const btn   = document.getElementById("macro-rec");
  const state = document.getElementById("macro-rec-state");
  const err   = document.getElementById("macro-err");
  const ta    = document.getElementById("macro-actions");

  if (!macroRecording) {
    try {
      await invoke("start_key_recording");
    } catch (e) {
      if (err) err.textContent = `Could not start recording: ${e?.message || e}`;
      return;
    }
    macroRecording = true;
    macroRecBaseline = (ta?.value ?? "").trim();
    macroRecDomEvents = [];
    macroRecDomStart  = performance.now();
    // Capture phase, on window: has to run before the editor's own handlers so
    // recording a key cannot also trigger whatever that key normally does here.
    window.addEventListener("keydown", macroRecDomHandler, true);
    window.addEventListener("keyup", macroRecDomHandler, true);
    setMacroRecLabel(true);
    if (err) err.textContent = "";
    // Read-only while recording: the preview rewrites this box several times a
    // second, so anything typed into it would be thrown away a moment later.
    if (ta) ta.readOnly = true;

    macroRecTimer = setInterval(async () => {
      // Errors are shown, not swallowed. A silent catch here hid a broken
      // preview once already: the box simply never updated and there was
      // nothing anywhere to say why.
      try {
        const hook = await invoke("peek_key_recording");
        const evs  = mergeRecordedEvents(hook, macroRecDomEvents);
        const n = renderMacroRecPreview(evs);
        // Raw tail, so a key that is arriving but not converting is visibly
        // different from one that never arrived. `162↓` is a vk the mapping
        // does not know; `KC_LCTL↓` is one it does.
        const tail = evs.slice(-6)
          .map(e => `${e.kc ? e.kc.replace(/^KC_/, "") : e.vk}${e.down ? "↓" : "↑"}`)
          .join(" ");
        setMacroRecState(`Recording · ${evs.length} keys · ${n} actions${tail ? ` · ${tail}` : ""}`);
      } catch (e) {
        setMacroRecState(`Preview failed: ${e?.message || e}`, true);
        logError(e, "peek_key_recording");
      }
    }, MACRO_REC_POLL_MS);
    return;
  }

  macroRecording = false;
  clearInterval(macroRecTimer);
  macroRecTimer = null;
  window.removeEventListener("keydown", macroRecDomHandler, true);
  window.removeEventListener("keyup", macroRecDomHandler, true);
  setMacroRecLabel(false);
  if (ta) ta.readOnly = false;

  let events = [];
  try {
    events = mergeRecordedEvents(await invoke("stop_key_recording"), macroRecDomEvents);
  } catch (e) {
    setMacroRecState(`Recording failed: ${e?.message || e}`, true);
    if (err) err.textContent = `Recording failed: ${e?.message || e}`;
    return;
  }

  // Rendered from the same baseline the live preview used, NOT appended to the
  // box's current contents — that already holds the preview, and appending to
  // it would write every action twice.
  const n = renderMacroRecPreview(events);
  const unmapped = events.filter(e => !e.kc && e.down).length;

  setMacroRecState(n
    ? `Captured ${n} action${n === 1 ? "" : "s"} — edit below`
      + (unmapped ? ` · ${unmapped} unmapped key(s) skipped` : "")
    : "Nothing captured");
  ta?.focus();
}

function setMacroRecLabel(recording) {
  const btn   = document.getElementById("macro-rec");
  const label = document.getElementById("macro-rec-label");
  if (label) label.textContent = recording ? "Stop" : "Record";
  if (btn) btn.classList.toggle("recording", recording);
}

// ── In-app capture ──────────────────────────────────────────────────────────
// The Win32 hook does not deliver keys that land in Orbit's own window, so
// anything pressed while the app has focus was silently missing from a
// recording — Ctrl+C typed at the editor produced nothing, while the same keys
// pressed in another app recorded fine.
//
// So the recorder listens on both: the hook for everything outside the app
// (Alt+Tab, the Windows key), and DOM events for everything inside it. The two
// streams are merged on a shared clock and deduplicated, so a machine where the
// hook DOES see in-app keys does not record them twice.

// event.code is the PHYSICAL key, so a recording maps to the same keycode
// regardless of the user's layout — which matters here, where the board speaks
// physical positions.
const DOM_CODE_TO_KC = {
  Backquote: "KC_GRV", Minus: "KC_MINS", Equal: "KC_EQL", BracketLeft: "KC_LBRC",
  BracketRight: "KC_RBRC", Backslash: "KC_BSLS", Semicolon: "KC_SCLN",
  Quote: "KC_QUOT", Comma: "KC_COMM", Period: "KC_DOT", Slash: "KC_SLSH",
  Space: "KC_SPC", Enter: "KC_ENT", Tab: "KC_TAB", Backspace: "KC_BSPC",
  Escape: "KC_ESC", CapsLock: "KC_CAPS", Delete: "KC_DEL", Insert: "KC_INS",
  Home: "KC_HOME", End: "KC_END", PageUp: "KC_PGUP", PageDown: "KC_PGDN",
  ArrowLeft: "KC_LEFT", ArrowRight: "KC_RGHT", ArrowUp: "KC_UP", ArrowDown: "KC_DOWN",
  ControlLeft: "KC_LCTL", ControlRight: "KC_RCTL",
  ShiftLeft: "KC_LSFT", ShiftRight: "KC_RSFT",
  AltLeft: "KC_LALT", AltRight: "KC_RALT",
  MetaLeft: "KC_LGUI", MetaRight: "KC_RGUI", ContextMenu: "KC_APP",
  NumLock: "KC_NUM", ScrollLock: "KC_SCRL", Pause: "KC_PAUS", PrintScreen: "KC_PSCR",
  NumpadEnter: "KC_KP_ENTER", NumpadAdd: "KC_PPLS", NumpadSubtract: "KC_PMNS",
  NumpadMultiply: "KC_PAST", NumpadDivide: "KC_PSLS", NumpadDecimal: "KC_PDOT",
};

function domCodeToKc(code) {
  if (!code) return null;
  if (/^Key[A-Z]$/.test(code))    return `KC_${code.slice(3)}`;
  if (/^Digit[0-9]$/.test(code))  return `KC_${code.slice(5)}`;
  if (/^F([1-9]|1[0-2])$/.test(code)) return `KC_${code}`;
  if (/^Numpad[0-9]$/.test(code)) return `KC_P${code.slice(6)}`;
  return DOM_CODE_TO_KC[code] ?? null;
}

let macroRecDomEvents = [];
let macroRecDomStart  = 0;

function macroRecDomHandler(e) {
  if (!macroRecording) return;
  // Keep the app inert while recording: without this, Ctrl+C copies, Tab moves
  // focus out of the editor, and Escape closes the modal mid-take.
  e.preventDefault();
  e.stopPropagation();
  if (e.repeat) return; // auto-repeat is not a new press
  const kc = domCodeToKc(e.code);
  if (!kc) return;
  macroRecDomEvents.push({
    kc,
    vk: 0,
    down: e.type === "keydown",
    t_ms: Math.max(0, Math.round(performance.now() - macroRecDomStart)),
  });
}

// Merge on the shared "ms since recording started" clock. Dedupe is deliberately
// conservative: identical keycode AND direction within DEDUPE_MS collapses to
// one. The two clocks start a few ms apart, so an exact match is not available.
const MACRO_REC_DEDUPE_MS = 120;

function mergeRecordedEvents(hookEvents, domEvents) {
  const all = [...(hookEvents || []), ...(domEvents || [])]
    .sort((a, b) => a.t_ms - b.t_ms);
  const out = [];
  for (const e of all) {
    const dup = out.some(p =>
      p.kc === e.kc && p.down === e.down && Math.abs(p.t_ms - e.t_ms) <= MACRO_REC_DEDUPE_MS);
    if (!dup) out.push(e);
  }
  return out;
}

// ── Recording → actions ─────────────────────────────────────────────────────
// The recorder hands back raw key transitions ({kc, vk, down, t_ms}); this turns
// them into the same action vocabulary the editor already speaks, so a recording
// is indistinguishable from something typed by hand and stays editable.

const REC_MODIFIERS = new Set([
  "KC_LCTL", "KC_RCTL", "KC_LSFT", "KC_RSFT",
  "KC_LALT", "KC_RALT", "KC_LGUI", "KC_RGUI",
]);

// Unshifted character for keys that can live inside a TEXT action.
const REC_CHARS = {
  KC_SPC: " ", KC_COMM: ",", KC_DOT: ".", KC_SLSH: "/", KC_SCLN: ";",
  KC_QUOT: "'", KC_LBRC: "[", KC_RBRC: "]", KC_BSLS: "\\", KC_MINS: "-",
  KC_EQL: "=", KC_GRV: "`",
};

// A tap only becomes text if the result is unambiguous. Letters with shift are
// safe — shift+letter is uppercase on every Latin layout. Shifted digits and
// punctuation are NOT: shift+2 is @ on US and " on several others, so those stay
// as explicit key actions rather than guessing a character.
function recCharFor(kc, shiftHeld) {
  if (/^KC_[A-Z]$/.test(kc)) {
    const ch = kc.slice(3);
    return shiftHeld ? ch : ch.toLowerCase();
  }
  if (shiftHeld) return null;
  if (/^KC_[0-9]$/.test(kc)) return kc.slice(3);
  return REC_CHARS[kc] ?? null;
}

// `mode`: "none" | "fixed" | "natural". The UI only offers "fixed" — the other
// two are kept because they are covered by tests and cost nothing, and because
// "none" is what a fixed delay of 0 already produces.
// Natural gaps are floored so ordinary
// typing rhythm does not become a DELAY between every letter, and capped so a
// pause for thought does not become a macro that appears to hang.
const REC_NATURAL_MIN_MS = 40;
const REC_NATURAL_MAX_MS = 2000;

function recordingToActions(events, mode = "fixed", fixedMs = 30) {
  const out  = [];
  const held = new Set();
  let lastT  = null;

  const gapBefore = (t) => {
    if (mode === "none") return 0;
    if (mode === "fixed") return out.length === 0 ? 0 : fixedMs;
    if (lastT === null) return 0;
    const d = t - lastT;
    return d < REC_NATURAL_MIN_MS ? 0 : Math.min(d, REC_NATURAL_MAX_MS);
  };

  const pushDelay = (t) => {
    const ms = gapBefore(t);
    if (ms > 0) out.push({ type: "delay", ms });
  };

  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!e.kc) continue; // unmapped key — reported separately, never guessed at

    if (REC_MODIFIERS.has(e.kc)) {
      pushDelay(e.t_ms);
      out.push({ type: e.down ? "down" : "up", key: e.kc });
      if (e.down) held.add(e.kc); else held.delete(e.kc);
      lastT = e.t_ms;
      continue;
    }

    // Non-modifiers are emitted on the DOWN edge as a tap. The matching up is
    // skipped: TAP already means press-and-release, and emitting both would
    // double every key.
    if (!e.down) continue;

    pushDelay(e.t_ms);
    out.push({ type: "tap", key: e.kc });
    lastT = e.t_ms;
  }

  return collapseTextRuns(out);
}

// Turn consecutive plain taps into one TEXT action. Twelve TAP lines for a typed
// word is exactly the "complicated to use" the recorder exists to remove, and
// TEXT is also cheaper in the board's macro buffer.
//
// Only runs with nothing held but shift are eligible, and only where every key
// has an unambiguous character. A run of one is left as a TAP — `TEXT a` reads
// worse than `TAP KC_A` and gains nothing.
function collapseTextRuns(actions) {
  const out  = [];
  const held = new Set();
  let   run  = [];   // ordered mix of {ch, action} and {shift: action}

  const isShift = (k) => k === "KC_LSFT" || k === "KC_RSFT";

  // A run collapses only if it yields two or more characters. When it does, any
  // shift presses inside it are DROPPED — they are already expressed by the
  // uppercase letters, and re-emitting them would shift the text twice. When it
  // does not collapse, everything is replayed in its original order, which is
  // why the run keeps shifts inline rather than in a side list.
  const flush = () => {
    const chars = run.filter(e => e.ch !== undefined);
    if (chars.length >= 2) {
      out.push({ type: "text", value: chars.map(e => e.ch).join("") });
    } else {
      for (const e of run) out.push(e.action ?? e.shift);
    }
    run = [];
  };

  for (const a of actions) {
    if ((a.type === "down" || a.type === "up") && isShift(a.key)) {
      if (a.type === "down") held.add(a.key); else held.delete(a.key);
      run.push({ shift: a });
      continue;
    }

    const shiftOnly = [...held].every(isShift);
    if (a.type === "tap" && shiftOnly) {
      const ch = recCharFor(a.key, held.has("KC_LSFT") || held.has("KC_RSFT"));
      if (ch !== null) { run.push({ ch, action: a }); continue; }
    }

    flush();
    if (a.type === "down") held.add(a.key);
    if (a.type === "up")   held.delete(a.key);
    out.push(a);
  }
  flush();
  return out;
}

function actionsToText(actions) {
  return (actions || []).map(a => {
    switch (a.type) {
      case "tap":   return `TAP ${a.key}`;
      case "down":  return `DOWN ${a.key}`;
      case "up":    return `UP ${a.key}`;
      case "delay": return `DELAY ${a.ms}`;
      case "text":  return `TEXT ${a.value}`;
      default:      return `# unsupported action: ${a.type}`;
    }
  }).join("\n");
}

// One entry point for both levels, so the header, breadcrumb, grid and list can
// never disagree about which level is showing.
function renderMacroList() {
  const grid   = document.getElementById("lib-grid");
  const list   = document.getElementById("lib-list");
  const empty  = document.getElementById("lib-empty");
  const title  = document.getElementById("lib-title");
  const crumb  = document.getElementById("lib-crumb");
  const bar    = document.getElementById("lib-actions");
  if (!grid || !list || !empty || !bar) return;

  const lib = activeLibrary();
  // A deleted library must not strand us inside it.
  if (activeLibraryId && !lib) { activeLibraryId = null; macroSelection.clear(); }

  if (!activeLibrary()) { renderLibraryTiles(); return; }

  grid.style.display = "none";
  list.style.display = "";
  title.textContent  = lib.name;
  crumb.innerHTML    = `<button class="lib-back" id="lib-back">← Macro Libraries</button>`;
  crumb.style.display = "";
  document.getElementById("lib-back").addEventListener("click", () => {
    activeLibraryId = null;
    macroSelection.clear();
    renderMacroList();
  });

  bar.innerHTML = `
    <span class="lib-selcount" id="lib-selcount"></span>
    <button class="home-add ghost" id="lib-test" disabled>▶ Test</button>
    <button class="home-add ghost" id="lib-export" disabled>Export</button>
    <button class="home-add ghost danger" id="lib-delete" disabled>Delete</button>
    <button class="home-add" id="lib-new">+ New Macro</button>`;
  document.getElementById("lib-new").addEventListener("click", () => openMacroEditor(null));
  document.getElementById("lib-test").addEventListener("click", testSelectedMacros);
  document.getElementById("lib-export").addEventListener("click", exportActiveLibrary);
  document.getElementById("lib-delete").addEventListener("click", deleteSelectedMacros);

  const macros = getMacros();
  empty.innerHTML = `
    <div class="home-empty-icon">⌘</div>
    <div class="home-empty-title">No macros in this library</div>
    <div class="home-empty-sub">Add one with <b>New Macro</b>.</div>`;
  empty.style.display = macros.length ? "none" : "";
  list.innerHTML = "";

  for (const m of macros) {
    const card = document.createElement("div");
    const on = macroSelection.has(m.id);
    card.className = "macro-card" + (on ? " selected" : "");
    const steps = (m.actions || []).length;
    card.innerHTML = `
      <input type="checkbox" ${on ? "checked" : ""} title="Select" />
      <div>
        <div class="macro-card-name"></div>
        ${m.description ? `<div class="macro-card-desc">${escapeHtml(m.description)}</div>` : ""}
      </div>
      <div class="macro-card-steps">${steps} step${steps === 1 ? "" : "s"}</div>`;

    // textContent, not innerHTML — a macro name is user text and must not be
    // able to inject markup into the card.
    card.querySelector(".macro-card-name").textContent = m.name || "Untitled";

    card.querySelector("input[type=checkbox]").addEventListener("click", (e) => {
      e.stopPropagation(); // selecting must not also open the editor
      if (macroSelection.has(m.id)) macroSelection.delete(m.id);
      else macroSelection.add(m.id);
      renderMacroList();
    });
    card.addEventListener("click", () => openMacroEditor(m.id));
    list.appendChild(card);
  }
  updateMacroSelectionUI();
}

// The library tiles — the folder level.
function renderLibraryTiles() {
  const grid  = document.getElementById("lib-grid");
  const list  = document.getElementById("lib-list");
  const empty = document.getElementById("lib-empty");
  const title = document.getElementById("lib-title");
  const crumb = document.getElementById("lib-crumb");
  const bar   = document.getElementById("lib-actions");

  list.style.display  = "none";
  grid.style.display  = "";
  crumb.style.display = "none";
  title.textContent   = "Macro Libraries";

  bar.innerHTML = `
    <button class="home-add ghost" id="lib-import-btn" title="Import a shared .json library">Import</button>
    <button class="home-add" id="lib-newlib">+ New Library</button>`;
  document.getElementById("lib-newlib").addEventListener("click", createLibrary);
  document.getElementById("lib-import-btn")
    .addEventListener("click", () => document.getElementById("lib-import").click());

  const libs = getLibraries();
  empty.innerHTML = `
    <div class="home-empty-icon">📚</div>
    <div class="home-empty-title">No macro libraries yet</div>
    <div class="home-empty-sub">Create one with <b>New Library</b>, or <b>Import</b> a shared file.</div>`;
  empty.style.display = libs.length ? "none" : "";
  grid.innerHTML = "";

  for (const lib of libs) {
    const n = (lib.macros || []).length;
    const tile = document.createElement("div");
    tile.className = "lib-tile";
    tile.title = "Open library";
    tile.innerHTML = `
      <div class="lib-tile-icon">📁</div>
      <div class="lib-tile-name"></div>
      <div class="lib-tile-sub">${n} macro${n === 1 ? "" : "s"}</div>
      ${lib.description ? `<div class="lib-tile-desc">${escapeHtml(lib.description)}</div>` : ""}
      <button class="lib-tile-rename" title="Rename this library">✎</button>
      <button class="lib-tile-del" title="Delete this library">✕</button>`;
    tile.querySelector(".lib-tile-name").textContent = lib.name || "Untitled";
    tile.querySelector(".lib-tile-rename").addEventListener("click", (e) => {
      e.stopPropagation(); // renaming must not also open the library
      beginInlineRename(tile.querySelector(".lib-tile-name"), lib.name || "",
        (name) => renameLibrary(lib.id, name));
    });
    tile.addEventListener("click", () => {
      activeLibraryId = lib.id;
      macroSelection.clear();
      renderMacroList();
    });
    tile.querySelector(".lib-tile-del").addEventListener("click", (e) => {
      e.stopPropagation(); // deleting must not also open the library
      if (!confirm(`Delete library "${lib.name}" and its ${n} macro${n === 1 ? "" : "s"}?`)) return;
      const orphaned = new Set((lib.macros || []).map(m => m.id));
      saveLibraries(getLibraries().filter(l => l.id !== lib.id));
      releaseDeletedMacroBindings(orphaned);
      renderMacroList();
    });
    grid.appendChild(tile);
  }
}

async function createLibrary() {
  const name = await promptModal({
    title: "New library",
    label: "Library name",
    value: "",
    placeholder: "e.g. Git shortcuts",
    confirmLabel: "Create library",
  });
  if (name === null) return;
  const libs = getLibraries();
  const lib = { id: `lib${Date.now()}`, name, description: "", macros: [] };
  libs.push(lib);
  saveLibraries(libs);
  // Drop straight into it — creating a library is always followed by filling it.
  activeLibraryId = lib.id;
  macroSelection.clear();
  renderMacroList();
}

function updateMacroSelectionUI() {
  const n = macroSelection.size;
  const count = document.getElementById("lib-selcount");
  if (count) count.textContent = n ? `${n} selected` : "";
  // Export is library-wide, so it stays enabled; the rest need a selection.
  for (const id of ["lib-test", "lib-delete"]) {
    const b = document.getElementById(id);
    if (b) b.disabled = n === 0;
  }
  const exp = document.getElementById("lib-export");
  if (exp) exp.disabled = getMacros().length === 0;
}

// Inline rename: swaps a label for an input in place. Enter or blur commits,
// Escape cancels. Used by both macro cards and library tiles so renaming feels
// the same at either level.
function beginInlineRename(labelEl, currentName, commit) {
  if (labelEl.querySelector("input")) return; // already editing
  const input = document.createElement("input");
  input.type = "text";
  input.className = "inline-rename";
  input.value = currentName;
  input.maxLength = 40;

  let settled = false;
  const finish = (save) => {
    if (settled) return; // blur fires again after Enter; only act once
    settled = true;
    const next = input.value.trim();
    if (save && next && next !== currentName) commit(next);
    else renderMacroList(); // redraw to drop the input either way
  };

  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter")  { e.preventDefault(); finish(true); }
    if (e.key === "Escape") { e.preventDefault(); finish(false); }
  });
  input.addEventListener("blur", () => finish(true));
  // The card and tile both navigate on click; editing must not trigger that.
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("mousedown", (e) => e.stopPropagation());

  labelEl.textContent = "";
  labelEl.appendChild(input);
  input.focus();
  input.select();
}

function renameLibrary(libId, name) {
  saveLibraries(getLibraries().map(l => (l.id === libId ? { ...l, name } : l)));
  renderMacroList();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ── Editor ──────────────────────────────────────────────────────────────────
// "keys" replays keystrokes on the board; "shell" runs a script on this
// computer through HOST(n). Absent kind means keys, so libraries written before
// shell macros existed still load.
function macroKind(m) {
  return m?.kind === "shell" ? "shell" : "keys";
}

let editingMacroKind = "keys";

function setMacroEditorKind(kind) {
  editingMacroKind = kind === "shell" ? "shell" : "keys";
  const shell = editingMacroKind === "shell";
  document.getElementById("macro-pane-keys").style.display  = shell ? "none" : "";
  document.getElementById("macro-pane-shell").style.display = shell ? "" : "none";
  document.getElementById("macro-kind-keys").classList.toggle("active", !shell);
  document.getElementById("macro-kind-shell").classList.toggle("active", shell);
  if (shell) updateTermGutter();
}

// Line numbers beside the script. Rebuilt on input and kept scroll-locked to
// the textarea so they cannot drift out of alignment.
function updateTermGutter() {
  const ta = document.getElementById("macro-script");
  const g  = document.getElementById("term-gutter");
  if (!ta || !g) return;
  const lines = ta.value.split("\n").length;
  g.textContent = Array.from({ length: Math.max(lines, 1) }, (_, i) => i + 1).join("\n");
  g.scrollTop = ta.scrollTop;
}

function openMacroEditor(id) {
  const m = getMacros().find(x => x.id === id);
  editingMacroId = id;
  document.getElementById("macro-name").value    = m?.name ?? "";
  document.getElementById("macro-desc").value    = m?.description ?? "";
  document.getElementById("macro-actions").value = actionsToText(m?.actions);
  document.getElementById("macro-script").value  = m?.script ?? "";
  document.getElementById("macro-cwd").value     = m?.cwd ?? "";
  document.getElementById("term-shell-name").textContent =
    navigator.userAgent.includes("Windows") ? "powershell" : "sh";
  setMacroEditorKind(macroKind(m));
  document.getElementById("macro-err").textContent = "";
  document.getElementById("macro-editor").classList.add("open");
  document.getElementById("macro-name").focus();
}

function closeMacroEditor() {
  editingMacroId = null;
  // Closing the editor must tear the hook down. Leaving a global keyboard hook
  // armed because a modal was dismissed is exactly the state this feature must
  // never be in — the UI that says "recording" would be gone.
  if (macroRecording) {
    macroRecording = false;
    clearInterval(macroRecTimer);
    macroRecTimer = null;
    window.removeEventListener("keydown", macroRecDomHandler, true);
    window.removeEventListener("keyup", macroRecDomHandler, true);
    const btn = document.getElementById("macro-rec");
    if (btn) { btn.textContent = "● Record"; btn.classList.remove("recording"); }
    const state = document.getElementById("macro-rec-state");
    if (state) state.textContent = "";
    const ta = document.getElementById("macro-actions");
    if (ta) ta.readOnly = false;
    invoke("stop_key_recording").catch((e) => logError(e, "stop_key_recording"));
  }
  document.getElementById("macro-editor").classList.remove("open");
}

function saveMacroFromEditor() {
  const name = document.getElementById("macro-name").value.trim();
  const err  = document.getElementById("macro-err");
  if (!name) { err.textContent = "Give the macro a name."; return; }

  const shell  = editingMacroKind === "shell";
  const script = document.getElementById("macro-script").value;
  let actions = [];

  if (shell) {
    if (!script.trim()) { err.textContent = "The script is empty."; return; }
  } else {
    const parsed = parseActions(document.getElementById("macro-actions").value);
    if (parsed.errors.length) { err.textContent = parsed.errors.slice(0, 3).join(" · "); return; }
    actions = parsed.actions;
  }

  const macros = getMacros();
  const i = macros.findIndex(m => m.id === editingMacroId);
  const cwd = document.getElementById("macro-cwd").value.trim();
  const entry = {
    id: editingMacroId ?? `m${Date.now()}`,
    name,
    description: document.getElementById("macro-desc").value.trim(),
    kind: shell ? "shell" : "keys",
    // Both fields are always written so switching kind cannot leave the other
    // one behind as stale, silently-executable content.
    actions: shell ? [] : actions,
    script:  shell ? script : "",
    cwd:     shell && cwd ? cwd : null,
  };
  if (i >= 0) macros[i] = entry; else macros.push(entry);
  saveMacros(macros);
  closeMacroEditor();
  renderMacroList();
  // Keycaps show the macro's name, so renaming here leaves the board stale.
  if (document.body.classList.contains("editor")) { applyMacroKeycodes(); renderBoard(); }
  syncHostBindings();
}

// ── Import / export ─────────────────────────────────────────────────────────
// The library is the shareable unit, so export writes the whole thing — a
// half-exported library would be a confusing artefact to hand someone.
async function exportActiveLibrary() {
  const lib = activeLibrary();
  if (!lib) return;
  const err = document.getElementById("macro-err");
  const payload = {
    format: MACRO_FORMAT,
    version: MACRO_FORMAT_V,
    name: lib.name,
    description: lib.description || "",
    exportedAt: new Date().toISOString(),
    macros: lib.macros || [],
  };
  // Reported as "click Export, nothing visually happens". A silent failure is
  // the thing to avoid here, so anything that goes wrong lands in the same
  // error line import already uses.
  try {
    if (err) err.textContent = "";
    await saveJsonFile(`${(lib.name || "library").replace(/[^\w-]+/g, "_")}.macrolib.json`, payload);
  } catch (e) {
    if (err) err.textContent = `Export failed: ${e?.message || e}`;
    logError(`macro library export failed: ${e?.message || e}`, "export");
  }
}

// Imported macros are always given fresh ids. Trusting ids from a shared file
// would let one library silently overwrite another's macros on import.
async function importMacroLibrary(file) {
  const err = document.getElementById("macro-err");
  try {
    const parsed = JSON.parse(await file.text());
    if (parsed.format !== MACRO_FORMAT) throw new Error("not a KeyFigurator macro library");
    if (parsed.version > MACRO_FORMAT_V) {
      throw new Error(`library is version ${parsed.version}, this app understands ${MACRO_FORMAT_V}`);
    }
    if (!Array.isArray(parsed.macros)) throw new Error("no macros in file");

    // An import arrives as its own library rather than being merged into an
    // existing one — that keeps someone else's set identifiable after import.
    let added = 0;
    const macros = parsed.macros
      .filter(m => m && typeof m.name === "string")
      .map(m => ({
        id: `m${Date.now()}-${added++}`,
        name: m.name,
        description: typeof m.description === "string" ? m.description : "",
        actions: Array.isArray(m.actions) ? m.actions : [],
      }));

    const libs = getLibraries();
    const lib = {
      id: `lib${Date.now()}`,
      name: (typeof parsed.name === "string" && parsed.name.trim())
        || file.name.replace(/\.(macrolib\.)?json$/i, "")
        || "Imported Library",
      description: typeof parsed.description === "string" ? parsed.description : "",
      macros,
    };
    libs.push(lib);
    saveLibraries(libs);
    renderMacroList();
    console.log(`imported library "${lib.name}" with ${added} macro(s)`);
  } catch (e) {
    logError(e, "macroImport");
    if (err) err.textContent = `Import failed: ${e.message}`;
    alert(`Import failed: ${e.message}`);
  }
}

// ── Test playback ───────────────────────────────────────────────────────────
// Steps through a macro's actions in real time — honouring DELAY — and shows
// what it would produce. Deliberately a DRY RUN: it does not inject keystrokes
// into the OS. Real injection would type into whatever window has focus, which
// during editing is this app, and there is no way back from a macro that has
// started holding modifiers down. This verifies sequence and timing, which is
// what is actually wrong with a broken macro.
let testAbort = false;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function testSelectedMacros() {
  const queue = getMacros().filter(m => macroSelection.has(m.id));
  if (!queue.length) return;

  testAbort = false;
  const overlay = document.getElementById("macro-test");
  const titleEl = document.getElementById("macro-test-title");
  const queueEl = document.getElementById("macro-test-queue");
  const stepsEl = document.getElementById("macro-test-steps");
  const outEl   = document.getElementById("macro-test-out");
  overlay.classList.add("open");

  // Queued runs are sequential — that is the point of queueing, and it is also
  // what the board would do.
  queueEl.innerHTML = queue
    .map((m, i) => `<span class="mt-q" id="mt-q${i}">${escapeHtml(m.name)}</span>`)
    .join('<span class="mt-arrow">→</span>');

  let typed = "";
  const held = new Set();

  for (let qi = 0; qi < queue.length && !testAbort; qi++) {
    const m = queue[qi];
    titleEl.textContent = `Testing — ${m.name}  (${qi + 1}/${queue.length})`;
    document.getElementById(`mt-q${qi}`)?.classList.add("active");

    // A shell macro is tested by actually running it — that is what the key
    // will do, and unlike keystroke injection it does not depend on which
    // window has focus.
    if (macroKind(m) === "shell") {
      stepsEl.innerHTML = `<div class="mt-step active">$ running…</div>`;
      try {
        // Run the script directly rather than through a host slot. Slots are
        // derived from key bindings, so requiring one meant an unbound macro
        // could not be tested — exactly backwards, since testing is what you do
        // BEFORE deciding it is worth a key. Same shell either way, so a pass
        // here still means what it says.
        const res = await invoke("run_script", {
          script: m.script || "",
          cwd: m.cwd || null,
        });
        stepsEl.innerHTML = `<div class="mt-step done">$ ${escapeHtml(m.name)}</div>`;
        outEl.textContent = String(res);
      } catch (e) {
        stepsEl.innerHTML = `<div class="mt-step">$ failed</div>`;
        outEl.textContent = String(e);
      }
      document.getElementById(`mt-q${qi}`)?.classList.remove("active");
      document.getElementById(`mt-q${qi}`)?.classList.add("done");
      if (qi < queue.length - 1 && !testAbort) await sleep(350);
      continue;
    }

    const acts = m.actions || [];
    stepsEl.innerHTML = acts
      .map((a, i) => `<div class="mt-step" id="mt-s${i}">${escapeHtml(describeAction(a))}</div>`)
      .join("");

    for (let i = 0; i < acts.length && !testAbort; i++) {
      const a = acts[i];
      const el = document.getElementById(`mt-s${i}`);
      el?.classList.add("active");

      switch (a.type) {
        case "down": held.add(a.key); break;
        case "up":   held.delete(a.key); break;
        case "tap":  typed += keycodeToChar(a.key, held); break;
        case "text": typed += a.value; break;
        case "delay": await sleep(Math.min(a.ms, 5000)); break;
      }
      outEl.textContent = typed + (held.size ? `   [holding ${[...held].join(" + ")}]` : "");

      // A visible beat per step, so a fast macro is still watchable.
      if (a.type !== "delay") await sleep(140);
      el?.classList.remove("active");
      el?.classList.add("done");
    }
    document.getElementById(`mt-q${qi}`)?.classList.remove("active");
    document.getElementById(`mt-q${qi}`)?.classList.add("done");
    if (qi < queue.length - 1 && !testAbort) await sleep(350);
  }

  if (!testAbort) titleEl.textContent = `Done — ${queue.length} macro${queue.length === 1 ? "" : "s"}`;
  // Unbalanced DOWN without a matching UP is a real macro bug worth naming.
  if (held.size) {
    outEl.textContent += `\n⚠ still held at end: ${[...held].join(" + ")} — missing an UP?`;
  }
}

function describeAction(a) {
  switch (a.type) {
    case "tap":   return `TAP    ${a.key}`;
    case "down":  return `DOWN   ${a.key}`;
    case "up":    return `UP     ${a.key}`;
    case "delay": return `DELAY  ${a.ms} ms`;
    case "text":  return `TEXT   "${a.value}"`;
    default:      return `? ${a.type}`;
  }
}

// Rough preview only: enough to make a typed string readable. Modifier-held taps
// show as a chord rather than a character, since that is what they produce.
function keycodeToChar(kc, held) {
  const mods = [...held].filter(k => /^KC_[LR](CTL|ALT|GUI)$/.test(k));
  const bare = String(kc || "").replace(/^KC_/, "");
  if (mods.length) return `<${mods.map(m => m.replace(/^KC_/, "")).join("+")}+${bare}>`;
  const shifted = [...held].some(k => /^KC_[LR]SFT$/.test(k));
  if (/^[A-Z]$/.test(bare)) return shifted ? bare : bare.toLowerCase();
  if (/^[0-9]$/.test(bare)) return bare;
  if (bare === "SPACE" || bare === "SPC") return " ";
  if (bare === "ENTER" || bare === "ENT") return "\n";
  if (bare === "TAB") return "\t";
  return `<${bare}>`;
}

function stopMacroTest() {
  testAbort = true;
  document.getElementById("macro-test")?.classList.remove("open");
}

function deleteSelectedMacros() {
  const removed = new Set(macroSelection);
  saveMacros(getMacros().filter(m => !macroSelection.has(m.id)));
  macroSelection.clear();
  releaseDeletedMacroBindings(removed);
  renderMacroList();
}

// Deleting a macro must release any key bound to it, or those keys keep a
// HOST(n) keycode pointing at a slot that no longer means anything. MACRO(n)
// is matched too, for keys bound before keystroke macros moved onto HOST(n).
function releaseDeletedMacroBindings(removedIds) {
  let touched = false;
  keyMacros = keyMacros.map((id, idx) => {
    if (!id || !removedIds.has(id)) return id;
    touched = true;
    const kc = keymap?.layers[0]?.keys[idx] ?? "";
    if (/^(MACRO|HOST)\(\d+\)$/.test(kc)) keymap.layers[0].keys[idx] = "KC_NO";
    return null;
  });
  if (!touched) return;
  applyMacroKeycodes();
  renderKeyMacroRow();
  renderBoard();
  scheduleLiveSync("keymap");
  // Drop the deleted macro's binding backend-side too, or its slot keeps
  // running the old script.
  syncHostBindings();
}

function renderBrightness() {
  const out = document.getElementById("led-brightness-val");
  if (out) out.textContent = `${Math.round((ledBrightness / 255) * 100)}%`;
}

// Purely derived from the animation. "App" = solid, so the board renders the
// per-key colours we pushed. "Board" = a real animation, so QMK's effect owns
// the LEDs and the editor's per-key colours are a preview, not what is lit.
function renderOverlayBtn() {
  const ind = document.getElementById("overlay-ind");
  const lbl = document.getElementById("overlay-state");
  if (!ind || !lbl) return;
  const appDriven = isAppDrivingLeds();
  lbl.textContent = appDriven ? "App" : "Board";
  ind.classList.toggle("board-driven", !appDriven);
  ind.title = appDriven
    ? "Animation is Solid, so the board is showing this app's per-key colours."
    : "The board is running its own animation. Per-key colours are a preview; set animation to Solid to show them.";
}

function renderConnPill(connected) {
  const connPill = document.getElementById("conn");
  if (!connPill) return;
  connPill.textContent = connected ? "● connected" : "○ mock (no board)";
  connPill.classList.toggle("ok", connected);
}

// The one place that reacts to the link changing state. Driven by the backend's
// board-connection event (fires on the plug) and by the poll below (a fallback
// in case an event is ever missed) — both are idempotent via _wasConnected.
async function onConnectionChange(connected) {
  renderConnPill(connected);
  // Keep the header's device dot honest rather than frozen at whatever it was
  // when the editor opened.
  if (activeDevice) {
    activeDevice.connected = connected;
    renderActiveDeviceInfo();
  }
  // Transition only. The home list is persisted state, not live state, so it
  // has to be reconciled explicitly — and identifying a board costs a real HID
  // round-trip, which is not something to spend on every poll.
  if (connected !== _wasConnected) await syncDeviceListConnection(connected);
  if (connected && !_wasConnected) {
    try { await applyActiveProfileToBoard(); }
    catch (e) { logError(e, "applyOnConnect"); }
  }
  _wasConnected = connected;
}

// board_status now does a wire round-trip, and its timeout (3 s) is the same as
// this interval — so a board that stops answering would stack overlapping polls,
// each queueing another frame behind the last. One at a time; a skipped tick
// costs nothing because the next one is 3 s away.
let _pollInFlight = false;

async function pollConnection() {
  if (_pollInFlight) return;
  _pollInFlight = true;
  try {
    const status = await invoke("board_status");
    await onConnectionChange(!!status?.connected);
  } catch {}
  finally { _pollInFlight = false; }
}

// Last line of defence: a debounced save can still be pending when the window
// closes. Both events are used because Tauri's webview does not fire
// beforeunload reliably on a native window close.
for (const ev of ["beforeunload", "pagehide"]) {
  window.addEventListener(ev, () => {
    if (document.body.classList.contains("editor")) {
      clearTimeout(_autoSaveTimer);
      persistDeviceState();
    }
  });
}

init().then(async () => {
  // A board attached before the app started never fires an attach event, so push
  // the active profile once here. A board attached later is handled by the event.
  if (_wasConnected) {
    try { await applyActiveProfileToBoard(); }
    catch (e) { logError(e, "initialApply"); }
  }
  setInterval(pollConnection, 3000);
});
