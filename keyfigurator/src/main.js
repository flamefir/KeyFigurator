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
let keyLedColors  = Array.from({ length: 21 }, () => "#000000");
let keyIconLabels = Array(21).fill("");   // optional per-key icon/emoji (max 2 chars)
let isDragging = false;
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

let cornerColors  = ["#ff6e14", "#ff6e14", "#ff6e14", "#ff6e14"];
let ugAnimation   = "breathe";
let ugRate        = 128;
let ugIntensity   = 180;

let klAnimation   = "solid";
let klRate        = 128;
let klIntensity   = 180;

let klPalette     = [];
let ugPalette     = [];

const KL_PER_KEY  = "kf-kl-perkey";
const mkKeyAnim   = () => ({ animation: "solid", rate: 128, intensity: 180, palette: [] });
let keyAnimStates = Array.from({ length: 21 }, mkKeyAnim);
let encoderMode   = "layer"; // "layer" | "scroll"

// ── OLED state ────────────────────────────────────────────────────────────
const OLED_CUSTOM_KEY     = "kf-oled-custom";
const OLED_CD_KEY         = "kf-oled-cd";
const OLED_BACK_KEY       = "kf-oled-back";
// Max chars that fit on the 120px screen at each font size (Courier New, with 110px text area)
const OLED_LAYER_NAME_MAX  = 16;   // 10px Courier ≈ 6px/char → ~18 fit; 16 is the enforced display limit
const OLED_CUSTOM_TITLE_MAX = 14;  // 13px Courier ≈ 7.8px/char → ~14 fit

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
let oledAssigningBack  = false;      // true while waiting for the user to press a key to assign

let oledCustomScreens = [];         // { id, type:"custom", title, imageDataUrl }
let oledAnimFrame     = null;
let oledLastTick      = 0;

const ANIMATIONS = [
  { id: "solid",    label: "Solid"    },
  { id: "breathe",  label: "Breathe"  },
  { id: "rainbow",  label: "Rainbow"  },
  { id: "wave",     label: "Wave"     },
  { id: "reactive", label: "Reactive" },
  { id: "sparkle",  label: "Sparkle"  },
];

// ── OLED helpers ──────────────────────────────────────────────────────────
function getOledScreens() {
  return [
    ...getSavedLayers().map(l => ({ type: "layer", layerId: l.id })),
    { type: "timer" },
    { type: "countdown" },
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
        const kc   = keymap?.layers[0]?.keys[oledKeyCycleIdx] ?? "KC_NO";
        const disp = kc.replace(/^KC_/, "");
        const icon = keyIconLabels[oledKeyCycleIdx] || "";
        screenEl.innerHTML = `<div class="oled-keycycle">
          <div class="oled-kc-num">${String(oledKeyCycleIdx + 1).padStart(2,"0")}</div>
          ${icon ? `<div class="oled-kc-icon">${icon}</div>` : ""}
          <div class="oled-kc-val">${disp}</div>
        </div>`;
      } else {
        const layers = getSavedLayers();
        const layer  = layers.find(l => l.id === screen.layerId);
        const idx    = String(layers.indexOf(layer) + 1).padStart(2, "0");
        const name   = (layer?.name || "").toUpperCase().slice(0, OLED_LAYER_NAME_MAX);
        screenEl.innerHTML = `<div class="oled-layer-screen">
          <div class="oled-lyr-idx">LAYER ${idx}</div>
          <div class="oled-lyr-name">${name}</div>
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
    case "custom": {
      if (screen.imageDataUrl) {
        screenEl.innerHTML = `<img class="oled-custom-img" src="${screen.imageDataUrl}" alt="" />`;
      } else {
        const txt = (screen.title || "").toUpperCase().slice(0, OLED_CUSTOM_TITLE_MAX);
        screenEl.innerHTML = `<div class="oled-custom-text">${txt || "—"}</div>`;
      }
      break;
    }
  }
}

function updateOledDisplay() {
  const screenEl = document.querySelector(".oled-screen");
  if (screenEl) renderOledScreenContent(screenEl);
  if (document.getElementById("oled-pill").classList.contains("visible")) {
    renderOledPillNav();
    renderOledPillContent();
  }
}

function oledScreenNav(dir) {
  if (oledCdDone) { oledCdDone = false; oledFlashKeys = false; oledCdAcc = 0; }
  oledSubMode = "nav";
  const screens = getOledScreens();
  oledScreenIdx = (oledScreenIdx + dir + screens.length) % screens.length;
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
    case "hours":   oledCdH = Math.max(0, Math.min(23, oledCdH + delta)); break;
    case "minutes": oledCdM = Math.max(0, Math.min(59, oledCdM + delta)); break;
    case "seconds": oledCdS = Math.max(0, Math.min(59, oledCdS + delta)); break;
  }
  updateOledDisplay();
}

function renderOledPillNav() {
  const screens = getOledScreens();
  const screen  = screens[oledScreenIdx] ?? {};
  let name = "";
  switch (screen.type) {
    case "layer": {
      const layer = getSavedLayers().find(l => l.id === screen.layerId);
      const idx   = getSavedLayers().indexOf(layer) + 1;
      name = `Layer ${String(idx).padStart(2,"0")}${oledSubMode === "keycycle" ? " — Key Cycle" : ""}`;
      break;
    }
    case "timer":     name = "Timer";     break;
    case "countdown": name = "Countdown"; break;
    case "custom":    name = screen.title || "Custom Screen"; break;
  }
  const nameEl = document.getElementById("oled-screen-name");
  if (nameEl) nameEl.textContent = `${oledScreenIdx + 1} / ${screens.length} — ${name}`;

  const pressBtn = document.getElementById("oled-enc-press");
  if (!pressBtn) return;
  const labels = {
    layer:     oledSubMode === "keycycle" ? "↓ Exit Cycle" : "↓ Key Cycle",
    timer:     oledTimerRunning ? "↓ Stop" : "↓ Start",
    countdown: oledCdDone ? "↓ Reset" : (oledCdRunning ? "↓ Stop" : "↓ Next Field / Start"),
    custom:    "",
  };
  pressBtn.textContent = labels[screen.type] ?? "↓ Press";
  pressBtn.style.display = screen.type === "custom" ? "none" : "";
}

function renderOledPillContent() {
  const container = document.getElementById("oled-pill-content");
  if (!container) return;
  const screens = getOledScreens();
  const screen  = screens[oledScreenIdx] ?? {};

  switch (screen.type) {
    case "layer": {
      const layer = getSavedLayers().find(l => l.id === screen.layerId);
      container.innerHTML = `
        <div class="oled-pill-section">
          <span class="pill-label">TITLE</span>
          <input class="oled-title-inp" id="oled-title-inp" type="text"
            value="${layer?.name || ""}" placeholder="Layer name…" maxlength="${OLED_LAYER_NAME_MAX}" />
        </div>
        <div class="oled-pill-hint">
          Press ↓ to enter key cycle mode — rotate CW/CCW to step through keys, press again to exit.
          First ${OLED_LAYER_NAME_MAX} chars shown on OLED.
        </div>`;
      document.getElementById("oled-title-inp")?.addEventListener("input", (e) => {
        if (layer) { renameSavedLayer(layer.id, e.target.value); updateOledDisplay(); }
      });
      break;
    }
    case "timer": {
      container.innerHTML = `
        <div class="oled-pill-section oled-pill-hint">
          Press encoder ↓ to start / stop. Resets when you navigate away.
        </div>
        <div class="oled-pill-section">
          <button class="oled-action-btn" id="oled-timer-reset">Reset Timer</button>
        </div>`;
      document.getElementById("oled-timer-reset")?.addEventListener("click", () => {
        oledTimerRunning = false; oledTimerAcc = 0; updateOledDisplay();
      });
      break;
    }
    case "countdown": {
      container.innerHTML = `
        <div class="oled-pill-section oled-cd-setrow">
          <label class="oled-cd-field-lbl">H
            <input class="oled-cd-num" id="oled-cd-h" type="number" min="0" max="23" value="${oledCdH}" />
          </label>
          <span class="oled-cd-sep">:</span>
          <label class="oled-cd-field-lbl">M
            <input class="oled-cd-num" id="oled-cd-m" type="number" min="0" max="59" value="${oledCdM}" />
          </label>
          <span class="oled-cd-sep">:</span>
          <label class="oled-cd-field-lbl">S
            <input class="oled-cd-num" id="oled-cd-s" type="number" min="0" max="59" value="${oledCdS}" />
          </label>
        </div>
        <div class="oled-pill-hint">
          Rotate encoder to adjust selected field (underlined) · Press ↓ to cycle field, then start.
        </div>`;
      document.getElementById("oled-cd-h")?.addEventListener("input", (e) => { oledCdH = Math.max(0, Math.min(23, +e.target.value||0)); updateOledDisplay(); });
      document.getElementById("oled-cd-m")?.addEventListener("input", (e) => { oledCdM = Math.max(0, Math.min(59, +e.target.value||0)); updateOledDisplay(); });
      document.getElementById("oled-cd-s")?.addEventListener("input", (e) => { oledCdS = Math.max(0, Math.min(59, +e.target.value||0)); updateOledDisplay(); });
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
            value="${screen.title || ""}" placeholder="Screen title…" maxlength="${OLED_CUSTOM_TITLE_MAX}" />
        </div>
        <div class="oled-pill-section oled-img-row">
          <div class="oled-img-thumb">${imgPreview}</div>
          <label class="oled-upload-btn">Upload Image / GIF
            <input type="file" id="oled-img-upload" accept="image/*" style="display:none" />
          </label>
          ${screen.imageDataUrl ? `<button class="oled-img-clear" id="oled-img-clear">✕</button>` : ""}
        </div>
        <div class="oled-pill-hint">Max 128×128 px — larger images will be rejected.</div>
        <div class="oled-pill-section">
          <button class="oled-action-btn oled-del-screen" id="oled-del-screen">Delete Screen</button>
        </div>`;
      document.getElementById("oled-custom-title")?.addEventListener("input", (e) => {
        screen.title = e.target.value; saveOledCustomScreens(); updateOledDisplay();
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
      document.getElementById("oled-del-screen")?.addEventListener("click", () => {
        oledCustomScreens = oledCustomScreens.filter(s => s.id !== screen.id);
        saveOledCustomScreens();
        oledScreenIdx = Math.max(0, oledScreenIdx - 1);
        updateOledDisplay(); renderOledPillNav(); renderOledPillContent();
      });
      break;
    }
    default:
      container.innerHTML = "";
  }

  // ── Shared footer: back-key assignment ──────────────────────────────────
  const footer = document.createElement("div");
  footer.className = "oled-pill-section oled-back-row";
  const backLabel = oledBackKeyIdx !== null ? `Key ${oledBackKeyIdx}` : "None";
  const assignLabel = oledAssigningBack ? "Press a key…" : "Set";
  footer.innerHTML = `
    <span class="pill-label">BACK KEY</span>
    <span class="oled-back-val">${backLabel}</span>
    <button class="oled-action-btn oled-set-back" id="oled-set-back">${assignLabel}</button>
    ${oledBackKeyIdx !== null ? `<button class="oled-action-btn oled-del-screen" id="oled-clear-back">Clear</button>` : ""}`;
  container.appendChild(footer);

  document.getElementById("oled-set-back")?.addEventListener("click", () => {
    oledAssigningBack = !oledAssigningBack;
    renderOledPillContent();
  });
  document.getElementById("oled-clear-back")?.addEventListener("click", () => {
    oledBackKeyIdx = null;
    oledAssigningBack = false;
    localStorage.removeItem(OLED_BACK_KEY);
    renderBoard(); renderOledPillContent();
  });
}

function renderOledPill() {
  renderOledPillNav();
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
               || (s?.type === "countdown" && oledCdRunning);
  if (live && now - oledLastTick > 250) {
    oledLastTick = now;
    const screenEl = document.querySelector(".oled-screen");
    if (screenEl) renderOledScreenContent(screenEl);
    if (document.getElementById("oled-pill").classList.contains("visible")
        && (s.type === "timer" || s.type === "countdown")) {
      renderOledPillContent();
    }
  }

  oledAnimFrame = requestAnimationFrame(oledAnimTick);
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
    // Board-ring corner pip
    const corner = document.getElementById(`ug-c${i}`);
    if (corner) {
      corner.querySelector(".ug-dot").style.background = hex;
      corner.querySelector(".ug-corner-inp").value     = hex;
    }
    // Main-row inline button dot
    const btn = document.getElementById(`ug-cb-${i}`);
    if (btn) {
      btn.querySelector(".ug-c-dot").style.background = hex;
      btn.querySelector(".ug-c-inp").value            = hex;
    }
  }
}

function applyUnderglowHex(hex) {
  document.documentElement.style.setProperty("--ug-color", hexToRgbTriple(hex));
  const inp = document.getElementById("underglow-color");
  if (inp) inp.value = hex;
  localStorage.setItem(UG_KEY, hex);
  // Sync all 4 corner LEDs to the chosen color
  cornerColors = [hex, hex, hex, hex];
  localStorage.setItem(UG_CORNERS_KEY, JSON.stringify(cornerColors));
  applyCornerColors();
}

function saveAdvancedState() {
  localStorage.setItem(UG_ADVANCED_KEY, JSON.stringify({
    animation: ugAnimation, rate: ugRate, intensity: ugIntensity,
  }));
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
}

function renderAnimChips() {
  const container = document.getElementById("ug-anims");
  if (!container) return;
  container.innerHTML = "";
  for (const anim of ANIMATIONS) {
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
    container.appendChild(chip);
  }
}

function updatePaletteDisabled() {
  const off = klAnimation === "solid" || klAnimation === "rainbow";
  document.getElementById("kl-palette").classList.toggle("disabled", off);
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
  for (const anim of ANIMATIONS) {
    const chip = document.createElement("button");
    chip.className = "ug-anim-chip" + (klAnimation === anim.id ? " active" : "");
    const preview = document.createElement("span");
    preview.className = `ug-anim-preview ${anim.id}`;
    chip.appendChild(preview);
    chip.appendChild(document.createTextNode(anim.label));
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      klAnimation = anim.id;
      saveKlAdvancedState();
      renderKlAnimChips();
    });
    container.appendChild(chip);
  }
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

function buildBoardGlow(tl, tr, bl, br) {
  const f = (c, scale) => `rgba(${c.rgb},${Math.min(0.99, c.opacity * scale).toFixed(3)})`;
  return [
    `0 20px 70px ${f(bl, 0.55)}`,   `0 20px 70px ${f(br, 0.55)}`,
    `-14px 6px 40px ${f(tl, 0.38)}`, `-14px 6px 40px ${f(bl, 0.38)}`,
    `14px 6px 40px ${f(tr, 0.38)}`,  `14px 6px 40px ${f(br, 0.38)}`,
    `0 -12px 48px ${f(tl, 0.22)}`,  `0 -12px 48px ${f(tr, 0.22)}`,
  ].join(", ");
}

function computeCornerStates(elapsed) {
  const duration = 0.3 + (ugRate / 255) * 7.7;
  const t        = (elapsed % duration) / duration;
  const maxOp    = 0.15 + (ugIntensity / 255) * 0.85;
  // Non-rainbow animations use palette when set, otherwise fall back to corner pickers
  const bases    = [0,1,2,3].map(i => ugPalette.length > 0 ? ugPalette[i % ugPalette.length] : cornerColors[i]);

  switch (ugAnimation) {
    case "solid":
      return bases.map(hex => {
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

  // Board glow — CSS @keyframes (flash) overrides inline style automatically while active
  const board = document.getElementById("board");
  if (board) board.style.boxShadow = buildBoardGlow(tl, tr, bl, br);

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
  const duration = 0.3 + (klRate / 255) * 7.7;
  const t        = (elapsed % duration) / duration;
  const maxOp    = 0.15 + (klIntensity / 255) * 0.85;
  const ownColor = keyLedColors[idx] || "#000000";
  // Palette: time-based — all selected keys advance through colors together each cycle
  const usePalette = klPalette.length > 0 && isSel && klAnimation !== "solid" && klAnimation !== "rainbow";
  const paletteIdx = usePalette ? Math.floor(elapsed / duration) % klPalette.length : 0;
  const baseHex  = usePalette ? klPalette[paletteIdx] : ownColor;
  const hasColor = baseHex && baseHex !== "#000000";

  switch (klAnimation) {
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
      if (!isSel) return null;
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
      if (age > 0.8) return null;
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

    default: return null;
  }
}

function klAnimTick(now) {
  if (!klAnimStart) klAnimStart = now;
  const elapsed = (now - klAnimStart) / 1000;

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

  const connected = await invoke("is_connected");
  const connPill = document.getElementById("conn");
  connPill.textContent = connected ? "● connected (mock)" : "○ no device";
  connPill.classList.toggle("ok", connected);

  // Restore underglow + corner + advanced settings from localStorage
  const savedUg = localStorage.getItem(UG_KEY);
  if (savedUg) {
    document.documentElement.style.setProperty("--ug-color", hexToRgbTriple(savedUg));
    const ugInp = document.getElementById("underglow-color");
    if (ugInp) ugInp.value = savedUg;
  }
  const savedCorners = localStorage.getItem(UG_CORNERS_KEY);
  if (savedCorners) try { cornerColors = JSON.parse(savedCorners); } catch {}
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
  keymap       = structuredClone(bootLayer.keymap);
  keyLedColors = [...bootLayer.leds];
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

  renderBoard();
  startUgAnimation();
  startKlAnimation();
  startOledAnim();

  // ── Saved Layers ──────────────────────────────────────────────────────────
  const slWrap     = document.getElementById("sl-wrap");
  const slDropdown = document.getElementById("sl-dropdown");
  const slPlus     = document.getElementById("sl-plus");
  const slNewRow   = document.getElementById("sl-new-row");
  const slNewInput = document.getElementById("sl-new-input");

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

  document.addEventListener("mouseup", () => { isDragging = false; });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      selectedKeys.clear();
      closeKeyLedPill();
      closeUnderglowPill();
      closeOledPill();
      renderBoard();
    }
  });

  // ── Underglow ring click ───────────────────────────────────────────────────
  document.getElementById("board-ring").addEventListener("click", (e) => {
    if (e.target.closest(".key, .encoder-knob, .oled-panel, .ug-corner")) return;
    const isOpen = document.getElementById("underglow-pill").classList.contains("visible");
    if (isOpen) {
      closeUnderglowPill();
    } else {
      openUnderglowPill();
    }
  });

  // ── Close pills when clicking outside board-ring / pill ──────────────────
  document.addEventListener("click", (e) => {
    if (e.target.closest("#board-ring, #underglow-pill, #key-pills, #oled-pill")) return;
    closeUnderglowPill();
    if (document.getElementById("key-pills").classList.contains("visible")) {
      selectedKeys.clear();
      closeKeyLedPill();
      renderBoard();
    }
    closeOledPill();
  });

  // ── Corner LED pickers (board-ring pips + main-row inline buttons) ───────
  function onCornerColorChange(i, hex) {
    cornerColors[i] = hex;
    localStorage.setItem(UG_CORNERS_KEY, JSON.stringify(cornerColors));
    applyCornerColors();
    if (cornerColors.every(c => c === hex)) applyUnderglowHex(hex);
  }

  for (let i = 0; i < 4; i++) {
    // Board-ring pip (visual indicator + alternative picker)
    const corner = document.getElementById(`ug-c${i}`);
    const pip    = corner.querySelector(".ug-corner-inp");
    corner.addEventListener("click", (e) => { e.stopPropagation(); pip.click(); });
    pip.addEventListener("input", (e) => onCornerColorChange(i, e.target.value));

    // Main-row inline button — transparent input overlays the button,
    // so clicking anywhere on the button opens the native color picker.
    const btn = document.getElementById(`ug-cb-${i}`);
    const inp = document.getElementById(`ug-ci-${i}`);
    inp.addEventListener("input", (e) => onCornerColorChange(i, e.target.value));
    inp.addEventListener("focus", () => btn.classList.add("selected"));
    inp.addEventListener("blur",  () => btn.classList.remove("selected"));
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
  document.getElementById("kc-adv-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    const adv     = document.getElementById("kc-advanced");
    const arrow   = document.getElementById("kc-adv-arrow");
    const btn     = document.getElementById("kc-adv-btn");
    const opening = !adv.classList.contains("open");
    adv.classList.toggle("open", opening);
    btn.classList.toggle("open", opening);
    arrow.textContent = opening ? "▾" : "▸";
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
    klAnimation = "solid";
    saveKlAdvancedState();
    renderKlAnimChips();
    for (const idx of selectedKeys) keyLedColors[idx] = e.target.value;
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
    for (const idx of selectedKeys) keyIconLabels[idx] = val;
    renderBoard();
  });

  // ── OLED pill controls ────────────────────────────────────────────────────
  document.getElementById("oled-nav-prev").addEventListener("click", (e) => {
    e.stopPropagation(); oledScreenNav(-1); renderOledPill();
  });
  document.getElementById("oled-nav-next").addEventListener("click", (e) => {
    e.stopPropagation(); oledScreenNav(1); renderOledPill();
  });
  document.getElementById("oled-enc-press").addEventListener("click", (e) => {
    e.stopPropagation(); onEncoderPress(); renderOledPill();
  });
  document.getElementById("oled-add-screen").addEventListener("click", (e) => {
    e.stopPropagation();
    oledCustomScreens.push({ id: Date.now().toString(), type: "custom", title: "New Screen", imageDataUrl: null });
    saveOledCustomScreens();
    const screens = getOledScreens();
    oledScreenIdx = screens.length - 1;
    updateOledDisplay(); renderOledPill();
  });
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
  oledPanel.title = "Click to open OLED designer";
  const oledScreen = document.createElement("div");
  oledScreen.className = "oled-screen";
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

      const enc = document.createElement("button");
      enc.id = "key-" + pos.idx;
      enc.className = "encoder-knob" + (isSel ? " sel" : "");
      enc.textContent = "◉";
      enc.title = "Click to select encoder LED · ↻/↺ to rotate · OLED ↓ Press to enter screen sub-mode";
      enc.addEventListener("mousedown", (e) => { e.preventDefault(); onKeyDown(pos.idx); });
      enc.addEventListener("mouseenter", () => onKeyEnter(pos.idx));
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
      const isEmpty = kc === "KC_NO" || kc === "KC_TRNS";
      const isCycleActive = oledSubMode === "keycycle" && pos.idx === oledKeyCycleIdx;
      const isBackKey     = pos.idx === oledBackKeyIdx;
      const isAssigning   = oledAssigningBack;
      k.className = "key"
        + (isSel ? " sel" : "")
        + (isEmpty ? " empty" : "")
        + (isCycleActive ? " oled-key-active" : "")
        + (isBackKey && !isAssigning ? " oled-back-key" : "")
        + (isAssigning ? " oled-assigning" : "");
      k.style.cssText = `grid-row:${pos.row};grid-column:${pos.col}`;
      const icon = keyIconLabels[pos.idx];
      k.textContent = icon || (isEmpty ? "·" : kc.replace(/^KC_/, ""));
      k.title = `Key ${pos.idx}: ${kc}${icon ? ` [${icon}]` : ""} · Click / drag to select · Selection opens LED settings`;
      k.addEventListener("mousedown", (e) => { e.preventDefault(); onKeyDown(pos.idx); });
      k.addEventListener("mouseenter", () => onKeyEnter(pos.idx));
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
  // Back-key assignment mode — next press sets the key, no LED selection.
  if (oledAssigningBack) {
    oledBackKeyIdx = idx;
    oledAssigningBack = false;
    localStorage.setItem(OLED_BACK_KEY, String(idx));
    renderBoard();
    if (document.getElementById("oled-pill").classList.contains("visible")) renderOledPill();
    return;
  }

  // Back key pressed while in OLED sub-mode — exit to nav without touching LED selection.
  if (oledBackKeyIdx === idx && oledSubMode !== "nav") {
    oledSubMode = "nav";
    oledKeyCycleIdx = 0;
    updateOledDisplay();
    renderBoard();
    return;
  }

  lastKeyClickTime = performance.now();
  keyClickTimes[idx] = performance.now();
  isDragging = true;
  selectedKeys.clear();
  selectedKeys.add(idx);
  loadKeyAnimState(idx);
  closeUnderglowPill();
  closeOledPill();
  syncKeyLedPill();
  renderBoard();
  openKeyLedPill();
}

function onKeyEnter(idx) {
  if (!isDragging) return;
  selectedKeys.add(idx);
  syncKeyLedPill();
  renderBoard();
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
    document.getElementById("kl-color").value = col || "#000000";
  } else {
    document.getElementById("kl-kc").value   = "";
    document.getElementById("kl-icon").value = "";
    const colors = [...selectedKeys].map(i => keyLedColors[i]).filter(c => c && c !== "#000000");
    document.getElementById("kl-color").value =
      (colors.length && colors.every(c => c === colors[0])) ? colors[0] : "#000000";
  }
}

// ── Saved Layers storage ───────────────────────────────────────────────────
const LAYERS_KEY = "kf-saved-layers";

function getSavedLayers() {
  try { return JSON.parse(localStorage.getItem(LAYERS_KEY) || "[]"); }
  catch { return []; }
}

function saveCurrentAsLayer(name) {
  const layers = getSavedLayers();
  const id = Date.now().toString();
  layers.push({ id, name, keymap: structuredClone(keymap), leds: [...keyLedColors], icons: [...keyIconLabels] });
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

function deleteSavedLayer(id) {
  const layers = getSavedLayers().filter(l => l.id !== id);
  localStorage.setItem(LAYERS_KEY, JSON.stringify(layers));
  if (activeProfileId === id) activeProfileId = null;

  if (layers.length === 0) {
    // No layers left — blank the device: all KC_NO, all LEDs off
    activeProfileId = null;
    keymap = { layers: keymap.layers.map(() => ({ keys: Array(21).fill("KC_NO") })) };
    keyLedColors = Array(21).fill("#000000");
    invoke("set_keymap", { map: keymap });
    invoke("set_leds", { leds: { colors: Array(21).fill({ r: 0, g: 0, b: 0 }) } });
  }

  renderSavedLayers();
  renderBoard();
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

async function switchToLayer(id) {
  const layer = getSavedLayers().find(l => l.id === id);
  if (!layer) return;
  keymap = structuredClone(layer.keymap);
  keyLedColors   = [...layer.leds];
  keyIconLabels  = layer.icons ? [...layer.icons] : Array(21).fill("");
  activeProfileId = id;
  selectedKeys.clear();
  closeKeyLedPill();
  renderBoard();
  flashBoard();
  await invoke("set_keymap", { map: keymap });
  renderSavedLayers();
  // Open rename input pre-filled with this layer's name
  const slNewRow   = document.getElementById("sl-new-row");
  const slNewInput = document.getElementById("sl-new-input");
  slNewInput.value = layer.name;
  slNewInput.classList.remove("error");
  slNewRow.classList.add("open");
  slNewInput.select();
  slNewInput.focus();
}

function switchToBlankLayer() {
  keymap = { layers: Array.from({ length: 4 }, () => ({ keys: Array(21).fill("KC_NO") })) };
  keyLedColors = Array.from({ length: 21 }, () => "#000000");
  activeProfileId = null;
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

    const del = document.createElement("button");
    del.className = "sl-del";
    del.textContent = "✕";
    del.title = "Delete";
    del.addEventListener("click", (e) => { e.stopPropagation(); deleteSavedLayer(layer.id); });

    item.appendChild(idx);
    item.appendChild(name);
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
function closeOledPill()   { document.getElementById("oled-pill").classList.remove("visible"); }

function openUnderglowPill() {
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

init();
