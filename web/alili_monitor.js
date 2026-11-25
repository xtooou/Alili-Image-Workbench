// Alili 资源监控条 —— 并入 Alili-Image-Workbench
// CPU / 内存 / 显卡 / 显存 / 温度 + 每步耗时 + 模型驻留状态
// 无节点，只有一条可拖拽的浮层。

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const EVENT = "alili.monitor";
const LS_POS = "AliliMonitor.Position";
const LS_AUTO = "AliliMonitor.Auto";
const LS_THEME = "AliliMonitor.Theme";

// Alili 统一色板
const UI = {
  face: "#2b2d32",
  faceHover: "#35383e",
  text: "#e3e3e3",
  muted: "#9aa0a6",
  line: "rgba(255,255,255,.12)",
  lineHover: "rgba(255,255,255,.24)",
  accent: "#8ab4f8",
  warn: "#ff8a9a",
};

// 语义色（填充条用，低透明度铺底）
const TINT = {
  cpu: "rgba(56,189,248,.22)",
  ram: "rgba(167,139,250,.22)",
  gpu: "rgba(52,211,153,.22)",
  vram: "rgba(251,146,60,.24)",
  temp: "rgba(244,114,182,.22)",
  hdd: "rgba(148,163,184,.22)",
  sit: "rgba(138,180,248,.22)",
  res: "rgba(255,138,154,.20)",
  danger: "rgba(248,113,113,.26)",
};

const STYLE = `
.aim-root {
  --aim-shell: #202226;
  --aim-cell: #2b2d32;
  --aim-cell-hover: #35383e;
  --aim-text: #e3e3e3;
  --aim-muted: #9aa0a6;
  --aim-hair: rgba(255,255,255,.12);
  position: fixed;
  z-index: 850;
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 4px;
  padding: 4px;
  border-radius: 9px;
  background: var(--aim-shell);
  font-family: inherit;
  -webkit-user-select: none;
  user-select: none;
}
.aim-root.aim-light {
  --aim-shell: #ffffff;
  --aim-cell: #e9e9e9;
  --aim-cell-hover: #dedede;
  --aim-text: #1f2124;
  --aim-muted: #6b7076;
  --aim-hair: rgba(0,0,0,.14);
}
.aim-pill.aim-drag { cursor: grab; }
.aim-pill.aim-drag:hover { background: var(--aim-cell-hover); }
.aim-pill.aim-drag:active,
.aim-pill.aim-drag.aim-dragging { cursor: grabbing; }
.aim-gear {
  width: 20px;
  height: 32px;
  flex: none;
  border-radius: 6px;
  background: var(--aim-cell);
  color: var(--aim-muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  line-height: 1;
}
.aim-gear:hover { color: var(--aim-text); background: var(--aim-cell-hover); }
.aim-pills { display: flex; flex-direction: row; gap: 5px; }
.aim-pill {
  position: relative;
  width: 124px;
  height: 32px;
  border-radius: 6px;
  overflow: hidden;
  background: var(--aim-cell);
  flex: none;
}
.aim-pill.aim-clickable { cursor: pointer; }
.aim-pill.aim-clickable:active { transform: scale(.98); }
.aim-fill {
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 0%;
  transition: width .35s ease, background .35s ease;
  pointer-events: none;
}
.aim-content {
  position: absolute;
  inset: 0 9px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  pointer-events: none;
}
.aim-label {
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: .05em;
  color: var(--aim-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.aim-value {
  font-size: 14px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  color: var(--aim-text);
  flex: none;
}
.aim-pill.aim-danger .aim-value { color: ${UI.warn}; }
.aim-root.aim-light .aim-pill.aim-danger .aim-value { color: #d9455f; }
.aim-root.aim-collapsed .aim-pill[data-key]:not([data-key="vram"]) { display: none; }
.aim-tip {
  position: fixed;
  z-index: 9000;
  padding: 6px 9px;
  border-radius: 8px;
  background: #1e1f22;
  border: 1px solid ${UI.line};
  color: ${UI.text};
  font-size: 11px;
  line-height: 1.55;
  pointer-events: none;
  white-space: pre;
  opacity: 0;
  transition: opacity .12s ease;
}
.aim-tip.aim-show { opacity: 1; }
.aim-tip.aim-light {
  background: #ffffff;
  border-color: rgba(0,0,0,.14);
  color: #1f2124;
}
.aim-menu {
  position: fixed;
  z-index: 9001;
  min-width: 208px;
  padding: 5px;
  border-radius: 10px;
  background: #1e1f22;
  border: 1px solid ${UI.line};
  box-shadow: 0 8px 26px rgba(0,0,0,.5);
}
.aim-menu.aim-light {
  background: #ffffff;
  border-color: rgba(0,0,0,.14);
  box-shadow: 0 8px 26px rgba(0,0,0,.18);
}
.aim-menu-title {
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: .08em;
  color: ${UI.muted};
  padding: 5px 9px 3px 9px;
}
.aim-menu.aim-light .aim-menu-title,
.aim-menu.aim-light .aim-menu-hint { color: #6b7076; }
.aim-menu.aim-light .aim-menu-item { color: #1f2124; }
.aim-menu.aim-light .aim-menu-item:hover { background: #f1f1f1; }
.aim-menu.aim-light .aim-menu-right { color: #6b7076; }
.aim-menu.aim-light .aim-switch { background: rgba(0,0,0,.14); border-color: rgba(0,0,0,.18); }
.aim-menu.aim-light .aim-switch::after { background: #3a3f46; }
.aim-menu.aim-light .aim-switch.aim-on {
  background: #5b8fe0;
  border-color: #5b8fe0;
}
.aim-menu.aim-light .aim-switch.aim-on::after { background: #ffffff; }
.aim-menu-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  text-align: left;
  padding: 7px 9px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: ${UI.text};
  font-size: 12px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
}
.aim-menu-item:hover { background: ${UI.faceHover}; }
.aim-menu-hint {
  font-size: 10px;
  color: ${UI.muted};
  font-weight: 400;
  margin-top: 1px;
  display: block;
}
.aim-switch {
  width: 30px;
  height: 16px;
  border-radius: 9px;
  background: rgba(255,255,255,.14);
  border: 1px solid ${UI.line};
  flex: none;
  position: relative;
  transition: background .2s ease;
}
.aim-switch.aim-on { background: rgba(138,180,248,.55); border-color: ${UI.accent}; }
.aim-switch::after {
  content: "";
  position: absolute;
  top: 1px; left: 1px;
  width: 12px; height: 12px;
  border-radius: 50%;
  background: ${UI.text};
  transition: transform .2s ease;
}
.aim-switch.aim-on::after { transform: translateX(14px); }
.aim-menu-right {
  font-size: 10px;
  color: ${UI.muted};
  flex: none;
}
.aim-dots {
  display: flex;
  gap: 7px;
  flex: none;
  align-items: center;
}
.aim-dot {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  box-sizing: border-box;
  border: 1px solid rgba(255,255,255,.3);
  cursor: pointer;
  transition: box-shadow .15s ease, transform .15s ease;
}
.aim-dot:hover { transform: scale(1.1); }
.aim-dot.aim-dot-on { box-shadow: 0 0 0 2px rgba(138,180,248,.75); }
.aim-menu.aim-light .aim-dot { border-color: rgba(0,0,0,.28); }
.aim-menu.aim-light .aim-dot.aim-dot-on { box-shadow: 0 0 0 2px rgba(80,120,200,.6); }
`;

// ---------------------------------------------------------------------------
// 设置项
// ---------------------------------------------------------------------------

const SID = {
  rate: "AliliMonitor.RefreshRate",
  cpu: "AliliMonitor.ShowCPU",
  ram: "AliliMonitor.ShowRAM",
  gpu: "AliliMonitor.ShowGPU",
  vram: "AliliMonitor.ShowVRAM",
  temp: "AliliMonitor.ShowTemp",
  hdd: "AliliMonitor.ShowDisk",
};

function setting(id, fallback) {
  try {
    return app.ui.settings.getSettingValue(id) ?? fallback;
  } catch {
    return fallback;
  }
}

// 主题：深色（默认）/ 浅色（外壳 #ffffff、格子 #e9e9e9）
function getTheme() {
  try {
    return localStorage.getItem(LS_THEME) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function applyTheme() {
  const light = getTheme() === "light";
  root.classList.toggle("aim-light", light);
  tip.classList.toggle("aim-light", light);
  try {
    for (const p of Object.values(pills)) p.repaint();
  } catch {
    /* pills 还没建好时忽略 */
  }
}

function setTheme(t) {
  try {
    localStorage.setItem(LS_THEME, t === "light" ? "light" : "dark");
  } catch {}
  applyTheme();
}

function formatBytes(bytes) {
  if (!bytes || bytes < 0) return "—";
  const gb = bytes / 1024 ** 3;
  if (gb >= 100) return `${gb.toFixed(0)} GB`;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

function shortGpuName(name) {
  if (!name) return "GPU";
  const short = name
    .replace(/NVIDIA|GeForce|AMD|Radeon|Intel\(R\)|Intel|\(TM\)|\(R\)|Graphics/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return short || name;
}

// 深色底用 22% 的淡色铺底；浅色底（#e9e9e9）上同样的淡色会看不见，所以把 alpha 提上去
function tintFor(tint) {
  if (getTheme() !== "light") return tint;
  return String(tint).replace(/,([\d.]+)\)$/i, (m, a) => {
    const alpha = Math.min(0.78, Number(a) * 2.7);
    return `,${alpha})`;
  });
}

function toast(severity, summary, detail) {
  try {
    app.extensionManager.toast.add({ severity, summary, detail, life: 3200 });
  } catch {
    console.log(`[AliliMonitor] ${summary}: ${detail}`);
  }
}

// ---------------------------------------------------------------------------
// 胶囊
// ---------------------------------------------------------------------------

class Pill {
  constructor(key, label, tint, { dangerAt = 90, clickable = false } = {}) {
    this.key = key;
    this.tint = tint;
    this.dangerAt = dangerAt;
    this.value = -1;

    this.el = document.createElement("div");
    this.el.className = "aim-pill";
    this.el.dataset.key = key;

    this.fill = document.createElement("div");
    this.fill.className = "aim-fill";
    this.fill.style.background = tintFor(tint);

    const content = document.createElement("div");
    content.className = "aim-content";
    this.labelEl = document.createElement("span");
    this.labelEl.className = "aim-label";
    this.labelEl.textContent = label;
    this.valueEl = document.createElement("span");
    this.valueEl.className = "aim-value";
    this.valueEl.textContent = "—";
    content.append(this.labelEl, this.valueEl);

    this.el.append(this.fill, content);
    if (clickable) this.el.classList.add("aim-clickable");
  }

  setVisible(v) {
    this.el.style.display = v ? "" : "none";
  }

  // pct: 0-100 用于填充；text: 右侧文字；tip: 悬停正文
  set(pct, text, tip) {
    this.value = pct;
    this.text = text;
    this.tip = tip ?? this.tip ?? "";
    if (pct < 0) {
      this.fill.style.width = "0%";
      this.valueEl.textContent = "—";
      return;
    }
    const clamp = Math.max(0, Math.min(100, pct));
    this.fill.style.width = `${clamp}%`;
    this.valueEl.textContent = text;
    const danger = this.dangerAt > 0 && pct >= this.dangerAt;
    this.el.classList.toggle("aim-danger", danger);
    this.fill.style.background = tintFor(danger ? TINT.danger : this.tint);
  }

  // 切换主题后按当前数值重刷一次填充色
  repaint() {
    if (this.value >= 0) this.set(this.value, this.text, this.tip);
  }
}

// ---------------------------------------------------------------------------
// 悬浮提示
// ---------------------------------------------------------------------------

const tip = document.createElement("div");
tip.className = "aim-tip";

function showTip(anchor, text) {
  if (!text) return;
  if (!tip.isConnected) document.body.appendChild(tip);
  tip.textContent = text;
  const r = anchor.getBoundingClientRect();
  tip.style.opacity = "0";
  tip.classList.add("aim-show");
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  let x = r.left;
  if (x + w > window.innerWidth - 6) x = window.innerWidth - w - 6;
  let y = r.bottom + 7;
  if (y + h > window.innerHeight - 6) y = r.top - h - 7;
  tip.style.left = `${Math.max(6, x)}px`;
  tip.style.top = `${Math.max(6, y)}px`;
}

function hideTip() {
  tip.classList.remove("aim-show");
}

// ---------------------------------------------------------------------------
// 菜单
// -------------------------------------------------------------------------------------------------------------------------------------------

let openMenu = null;

function closeMenu() {
  if (openMenu) {
    openMenu.remove();
    openMenu = null;
  }
}

document.addEventListener(
  "pointerdown",
  (e) => {
    // 齿轮自己负责开关菜单，别在这里先关掉
    if (e.target === gear) return;
    if (openMenu && !openMenu.contains(e.target)) closeMenu();
  },
  true
);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeMenu();
});

function buildMenu(anchorEl, title, rows) {
  closeMenu();
  hideTip();

  const menu = document.createElement("div");
  menu.className = "aim-menu" + (getTheme() === "light" ? " aim-light" : "");

  const t = document.createElement("div");
  t.className = "aim-menu-title";
  t.textContent = title;
  menu.appendChild(t);

  for (const row of rows) {
    const btn = document.createElement("button");
    btn.className = "aim-menu-item";

    const left = document.createElement("div");
    const main = document.createElement("div");
    main.textContent = row.label;
    left.appendChild(main);
    if (row.hint) {
      const h = document.createElement("span");
      h.className = "aim-menu-hint";
      h.textContent = row.hint;
      left.appendChild(h);
    }

    const right = document.createElement("span");
    if (row.dots) {
      right.className = "aim-dots";
      for (const d of row.dots) {
        const dot = document.createElement("span");
        dot.className = "aim-dot" + (d.active ? " aim-dot-on" : "");
        dot.style.background = d.color;
        dot.title = d.title || "";
        dot.addEventListener("click", (ev) => {
          ev.stopPropagation();
          d.onClick?.();
        });
        right.appendChild(dot);
      }
    } else if (row.switch) {
      right.className = "aim-switch" + (row.on ? " aim-on" : "");
    } else {
      right.className = "aim-menu-right";
      right.textContent = row.right || "";
    }

    btn.append(left, right);
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (row.dots) return; // 圆点自己处理点击，别把整行也点了
      row.onClick?.();
      if (!row.switch) closeMenu();
    });
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);
  const r = anchorEl.getBoundingClientRect();
  const mw = menu.offsetWidth;
  let x = Math.min(Math.max(6, r.left), window.innerWidth - mw - 6);
  let y = r.bottom + 7;
  const mh = menu.offsetHeight;
  if (y + mh > window.innerHeight - 6) y = Math.max(6, r.top - mh - 7);
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  openMenu = menu;
  return menu;
}

// ---------------------------------------------------------------------------
// 动作
// ---------------------------------------------------------------------------

async function freeAction(action, label) {
  try {
    const res = await api.fetchApi("/alili_monitor/free", {
      method: "POST",
      body: JSON.stringify({ action }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    toast("success", label, "已提交，在任务边界执行");
  } catch (err) {
    toast("error", `${label} 失败`, String(err?.message ?? err));
  }
}

// 自动开关：真值在后端（unload.on 文件是否存在），localStorage 只缓存显示
function loadAuto() {
  try {
    const raw = localStorage.getItem(LS_AUTO);
    if (raw) {
      const v = JSON.parse(raw);
      return { vram: !!v.vram };
    }
  } catch {}
  return { vram: false };
}

function saveAuto(cfg) {
  try {
    localStorage.setItem(LS_AUTO, JSON.stringify(cfg));
  } catch {}
}

let autoCfg = loadAuto();

// 页面打开时向后端问一次真实状态，避免"刷新后开关看着开着、其实后端是关的"
async function fetchAuto() {
  try {
    const res = await api.fetchApi("/alili_monitor/auto");
    const data = await res.json();
    if (typeof data?.vram === "boolean") {
      autoCfg = { vram: data.vram };
      saveAuto(autoCfg);
    }
  } catch {
    /* 后端没起或接口异常，保持本地缓存 */
  }
}

// 切换：开后端建 unload.on，关后端删 unload.on
async function setAutoVram(on) {
  try {
    const res = await api.fetchApi("/alili_monitor/auto", {
      method: "POST",
      body: JSON.stringify({ vram: !!on }),
    });
    const data = await res.json();
    if (typeof data?.vram === "boolean") {
      autoCfg = { vram: data.vram };
    } else {
      autoCfg = { vram: !!on };
    }
  } catch {
    autoCfg = { vram: !!on };
    toast("warn", "自动卸显存", "切换失败，后端没响应");
  }
  saveAuto(autoCfg);
  return autoCfg.vram;
}

// -------------------------------------------------------------------------------------------------------------------------------------------
// 主容器
// -------------------------------------------------------------------------------------------------------------------------------------------

const state = { models: [], gpus: [] };

const root = document.createElement("div");
root.className = "aim-root";

const gear = document.createElement("div");
gear.className = "aim-gear";
gear.textContent = "⚙";
gear.title = "监控设置";

const pillsBox = document.createElement("div");
pillsBox.className = "aim-pills";
root.append(pillsBox, gear);

const pills = {
  cpu: new Pill("cpu", "CPU", TINT.cpu),
  ram: new Pill("ram", "内存", TINT.ram, { clickable: true }),
  gpu: new Pill("gpu", "GPU", TINT.gpu, { dangerAt: 95 }),
  vram: new Pill("vram", "显存", TINT.vram, { clickable: true, dangerAt: 92 }),
  temp: new Pill("temp", "温度", TINT.temp, { dangerAt: 85 }),
  sit: new Pill("sit", "S/IT", TINT.sit),
  res: new Pill("res", "驻留", TINT.res, { clickable: true, dangerAt: 0 }),
};

// 横排顺序：CPU / 内存 / 显存 / GPU / 温度 / SIT / 驻留
for (const p of [pills.cpu, pills.ram, pills.vram, pills.gpu, pills.temp, pills.sit, pills.res]) {
  pillsBox.appendChild(p.el);
}

function applyVisibility() {
  pills.cpu.setVisible(setting(SID.cpu, true));
  pills.ram.setVisible(setting(SID.ram, true));
  pills.gpu.setVisible(setting(SID.gpu, true));
  pills.vram.setVisible(setting(SID.vram, true));
  pills.temp.setVisible(setting(SID.temp, true));
  // S/IT 与驻留不参与显隐设置，常驻
}

// 位置
function hasSavedPos() {
  try {
    return !!localStorage.getItem(LS_POS);
  } catch {
    return false;
  }
}

function loadPos() {
  try {
    const raw = localStorage.getItem(LS_POS);
    if (raw) {
      const p = JSON.parse(raw);
      if (Number.isFinite(p.left) && Number.isFinite(p.top)) return p;
    }
  } catch {}
  return defaultPos();
}

function applyPos(p) {
  root.style.left = `${Math.max(0, p.left)}px`;
  root.style.top = `${Math.max(0, p.top)}px`;
}

function savePos() {
  try {
    const r = root.getBoundingClientRect();
    localStorage.setItem(LS_POS, JSON.stringify({ left: Math.round(r.left), top: Math.round(r.top) }));
  } catch {}
}

// 拖拽把手：CPU 那一格；折叠后 CPU 藏起来，齿轮也能拖
const dragEl = pills.cpu.el;
dragEl.classList.add("aim-drag");
dragEl.title = "拖动整条，双击复位";

let drag = null;
let dragSource = null;

function beginDrag(el, e) {
  const r = root.getBoundingClientRect();
  drag = { x: e.clientX, y: e.clientY, left: r.left, top: r.top, moved: false };
  dragSource = el;
  el.classList.add("aim-dragging");
  el.setPointerCapture?.(e.pointerId);
}

dragEl.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  e.stopPropagation();
  beginDrag(dragEl, e);
});

window.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
  const left = Math.min(Math.max(0, drag.left + dx), window.innerWidth - root.offsetWidth);
  const top = Math.min(Math.max(0, drag.top + dy), window.innerHeight - 24);
  applyPos({ left, top });
});

window.addEventListener("pointerup", () => {
  if (!drag) return;
  const src = dragSource;
  dragSource = null;
  drag = null;
  src?.classList.remove("aim-dragging");
  savePos();
});

dragEl.addEventListener("dblclick", () => {
  applyPos(defaultPos());
  savePos();
});

// 齿轮：单击开菜单（纯按钮，不参与拖拽）
function openGearMenu() {
  closeMenu();
  const cfg = autoCfg;
  buildMenu(gear, "ALILI 监控", [
    {
      label: "自动卸显存",
      hint: "每个任务开跑前把权重退出显存",
      switch: true,
      on: cfg.vram,
      onClick: () => {
        closeMenu();
        setAutoVram(!autoCfg.vram).then(() => openGearMenu());
      },
    },
    {
      label: "折叠成单体",
      hint: "只留显存那一格",
      onClick: () => {
        root.classList.toggle("aim-collapsed");
        savePos();
      },
    },
    {
      label: "主题",
      dots: [
        {
          color: "#2b2d32",
          title: "深色",
          active: getTheme() === "dark",
          onClick: () => {
            setTheme("dark");
            openGearMenu();
          },
        },
        {
          color: "#e9e9e9",
          title: "浅色",
          active: getTheme() === "light",
          onClick: () => {
            setTheme("light");
            openGearMenu();
          },
        },
      ],
    },
  ]);
}

gear.addEventListener("click", (e) => {
  e.stopPropagation();
  if (openMenu) {
    closeMenu();
    return;
  }
  openGearMenu();
});

// 胶囊点击菜单
pills.vram.el.addEventListener("click", (e) => {
  e.stopPropagation();
  buildMenu(pills.vram.el, "显存", [
    {
      label: "卸载模型",
      hint: "权重退回内存，不触发冷启动",
      onClick: () => freeAction("unload_models", "卸载模型"),
    },
    {
      label: "清空显存缓存",
      hint: "只 gc + 释放 CUDA 缓存块",
      onClick: () => freeAction("purge_vram", "清空显存缓存"),
    },
  ]);
});

pills.ram.el.addEventListener("click", (e) => {
  e.stopPropagation();
  buildMenu(pills.ram.el, "内存", [
    {
      label: "释放内存",
      hint: "清执行缓存 + 卸载模型 + gc",
      onClick: () => freeAction("purge_ram", "释放内存"),
    },
  ]);
});

pills.res.el.addEventListener("click", (e) => {
  e.stopPropagation();
  const rows = [];
  if (state.models.length === 0) {
    rows.push({ label: "当前无驻留模型", hint: "显存干净", onClick: () => {} });
  } else {
    for (const m of state.models) {
      rows.push({
        label: m.name || "模型",
        hint: formatBytes(m.vram),
        onClick: () => freeAction("unload_models", "卸载模型"),
      });
    }
  }
  buildMenu(pills.res.el, "驻留状态", rows);
});

// 悬停提示
for (const p of Object.values(pills)) {
  p.el.addEventListener("mouseenter", () => {
    if (openMenu) return;
    showTip(p.el, p.tip || "");
  });
  p.el.addEventListener("mouseleave", hideTip);
}

// -------------------------------------------------------------------------------------------------------------------------------------------
// 数据
// -------------------------------------------------------------------------------------------------------------------------------------------

function onData(d) {
  if (!d) return;
  pills.cpu.set(d.cpu ?? -1, `${Math.round(d.cpu ?? 0)}%`, `CPU ${(d.cpu ?? 0).toFixed(1)}%`);

  if (d.ram) {
    pills.ram.set(
      d.ram.percent,
      `${Math.round(d.ram.percent)}%`,
      `${formatBytes(d.ram.used)} / ${formatBytes(d.ram.total)}`
    );
  }

  state.models = Array.isArray(d.models) ? d.models : [];
  pills.res.set(
    state.models.length > 0 ? 100 : 0,
    state.models.length > 0 ? `${state.models.length} 个` : "空",
    state.models.length > 0
      ? state.models.map((m) => `${m.name}  ${formatBytes(m.vram)}`).join("\n")
      : "显存无驻留模型"
  );
  pills.res.el.classList.toggle("aim-danger", state.models.length > 0);

  if (Array.isArray(d.gpus) && d.gpus.length) {
    state.gpus = d.gpus;
    const g = d.gpus[0];
    pills.gpu.set(
      g.utilization,
      `${g.utilization}%`,
      `${shortGpuName(g.name)}\n利用率 ${g.utilization}%`
    );
    pills.vram.set(
      g.vram_percent,
      `${Math.round(g.vram_percent)}%`,
      `${shortGpuName(g.name)}\n${formatBytes(g.vram_used)} / ${formatBytes(g.vram_total)}`
    );
    pills.temp.set(g.temperature, `${g.temperature}°`, `${shortGpuName(g.name)} 核心 ${g.temperature}°C`);
  }
}

// 每步耗时：和 tqdm / ComfyUI 前端同一套算法 —— 平滑的累计平均，而不是「两次事件的间隔」
// （间隔法在 4 步这种少步数流程上抓不到样本，前几步完全不动）
const SIT_SEED = "AliliMonitor.SitSeed";
let sitEma = 0;      // 平滑后的 s/it
let sitAt = 0;       // 上一次 progress 时间
let sitNode = null;  // 当前采样节点（换节点 = 换阶段，各自起算）
let taskAt = 0;      // 本次任务开始时间（首个样本没间隔时兜底）

try {
  const v = Number(localStorage.getItem(SIT_SEED));
  if (v > 0 && v < 120) sitEma = v;
} catch {}

api.addEventListener("execution_start", () => {
  taskAt = performance.now();
  sitAt = 0;
  sitNode = null;
});

api.addEventListener("progress", (ev) => {
  const d = ev?.detail;
  if (!d) return;
  const max = Number(d.max);
  const val = Number(d.value);
  if (!Number.isFinite(max) || max <= 0) return;

  // 采样节点变了，说明进入新的采样阶段（二采 / 放大等），间隔重新起算
  if (d.node !== sitNode) {
    sitNode = d.node;
    sitAt = 0;
  }

  const now = performance.now();
  let gap = 0;
  if (sitAt) gap = (now - sitAt) / 1000;
  else if (taskAt) gap = (now - taskAt) / 1000; // 首个样本含加载时间，权重压低

  if (gap > 0.05 && gap < 120) {
    const w = sitAt ? 0.35 : sitEma > 0 ? 0.2 : 0.5;
    sitEma = sitEma > 0 ? sitEma * (1 - w) + gap * w : gap;
    try {
      localStorage.setItem(SIT_SEED, sitEma.toFixed(3));
    } catch {}
  }

  if (sitEma > 0) {
    const fast = sitEma <= 4.2;
    pills.sit.set(
      Math.min(100, (sitEma / 10) * 100),
      sitEma.toFixed(2),
      `${val}/${max} 步 · 每步约 ${sitEma.toFixed(2)} s\n档位：${fast ? "正常" : "慢（建议开跑前卸显存）"}`
    );
    pills.sit.tint = fast ? TINT.sit : TINT.res;
    if (!pills.sit.el.classList.contains("aim-danger")) {
      pills.sit.fill.style.background = tintFor(pills.sit.tint);
    }
  }
  sitAt = now;
});

api.addEventListener(EVENT, (ev) => {
  if (ev?.detail) onData(ev.detail);
});

// ---------------------------------------------------------------------------
// 画布左上角的「应用 › 图形」面包屑 —— 只读位置用来贴靠，不改它的显隐
// ---------------------------------------------------------------------------

function breadcrumbRect() {
  for (const el of document.querySelectorAll(".floating-pane")) {
    const txt = (el.innerText || "").replace(/\s+/g, " ").trim();
    if (!txt || txt.length > 40) continue;
    if (!/应用|Application/.test(txt)) continue;
    if (!/图形|Graph|Subgraph/.test(txt)) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 40 && r.height > 8) return r;
  }
  return null;
}

function defaultPos() {
  const r = breadcrumbRect();
  if (r) return { left: Math.round(r.right + 8), top: Math.round(r.top) };
  return { left: 204, top: 46 };
}

// -------------------------------------------------------------------------------------------------------------------------------------------
// 注册
// -------------------------------------------------------------------------------------------------------------------------------------------

app.registerExtension({
  name: "AliliMonitor",
  settings: [
    {
      id: SID.rate,
      name: "Alili 监控刷新间隔（秒）",
      type: "slider",
      attrs: { min: 0.25, max: 5, step: 0.25 },
      defaultValue: 1,
      onChange: (v) => patchRate(Number(v) || 1),
    },
    { id: SID.cpu, name: "显示 CPU", type: "boolean", defaultValue: true, onChange: applyVisibility },
    { id: SID.ram, name: "显示内存", type: "boolean", defaultValue: true, onChange: applyVisibility },
    { id: SID.gpu, name: "显示 GPU 利用率", type: "boolean", defaultValue: true, onChange: applyVisibility },
    { id: SID.vram, name: "显示显存", type: "boolean", defaultValue: true, onChange: applyVisibility },
    { id: SID.temp, name: "显示 GPU 温度", type: "boolean", defaultValue: true, onChange: applyVisibility },
    { id: SID.hdd, name: "显示磁盘", type: "boolean", defaultValue: false, onChange: applyVisibility },
  ],

  setup() {
    const style = document.createElement("style");
    style.textContent = STYLE;
    document.head.appendChild(style);

    applyPos(loadPos());
    applyVisibility();
    document.body.appendChild(root);
    applyTheme();
    fetchAuto();

    patchRate(Number(setting(SID.rate, 1)) || 1);

    // 面包屑比脚本晚渲染一会儿，位置没就绪时先贴一个兜底值，再对齐几次。
    // 用户拖过（localStorage 有记录）就不再自动对齐。
    if (!hasSavedPos()) {
      applyPos(defaultPos());
      const alignTimer = setInterval(() => {
        if (hasSavedPos()) {
          clearInterval(alignTimer);
          return;
        }
        applyPos(defaultPos());
      }, 500);
      setTimeout(() => clearInterval(alignTimer), 5000);
    }

    // 开跑前卸载显存由后端 PromptExecutor.execute 钩子负责，前端不再参与触发。
    // 旧的「队列空转满 → 发 /free」那套已删除：它把 status 事件的字段读低了一层，
    // 从来没有真正触发过。
  },
});

let rateTimer = null;
function patchRate(rate) {
  clearTimeout(rateTimer);
  rateTimer = setTimeout(() => {
    api
      .fetchApi("/alili_monitor/config", {
        method: "PATCH",
        body: JSON.stringify({ rate }),
      })
      .catch(() => {});
  }, 250);
}
