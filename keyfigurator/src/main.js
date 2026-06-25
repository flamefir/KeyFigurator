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
let keyLedColors = Array.from({ length: 21 }, () => "");
let isDragging = false;
let activeProfileId = null;
let dragSrcId = null;

const UG_KEY          = "kf-underglow";
const UG_CORNERS_KEY  = "kf-ug-corners";
const UG_ADVANCED_KEY = "kf-ug-adv";

let cornerColors  = ["#ff6e14", "#ff6e14", "#ff6e14", "#ff6e14"];
let ugAnimation   = "breathe";
let ugRate        = 128;
let ugIntensity   = 180;

const ANIMATIONS = [
  { id: "solid",    label: "Solid"    },
  { id: "breathe",  label: "Breathe"  },
  { id: "rainbow",  label: "Rainbow"  },
  { id: "wave",     label: "Wave"     },
  { id: "reactive", label: "Reactive" },
  { id: "sparkle",  label: "Sparkle"  },
];

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
    chip.addEventListener("click", () => {
      ugAnimation = anim.id;
      ugAnimStart = 0; // restart cycle from t=0 for the new animation
      saveAdvancedState();
      renderAnimChips();
    });
    container.appendChild(chip);
  }
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
  const duration = 0.3 + (ugRate / 255) * 7.7;     // rate 0→0.3 s, rate 255→8 s
  const t        = (elapsed % duration) / duration;  // 0→1 normalized cycle
  const maxOp    = 0.15 + (ugIntensity / 255) * 0.85;

  switch (ugAnimation) {
    case "solid":
      return cornerColors.map(hex => {
        const {r,g,b} = hexToRgb(hex); return { rgb:`${r},${g},${b}`, opacity: maxOp * 0.7 };
      });

    case "breathe": {
      const op = maxOp * (0.5 - 0.5 * Math.cos(t * Math.PI * 2));
      return cornerColors.map(hex => {
        const {r,g,b} = hexToRgb(hex); return { rgb:`${r},${g},${b}`, opacity: op };
      });
    }

    case "rainbow": {
      const hueOffset  = t * 360;
      const phaseShift = [0, 90, 270, 180]; // TL, TR, BL, BR
      return cornerColors.map((hex, i) => ({
        rgb:     shiftHue(hex, hueOffset + phaseShift[i]),
        opacity: maxOp * 0.75,
      }));
    }

    case "wave": {
      const phaseOff = [0, 0.25, 0.75, 0.5]; // clockwise: TL→TR→BR→BL
      return cornerColors.map((hex, i) => {
        const {r,g,b} = hexToRgb(hex);
        const pt = (t + phaseOff[i]) % 1;
        return { rgb:`${r},${g},${b}`, opacity: maxOp * (0.5 - 0.5 * Math.cos(pt * Math.PI * 2)) };
      });
    }

    case "reactive": {
      const age = (performance.now() - lastKeyClickTime) / 1000;
      const op  = age < 0.8 ? maxOp * Math.pow(1 - age / 0.8, 1.5) : maxOp * 0.08;
      return cornerColors.map(hex => {
        const {r,g,b} = hexToRgb(hex); return { rgb:`${r},${g},${b}`, opacity: op };
      });
    }

    case "sparkle": {
      const freqs  = [2.3, 3.7, 1.9, 4.1];
      const phases = [0,   1.2, 2.5, 0.8];
      return cornerColors.map((hex, i) => {
        const {r,g,b} = hexToRgb(hex);
        const v  = Math.sin(t * Math.PI * 2 * freqs[i] + phases[i]);
        return { rgb:`${r},${g},${b}`, opacity: maxOp * Math.max(0.04, Math.pow(Math.max(0, v), 2)) };
      });
    }

    default:
      return cornerColors.map(hex => {
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

  renderBoard();
  startUgAnimation(); // start the 60fps underglow loop

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
      closePill();
      closeUnderglowPill();
      renderBoard();
    }
  });

  // ── Underglow ring click ───────────────────────────────────────────────────
  document.getElementById("board-ring").addEventListener("click", (e) => {
    if (e.target.closest(".key, .encoder-knob, .oled-panel, .ug-corner")) return;
    const ugPill = document.getElementById("underglow-pill");
    const isOpen = ugPill.classList.contains("visible");
    selectedKeys.clear();
    closePill();
    if (isOpen) {
      closeUnderglowPill();
    } else {
      openUnderglowPill();
      renderBoard();
    }
  });

  // ── Close underglow when clicking outside board-ring or pill ──────────────
  document.addEventListener("click", (e) => {
    if (!document.getElementById("underglow-pill").classList.contains("visible")) return;
    if (e.target.closest("#board-ring, #underglow-pill")) return;
    closeUnderglowPill();
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

  // ── Advanced toggle ───────────────────────────────────────────────────────
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

  document.getElementById("pill-color").addEventListener("input", (e) => {
    for (const idx of selectedKeys) keyLedColors[idx] = e.target.value;
    renderBoard();
  });

  document.getElementById("pill-kc").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const val = e.target.value.trim() || "KC_NO";
      for (const idx of selectedKeys) keymap.layers[0].keys[idx] = val;
      renderBoard();
    }
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

  const oled = document.createElement("div");
  oled.className = "oled-panel";
  oled.innerHTML = `
    <div class="oled-screen">
      <span class="oled-layer">LAYER ${activeIdx}</span>
    </div>`;
  el.appendChild(oled);

  for (const pos of BOARD_POSITIONS) {
    const kc = keymap.layers[0].keys[pos.idx] ?? "KC_NO";
    const isSel = selectedKeys.has(pos.idx);
    const ledColor = keyLedColors[pos.idx];

    if (pos.type === "encoder") {
      const enc = document.createElement("button");
      enc.className = "encoder-knob" + (isSel ? " sel" : "");
      enc.style.cssText = `grid-row:${pos.row};grid-column:${pos.col}`;
      enc.textContent = "◉";
      enc.addEventListener("mousedown", (e) => { e.preventDefault(); onKeyDown(pos.idx); });
      enc.addEventListener("mouseenter", () => onKeyEnter(pos.idx));
      el.appendChild(enc);
    } else {
      const k = document.createElement("button");
      const isEmpty = kc === "KC_NO" || kc === "KC_TRNS";
      k.className = "key" + (isSel ? " sel" : "") + (isEmpty ? " empty" : "");
      k.style.cssText = `grid-row:${pos.row};grid-column:${pos.col}`;
      if (isSel && ledColor) {
        k.style.borderColor = ledColor;
        k.style.boxShadow = `0 0 14px ${ledColor}cc, 0 0 28px ${ledColor}66`;
        k.style.color = ledColor;
      }
      k.textContent = isEmpty ? "·" : kc.replace(/^KC_/, "");
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
  lastKeyClickTime = performance.now(); // drives the reactive animation
  isDragging = true;
  selectedKeys.clear();
  selectedKeys.add(idx);
  syncPillInputs();
  renderBoard();
  openPill();
}

function onKeyEnter(idx) {
  if (!isDragging) return;
  selectedKeys.add(idx);
  syncPillInputs();
  renderBoard();
}

function syncPillInputs() {
  if (selectedKeys.size === 1) {
    const [idx] = selectedKeys;
    const kc = keymap.layers[0].keys[idx] ?? "KC_NO";
    document.getElementById("pill-kc").value = kc === "KC_NO" ? "" : kc;
    const col = keyLedColors[idx];
    if (col) document.getElementById("pill-color").value = col;
  } else {
    document.getElementById("pill-kc").value = "";
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
  layers.push({ id, name, keymap: structuredClone(keymap), leds: [...keyLedColors] });
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
    keyLedColors = Array(21).fill("");
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
  keyLedColors = [...layer.leds];
  activeProfileId = id;
  selectedKeys.clear();
  closePill();
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
  keyLedColors = Array.from({ length: 21 }, () => "");
  activeProfileId = null;
  selectedKeys.clear();
  closePill();
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
    item.setAttribute("draggable", "true");

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

    // Drag to reorder
    item.addEventListener("dragstart", (e) => {
      dragSrcId = layer.id;
      e.dataTransfer.effectAllowed = "move";
      item.classList.add("dragging");
      // inline style already set by openDropdown(); remains visible even when :hover is stripped
    });
    item.addEventListener("dragend", () => {
      dragSrcId = null;
      item.classList.remove("dragging");
      list.querySelectorAll(".drag-over").forEach(el => el.classList.remove("drag-over"));
      // if pointer left the wrap during drag, close now that drag is done
      setTimeout(() => {
        const wrap = document.getElementById("sl-wrap");
        if (!wrap.matches(":hover")) {
          document.getElementById("sl-dropdown").style.display = "";
          document.getElementById("sl-new-row").classList.remove("open");
          document.getElementById("sl-new-input").classList.remove("error");
        }
      }, 0);
    });
    item.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (layer.id !== dragSrcId) item.classList.add("drag-over");
    });
    item.addEventListener("dragleave", () => item.classList.remove("drag-over"));
    item.addEventListener("drop", (e) => {
      e.preventDefault();
      item.classList.remove("drag-over");
      if (!dragSrcId || dragSrcId === layer.id) return;
      reorderLayers(dragSrcId, layer.id);
      renderSavedLayers();
    });

    list.appendChild(item);
  }
}

function openPill()  { document.getElementById("settings-pill").classList.add("visible"); }
function closePill() { document.getElementById("settings-pill").classList.remove("visible"); }

function openUnderglowPill() {
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
