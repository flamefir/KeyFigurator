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
    case "is_connected": return true;
    case "get_keymap":   return structuredClone(browserState.keymap);
    case "set_keymap":   browserState.keymap = structuredClone(args.map); return;
    case "set_leds":     return;
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
let keyAnimStates = Array.from({ length: 21 }, mkKeyAnim);
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
let oledCdM          = 1;
let oledCdS          = 0;
let oledCdField      = "minutes";   // "hours" | "minutes" | "seconds"
let oledCdRunning    = false;
let oledCdStart      = 0;
let oledCdAcc        = 0;
let oledCdDone       = false;

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
];
const KC_ALL_FLAT = KC_CATEGORIES.flatMap(c => c.keys);

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
    case "custom": {
      if (screen.imageDataUrl) {
        screenEl.innerHTML = `<img class="oled-custom-img" src="${screen.imageDataUrl}" alt="" />`;
      } else {
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
        const pscreens = getOledScreens();
        if (pscreens[oledScreenIdx]?.type !== "layer") {
          const layerScrIdx = pscreens.findIndex(s => s.type === "layer" && s.layerId === activeProfileId);
          if (layerScrIdx !== -1) oledScreenIdx = layerScrIdx;
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
      } else {
        oledCdField   = "hours";
        oledCdStart   = performance.now();
        oledCdAcc     = 0;
        oledCdRunning = true;
        localStorage.setItem(OLED_CD_KEY, JSON.stringify({ h: oledCdH, m: oledCdM, s: oledCdS }));
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
    case "custom":    name = screen.title || "Custom Screen"; break;
  }
  const nameEl = document.getElementById("oled-screen-name");
  if (nameEl) nameEl.textContent = `${oledScreenIdx + 1} / ${screens.length} — ${name}`;

  const removable = ["timer", "countdown", "datetime", "custom"].includes(screen.type);
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
    case "custom": {
      const imgPreview = screen.imageDataUrl
        ? `<img class="oled-img-preview" src="${screen.imageDataUrl}" />`
        : `<div class="oled-img-placeholder">No image</div>`;
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
        <div class="oled-pill-section oled-img-row">
          <div class="oled-img-thumb">${imgPreview}</div>
          <label class="oled-upload-btn">Upload Image / GIF
            <input type="file" id="oled-img-upload" accept="image/*" style="display:none" />
          </label>
          <span class="oled-img-notice">max 128×128</span>
          ${screen.imageDataUrl ? `<button class="oled-img-clear" id="oled-img-clear">✕</button>` : ""}
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
      document.getElementById("oled-img-upload")?.addEventListener("change", async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const url = await readFileAsDataUrl(file);
        const ok  = await checkImageSize(url);
        if (!ok) { alert("Image must be 128×128 pixels or smaller."); return; }
        screen.imageDataUrl = url;
        saveOledCustomScreens(); renderOledPillContent(); updateOledDisplay();
      });
      document.getElementById("oled-img-clear")?.addEventListener("click", () => {
        screen.imageDataUrl = null; saveOledCustomScreens(); renderOledPillContent(); updateOledDisplay();
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

  // Throttle live updates to ~4fps (timers only update per-second anyway)
  const screens = getOledScreens();
  const s       = screens[oledScreenIdx];
  const live    = (s?.type === "timer" && oledTimerRunning)
               || (s?.type === "countdown" && oledCdRunning)
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
  const anim  = (keyAnimStates[idx] ?? mkKeyAnim()).animation;
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

function saveCurrentKeyAnimState() {
  for (const idx of selectedKeys) {
    keyAnimStates[idx] = { animation: klAnimation, rate: klRate, intensity: klIntensity, palette: [...klPalette] };
  }
  localStorage.setItem(KL_PER_KEY, JSON.stringify(keyAnimStates));
  updateKlColorVars();
}

function updateKlColorVars() {
  const hex = document.getElementById("kl-color")?.value || "#ffffff";
  document.documentElement.style.setProperty("--kl-color", hexToRgbTriple(hex));
  const cycleHex = klPalette.length > 0 ? klPalette[0] : hex;
  document.documentElement.style.setProperty("--kl-cycle-color", hexToRgbTriple(cycleHex));
  const dur = (0.3 + (klRate / 255) * 7.7).toFixed(2);
  document.documentElement.style.setProperty("--kl-anim-dur", dur + "s");
}

function loadKeyAnimState(idx) {
  const s = keyAnimStates[idx] ?? mkKeyAnim();
  klAnimation = s.animation;
  klRate      = s.rate;
  klIntensity = s.intensity;
  klPalette   = [...s.palette];
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
  const duration = 0.3 + (ugRate / 255) * 7.7;
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
  const s = isSel
    ? { animation: klAnimation, rate: klRate, intensity: klIntensity, palette: klPalette }
    : (keyAnimStates[idx] ?? mkKeyAnim());
  const { animation, rate, intensity, palette } = s;

  const duration = 0.3 + (rate / 255) * 7.7;
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
    const dur = 0.3 + (klRate / 255) * 7.7;
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
      await invoke("eeprom_commit");
      btn.textContent = "Saved ✓";
      setTimeout(() => { btn.textContent = "Save to Board"; btn.disabled = false; }, 1500);
    } catch {
      btn.textContent = "No Board";
      setTimeout(() => { btn.textContent = "Save to Board"; btn.disabled = false; }, 1500);
    }
  });

  const connected = await invoke("is_connected");
  _wasConnected   = connected;
  const connPill = document.getElementById("conn");
  connPill.textContent = connected ? "● connected (mock)" : "○ no device";
  connPill.classList.toggle("ok", connected);

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
    if (Array.isArray(loaded) && loaded.length === 21) keyAnimStates = loaded;
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
  keymap         = structuredClone(bootLayer.keymap);
  keyLedColors   = [...bootLayer.leds];
  keyIconLabels  = bootLayer.icons ? [...bootLayer.icons] : Array(21).fill("");
  keyIconImages  = bootLayer.iconImages ? [...bootLayer.iconImages] : Array(21).fill(null);
  if (bootLayer.animStates) {
    try { keyAnimStates = JSON.parse(JSON.stringify(bootLayer.animStates)); } catch {}
  }
  if (bootLayer.underglow) applyUnderglowSnapshot(bootLayer.underglow);
  activeProfileId = bootLayer.id;
  await invoke("set_keymap", { map: keymap });

  // Restore OLED custom screens + countdown settings + back key
  try { oledCustomScreens = JSON.parse(localStorage.getItem(OLED_CUSTOM_KEY) || "[]"); } catch {}
  try {
    const c = JSON.parse(localStorage.getItem(OLED_CD_KEY) || "{}");
    oledCdH = c.h ?? 0; oledCdM = c.m ?? 1; oledCdS = c.s ?? 0;
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
      await renderHostBindings();
      if (selectedKeys.size === 1) updateIconPreview([...selectedKeys][0]);
    }
  });

  document.getElementById("kc-search").addEventListener("input", (e) => renderKcPalette(e.target.value));

  document.getElementById("hb-add").addEventListener("click", async () => {
    const bindings = await invoke("get_bindings");
    const maxIdx   = bindings.reduce((m, b) => Math.max(m, b.index), -1);
    bindings.push({ index: maxIdx + 1, label: "New Command", command: ["echo", "hello"], cwd: null });
    await invoke("set_bindings", { bindings });
    await renderHostBindings();
  });

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
  });

  document.getElementById("kl-kc").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const val = e.target.value.trim() || "KC_NO";
      for (const idx of selectedKeys) keymap.layers[0].keys[idx] = val;
      renderBoard();
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
    e.target.value = "";
  });

  document.getElementById("kc-icon-clear")?.addEventListener("click", () => {
    for (const idx of selectedKeys) keyIconImages[idx] = null;
    if (selectedKeys.size === 1) updateIconPreview([...selectedKeys][0]);
    renderBoard();
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
        const label = document.createElement("span");
        label.className = "key-label";
        label.textContent = icon || (isEmpty ? "·" : kc.replace(/^KC_/, ""));
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

  // Event key: trigger the bound OLED event for the current screen
  const sk        = currentOledScreenKey();
  const screenEvMap = sk ? (oledEventKeys[sk] || {}) : {};
  const eventHit  = Object.entries(screenEvMap).find(([, v]) => evIdx(v) === idx);
  if (eventHit) { triggerOledEvent(eventHit[0]); return; }

  // Back key pressed while in OLED sub-mode — exit to nav without touching LED selection.
  if (oledBackKeyIdx === idx && oledSubMode !== "nav") {
    oledSubMode = "nav";
    oledKeyCycleIdx = 0;
    updateOledDisplay();
    renderBoard();
    return;
  }

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
  try { return JSON.parse(localStorage.getItem(LAYERS_KEY) || "[]"); }
  catch { return []; }
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
  cur.animStates = JSON.parse(JSON.stringify(keyAnimStates));
  cur.underglow  = currentUnderglowSnapshot();
  localStorage.setItem(LAYERS_KEY, JSON.stringify(layers));
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
    animStates: JSON.parse(JSON.stringify(keyAnimStates)),
    underglow:  currentUnderglowSnapshot(),
  });
  localStorage.setItem(LAYERS_KEY, JSON.stringify(layers));
  activeProfileId = id;
}

function renameSavedLayer(id, name) {
  const layers = getSavedLayers();
  const layer = layers.find(l => l.id === id);
  if (layer) {
    layer.name = name;
    localStorage.setItem(LAYERS_KEY, JSON.stringify(layers));
  }
}

function setLayerShowTitle(id, show) {
  const layers = getSavedLayers();
  const layer = layers.find(l => l.id === id);
  if (layer) {
    layer.showTitle = show;
    localStorage.setItem(LAYERS_KEY, JSON.stringify(layers));
  }
}

function deleteSavedLayer(id) {
  const layers = getSavedLayers().filter(l => l.id !== id);
  localStorage.setItem(LAYERS_KEY, JSON.stringify(layers));
  if (activeProfileId === id) activeProfileId = null;

  if (layers.length === 0) {
    // No layers left — blank the device: all KC_NO, all LEDs off
    activeProfileId = null;
    keymap = { layers: keymap.layers.map(() => ({ keys: Array(21).fill("KC_NO") })) };
    keyLedColors = Array(21).fill("#ffffff");
    invoke("set_keymap", { map: keymap });
    invoke("set_leds", { leds: { colors: Array(21).fill({ r: 0, g: 0, b: 0 }) } });
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
        keymap: data.keymap,
        leds:   data.leds,
        icons:      data.icons || Array(21).fill(""),
        iconImages: data.iconImages || Array(21).fill(null),
      });
      localStorage.setItem(LAYERS_KEY, JSON.stringify(layers));
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
  localStorage.setItem(LAYERS_KEY, JSON.stringify(layers));
}

async function switchToLayer(id, { silent = false } = {}) {
  saveCurrentLayerState();
  const layer = getSavedLayers().find(l => l.id === id);
  if (!layer) return;
  keymap         = structuredClone(layer.keymap);
  keyLedColors   = [...layer.leds];
  keyIconLabels  = layer.icons ? [...layer.icons] : Array(21).fill("");
  keyIconImages  = layer.iconImages ? [...layer.iconImages] : Array(21).fill(null);
  keyAnimStates  = layer.animStates
    ? JSON.parse(JSON.stringify(layer.animStates))
    : Array.from({ length: 21 }, mkKeyAnim);
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
  keyAnimStates  = Array.from({ length: 21 }, mkKeyAnim);
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

async function renderHostBindings() {
  const list     = document.getElementById("hb-list");
  const outputEl = document.getElementById("hb-output");
  if (!list) return;
  const bindings = await invoke("get_bindings");
  list.innerHTML = "";

  for (const b of bindings) {
    const row = document.createElement("div");
    row.className = "hb-row";
    row.innerHTML = `
      <span class="hb-idx">HOST(${b.index})</span>
      <input class="hb-label"   value="${b.label}"                placeholder="Label" />
      <input class="hb-cmd"     value="${b.command.join(" ")}"    placeholder="git commit -am wip" />
      <input class="hb-cwd"     value="${b.cwd || ""}"            placeholder="Working dir (optional)" />
      <button class="hb-run"  title="Run now and show output">▶</button>
      <button class="hb-del"  title="Delete">✕</button>`;

    const save = async () => {
      const label   = row.querySelector(".hb-label").value;
      const cmdStr  = row.querySelector(".hb-cmd").value.trim();
      const cwd     = row.querySelector(".hb-cwd").value.trim() || null;
      const updated = bindings.map(x => x.index === b.index
        ? { ...x, label, command: cmdStr.split(/\s+/), cwd }
        : x);
      await invoke("set_bindings", { bindings: updated });
    };

    row.querySelector(".hb-label").addEventListener("change", save);
    row.querySelector(".hb-cmd").addEventListener("change", save);
    row.querySelector(".hb-cwd").addEventListener("change", save);

    row.querySelector(".hb-run").addEventListener("click", async () => {
      await save();
      const runBtn = row.querySelector(".hb-run");
      runBtn.disabled = true;
      try {
        const result = await invoke("run_binding", { index: b.index });
        outputEl.textContent = result;
        outputEl.style.display = "";
      } catch (err) {
        outputEl.textContent = "Error: " + err;
        outputEl.style.display = "";
      }
      runBtn.disabled = false;
    });

    row.querySelector(".hb-del").addEventListener("click", async () => {
      const updated = bindings.filter(x => x.index !== b.index);
      await invoke("set_bindings", { bindings: updated });
      await renderHostBindings();
    });

    list.appendChild(row);
  }

  if (bindings.length === 0) {
    list.innerHTML = `<div class="hb-empty">No bindings yet — add one with the button below.</div>`;
  }
}

async function applyActiveProfileToBoard() {
  if (!keymap || !activeProfileId) return;
  const colors = keyLedColors.map(hex => {
    const { r, g, b } = hexToRgb(hex || "#ffffff");
    return { r, g, b };
  });
  await invoke("set_keymap", { map: keymap });
  await invoke("set_leds", { leds: { colors } });
}

let _wasConnected = false;

async function pollConnection() {
  try {
    // try_connect upgrades mock -> real board when one appears (and answers
    // whether the active transport is a real, live board)
    const connected = hasTauri ? await invoke("try_connect") : await invoke("is_connected");
    const connPill  = document.getElementById("conn");
    if (connPill) {
      connPill.textContent = connected ? "● connected" : "○ no device";
      connPill.classList.toggle("ok", connected);
    }
    if (connected && !_wasConnected) {
      await applyActiveProfileToBoard();
    }
    _wasConnected = connected;
  } catch {}
}

// Drain HOST(n) key presses from the board; the backend runs the bound command.
async function pollHostCmds() {
  if (!hasTauri || !_wasConnected) return;
  try {
    const results = await invoke("poll_host_cmds");
    for (const line of results || []) console.log("[host-cmd]", line);
  } catch {}
}

init().then(() => {
  _wasConnected = true; // init already applied the profile; don't re-push on first poll
  setInterval(pollConnection, 3000);
  setInterval(pollHostCmds, 300);
});
