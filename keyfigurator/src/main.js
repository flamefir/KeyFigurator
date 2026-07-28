import { invoke as tauriInvoke } from "@tauri-apps/api/core";

const hasTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
let browserState = null;
async function invoke(cmd, args) {
  if (hasTauri) return tauriInvoke(cmd, args);
  return browserMock(cmd, args);
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
    case "get_keymap":   return structuredClone(browserState.keymap);
    case "set_keymap":   browserState.keymap = structuredClone(args.map); return;
    case "set_leds":     return;
    case "oled_push":    return;
    case "sync_time":    return;
    case "eeprom_commit":return;
    case "board_ping":   return { protocol: 1, fw_major: 0, fw_minor: 1 };
    case "get_bindings": return [];
    case "set_bindings": return;
    case "run_binding":  return "exit=Some(0)\n--- stdout ---\n(browser mock)\n--- stderr ---\n";
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
let keyIconLabels = Array(21).fill("");   // optional per-key icon/emoji (max 2 chars)
let keyIconImages = Array(21).fill(null); // optional per-key image data URL
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
// The confirm/enter action the board uses to accept things. By default that is
// the encoder push — but hardware revisions without a push switch (product 0x01
// hw 1.0.0) have no such button, so any key can stand in for it. `null` means
// "use the encoder push", which is only valid where the hardware has one.
const SPECIAL_ENTER_KEY = "kf-special-enter";
let specialEnterIdx = null;

let cornerColors    = ["#ff6e14", "#ff6e14", "#ff6e14", "#ff6e14"];
let selectedCorners = new Set([0, 1, 2, 3]);
const UG_SELECTED_KEY = "kf-ug-selected";
let ugAnimation   = "breathe";
let ugRate        = 128;
let ugIntensity   = 180;

let klAnimation   = "solid";
let klRate        = 128;
let klIntensity   = 180;

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

function applyAnimState(a) {
  klAnimation = a.animation ?? "solid";
  klRate      = a.rate ?? 128;
  klIntensity = a.intensity ?? 180;
  klPalette   = Array.isArray(a.palette) ? [...a.palette] : [];
}

function currentAnimState() {
  return { animation: klAnimation, rate: klRate, intensity: klIntensity, palette: [...klPalette] };
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
const OLED_CD_KEY         = "kf-oled-cd";
const OLED_BACK_KEY       = "kf-oled-back";
// Standard 128×128 OLED font presets — char limits derived from real glyph cell widths
const OLED_FONTS = [
  { id: "small",  label: "Small",  hw: "5×7",  previewPx: "8px",  nameMax: 21, titleMax: 19 },
  { id: "medium", label: "Medium", hw: "6×8",  previewPx: "10px", nameMax: 16, titleMax: 14 },
  { id: "large",  label: "Large",  hw: "8×8",  previewPx: "13px", nameMax: 13, titleMax: 11 },
  { id: "xl",     label: "XL",     hw: "8×16", previewPx: "16px", nameMax: 11, titleMax:  9 },
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
const POMO_WORK_MIN        = 25;
const POMO_SHORT_BREAK_MIN = 5;
const POMO_LONG_BREAK_MIN  = 15;
const POMO_LONG_EVERY      = 4;

let oledPomoPhase     = "work";     // "work" | "shortBreak" | "longBreak"
let oledPomoRunning   = false;
let oledPomoStart     = 0;
let oledPomoAcc       = 0;          // seconds accumulated before current start
let oledPomoCompleted = 0;

function pomoPhaseSeconds() {
  if (oledPomoPhase === "shortBreak") return POMO_SHORT_BREAK_MIN * 60;
  if (oledPomoPhase === "longBreak")  return POMO_LONG_BREAK_MIN * 60;
  return POMO_WORK_MIN * 60;
}

function getPomoElapsed() {
  return oledPomoAcc + (oledPomoRunning ? (performance.now() - oledPomoStart) / 1000 : 0);
}

function getPomoRemaining() {
  return Math.max(0, pomoPhaseSeconds() - getPomoElapsed());
}

// Roll finished phases forward. Same rule as pomo_advance(): only WORK phases
// count toward the completed tally, and every POMO_LONG_EVERY of them earns a
// long break instead of a short one.
function pomoTick() {
  if (!oledPomoRunning) return;
  let guard = 0;
  while (getPomoElapsed() >= pomoPhaseSeconds() && guard++ < POMO_LONG_EVERY * 2) {
    if (oledPomoPhase === "work") {
      oledPomoCompleted++;
      oledPomoPhase = (oledPomoCompleted % POMO_LONG_EVERY === 0) ? "longBreak" : "shortBreak";
    } else {
      oledPomoPhase = "work";
    }
    oledPomoAcc   = 0;
    oledPomoStart = performance.now();
  }
}

let oledFlashKeys    = false;
let oledFlashStart   = 0;

let oledBackKeyIdx     = null;       // physical key index assigned as OLED back/escape; null = unassigned

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
  // QMK dynamic macros. Recorded and stored ON THE BOARD (dynamic_keymap_macro_*),
  // so assigning MACRO(n) here binds the key; the macro's contents are edited in
  // Vial. DYNAMIC_KEYMAP_MACRO_COUNT is 16, so only 0..15 will fire.
  { label: "Macros",  keys: Array.from({ length: 16 }, (_, i) => `MACRO(${i})`) },
  // HOST(n) runs a command on this computer — the KeyFigurator differentiator.
  { label: "Host",    keys: Array.from({ length: 16 }, (_, i) => `HOST(${i})`) },
];
const KC_ALL_FLAT = KC_CATEGORIES.flatMap(c => c.keys);

// RATE is a SPEED: 0 = slowest, 255 = fastest. That is what the wire carries and
// what QMK's rgb_matrix speed means, so the preview has to agree.
//
// The preview needs a DURATION, which is the inverse of speed — a high rate must
// produce a SHORT cycle. The original formula had it the right way round for
// duration but the wrong way round for the label, so the app previewed fast
// while the board ran slow at the same slider value.
//
// One helper rather than the four copies of this expression that let the two
// sides drift apart in the first place.
const ANIM_MIN_DUR = 0.3; // seconds, at rate 255
const ANIM_MAX_DUR = 8.0; // seconds, at rate 0

function rateToDuration(rate) {
  const r = Math.min(255, Math.max(0, Number(rate) || 0));
  return ANIM_MIN_DUR + ((255 - r) / 255) * (ANIM_MAX_DUR - ANIM_MIN_DUR);
}

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

function renderOledScreenContent(screenEl) {
  const screens = getOledScreens();
  if (!screens.length) { screenEl.innerHTML = ""; return; }
  if (oledScreenIdx >= screens.length) oledScreenIdx = screens.length - 1;
  const screen = screens[oledScreenIdx];

  switch (screen.type) {
    case "layer": {
      if (oledSubMode === "keycycle") {
        const cyclePos    = BOARD_POSITIONS[oledKeyCycleIdx];
        const cycleKeyI   = cyclePos?.idx ?? 0;
        const ksk         = currentOledScreenKey();
        const kScreenEvMap = ksk ? (oledEventKeys[ksk] || {}) : {};
        const evEntry     = Object.entries(kScreenEvMap).find(([, v]) => evIdx(v) === cycleKeyI);
        const evLabel     = evEntry ? OLED_EVENT_LABELS[evEntry[0]] : null;
        let numLabel, icon, disp;
        if (cyclePos?.type === "encoder") {
          numLabel = "ENC"; icon = ""; disp = evLabel || "ENCODER";
        } else {
          numLabel = String(cycleKeyI + 1).padStart(2, "0");
          const kc = keymap?.layers[0]?.keys[cycleKeyI] ?? "KC_NO";
          icon = keyIconLabels[cycleKeyI] || "";
          disp = evLabel || kc.replace(/^KC_/, "");
        }
        screenEl.innerHTML = `<div class="oled-keycycle">
          <div class="oled-kc-num">${numLabel}</div>
          ${icon ? `<div class="oled-kc-icon">${icon}</div>` : ""}
          <div class="oled-kc-val">${disp}</div>
        </div>`;
      } else {
        const layers    = getSavedLayers();
        const layer     = layers.find(l => l.id === screen.layerId);
        const idx       = String(layers.indexOf(layer) + 1).padStart(2, "0");
        const name      = (layer?.name || "").toUpperCase().slice(0, oledNameMax());
        const showTitle = layer?.showTitle !== false;
        screenEl.innerHTML = `<div class="oled-layer-screen">
          <div class="oled-lyr-idx">LAYER ${idx}</div>
          ${showTitle && name ? `<div class="oled-lyr-name">${name}</div>` : ""}
        </div>`;
      }
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
          <div class="oled-screen-hint">${oledCdRunning ? "↓ stop" : "↓ cycle field · rotate to set"}</div>
        </div>`;
      }
      break;
    }
    case "pomodoro": {
      const phaseLabel = oledPomoPhase === "work"
        ? "POMODORO"
        : (oledPomoPhase === "longBreak" ? "LONG BREAK" : "BREAK");
      screenEl.innerHTML = `<div class="oled-timer-screen">
        <div class="oled-screen-lbl">${phaseLabel}</div>
        <div class="oled-time-val${oledPomoPhase === "work" ? "" : " oled-pomo-break"}">${formatTime(getPomoRemaining())}</div>
        <div class="oled-screen-hint">DONE ${oledPomoCompleted}</div>
        <div class="oled-screen-hint">${oledPomoRunning ? "↓ pause" : "↓ start"}</div>
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
  if (oledCdDone) { oledCdDone = false; oledFlashKeys = false; oledCdAcc = 0; }
  oledSubMode = "nav";
  const screens = getOledScreens();
  oledScreenIdx = (oledScreenIdx + dir + screens.length) % screens.length;
  const screen = screens[oledScreenIdx];
  if (screen?.type === "layer") switchToLayer(screen.layerId, { silent: true });
  updateOledDisplay();
}

function onEncoderCW() {
  const screens = getOledScreens();
  const screen  = screens[oledScreenIdx];
  if (oledSubMode === "keycycle") {
    oledKeyCycleIdx = (oledKeyCycleIdx + 1) % 21;
    updateOledDisplay(); renderBoard(); return;
  }
  if (screen?.type === "countdown" && !oledCdRunning && !oledCdDone) {
    adjustCdField(1); return;
  }
  oledScreenNav(1);
}

function onEncoderCCW() {
  const screens = getOledScreens();
  const screen  = screens[oledScreenIdx];
  if (oledSubMode === "keycycle") {
    oledKeyCycleIdx = (oledKeyCycleIdx + 20) % 21;
    updateOledDisplay(); renderBoard(); return;
  }
  if (screen?.type === "countdown" && !oledCdRunning && !oledCdDone) {
    adjustCdField(-1); return;
  }
  oledScreenNav(-1);
}

function triggerOledEvent(eventName) {
  switch (eventName) {
    case "presentKeys": {
      if (oledSubMode === "keycycle") {
        oledSubMode = "nav"; oledKeyCycleIdx = 0;
      } else {
        // Present Keys only renders on a layer screen, so we have to be ON one.
        // Prefer the active profile's screen, but fall back to any layer screen:
        // requiring activeProfileId meant that with no saved layer the mode was
        // entered and then rendered nothing, looking like a dead key.
        const pscreens = getOledScreens();
        if (pscreens[oledScreenIdx]?.type !== "layer") {
          let layerScrIdx = pscreens.findIndex(s => s.type === "layer" && s.layerId === activeProfileId);
          if (layerScrIdx === -1) layerScrIdx = pscreens.findIndex(s => s.type === "layer");
          if (layerScrIdx === -1) {
            console.warn("Present Keys needs a layer screen; none exists (no saved layers yet)");
            break;
          }
          oledScreenIdx = layerScrIdx;
        }
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
    case "cdEvent":
      if (oledCdDone) {
        oledCdDone = false; oledCdRunning = false; oledCdAcc = 0; oledFlashKeys = false;
        updateOledDisplay(); renderBoard();
      } else if (oledCdRunning) {
        oledCdAcc += (performance.now() - oledCdStart) / 1000;
        oledCdRunning = false; updateOledDisplay();
      } else {
        oledCdField = "hours"; oledCdStart = performance.now(); oledCdAcc = 0; oledCdRunning = true;
        localStorage.setItem(OLED_CD_KEY, JSON.stringify({ h: oledCdH, m: oledCdM, s: oledCdS }));
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
      oledCdAcc  = 0;    oledFlashKeys = false;
      updateOledDisplay(); renderBoard(); return;
    }
    if (oledCdRunning) {
      oledCdAcc    += (performance.now() - oledCdStart) / 1000;
      oledCdRunning = false;
    } else {
      const fields  = ["hours", "minutes", "seconds"];
      const fi      = fields.indexOf(oledCdField);
      if (fi < fields.length - 1) {
        oledCdField = fields[fi + 1];
      } else if (oledCdH + oledCdM + oledCdS > 0) {
        oledCdField   = "hours";
        oledCdStart   = performance.now();
        oledCdAcc     = 0;
        oledCdRunning = true;
        localStorage.setItem(OLED_CD_KEY, JSON.stringify({ h: oledCdH, m: oledCdM, s: oledCdS }));
      } else {
        // 00:00:00 would finish on the same tick — wrap instead of flashing done.
        oledCdField = "hours";
      }
    }
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

const OLED_EVENT_LABELS = {
  presentKeys:    "Present Keys",
  timerStartStop: "Start / Stop",
  timerReset:     "Reset Timer",
  cdEvent:        "Start / Stop",
};

function currentOledScreenKey() {
  const screens = getOledScreens();
  const s = screens[oledScreenIdx];
  return s ? (s.layerId || s.id) : null;
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

  const removable = ["timer", "countdown", "datetime", "pomodoro", "gif", "custom"].includes(screen.type);
  const oldBtn = document.getElementById("oled-remove-screen");
  if (oldBtn) {
    const newBtn = oldBtn.cloneNode(true);
    newBtn.style.display = removable ? "" : "none";
    oldBtn.parentNode.replaceChild(newBtn, oldBtn);
    if (removable) {
      newBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const wasLast = oledScreenIdx >= getOledScreens().length - 1;
        if (screen.type === "countdown") { oledCdRunning = false; oledCdDone = false; oledCdAcc = 0; }
        oledCustomScreens = oledCustomScreens.filter(s => s.id !== screen.id);
        saveOledCustomScreens();
        if (wasLast) oledScreenIdx = Math.max(0, oledScreenIdx - 1);
        updateOledDisplay(); renderOledPillNav(); renderOledPillContent();
      });
    }
  }
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
          <label class="oled-show-title-wrap" title="Show title on OLED">
            <input type="checkbox" id="oled-show-title" ${showTitle ? "checked" : ""} />
            <span>Show</span>
          </label>
        </div>
        <div class="oled-pill-hint">
          Layer name shown on OLED (max ${oledNameMax()} chars). Present Keys cycles through key assignments.
        </div>
        <div class="oled-pill-section" style="padding-bottom:6px">
          <span class="pill-label">OLED Events</span>
        </div>
        ${eventRowHTML("presentKeys", "Present Keys")}`;
      document.getElementById("oled-title-inp")?.addEventListener("input", (e) => {
        if (layer) { renameSavedLayer(layer.id, e.target.value); updateOledDisplay(); }
      });
      document.getElementById("oled-show-title")?.addEventListener("change", (e) => {
        if (layer) { setLayerShowTitle(layer.id, e.target.checked); updateOledDisplay(); }
      });
      wireEventRows(container);
      break;
    }
    case "timer": {
      container.innerHTML = `
        <div class="oled-pill-section oled-pill-hint">
          Timer resets when you navigate to another screen.
        </div>
        <div class="oled-pill-section" style="padding-bottom:6px">
          <span class="pill-label">OLED Events</span>
        </div>
        ${eventRowHTML("timerStartStop", "Start / Stop")}
        ${eventRowHTML("timerReset", "Reset")}
        ${eventRowHTML("presentKeys", "Present Keys")}`;
      wireEventRows(container);
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
          Rotate encoder to adjust the selected field.
        </div>
        <div class="oled-pill-section" style="padding-bottom:6px">
          <span class="pill-label">OLED Events</span>
        </div>
        ${eventRowHTML("cdEvent", "Start / Stop")}
        ${eventRowHTML("presentKeys", "Present Keys")}`;
      document.getElementById("oled-cd-h")?.addEventListener("input", (e) => { oledCdH = Math.max(0, Math.min(99, parseInt(e.target.value, 10) || 0)); e.target.value = oledCdH; updateOledDisplay(); });
      document.getElementById("oled-cd-m")?.addEventListener("input", (e) => { oledCdM = Math.max(0, Math.min(59, parseInt(e.target.value, 10) || 0)); e.target.value = oledCdM; updateOledDisplay(); });
      document.getElementById("oled-cd-s")?.addEventListener("input", (e) => { oledCdS = Math.max(0, Math.min(59, parseInt(e.target.value, 10) || 0)); e.target.value = oledCdS; updateOledDisplay(); });
      wireEventRows(container);
      break;
    }
    case "datetime": {
      container.innerHTML = `
        <div class="oled-pill-section oled-pill-hint">
          Shows current time and date.
        </div>
        <div class="oled-pill-section" style="padding-bottom:6px">
          <span class="pill-label">OLED Events</span>
        </div>
        ${eventRowHTML("presentKeys", "Present Keys")}`;
      wireEventRows(container);
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
          <span class="pill-label">OLED Events</span>
        </div>
        ${eventRowHTML("presentKeys", "Present Keys")}`;
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
          <span class="pill-label">OLED Events</span>
        </div>
        ${eventRowHTML("presentKeys", "Present Keys")}`;
      document.getElementById("oled-custom-title")?.addEventListener("input", (e) => {
        screen.title = e.target.value; saveOledCustomScreens(); updateOledDisplay();
      });
      document.getElementById("oled-custom-body")?.addEventListener("input", (e) => {
        screen.body = e.target.value; saveOledCustomScreens(); updateOledDisplay();
      });
      wireEventRows(container);
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

function applyOledFont(fontId) {
  oledFontId = fontId;
  localStorage.setItem("kf-oled-font", fontId);
  const font = getOledFont();
  document.documentElement.style.setProperty("--oled-lyr-font-size", font.previewPx);
  const slInp = document.getElementById("sl-new-input");
  if (slInp) slInp.maxLength = font.nameMax;
  document.querySelectorAll(".oled-font-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.font === fontId);
  });
  updateOledDisplay();
  renderOledPillContent();
}

function startOledAnim() {
  if (oledAnimFrame) cancelAnimationFrame(oledAnimFrame);
  oledAnimFrame = requestAnimationFrame(oledAnimTick);
}

function oledAnimTick(now) {
  // Countdown completion
  if (oledCdRunning && getCdRemaining() <= 0) {
    oledCdRunning = false; oledCdDone = true;
    oledFlashKeys = true;  oledFlashStart = performance.now();
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
  const icon  = keyIconLabels[idx];
  const anim  = klAnimation;
  const macro = keyMacros[idx] ? findMacroById(keyMacros[idx]) : null;
  const layer = getSavedLayers().find(l => l.id === activeProfileId);

  let html = `<div class="ktt-kc">`;
  if (icon) html += `<span class="ktt-icon">${icon}</span>`;
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

  if (oledBackKeyIdx === idx) {
    html += `<div class="ktt-row">
      <span class="ktt-label">ROLE</span>
      <span class="ktt-val">OLED back / escape</span>
    </div>`;
  }

  if (macro) {
    html += `<div class="ktt-row">
      <span class="ktt-label">MACRO</span>
      <span class="ktt-val">${escapeHtml(macro.name)}</span>
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

const DEFAULT_CORNER_COLORS = ["#ff6e14", "#ff6e14", "#ff6e14", "#ff6e14"];

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
  renderPalette("ug-palette", ugPalette, UG_PALETTE_KEY, () => {});
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
    animation: klAnimation, rate: klRate, intensity: klIntensity,
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
    animation: klAnimation, rate: klRate, intensity: klIntensity, palette: [...klPalette],
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

// Animation is global, so selecting a key no longer swaps the panel's animation
// state — it just re-syncs the controls to the one global setting.
function loadKeyAnimState(_idx) {
  const rateEl = document.getElementById("kl-rate");
  const intEl  = document.getElementById("kl-intensity");
  if (rateEl) rateEl.value = klRate;
  if (intEl)  intEl.value  = klIntensity;
  renderKlAnimChips();
  updatePaletteDisabled();
  renderPalette("kl-palette", klPalette, KL_PALETTE_KEY, saveCurrentKeyAnimState);
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

function renderPalette(containerId, palette, storageKey, onChange) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = "";

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
      palette.push(e.target.value);
      localStorage.setItem(storageKey, JSON.stringify(palette));
      renderPalette(containerId, palette, storageKey, onChange);
      onChange();
    });
    addEl.appendChild(addInp);
  }
  container.appendChild(addEl);

  palette.forEach((color, i) => {
    const swatch = document.createElement("label");
    swatch.className = "palette-swatch";
    swatch.style.background = color;
    swatch.title = color;

    const inp = document.createElement("input");
    inp.type = "color";
    inp.value = color;
    inp.style.cssText = "position:absolute;opacity:0;width:0;height:0;pointer-events:none";
    inp.addEventListener("input", (e) => {
      e.stopPropagation();
      palette[i] = e.target.value;
      swatch.style.background = e.target.value;
      onChange();
    });
    inp.addEventListener("change", (e) => {
      e.stopPropagation();
      palette[i] = e.target.value;
      localStorage.setItem(storageKey, JSON.stringify(palette));
      renderPalette(containerId, palette, storageKey, onChange);
      onChange();
    });
    swatch.appendChild(inp);

    const del = document.createElement("span");
    del.className = "ps-del";
    del.textContent = "×";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      palette.splice(i, 1);
      localStorage.setItem(storageKey, JSON.stringify(palette));
      renderPalette(containerId, palette, storageKey, onChange);
      onChange();
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
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r,g,b), min = Math.min(r,g,b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }
  return { h, s, l };
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
function shiftHue(hex, degrees) {
  const { r, g, b } = hexToRgb(hex);
  const { h, s, l } = rgbToHsl(r, g, b);
  const rgb = hslToRgb((h + degrees / 360 + 1) % 1, s, l);
  return `${rgb.r},${rgb.g},${rgb.b}`;
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
  const duration = rateToDuration(ugRate);
  const t        = (elapsed % duration) / duration;
  const maxOp    = 0.15 + (ugIntensity / 255) * 0.85;
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
      const op = maxOp * (0.5 - 0.5 * Math.cos(t * Math.PI * 2));
      return bases.map(hex => {
        const {r,g,b} = hexToRgb(hex); return { rgb:`${r},${g},${b}`, opacity: op };
      });
    }

    case "rainbow": {
      // Rainbow ignores palette — uses corner pickers with per-corner hue shifting
      const hueOffset  = t * 360;
      const phaseShift = [0, 90, 270, 180];
      return cornerColors.map((hex, i) => ({
        rgb:     shiftHue(hex, hueOffset + phaseShift[i]),
        opacity: maxOp * 0.75,
      }));
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

function computeKeyLedColor(idx, row, col, elapsed, isSel) {
  // Selected keys use the live panel state; deselected keys use their own stored state
  // One global animation for every key — this simulates what the board will
  // actually render, since QMK has a single board-wide effect.
  const animation = klAnimation, rate = klRate, intensity = klIntensity, palette = klPalette;

  const duration = rateToDuration(rate);
  const t        = (elapsed % duration) / duration;
  const maxOp    = 0.15 + (intensity / 255) * 0.85;
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

  // Countdown-done: flash all key LEDs until encoder press resets
  if (oledFlashKeys) {
    const age    = (now - oledFlashStart) / 1000;
    const flashOp = 0.35 + 0.35 * Math.sin(age * Math.PI * 5);
    for (const pos of BOARD_POSITIONS) {
      const el = document.getElementById("key-" + pos.idx);
      if (!el) continue;
      el.style.borderColor = `rgba(255,180,84,${flashOp.toFixed(3)})`;
      el.style.boxShadow   = `0 0 14px rgba(255,180,84,${(flashOp * 0.8).toFixed(3)})`;
      el.style.color       = "";
    }
    klAnimFrame = requestAnimationFrame(klAnimTick);
    return;
  }

  for (const pos of BOARD_POSITIONS) {
    const el = document.getElementById("key-" + pos.idx);
    if (!el) continue;

    const isSel  = selectedKeys.has(pos.idx);
    const result = computeKeyLedColor(pos.idx, pos.row, pos.col, elapsed, isSel);

    if (!result) {
      el.style.borderColor = isSel ? "transparent" : "";
      el.style.boxShadow   = isSel ? "none" : "";
      el.style.color       = "";
      continue;
    }

    const { rgb, opacity } = result;
    if (isSel) {
      el.style.borderColor = `rgba(${rgb},1)`;
      el.style.boxShadow   = `0 0 14px rgba(${rgb},${Math.min(0.99, opacity * 1.5).toFixed(3)}), 0 0 28px rgba(${rgb},${(opacity * 0.8).toFixed(3)})`;
      el.style.color       = `rgba(${rgb},1)`;
    } else {
      el.style.borderColor = `rgba(${rgb},${Math.min(0.99, opacity).toFixed(3)})`;
      el.style.boxShadow   = `0 0 8px rgba(${rgb},${(opacity * 0.6).toFixed(3)})`;
      el.style.color       = "";
    }
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
    btn.textContent = "Saving…";
    btn.disabled = true;
    try {
      // Push first, THEN commit. eeprom_commit only persists the LED block the
      // board already holds in RAM, so committing without pushing just re-saves
      // stale state — and it never touches the keymap or the OLED at all.
      await pushStateToBoard();
      await invoke("eeprom_commit");
      btn.textContent = "Saved ✓";
    } catch (e) {
      console.warn("save to board failed", e);
      btn.textContent = _wasConnected ? "Failed" : "No Board";
    } finally {
      setTimeout(() => { btn.textContent = "Save to Board"; btn.disabled = false; }, 1500);
    }
  });

  // ── Home page ─────────────────────────────────────────────────────────────
  const savedSpecialEnter = localStorage.getItem(SPECIAL_ENTER_KEY);
  if (savedSpecialEnter !== null && savedSpecialEnter !== "null") {
    const v = parseInt(savedSpecialEnter, 10);
    if (Number.isFinite(v)) specialEnterIdx = v;
  }
  document.getElementById("home-add")?.addEventListener("click", scanForDevices);
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
    scheduleLiveSync("leds");
  });

  renderOverlayBtn();

  const status  = await invoke("board_status");
  _wasConnected = !!status?.connected;
  renderConnPill(_wasConnected);

  // Backend events: inbound HOST(n) results, and board attach/detach. The
  // attach/detach event is what makes plugging a board in mid-session work —
  // the backend supervises USB for the whole run, not just at startup.
  if (hasTauri) {
    try {
      const { listen } = await import("@tauri-apps/api/event");
      await listen("host-cmd", (e) => {
        const p = e.payload || {};
        console.log("host-cmd", p.ok ? `HOST(${p.index}) exit ${p.status}` : `HOST(${p.index}) failed: ${p.error || ""}`);
      });
      await listen("board-connection", (e) => {
        const connected = !!e.payload?.connected;
        console.log("board-connection", connected ? "attached" : "detached");
        onConnectionChange(connected);
      });
    } catch (e) { console.warn("event listen failed", e); }
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
    klIntensity = a.intensity ?? klIntensity;
  } catch {}
  renderKlAnimChips();
  document.getElementById("kl-rate").value      = klRate;
  document.getElementById("kl-intensity").value = klIntensity;

  const savedKlPalette = localStorage.getItem(KL_PALETTE_KEY);
  if (savedKlPalette) try { klPalette = JSON.parse(savedKlPalette); } catch {}
  renderPalette("kl-palette", klPalette, KL_PALETTE_KEY, saveCurrentKeyAnimState);

  const savedPerKey = localStorage.getItem(KL_PER_KEY);
  if (savedPerKey) try {
    const loaded = JSON.parse(savedPerKey);
    if (loaded) applyAnimState(animFromStored(loaded));
  } catch {}

  const savedUgPalette = localStorage.getItem(UG_PALETTE_KEY);
  if (savedUgPalette) try { ugPalette = JSON.parse(savedUgPalette); } catch {}
  renderPalette("ug-palette", ugPalette, UG_PALETTE_KEY, () => {});

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
  keyIconLabels  = bootLayer.icons ? [...bootLayer.icons] : Array(21).fill("");
  keyIconImages  = bootLayer.iconImages ? [...bootLayer.iconImages] : Array(21).fill(null);
  if (bootLayer.animStates) {
    try { applyAnimState(animFromStored(bootLayer.animStates)); } catch {}
  }
  if (bootLayer.underglow) applyUnderglowSnapshot(bootLayer.underglow);
  activeProfileId = bootLayer.id;
  await invoke("set_keymap", { map: keymap });

  // Restore OLED custom screens + countdown settings + back key
  try { oledCustomScreens = JSON.parse(localStorage.getItem(OLED_CUSTOM_KEY) || "[]"); } catch {}
  try {
    const c = JSON.parse(localStorage.getItem(OLED_CD_KEY) || "{}");
    oledCdH = c.h ?? 0; oledCdM = c.m ?? 0; oledCdS = c.s ?? 0;
  } catch {}
  const savedBack = localStorage.getItem(OLED_BACK_KEY);
  if (savedBack !== null) oledBackKeyIdx = Number(savedBack);
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

  // ── Saved Layers ──────────────────────────────────────────────────────────
  const slWrap       = document.getElementById("sl-wrap");
  const slDropdown   = document.getElementById("sl-dropdown");
  const slPlus       = document.getElementById("sl-plus");
  const slNewRow     = document.getElementById("sl-new-row");
  const slNewInput   = document.getElementById("sl-new-input");
  const slImportFile = document.getElementById("sl-import-file");

  slImportFile?.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (file) importLayer(file);
    e.target.value = "";
  });

  function openDropdown() {
    slDropdown.style.display = "flex"; // inline style survives CSS hover loss during drag
    if (!dragSrcId) renderSavedLayers();
  }

  function closeDropdown() {
    slDropdown.style.display = "";
    slNewRow.classList.remove("open");
    slNewInput.classList.remove("error");
  }

  slWrap.addEventListener("mouseenter", openDropdown);

  slWrap.addEventListener("mouseleave", () => {
    // Defer so dragstart can fire and set dragSrcId before we evaluate.
    // In Chromium, mouseleave fires before dragstart, so without setTimeout
    // dragSrcId is still null and the dropdown closes before the drag begins.
    setTimeout(() => {
      if (dragSrcId || slWrap.matches(":hover")) return;
      closeDropdown();
    }, 0);
  });

  // + click: add a new blank layer immediately, then open rename input
  slPlus.addEventListener("click", (e) => {
    e.stopPropagation();
    const layers = getSavedLayers();
    const defaultName = `Layer ${String(layers.length + 1).padStart(2, "0")}`;
    switchToBlankLayer();
    saveCurrentAsLayer(defaultName);
    renderSavedLayers();
    slNewInput.value = defaultName;
    slNewInput.select();
    slNewInput.classList.remove("error");
    slNewRow.classList.add("open");
    slNewInput.focus();
  });

  // Typing in the rename input renames the active layer live; Enter confirms
  slNewInput.addEventListener("input", () => {
    const name = slNewInput.value.trim();
    if (name && activeProfileId) {
      renameSavedLayer(activeProfileId, name);
      renderBoard(); // refresh OLED
      renderSavedLayers();
    }
  });

  slNewInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const name = slNewInput.value.trim();
    if (!name) { slNewInput.classList.add("error"); return; }
    slNewInput.classList.remove("error");
    renameSavedLayer(activeProfileId, name);
    slNewRow.classList.remove("open");
    renderSavedLayers();
    renderBoard();
  });

  document.addEventListener("mousedown", (e) => {
    dragStartPos = { x: e.clientX, y: e.clientY };
    dragFromKey  = !!e.target.closest(".key, .encoder-knob");
    clickStartedInKeyPill = !!e.target.closest("#key-pills");
  });
  document.addEventListener("mousemove", (e) => {
    if (!dragStartPos || isDragging || !dragFromKey) return;
    const dx = e.clientX - dragStartPos.x;
    const dy = e.clientY - dragStartPos.y;
    if (dx * dx + dy * dy > 25) isDragging = true; // 5px threshold
  });
  document.addEventListener("mouseup", () => { wasDragging = isDragging; isDragging = false; dragStartPos = null; dragFromKey = false; });
  window.addEventListener("blur", () => { wasDragging = false; isDragging = false; dragStartPos = null; dragFromKey = false; });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      keySelectionOrder = [];
      selectedKeys.clear();
      closeKeyLedPill();
      closeUnderglowPill();
      closeOledPill();
      renderBoard();
    }
  });

  // ── Underglow ring click ───────────────────────────────────────────────────
  document.getElementById("board-ring").addEventListener("click", (e) => {
    if (e.target.closest(".key, .encoder-knob, .oled-panel, .ug-corner, .board")) return;
    const isOpen = document.getElementById("underglow-pill").classList.contains("visible");
    if (isOpen) {
      closeUnderglowPill();
    } else {
      openUnderglowPill();
    }
  });

  // ── Close pills when clicking outside board-ring / pill ──────────────────
  document.addEventListener("click", (e) => {
    if (wasDragging) { wasDragging = false; return; }
    if (clickStartedInKeyPill) { clickStartedInKeyPill = false; return; }
    if (e.target.closest("#board-ring, #underglow-pill, #key-pills, #oled-pill")) return;
    closeUnderglowPill();
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

  // ── Key LED Advanced toggle ────────────────────────────────────────────────
  document.getElementById("kl-adv-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    const adv     = document.getElementById("kl-advanced");
    const arrow   = document.getElementById("kl-adv-arrow");
    const btn     = document.getElementById("kl-adv-btn");
    const opening = !adv.classList.contains("open");
    adv.classList.toggle("open", opening);
    btn.classList.toggle("open", opening);
    arrow.textContent = opening ? "▾" : "▸";
  });

  document.getElementById("kl-rate").addEventListener("input", (e) => {
    klRate = Number(e.target.value); saveKlAdvancedState();
  });
  document.getElementById("kl-intensity").addEventListener("input", (e) => {
    klIntensity = Number(e.target.value); saveKlAdvancedState();
  });

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

  // ── Back key assignment ───────────────────────────────────────────────────
  document.getElementById("kc-back-assign").addEventListener("click", () => {
    const [idx] = selectedKeys;
    if (idx === undefined) return;
    oledBackKeyIdx = idx;
    localStorage.setItem(OLED_BACK_KEY, String(idx));
    updateBackKeyRow();
    renderBoard();
  });
  document.getElementById("kc-back-clear").addEventListener("click", () => {
    oledBackKeyIdx = null;
    localStorage.removeItem(OLED_BACK_KEY);
    updateBackKeyRow();
    renderBoard();
  });

  // ── Per-key macro binding ─────────────────────────────────────────────────
  document.getElementById("kc-macro-select")?.addEventListener("change", (e) => {
    const [idx] = selectedKeys;
    if (idx === undefined) return;
    bindMacroToKey(idx, e.target.value || null);
  });

  // ── Special Enter assignment ──────────────────────────────────────────────
  document.getElementById("kc-enter-assign").addEventListener("click", () => {
    const [idx] = selectedKeys;
    if (idx === undefined) return;
    specialEnterIdx = idx;
    localStorage.setItem(SPECIAL_ENTER_KEY, String(idx));
    updateSpecialEnterRow();
    renderBoard();
  });
  document.getElementById("kc-enter-clear").addEventListener("click", () => {
    // Clearing means "use the encoder push" — only meaningful on hardware that
    // has one, so refuse where the product table says it does not.
    if (document.body.classList.contains("no-encoder-push")) {
      console.warn("this hardware revision has no encoder push; Special Enter must be a key");
      return;
    }
    specialEnterIdx = null;
    localStorage.removeItem(SPECIAL_ENTER_KEY);
    updateSpecialEnterRow();
    renderBoard();
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

  document.getElementById("kl-icon").addEventListener("input", (e) => {
    const val = [...e.target.value].slice(0, 2).join(""); // safe emoji-aware slice
    e.target.value = val;
    for (const idx of selectedKeys) {
      keyIconLabels[idx] = val;
      if (val) keyIconImages[idx] = null; // text replaces image
    }
    if (selectedKeys.size === 1) updateIconPreview([...selectedKeys][0]);
    renderBoard();
    // Icons are host-side only, so they never reach scheduleLiveSync — they
    // need saving explicitly or they are lost on restart.
    scheduleAutoSave();
  });

  document.getElementById("kl-icon-file")?.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const url = await readFileAsDataUrl(file);
    const ok  = await checkImageSize(url);
    if (!ok) { alert("Image must be 128×128 pixels or smaller."); e.target.value = ""; return; }
    for (const idx of selectedKeys) {
      keyIconImages[idx] = url;
      keyIconLabels[idx] = "";
    }
    document.getElementById("kl-icon").value = "";
    if (selectedKeys.size === 1) updateIconPreview([...selectedKeys][0]);
    renderBoard();
    scheduleAutoSave();
    e.target.value = "";
  });

  document.getElementById("kc-icon-clear")?.addEventListener("click", () => {
    for (const idx of selectedKeys) keyIconImages[idx] = null;
    if (selectedKeys.size === 1) updateIconPreview([...selectedKeys][0]);
    renderBoard();
    scheduleAutoSave();
  });

  // ── OLED pill controls ────────────────────────────────────────────────────
  document.getElementById("oled-nav-prev").addEventListener("click", (e) => {
    e.stopPropagation(); oledScreenNav(-1); renderOledPill();
  });
  document.getElementById("oled-nav-next").addEventListener("click", (e) => {
    e.stopPropagation(); oledScreenNav(1); renderOledPill();
  });
  document.getElementById("oled-add-screen").addEventListener("click", (e) => {
    e.stopPropagation();
    openScreenPicker();
  });

  // OLED font picker
  document.getElementById("oled-font-btns").addEventListener("click", (e) => {
    const btn = e.target.closest(".oled-font-btn");
    if (btn) { e.stopPropagation(); applyOledFont(btn.dataset.font); }
  });
  applyOledFont(oledFontId);
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
  loadKeyAnimState(keyIdx);
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
      enc.addEventListener("mousedown", (e) => { e.preventDefault(); onKeyDown(pos.idx); });
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
      const isBackKey      = pos.idx === oledBackKeyIdx;
      const bsk            = currentOledScreenKey();
      const bScreenEvMap   = bsk ? (oledEventKeys[bsk] || {}) : {};
      const evEntry        = Object.values(bScreenEvMap).find(v => evIdx(v) === pos.idx);
      const isEventKey     = !!evEntry;
      const isAssigning    = pendingEventAssign !== null && !isEventKey && !isBackKey;
      k.className = "key"
        + (isSel ? " sel" : "")
        + (isEmpty ? " empty" : "")
        + (isCycleActive ? " oled-key-active" : "")
        + (isBackKey ? " oled-back-key" : "")
        + (isEventKey ? " oled-event-key" : "")
        + (isAssigning ? " oled-assigning" : "");
      k.style.cssText = `grid-row:${pos.row};grid-column:${pos.col}`;
      if (isEventKey) {
        const { r, g, b } = hexToRgb(evColor(evEntry));
        k.style.setProperty("--oled-ev-color", `rgba(${r},${g},${b},0.75)`);
      }
      const icon = keyIconLabels[pos.idx];
      const imgSrc = keyIconImages[pos.idx];
      if (imgSrc) {
        const imgEl = document.createElement("img");
        imgEl.src = imgSrc;
        imgEl.className = "key-icon-img";
        k.appendChild(imgEl);
      } else {
        // Label priority: uploaded image > icon > macro name > keycode.
        // An icon is an explicit choice about how this key should read, so it
        // outranks the macro name even when a macro is bound.
        const macroName = keyMacros[pos.idx]
          ? (findMacroById(keyMacros[pos.idx])?.name ?? null)
          : null;
        const usingMacroName = !icon && !!macroName;
        const label = document.createElement("span");
        // Macro names are free text and far longer than a keycode, so they get
        // the smaller, wrapping treatment.
        label.className = "key-label" + (usingMacroName ? " macro" : "");
        label.textContent = icon || macroName || (isEmpty ? "·" : kc.replace(/^KC_/, ""));
        k.appendChild(label);
      }
      k.addEventListener("mousedown", (e) => { e.preventDefault(); onKeyDown(pos.idx); });
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
  const isBackExit  = oledBackKeyIdx === idx && oledSubMode !== "nav";

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

  loadKeyAnimState(idx);
  closeUnderglowPill();
  closeOledPill();
  syncKeyLedPill();
  openKeyLedPill();
  flashKey(idx);

  // Fire the OLED role AFTER selecting, so the key is configurable either way.
  // Back-key exit wins over an event binding: leaving a sub-mode is the more
  // specific intent when a key happens to be both.
  if (isBackExit) {
    oledSubMode = "nav";
    oledKeyCycleIdx = 0;
    updateOledDisplay();
    renderBoard();
    // renderBoard() rebuilt the DOM, so re-apply the selection highlight.
    document.getElementById("key-" + idx)?.classList.add("sel");
  } else if (eventHit) {
    triggerOledEvent(eventHit[0]);
    document.getElementById("key-" + idx)?.classList.add("sel");
  }
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

function updateBackKeyRow() {
  const row = document.getElementById("kc-back-row");
  if (!row) return;
  const n = selectedKeys.size;
  const single = n === 1 && !selectedKeys.has(ENCODER_IDX);
  document.getElementById("kc-layer-events").style.display = single ? "" : "none";
  if (!single) return;
  const [idx] = selectedKeys;
  const isBack = oledBackKeyIdx === idx;
  document.getElementById("kc-back-val").textContent = isBack ? `Key ${idx}` : "—";
  document.getElementById("kc-back-assign").style.display = isBack ? "none" : "";
  document.getElementById("kc-back-clear").style.display  = isBack ? "" : "none";
  updateSpecialEnterRow();
  renderKeyMacroRow();
}

// Shown for a single selected key, same as the back-key row. Displays 1-based
// key numbers to match the board's Present Keys screen.
function updateSpecialEnterRow() {
  const val = document.getElementById("kc-enter-val");
  if (!val) return;
  const single = selectedKeys.size === 1 && !selectedKeys.has(ENCODER_IDX);
  if (!single) return;
  const [idx] = selectedKeys;
  const isEnter = specialEnterIdx === idx;

  const row = document.getElementById("kc-enter-row");
  val.textContent = specialEnterIdx === null
    ? "Encoder push"
    : `Key ${specialEnterIdx + 1}${isEnter ? "" : " (elsewhere)"}`;

  // Being Special Enter is only a default, and it constrains nothing: the key
  // keeps its own keycode, macro, icon and LED like any other. "Set" simply
  // moves the role here.
  if (row) {
    row.title = isEnter
      ? "This key is Special Enter. It is still fully configurable — press Set on another key to move the role."
      : "Special Enter is the confirm action. Press Set to move it to this key.";
  }
  document.getElementById("kc-enter-assign").style.display = isEnter ? "none" : "";
  // Clearing means "fall back to the encoder push", which is only possible on
  // hardware that has one.
  const canClear = isEnter && !document.body.classList.contains("no-encoder-push");
  document.getElementById("kc-enter-clear").style.display = canClear ? "" : "none";
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
    document.getElementById("kl-icon").value = keyIconLabels[idx] || "";
    const col = keyLedColors[idx];
    document.getElementById("kl-color").value = col || "#ffffff";
    updateIconPreview(idx);
  } else {
    document.getElementById("kl-kc").value   = "";
    document.getElementById("kl-icon").value = "";
    const colors = [...selectedKeys].map(i => keyLedColors[i]).filter(c => !!c);
    document.getElementById("kl-color").value =
      (colors.length && colors.every(c => c === colors[0])) ? colors[0] : "#ffffff";
    updateIconPreview(null);
  }
  updateKlColorVars();
  updateBackKeyRow();
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

function saveCurrentLayerState() {
  if (!activeProfileId) return;
  const layers = getSavedLayers();
  const cur = layers.find(l => l.id === activeProfileId);
  if (!cur) return;
  cur.keymap     = structuredClone(keymap);
  cur.leds       = [...keyLedColors];
  cur.icons      = [...keyIconLabels];
  cur.iconImages = [...keyIconImages];
  // Kept with the layer: the layer owns the keymap, and MACRO(n) keycodes are
  // meaningless without the bindings that produced them.
  cur.keyMacros  = [...keyMacros];
  cur.animStates = currentAnimState();
  cur.underglow  = currentUnderglowSnapshot();
  localStorage.setItem(layersKeyScoped(), JSON.stringify(layers));
}

function saveCurrentAsLayer(name) {
  const layers = getSavedLayers();
  const id = Date.now().toString();
  layers.push({
    id, name,
    keymap:     structuredClone(keymap),
    leds:       [...keyLedColors],
    icons:      [...keyIconLabels],
    iconImages: [...keyIconImages],
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

function setLayerShowTitle(id, show) {
  const layers = getSavedLayers();
  const layer = layers.find(l => l.id === id);
  if (layer) {
    layer.showTitle = show;
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

  renderSavedLayers();
  renderBoard();
}

function exportLayer(layer) {
  const data = JSON.stringify({ ...layer, exportedAt: new Date().toISOString() }, null, 2);
  const blob = new Blob([data], { type: "application/json" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `${layer.name.replace(/\s+/g, "-").toLowerCase()}-config.json`;
  a.click();
  URL.revokeObjectURL(url);
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
      renderSavedLayers();
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
  saveCurrentLayerState();
  const layer = getSavedLayers().find(l => l.id === id);
  if (!layer) return;
  keymap         = sanitizeKeymap(structuredClone(layer.keymap));
  keyLedColors   = [...layer.leds];
  keyIconLabels  = layer.icons ? [...layer.icons] : Array(21).fill("");
  keyIconImages  = layer.iconImages ? [...layer.iconImages] : Array(21).fill(null);
  keyMacros      = layer.keyMacros ? [...layer.keyMacros] : Array(21).fill(null);
  applyAnimState(animFromStored(layer.animStates));
  applyUnderglowSnapshot(layer.underglow ?? null);
  activeProfileId = id;
  keySelectionOrder = [];
  selectedKeys.clear();
  closeKeyLedPill();
  renderBoard();
  flashBoard();
  await invoke("set_keymap", { map: keymap });
  renderSavedLayers();
  if (!silent) {
    const slNewRow   = document.getElementById("sl-new-row");
    const slNewInput = document.getElementById("sl-new-input");
    slNewInput.value = layer.name;
    slNewInput.classList.remove("error");
    slNewRow.classList.add("open");
    slNewInput.select();
    slNewInput.focus();
  }
}

function switchToBlankLayer() {
  saveCurrentLayerState();
  keymap         = { layers: Array.from({ length: 4 }, () => ({ keys: Array(21).fill("KC_NO") })) };
  keyLedColors   = Array.from({ length: 21 }, () => "#ffffff");
  keyIconImages  = Array(21).fill(null);
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

function renderSavedLayers() {
  const list = document.getElementById("sl-list");
  const layers = getSavedLayers();

  if (layers.length === 0) {
    list.innerHTML = `<div style="color:var(--muted);font-size:12px;text-align:center;padding:6px 0">No saved layers yet</div>`;
    return;
  }

  list.innerHTML = "";
  for (const [i, layer] of layers.entries()) {
    const item = document.createElement("div");
    item.className = "sl-item" + (layer.id === activeProfileId ? " active-profile" : "");
    item.dataset.layerId = layer.id;

    const idx = document.createElement("span");
    idx.className = "sl-item-idx";
    idx.textContent = String(i + 1).padStart(2, "0");

    const name = document.createElement("span");
    name.className = "sl-item-name";
    name.textContent = layer.name;

    const exp = document.createElement("button");
    exp.className = "sl-exp";
    exp.textContent = "↓";
    exp.title = "Export as JSON";
    exp.addEventListener("click", (e) => { e.stopPropagation(); exportLayer(layer); });

    const del = document.createElement("button");
    del.className = "sl-del";
    del.textContent = "✕";
    del.title = "Delete";
    del.addEventListener("click", (e) => { e.stopPropagation(); deleteSavedLayer(layer.id); });

    item.appendChild(idx);
    item.appendChild(name);
    item.appendChild(exp);
    item.appendChild(del);

    // Switch on click
    item.addEventListener("click", () => switchToLayer(layer.id));

    // Drag to reorder — mouse-event based because WebView2 (Tauri/Windows) intercepts
    // the HTML5 dragover event at the OS level for file-drop, so drag/drop never fires.
    item.addEventListener("mousedown", (e) => {
      if (e.target.closest(".sl-del")) return;
      e.preventDefault();

      dragSrcId = layer.id;
      item.classList.add("dragging");

      const rect = item.getBoundingClientRect();
      const offsetY = e.clientY - rect.top;

      const ghost = item.cloneNode(true);
      Object.assign(ghost.style, {
        position: "fixed", pointerEvents: "none", zIndex: "9999",
        opacity: "0.85", width: rect.width + "px",
        left: rect.left + "px", top: (e.clientY - offsetY) + "px",
        margin: "0", borderRadius: "8px",
        background: "rgba(255,180,84,0.15)",
        boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
      });
      document.body.appendChild(ghost);

      const onMove = (me) => {
        ghost.style.top = (me.clientY - offsetY) + "px";
        ghost.style.visibility = "hidden";
        const target = document.elementFromPoint(me.clientX, me.clientY)?.closest("[data-layer-id]");
        ghost.style.visibility = "";
        list.querySelectorAll(".drag-over").forEach(el => el.classList.remove("drag-over"));
        if (target && target.dataset.layerId !== layer.id) target.classList.add("drag-over");
      };

      const onUp = (ue) => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        ghost.remove();
        item.classList.remove("dragging");
        list.querySelectorAll(".drag-over").forEach(el => el.classList.remove("drag-over"));

        const target = document.elementFromPoint(ue.clientX, ue.clientY)?.closest("[data-layer-id]");
        if (target && target.dataset.layerId !== layer.id) {
          reorderLayers(layer.id, target.dataset.layerId);
          renderSavedLayers();
        }

        dragSrcId = null;
        setTimeout(() => {
          if (dragSrcId || document.getElementById("sl-wrap").matches(":hover")) return;
          closeDropdown();
        }, 0);
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });

    list.appendChild(item);
  }
}

function openKeyLedPill()  { document.getElementById("key-pills").classList.add("visible"); }
function closeKeyLedPill() {
  document.getElementById("key-pills").classList.remove("visible");
  document.getElementById("kl-advanced").classList.remove("open");
  document.getElementById("kl-adv-btn").classList.remove("open");
  document.getElementById("kl-adv-arrow").textContent = "▸";
  document.getElementById("kc-advanced").classList.remove("open");
  document.getElementById("kc-adv-btn").classList.remove("open");
  document.getElementById("kc-adv-arrow").textContent = "▸";
}
function openOledPill()    { document.getElementById("oled-pill").classList.add("visible"); renderOledPill(); }
function closeOledPill() {
  document.getElementById("oled-pill").classList.remove("visible");
  if (pendingEventAssign !== null) { pendingEventAssign = null; renderBoard(); }
}

function openScreenPicker() {
  if (document.getElementById("oled-screen-picker")) return;
  const existing = new Set(oledCustomScreens.map(s => s.type));

  const TYPES = [
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
        <div style="font-size:6px;opacity:.25">↓ cycle field</div></div>`,
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
    for (const type of selected) {
      const s = { id: `${Date.now()}-${i++}`, type };
      if (type === "custom") { s.title = ""; s.body = ""; s.imageDataUrl = null; }
      if (type === "gif")    { s.imageDataUrl = null; }
      oledCustomScreens.push(s);
    }
    saveOledCustomScreens();
    oledScreenIdx = getOledScreens().length - 1;
    close();
    updateOledDisplay();
    renderOledPill();
  });

  document.body.appendChild(overlay);
}

function closeScreenPicker() {
  const el = document.getElementById("oled-screen-picker");
  if (!el) return;
  if (el._removeKey) el._removeKey();
  el.remove();
}

function openUnderglowPill() {
  keySelectionOrder = [];
  selectedKeys.clear();
  closeKeyLedPill();
  closeOledPill();
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

function buildLedState() {
  return {
    keys: keyLedColors.map(hexToRgbArr),
    underglow: cornerColors.slice(0, 4).map(hexToRgbArr),
    brightness: ledBrightness,
  };
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
  };
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
    console.warn("oled image upload failed", e);
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
  try { await invoke("oled_push", { config: buildOledConfig() }); }
  catch (e) { console.warn("oled_push failed", e); }
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
    if (parts.has("anim")) await invoke("set_anim", { anim: buildAnimState() });
    if (parts.has("oled")) {
      await invoke("oled_push", { config: buildOledConfig() });
      // Not forced: skips the multi-second transfer unless the image changed.
      await pushImageToBoard(false);
    }
  } catch (e) {
    console.warn("live sync failed", e);
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
      ? `<div class="device-warn">No encoder push on this revision — key ${
          (d.default_special_enter ?? 0) + 1} acts as Special Enter</div>`
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
        <button class="device-del" title="Remove this device from the list">✕</button>
      </div>`;
    card.addEventListener("click", () => enterEditor(d));
    // stopPropagation, or removing a device would also open its editor.
    card.querySelector(".device-del").addEventListener("click", (e) => {
      e.stopPropagation();
      removeDevice(d);
    });
    list.appendChild(card);
  }
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
  product_name: "Macro Pad Pro (demo)",
  hardware: "1.0.0",
  firmware: "0.2.0",
  transport: "usb",
  connected: false,
  known_product: true,
  capabilities: { encoder_push: false, key_count: 21, led_count: 25, layer_count: 4, has_oled: true, has_underglow: true },
  default_special_enter: 5,
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
    console.warn("device scan failed", e);
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

function enterEditor(device) {
  activeDevice = device;
  // Load BEFORE anything renders, so the editor never shows another device's
  // configuration for a frame.
  loadDeviceState();
  document.body.classList.add("editor");
  applyDeviceCapabilities(device);
  renderActiveDeviceInfo();
  syncUnderglowUI();
  renderKlAnimChips();
  renderOverlayBtn();
  renderBrightness();
  const brightInp = document.getElementById("led-brightness");
  if (brightInp) brightInp.value = String(ledBrightness);
  renderSavedLayers();
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
    ? `<div class="app-device-warn">No encoder push — key ${(d.default_special_enter ?? 0) + 1} is Special Enter</div>`
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
  document.body.classList.toggle("no-encoder-push", !!noPush);
  if (noPush && specialEnterIdx === null) {
    // Default the stand-in to the key the product table names.
    specialEnterIdx = device.default_special_enter ?? null;
    localStorage.setItem(SPECIAL_ENTER_KEY, String(specialEnterIdx));
  }
}

// ── Per-key macro binding ───────────────────────────────────────────────────
// A key can carry one macro from the Home page libraries. Binding does two
// things: it reserves one of the board's 16 dynamic macro slots for that macro,
// and it sets the key's keycode to MACRO(slot).
//
// Slots are DERIVED from the current bindings rather than stored, so they can
// never drift out of step with what is actually assigned. The cost is that
// slot numbers can shift when a binding is removed — which is fine, because the
// keycodes are recomputed in the same pass.
//
// Note the board's macro CONTENT still cannot be written over the wire (that
// needs VIA's dynamic_keymap_macro buffer commands). So this assigns the
// keycode and reserves the slot; the macro body is authored in Vial for now.
// The UI says so rather than implying the whole round trip works.
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
// Keystroke and shell macros use SEPARATE slot spaces because they ride
// different keycodes: keystrokes are MACRO(n), driven by the board's dynamic
// macros, while shell scripts are HOST(n), which the board reports to the app
// so `runner.rs` can execute them here. Sharing one counter would waste slots
// in both spaces and mismatch the indices the runner expects.
function macroSlotMap() {
  const map = new Map();
  let nKeys = 0, nShell = 0;
  for (const id of keyMacros) {
    if (!id || map.has(id)) continue;
    const m = findMacroById(id);
    if (!m) continue;
    if (macroKind(m) === "shell") {
      if (nShell < MACRO_SLOT_COUNT) map.set(id, { kind: "shell", slot: nShell++ });
    } else if (nKeys < MACRO_SLOT_COUNT) {
      map.set(id, { kind: "keys", slot: nKeys++ });
    }
  }
  return map;
}

// Push the derived slots back into the keymap. Called after any binding change
// so the keycodes and the slot allocation are always consistent.
function applyMacroKeycodes() {
  if (!keymap) return;
  const slots = macroSlotMap();
  keyMacros.forEach((id, idx) => {
    if (!id) return;
    const s = slots.get(id);
    if (!s) return; // over the slot limit, or the macro is gone; left unbound
    keymap.layers[0].keys[idx] = s.kind === "shell" ? `HOST(${s.slot})` : `MACRO(${s.slot})`;
  });
}

// Hand the shell macros bound to keys to the backend, so a physical HOST(n)
// press has something to run. The board only ever sends an index — this is what
// gives that index meaning.
async function syncHostBindings() {
  const slots = macroSlotMap();
  const bindings = [];
  for (const [id, s] of slots) {
    if (s.kind !== "shell") continue;
    const m = findMacroById(id);
    if (!m) continue;
    bindings.push({
      index: s.slot,
      label: m.name || "Macro",
      command: [],
      script: m.script || "",
      cwd: m.cwd || null,
    });
  }
  try { await invoke("set_bindings", { bindings }); }
  catch (e) { console.warn("set_bindings failed", e); }
}

function bindMacroToKey(idx, macroId) {
  const previous = keyMacros[idx];
  keyMacros[idx] = macroId || null;

  if (!macroId) {
    // Clearing the macro should clear the keycode it owned, but must not stomp
    // a keycode the user set by hand afterwards.
    const kc = keymap?.layers[0]?.keys[idx] ?? "";
    if (previous && /^MACRO\(\d+\)$/.test(kc)) keymap.layers[0].keys[idx] = "KC_NO";
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
  if (slotEl) {
    slotEl.textContent = !s ? "" : (s.kind === "shell" ? `HOST(${s.slot})` : `MACRO(${s.slot})`);
  }

  if (note) {
    note.className = "kc-macro-note";
    if (!libs.some(l => (l.macros || []).length)) {
      note.textContent = "No macros yet — create one in the Macro Library on the Home page.";
    } else if (bound && !s) {
      note.className = "kc-macro-note warn";
      note.textContent = `Over the ${MACRO_SLOT_COUNT}-slot limit, so this one is not assigned.`;
    } else if (bound && macroKind(boundMacro) === "shell") {
      note.textContent = "Runs its script on this computer when pressed. Works fully — the board sends the binding index and the app executes it.";
    } else if (bound) {
      note.className = "kc-macro-note warn";
      note.textContent = "Keystroke macros need their steps authored in Vial — the app cannot write macro content to the board yet. Shell macros do not have this limitation.";
    } else {
      note.textContent = "";
    }
  }
}

// ── Per-device config persistence ───────────────────────────────────────────
// Everything the editor holds is saved automatically, scoped to the device it
// belongs to. Three problems this exists to fix:
//
//   1. `keyLedColors`, `keyIconLabels`, `keyIconImages` and `keymap` only ever
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
    keyIconLabels:  [...keyIconLabels],
    keyIconImages:  [...keyIconImages],
    keyMacros:      [...keyMacros],
    anim:           currentAnimState(),
    underglow:      currentUnderglowSnapshot(),
    selectedCorners: [...selectedCorners],
    encoderMode,
    ledBrightness,
    specialEnterIdx,
    activeProfileId,
    oled: {
      customScreens: oledCustomScreens,
      countdown:     { h: oledCdH, m: oledCdM, s: oledCdS },
      backKeyIdx:    oledBackKeyIdx,
      eventKeys:     oledEventKeys,
    },
  };
}

function persistDeviceState() {
  try {
    localStorage.setItem(deviceCfgKey(), JSON.stringify(snapshotDeviceState()));
  } catch (e) {
    // Quota is the realistic failure here — icon images are data URLs.
    console.warn("device config save failed", e);
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
  if (s.keyIconLabels)   keyIconLabels   = [...s.keyIconLabels];
  if (s.keyIconImages)   keyIconImages   = [...s.keyIconImages];
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
  // null is meaningful here (= use the encoder push), so only `undefined` falls back.
  if (s.specialEnterIdx !== undefined)   specialEnterIdx = s.specialEnterIdx;
  if (s.activeProfileId !== undefined)   activeProfileId = s.activeProfileId;

  if (s.oled) {
    if (Array.isArray(s.oled.customScreens)) oledCustomScreens = s.oled.customScreens;
    if (s.oled.countdown) {
      oledCdH = s.oled.countdown.h ?? 0;
      oledCdM = s.oled.countdown.m ?? 0;
      oledCdS = s.oled.countdown.s ?? 0;
    }
    if (s.oled.backKeyIdx !== undefined) oledBackKeyIdx = s.oled.backKeyIdx;
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
// These map onto QMK's own macro primitives (SS_TAP / SS_DOWN / SS_UP / delay /
// string), so the format stays translatable to what the board can execute once
// macro content can be written over the wire.
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

function createLibrary() {
  const name = prompt("Library name:", "New Library");
  if (name === null) return;
  const libs = getLibraries();
  const lib = { id: `lib${Date.now()}`, name: name.trim() || "New Library", description: "", macros: [] };
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
function exportActiveLibrary() {
  const lib = activeLibrary();
  if (!lib) return;
  const payload = {
    format: MACRO_FORMAT,
    version: MACRO_FORMAT_V,
    name: lib.name,
    description: lib.description || "",
    exportedAt: new Date().toISOString(),
    macros: lib.macros || [],
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${(lib.name || "library").replace(/[^\w-]+/g, "_")}.macrolib.json`;
  a.click();
  URL.revokeObjectURL(a.href);
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
    console.warn("macro import failed", e);
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
        await syncHostBindings();
        const slot = macroSlotMap().get(m.id)?.slot;
        const res = slot === undefined
          ? "Not bound to a key, so it has no host slot to run in. Bind it to a key first."
          : await invoke("run_binding", { index: slot });
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
// MACRO(n) keycode pointing at a slot that no longer means anything.
function releaseDeletedMacroBindings(removedIds) {
  let touched = false;
  keyMacros = keyMacros.map((id, idx) => {
    if (!id || !removedIds.has(id)) return id;
    touched = true;
    const kc = keymap?.layers[0]?.keys[idx] ?? "";
    if (/^MACRO\(\d+\)$/.test(kc)) keymap.layers[0].keys[idx] = "KC_NO";
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
  if (connected && !_wasConnected) {
    try { await applyActiveProfileToBoard(); }
    catch (e) { console.warn("apply on connect failed", e); }
  }
  _wasConnected = connected;
}

async function pollConnection() {
  try {
    const status = await invoke("board_status");
    await onConnectionChange(!!status?.connected);
  } catch {}
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
    catch (e) { console.warn("initial apply failed", e); }
  }
  setInterval(pollConnection, 3000);
});
