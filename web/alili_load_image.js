import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

// =============================================================================
// Alili 加载图像节点 · 前端
//   - 竖排图像列表，每张都是 1:1 方图，超出出滚动条；缩略图宽度跟随节点宽度（拉宽节点图片一起放大）
//   - 左下角编号（= 提示词里 <imageN> 的 N），右上角 ×，右下角分辨率；点击图片 = 往工作台提示词插入 <imageN>
//   - 右键缩略图 → 「复制图像文件」（后端把本地文件放进系统剪贴板）
//   - 「换形象」：素材库多选 → 底部抽屉（图1~图4 + 命中提示词 + 自动优化开关）
//     确定 = 按槽位写回节点，再调下游工作台的 __aliliLook() 填提示词（可选顺手优化一次）
//   - 只做参考图收集：不做遮罩、不做画板、不做扩图
//   - 对外接口：node._aliliGetImages()，供工作台读取缩略图 / LLM 推理 / 自适应比例（含 role）
// =============================================================================

const NODE = "AliliLoadImage";
const STATE_KEY = "alili_state_json";
const MAX_IMAGES = 9;
const DEFAULT_SIZE = [340, 420];
const MIN_PANEL_HEIGHT = 160;
const IMAGE_BLUE = "#64B5F6";            // 与 ComfyUI 原生 IMAGE 接口同色
const WORKBENCH_NODE = "AliliImageWorkbench";

// 素材库
const ASSET_LIBRARY_ROUTE = "/alili/asset/library";
const ASSET_UPLOAD_ROUTE = "/alili/asset/upload";
const ASSET_DELETE_ROUTE = "/alili/asset/delete";
const ASSET_MOVE_ROUTE = "/alili/asset/move";
const ASSET_CONFIG_ROUTE = "/alili/asset/config";
const ASSET_BROWSE_ROUTE = "/alili/asset/browse";
const ASSET_FAVORITES_ROUTE = "/alili/asset/favorites";
const ASSET_FAVORITE_ROUTE = "/alili/asset/favorite";

// ---- 换形象：槽位定义（顺序 = 提示词里的图号：人像图1，之后服装→姿势→发型）----
const SLOT_ORDER = ["face", "cloth", "pose", "hair"];
const SLOT_LABELS = { face: "人像", cloth: "服装", pose: "姿势", hair: "发型" };
const ROLE_SLOT = { "人像": "face", "服装": "cloth", "姿势": "pose", "发型": "hair" };
const LOOK_ROUTE = "/alili/image-workbench/shop/presets";
const LOOK_AUTO_KEY = "alili_look_auto";
// 比例表照搬 GHIL：少一个选项用起来就断手
const CROP_RATIOS = ["自由", "1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9", "1:2", "2:1"];

// ---- 小工具 ----
function make(tag, css = {}, text = "") {
    const el = document.createElement(tag); Object.assign(el.style, css);
    if (text) el.textContent = text; return el;
}
function widget(node, name) { return node.widgets?.find(w => w.name === name); }
function dropWidgetSocket(node, name) {
    const index = node.inputs?.findIndex(i => i?.widget?.name === name || i?.name === name) ?? -1;
    if (index >= 0) { try { node.removeInput(index); } catch (err) { console.warn("[Alili]", err); } }
}
function hideWidget(w) {
    if (!w) return;
    w.hidden = true; w.options = w.options || {}; w.options.hidden = true;
    w.computeSize = () => [0, -4]; w.serialize = true;
}
function isImageFile(file) {
    return file.type?.startsWith("image/") || /\.(png|jpe?g|webp|bmp|gif)$/i.test(file.name);
}
function fileUrl(name) {
    if (!name || name === "(none)") return "";
    // 素材库可能落在任意可配置目录：绝对路径走素材路由，其余照旧走 /view
    if (/^[a-zA-Z]:[\\/]/.test(name) || name.startsWith("/")) {
        const path = `/alili/asset/file?path=${encodeURIComponent(name)}`;
        return typeof api.apiURL === "function" ? api.apiURL(path) : path;
    }
    const parts = String(name).replaceAll("\\", "/").split("/").filter(Boolean);
    const filename = parts.pop() || "";
    const params = new URLSearchParams({ filename, type: "input", subfolder: parts.join("/") });
    const path = `/view?${params.toString()}`;
    return typeof api.apiURL === "function" ? api.apiURL(path) : path;
}
async function uploadFile(file) {
    const body = new FormData(); body.append("image", file, file.name); body.append("type", "input");
    const response = await api.fetchApi("/upload/image", { method: "POST", body });
    if (!response.ok) throw new Error(`Upload failed: ${response.status}`);
    const result = await response.json();
    return [result.subfolder, result.name].filter(Boolean).join("/");
}
function probeSize(name) {
    return new Promise(resolve => {
        const img = new Image();
        img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => resolve({ w: 0, h: 0 });
        img.src = fileUrl(name);
    });
}

// ---- 换形象的零碎：角色 → 槽位 / 自动优化开关 / 找下游工作台 / 造型预设 ----
const slotOfRole = role => ROLE_SLOT[String(role || "").trim()] || "";

function loadAutoOptimize() {
    try { return localStorage.getItem(LOOK_AUTO_KEY) !== "0"; } catch { return true; }
}
function saveAutoOptimize(on) {
    try { localStorage.setItem(LOOK_AUTO_KEY, on ? "1" : "0"); } catch { /* 隐私模式忽略 */ }
}

// 下游工作台：顺着本节点的输出连线找 AliliImageWorkbench（没连 / 连的不是它 → null）
function findWorkbench(node) {
    const graph = node.graph || app.graph;
    for (const output of node.outputs || []) {
        for (const linkId of output.links || []) {
            const link = graph?.getLink ? graph.getLink(linkId)
                : (graph?.links instanceof Map ? graph.links.get(linkId) : graph?.links?.[linkId]);
            const target = link ? graph.getNodeById(link.target_id) : null;
            if (target && (target.comfyClass === WORKBENCH_NODE || target.type === WORKBENCH_NODE)) return target;
        }
    }
    return null;
}

// 造型预设（prompt/look_prompt/*.md）：slots 完全一致才命中
let lookPresets = null;
async function loadLookPresets() {
    // 每次都重读：在 Skill 里改了 md，下次打开抽屉就是新内容
    try {
        const res = await api.fetchApi(LOOK_ROUTE);
        const data = await res.json();
        lookPresets = Array.isArray(data.presets) ? data.presets : [];
    } catch {
        lookPresets = [];
    }
    return lookPresets;
}
const lookKey = slots => [...slots].sort().join("+");
const pickLookPreset = slots => {
    const key = lookKey(slots);
    return (lookPresets || []).find(p => Array.isArray(p.slots) && lookKey(p.slots) === key) || null;
};

// ---- 右键「复制图像文件」：交给后端把本地文件写进系统剪贴板 ----
// 旧做法（fetch 图片 → canvas 转 PNG → navigator.clipboard.write）受浏览器权限和
// PNG 编码影响经常静默失败。改由后端走 Win32 CF_HDROP，复制的是磁盘上的原文件，
// 资源管理器 / 微信 / PS 等任意程序都能直接 Ctrl+V 粘贴为文件。
const COPY_ROUTE = "/alili/image-workbench/copy-files";

let openMenu = null;
let dismissHandler = null;
function closeMenu() {
    openMenu?.remove();
    openMenu = null;
    if (dismissHandler) {
        document.removeEventListener("pointerdown", dismissHandler, true);
        dismissHandler = null;
    }
}
// 加载节点的 name 是 "subfolder/xxx.png"，统一拆成后端要的三元组
function fileRef(name) {
    const parts = String(name || "").replaceAll("\\", "/").split("/").filter(Boolean);
    const filename = (parts.pop() || "").replace(/\s*\[(?:input|output|temp)\]$/i, "");
    return { filename, subfolder: parts.join("/"), type: "input" };
}
async function copyFileToClipboard(ref) {
    const res = await api.fetchApi(COPY_ROUTE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: [ref] }),
    });
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
}
let toastTimer = null;
function copyToast(message, failed) {
    let el = document.getElementById("alili-load-copy-toast");
    if (!el) {
        el = make("div", {
            position: "fixed", right: "18px", bottom: "20px", zIndex: "10200",
            maxWidth: "min(420px, calc(100vw - 40px))", padding: "9px 14px",
            borderRadius: "7px", font: "12px/1.5 Arial, sans-serif",
            boxShadow: "0 8px 26px rgba(0,0,0,.45)", pointerEvents: "none",
            wordBreak: "break-all", display: "none",
        });
        el.id = "alili-load-copy-toast";
        document.body.appendChild(el);
    }
    el.textContent = message;
    el.style.display = "block";
    el.style.background = failed ? "#5a2730" : "#1d3c33";
    el.style.color = failed ? "#ffd9de" : "#cdf3e0";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.style.display = "none"; }, 2400);
}
function showCopyMenu(x, y, ref) {
    closeMenu();
    const menu = make("div", {
        position: "fixed", left: `${Math.max(0, Math.min(x, window.innerWidth - 160))}px`, top: `${Math.max(0, Math.min(y, window.innerHeight - 48))}px`, zIndex: "10210",
        minWidth: "130px", padding: "4px", background: "#17222c", color: "#dbe8f1",
        border: "1px solid #3a4d5b", borderRadius: "6px", boxShadow: "0 8px 24px rgba(0,0,0,.45)",
        font: "12px Arial, sans-serif",
    });
    // 关键：菜单自身的 pointerdown 不能冒泡到 document，否则外部关闭监听会提前移除菜单，
    // 导致后面的 click 根本派发不到菜单项（表现就是「点了没反应」）
    menu.addEventListener("pointerdown", e => e.stopPropagation());
    menu.addEventListener("contextmenu", e => e.preventDefault());
    const item = make("div", { padding: "6px 10px", cursor: "pointer", borderRadius: "4px" }, "复制图像文件");
    item.title = "把本地文件放进系统剪贴板，可在任意程序 Ctrl+V 粘贴";
    item.onmouseenter = () => { item.style.background = "#274252"; };
    item.onmouseleave = () => { item.style.background = "transparent"; };
    item.onclick = async e => {
        e.stopPropagation();
        closeMenu();
        try {
            const data = await copyFileToClipboard(ref);
            copyToast(`已复制：${data.names?.join("、") || ref.filename}（可 Ctrl+V 粘贴为文件）`, false);
        } catch (err) {
            console.warn("[Alili] 复制文件失败：", err);
            copyToast(`复制失败：${err.message}`, true);
        }
    };
    menu.appendChild(item);
    document.body.appendChild(menu);
    openMenu = menu;
    dismissHandler = e => { if (!menu.contains(e.target)) closeMenu(); };
    setTimeout(() => {
        if (dismissHandler && openMenu === menu) document.addEventListener("pointerdown", dismissHandler, true);
    }, 0);
}
function bindCopy(el, name) {
    el.addEventListener("contextmenu", e => {
        e.preventDefault();
        e.stopPropagation();
        showCopyMenu(e.clientX, e.clientY, fileRef(name));
    });
}
// 素材卡片右键菜单：删除素材（原图移 .trash，缩略图缓存清掉）
function showAssetCardMenu(x, y, onDelete) {
    closeMenu();
    const menu = make("div", {
        position: "fixed", left: `${Math.max(0, Math.min(x, window.innerWidth - 160))}px`, top: `${Math.max(0, Math.min(y, window.innerHeight - 48))}px`, zIndex: "10210",
        minWidth: "130px", padding: "4px", background: "#17222c", color: "#dbe8f1",
        border: "1px solid #3a4d5b", borderRadius: "6px", boxShadow: "0 8px 24px rgba(0,0,0,.45)",
        font: "12px Arial, sans-serif",
    });
    menu.addEventListener("pointerdown", e => e.stopPropagation());
    menu.addEventListener("contextmenu", e => e.preventDefault());
    const del = make("div", { padding: "6px 10px", cursor: "pointer", borderRadius: "4px", color: "#ff9e9e" }, "删除素材");
    del.title = "原图移到素材库 .trash/ 目录，不会永久删除";
    del.onmouseenter = () => { del.style.background = "#3a2329"; };
    del.onmouseleave = () => { del.style.background = "transparent"; };
    del.onclick = async e => {
        e.stopPropagation();
        closeMenu();
        await onDelete();
    };
    menu.appendChild(del);
    document.body.appendChild(menu);
    openMenu = menu;
    dismissHandler = e => { if (!menu.contains(e.target)) closeMenu(); };
    setTimeout(() => {
        if (dismissHandler && openMenu === menu) document.addEventListener("pointerdown", dismissHandler, true);
    }, 0);
}

// ---- 参考图缩放弹窗 ----
const RESIZE_DEFAULT = { enabled: false, megapixels: 1.0, include_first: true };
function normalizeResize(raw) {
    const r = raw && typeof raw === "object" ? raw : {};
    let mp = Number(r.megapixels);
    if (!Number.isFinite(mp)) mp = RESIZE_DEFAULT.megapixels;
    mp = Math.min(16, Math.max(0.1, mp));
    return {
        enabled: !!r.enabled,
        megapixels: mp,
        include_first: r.include_first !== false,  // 缺省/老数据 = 勾选
    };
}
function mpLabel(mp) {
    const side = Math.round(Math.sqrt(mp) * 1024);
    return `${Number(mp).toFixed(1)} MP (≈${side}×${side})`;
}
let openResize = null;
function closeResize() {
    openResize?.backdrop?.remove();
    openResize = null;
}
function showResizeDialog(current, onApply) {
    closeResize();
    const cfg = normalizeResize(current);
    const back = make("div"); back.className = "alli-dlg-back";
    const dlg = make("div"); dlg.className = "alli-dlg";
    dlg.addEventListener("pointerdown", e => e.stopPropagation());

    const hd = make("div"); hd.className = "alli-dlg-hd";
    hd.appendChild(make("span", {}, "参考图缩放"));
    const x = make("button", {}, "×"); x.className = "alli-dlg-x"; x.title = "关闭";
    x.onclick = () => closeResize();
    hd.appendChild(x);

    // 1 · 启用缩放
    const row1 = make("div"); row1.className = "alli-dlg-row";
    const lb1wrap = make("div");
    lb1wrap.appendChild(make("div", {}, "1 · 启用缩放")); lb1wrap.children[0].className = "alli-dlg-lb";
    lb1wrap.appendChild(make("div", {}, "关闭 = 全部保持原图")); lb1wrap.children[1].className = "alli-dlg-sub";
    const sw = make("label"); sw.className = "alli-sw";
    const swInput = document.createElement("input"); swInput.type = "checkbox"; swInput.checked = cfg.enabled;
    const track = make("span"); track.className = "track";
    sw.append(swInput, track);
    row1.append(lb1wrap, sw);

    // 2 · 总像素
    const row2 = make("div"); row2.className = "alli-dlg-row";
    const lb2wrap = make("div");
    lb2wrap.appendChild(make("div", {}, "2 · 总像素")); lb2wrap.children[0].className = "alli-dlg-lb";
    const mpVal = make("span"); mpVal.className = "alli-mp-val"; mpVal.textContent = mpLabel(cfg.megapixels);
    lb2wrap.appendChild(mpVal);
    const slider = document.createElement("input"); slider.type = "range";
    slider.min = "0.3"; slider.max = "4"; slider.step = "0.1"; slider.value = String(cfg.megapixels);
    slider.oninput = () => { mpVal.textContent = mpLabel(Number(slider.value)); };
    row2.append(lb2wrap, slider);

    // 3 · 图1也缩放
    const row3 = make("div"); row3.className = "alli-dlg-row";
    const lb3wrap = make("div");
    lb3wrap.appendChild(make("div", {}, "3 · 图1也缩放")); lb3wrap.children[0].className = "alli-dlg-lb";
    lb3wrap.appendChild(make("div", {}, "不勾选则第 1 张保持原图")); lb3wrap.children[1].className = "alli-dlg-sub";
    const ck = document.createElement("input"); ck.type = "checkbox"; ck.className = "alli-ck"; ck.checked = cfg.include_first;
    const ckLabel = make("label"); ckLabel.style.cssText = "display:flex;align-items:center;cursor:pointer"; ckLabel.appendChild(ck);
    row3.append(lb3wrap, ckLabel);

    const note = make("div"); note.className = "alli-dlg-note";
    note.textContent = "锁定：保持宽高比 · area 算法 · 8 倍数对齐 · 不改原图文件";

    const btns = make("div"); btns.className = "alli-dlg-btns";
    const cancel = make("button", {}, "取消"); cancel.onclick = () => closeResize();
    const go = make("button", {}, "应用 ↗"); go.className = "go";
    go.onclick = () => {
        onApply({
            enabled: swInput.checked,
            megapixels: Number(slider.value),
            include_first: ck.checked,
        });
        closeResize();
    };
    btns.append(cancel, go);

    const sync = () => {
        const on = swInput.checked;
        row2.classList.toggle("dim", !on);
        row3.classList.toggle("dim", !on);
        slider.disabled = !on; ck.disabled = !on;
    };
    swInput.onchange = sync;
    sync();

    dlg.append(hd, row1, row2, row3, note, btns);
    back.appendChild(dlg);
    back.addEventListener("pointerdown", e => { if (e.target === back) closeResize(); });
    document.body.appendChild(back);
    openResize = { backdrop: back };
}

// =============================================================================
// 通用小弹窗：单行输入 / 素材根目录设置 / 目录浏览
// =============================================================================
let closeSimpleDialog = null;

function showTextDialog(config, onConfirm) {
    closeSimpleDialog?.();
    const back = make("div"); back.className = "alli-dlg-back";
    const dlg = make("div"); dlg.className = "alli-dlg";
    dlg.addEventListener("pointerdown", e => e.stopPropagation());

    const hd = make("div"); hd.className = "alli-dlg-hd";
    hd.appendChild(make("span", {}, config.title || "输入"));
    const x = make("button", {}, "×"); x.className = "alli-dlg-x";
    hd.appendChild(x);

    const body = make("div"); body.className = "alli-simple-body";
    const label = make("div", {}, config.label || ""); label.className = "alli-dlg-sub";
    const input = document.createElement("input");
    input.className = "alli-lib-search"; input.value = config.value || "";
    input.placeholder = config.placeholder || ""; input.spellcheck = false;
    const err = make("div", {}, ""); err.className = "alli-simple-err";

    // 可选的作用域切换（例如「当前图库」/「全部图库」）
    let scopeKey = config.options?.[0]?.key ?? null;
    const scopeRow = make("div"); scopeRow.className = "alli-scope";
    for (const option of config.options || []) {
        const chip = make("button", {}, option.label);
        chip.className = "alli-scope-chip" + (option.key === scopeKey ? " on" : "");
        chip.dataset.key = option.key;
        chip.onclick = () => {
            scopeKey = option.key;
            scopeRow.querySelectorAll(".alli-scope-chip")
                .forEach(el => el.classList.toggle("on", el.dataset.key === scopeKey));
        };
        scopeRow.appendChild(chip);
    }

    if (config.options?.length) body.append(label, scopeRow, input, err);
    else body.append(label, input, err);

    const btns = make("div"); btns.className = "alli-dlg-btns";
    const cancel = make("button", {}, "取消");
    const go = make("button", {}, config.confirmText || "确定"); go.className = "go";
    btns.append(cancel, go);

    const close = () => {
        document.removeEventListener("keydown", onKey, true);
        closeSimpleDialog = null;
        back.remove();
    };
    const submit = async () => {
        const value = input.value.trim();
        if (!value) { err.textContent = "不能为空"; input.focus(); return; }
        go.disabled = true;
        try {
            await onConfirm(value, scopeKey);
            close();
        } catch (error) {
            err.textContent = error.message || String(error);
            go.disabled = false;
        }
    };
    const onKey = event => {
        if (event.key === "Escape") { event.preventDefault(); close(); return; }
        if (event.key === "Enter") { event.preventDefault(); submit(); }
    };
    x.onclick = close; cancel.onclick = close; go.onclick = submit;
    back.addEventListener("pointerdown", e => { if (e.target === back) close(); });
    document.addEventListener("keydown", onKey, true);

    dlg.append(hd, body, btns);
    back.appendChild(dlg);
    document.body.appendChild(back);
    closeSimpleDialog = close;
    setTimeout(() => { input.focus(); input.select?.(); }, 30);
}

// ---- 素材库设置：根目录 + 主题 + 字号 + 卡片大小 ----
let closeSettings = null;
function openSettingsDialog(onSaved) {
    closeSettings?.();
    const back = make("div"); back.className = "alli-dlg-back";
    const dlg = make("div"); dlg.className = "alli-dlg"; dlg.style.width = "540px";
    dlg.addEventListener("pointerdown", e => e.stopPropagation());

    const hd = make("div"); hd.className = "alli-dlg-hd";
    hd.appendChild(make("span", {}, "素材库设置"));
    const x = make("button", {}, "×"); x.className = "alli-dlg-x";
    hd.appendChild(x);

    const body = make("div"); body.className = "alli-simple-body";
    const draft = { ...libUI };

    const paint = () => {
        const root = document.documentElement;
        root.style.setProperty("--alli-ts", String(LIB_UI_FONT_SCALE[draft.size] || 1));
        root.style.setProperty("--alli-card-w", `${draft.card}px`);
        setAlliTheme(draft.theme);
        if (cardVal) cardVal.textContent = `${draft.card}px`;
    };

    // 分段按钮（主题 / 字号）
    const makeSeg = (label, items, value, onPick) => {
        const row = make("div"); row.className = "alli-set-row";
        const cap = make("span", {}, label); cap.className = "alli-set-label";
        const box = make("div"); box.className = "alli-seg";
        const entries = [];
        for (const item of items) {
            const btn = make("button", {}, item.name);
            btn.onclick = () => {
                onPick(item.key);
                entries.forEach(entry => entry.el.classList.toggle("on", entry.key === item.key));
            };
            box.appendChild(btn);
            entries.push({ el: btn, key: item.key });
        }
        entries.forEach(entry => entry.el.classList.toggle("on", entry.key === value));
        row.append(cap, box);
        return row;
    };

    // 卡片大小滑条
    const cardRow = make("div"); cardRow.className = "alli-set-row";
    const cardCap = make("span", {}, "卡片大小"); cardCap.className = "alli-set-label";
    const range = document.createElement("input");
    range.type = "range"; range.min = "104"; range.max = "320"; range.step = "4";
    range.className = "alli-range"; range.value = String(draft.card);
    let cardVal = make("span", {}, `${draft.card}px`); cardVal.className = "alli-set-val";
    range.oninput = () => { draft.card = Number(range.value) || LIB_UI_DEFAULT.card; paint(); };
    cardRow.append(cardCap, range, cardVal);

    const look = make("div"); look.className = "alli-set-sec";
    const renderLook = () => {
        look.replaceChildren();
        const title = make("div", {}, "外观"); title.className = "alli-set-title";
        look.appendChild(title);
        look.appendChild(makeSeg("字号", [
            { key: "s", name: "小" },
            { key: "m", name: "中" },
            { key: "l", name: "大" },
        ], draft.size, key => { draft.size = key; paint(); }));
        look.appendChild(cardRow);
    };
    renderLook();

    const dirSec = make("div"); dirSec.className = "alli-set-sec";
    const dirTitle = make("div", {}, "素材根目录"); dirTitle.className = "alli-set-title";
    const tip = make("div", {},
        "默认 models/Alili_Library，就在 ComfyUI 的 models 文件夹里。\n"
        + "一级子文件夹 = 图库（人像 / 服装 / 发型 …），图库里的子文件夹 = TAB（短发 / 长发 …）。\n"
        + "这里填相对 ComfyUI 根目录的路径就好，不写盘符，换电脑不用改。");
    tip.className = "alli-dlg-sub"; tip.style.whiteSpace = "pre-line"; tip.style.lineHeight = "1.7";
    const row = make("div", { display: "flex", gap: "8px", marginTop: "8px" });
    const input = document.createElement("input");
    input.className = "alli-lib-search"; input.spellcheck = false;
    input.placeholder = "models/Alili_Library";
    input.style.paddingLeft = "12px";
    const browseBtn = make("button", {}, "浏览…"); browseBtn.className = "alli-lib-btn browse";
    row.append(input, browseBtn);
    const meta = make("div", {}, ""); meta.className = "alli-dlg-sub";
    meta.style.marginTop = "8px"; meta.style.whiteSpace = "pre-line"; meta.style.lineHeight = "1.6";
    const err = make("div", {}, ""); err.className = "alli-simple-err";
    dirSec.append(dirTitle, tip, row, meta);
    body.append(look, dirSec, err);

    const btns = make("div"); btns.className = "alli-dlg-btns";
    const cancel = make("button", {}, "取消");
    const reset = make("button", {}, "恢复默认");
    const save = make("button", {}, "保存"); save.className = "go";
    btns.append(cancel, reset, save);

    const close = () => { closeSettings = null; back.remove(); };

    const submit = async () => {
        save.disabled = true; err.textContent = "";
        try {
            const res = await api.fetchApi(ASSET_CONFIG_ROUTE, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ root: input.value.trim() }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
            saveLibUI({ theme: draft.theme, size: draft.size, card: draft.card });
            close();
            copyToast(`素材根目录：${data.root_display || data.root}`, false);
            await onSaved?.(data);
        } catch (error) {
            err.textContent = error.message || String(error);
            save.disabled = false;
        }
    };

    x.onclick = () => { applyLibUI(); close(); };
    cancel.onclick = () => { applyLibUI(); close(); };
    save.onclick = submit;
    reset.onclick = () => {
        input.value = "";
        draft.theme = LIB_UI_DEFAULT.theme;
        draft.size = LIB_UI_DEFAULT.size;
        draft.card = LIB_UI_DEFAULT.card;
        range.value = String(draft.card);
        renderLook();
        paint();
    };
    browseBtn.onclick = () => openBrowseDialog(input.value.trim(), picked => { input.value = picked; });
    back.addEventListener("pointerdown", e => { if (e.target === back) { applyLibUI(); close(); } });

    dlg.append(hd, body, btns);
    back.appendChild(dlg);
    document.body.appendChild(back);
    closeSettings = close;

    (async () => {
        try {
            const res = await api.fetchApi(ASSET_CONFIG_ROUTE);
            const data = await res.json();
            if (!data.ok) throw new Error(data.error || "读取失败");
            input.value = data.root_display || data.root || "";
            meta.textContent = [
                `默认目录：${data.default_display || data.default}`,
                `实际位置：${data.root}`,
                data.configured ? "已自定义（存的是相对路径，搬包不失效）" : "当前用的就是默认目录",
            ].join("\n");
        } catch (error) {
            err.textContent = `读取设置失败：${error.message}`;
        }
    })();
}

// ---- 目录浏览（盘符 + 子文件夹），给设置面板选路径用 ----
let closeBrowse = null;
function openBrowseDialog(startPath, onPick) {
    closeBrowse?.();
    const back = make("div"); back.className = "alli-dlg-back";
    const dlg = make("div"); dlg.className = "alli-dlg"; dlg.style.width = "540px";
    dlg.addEventListener("pointerdown", e => e.stopPropagation());

    const hd = make("div"); hd.className = "alli-dlg-hd";
    hd.appendChild(make("span", {}, "选择文件夹"));
    const x = make("button", {}, "×"); x.className = "alli-dlg-x";
    hd.appendChild(x);

    const body = make("div"); body.className = "alli-simple-body";
    const quickRow = make("div"); quickRow.className = "alli-browse-drives";
    const current = make("div", {}, ""); current.className = "alli-browse-path";
    const drivesRow = make("div"); drivesRow.className = "alli-browse-drives";
    const listEl = make("div"); listEl.className = "alli-browse-list";
    const hint = make("div", {}, "选好后这里会显示相对路径；只有素材放在 ComfyUI 外面才会用绝对路径。");
    hint.className = "alli-dlg-sub"; hint.style.marginTop = "6px";
    const err = make("div", {}, ""); err.className = "alli-simple-err";
    body.append(quickRow, current, drivesRow, listEl, hint, err);

    const btns = make("div"); btns.className = "alli-dlg-btns";
    const cancel = make("button", {}, "取消");
    const pick = make("button", {}, "用这个目录"); pick.className = "go";
    btns.append(cancel, pick);

    const close = () => { closeBrowse = null; back.remove(); };
    const choose = () => { onPick(current.dataset.display || current.dataset.path || ""); close(); };

    const load = async path => {
        listEl.replaceChildren(make("div", {}, "读取中…"));
        try {
            const res = await api.fetchApi(`${ASSET_BROWSE_ROUTE}?path=${encodeURIComponent(path || "")}`);
            const data = await res.json();
            if (!data.ok) throw new Error(data.error || "读取失败");
            current.textContent = data.display || data.path;
            current.title = data.path;
            current.dataset.path = data.path;
            current.dataset.display = data.display || data.path;
            quickRow.replaceChildren();
            for (const item of data.shortcuts || []) {
                const chip = make("button", {}, item.name); chip.className = "alli-browse-chip";
                chip.onclick = () => load(item.path);
                quickRow.appendChild(chip);
            }
            drivesRow.replaceChildren();
            for (const drive of data.drives || []) {
                const chip = make("button", {}, drive); chip.className = "alli-browse-chip";
                chip.onclick = () => load(drive);
                drivesRow.appendChild(chip);
            }
            listEl.replaceChildren();
            if (data.parent) {
                const up = make("div", {}, "↩ 上一级"); up.className = "alli-browse-row";
                up.onclick = () => load(data.parent);
                listEl.appendChild(up);
            }
            if (!data.dirs.length) {
                const empty = make("div", {}, "（没有子文件夹）"); empty.className = "alli-browse-empty";
                listEl.appendChild(empty);
            }
            for (const dir of data.dirs) {
                const row = make("div", {}, `📁 ${dir.name}`); row.className = "alli-browse-row";
                row.onclick = () => load(dir.path);
                listEl.appendChild(row);
            }
            err.textContent = "";
        } catch (error) {
            listEl.replaceChildren();
            err.textContent = `读取失败：${error.message}`;
        }
    };

    x.onclick = close; cancel.onclick = close; pick.onclick = choose;
    back.addEventListener("pointerdown", e => { if (e.target === back) close(); });

    dlg.append(hd, body, btns);
    back.appendChild(dlg);
    document.body.appendChild(back);
    closeBrowse = close;
    load(startPath);
}

// ---- 素材库界面偏好：主题 / 字号 / 卡片大小（存 localStorage，刷新与重启都记得）----
const LIB_UI_KEY = "alili_lib_ui";
// 明暗 2 套主题：经典浅色 / 极客暗黑（token 见 injectStyle）；图标 sun/moon 走 /alili/icon
const ALLI_THEMES = [
    { key: "chrome-light",   name: "经典浅色", icon: "sun" },
    { key: "chrome-default", name: "极客暗黑", icon: "moon" },
];
// 老版本只存了 dark / light，映射到新的主题 id
const ALLI_THEME_ALIAS = { dark: "chrome-default", light: "chrome-light" };
const ALLI_THEME_KEYS = ALLI_THEMES.map(t => t.key);
// 档位整体上移一档：小=原来的中(1)，中=原来的大(1.16)，大再往上加一档
const LIB_UI_FONT_SCALE = { s: 1, m: 1.16, l: 1.34 };
const LIB_UI_DEFAULT = { theme: "chrome-light", size: "m", card: 154 };
let libUI = { ...LIB_UI_DEFAULT };
try {
    const saved = JSON.parse(localStorage.getItem(LIB_UI_KEY) || "{}");
    if (saved && typeof saved === "object") libUI = { ...libUI, ...saved };
} catch { /* 坏数据就当默认 */ }
(function normalizeTheme() {
    libUI.theme = ALLI_THEME_ALIAS[libUI.theme] || libUI.theme;
    if (!ALLI_THEME_KEYS.includes(libUI.theme)) libUI.theme = LIB_UI_DEFAULT.theme;
})();

// 统一把当前主题写进 html[data-alli-theme]，CSS 令牌据此切换；alli-light 保留给旧规则兜底
function setAlliTheme(theme) {
    const key = ALLI_THEME_ALIAS[theme] || theme;
    const root = document.documentElement;
    root.setAttribute("data-alli-theme", ALLI_THEME_KEYS.includes(key) ? key : LIB_UI_DEFAULT.theme);
    root.classList.toggle("alli-light", key === "chrome-light");
}

function applyLibUI() {
    const ts = LIB_UI_FONT_SCALE[libUI.size] || 1;
    const card = Math.max(104, Math.min(320, Number(libUI.card) || LIB_UI_DEFAULT.card));
    const root = document.documentElement;
    root.style.setProperty("--alli-ts", String(ts));
    root.style.setProperty("--alli-card-w", `${card}px`);
    setAlliTheme(libUI.theme);
}

function saveLibUI(patch) {
    libUI = { ...libUI, ...patch };
    try { localStorage.setItem(LIB_UI_KEY, JSON.stringify(libUI)); } catch { /* 隐私模式忽略 */ }
    applyLibUI();
}

applyLibUI();

// =============================================================================
// 素材选择大弹窗：图库 + TAB + 搜索 + 缩略图网格
// =============================================================================
let openLib = null;
function closeLibrary() {
    openLib?.mask?.remove();
    // 图库下拉是挂在 body 上的浮层，关弹窗时一起收掉
    document.querySelectorAll(".alli-gmenu").forEach(el => el.remove());
    openLib = null;
}

// =============================================================================
// 换形象：素材库 + 底部抽屉（图1~图4 + 命中的提示词 + 自动优化开关）
//   - 点素材 = 放进它所属图库对应的槽位（人像 / 服装 / 姿势 / 发型），同类再点就替换
//   - 槽位顺序 = 提示词里的图号：人像永远是图1，后面按 服装 → 姿势 → 发型 紧凑编号
//   - 确定：按槽位写回加载节点 → 调下游工作台的 __aliliLook(auto) 填提示词（可选自动优化）
// =============================================================================
function openLookPicker(ctx) {
    const { node, images, persist, render } = ctx;
    closeLibrary();
    const mask = make("div"); mask.className = "alli-lib-mask"; mask.id = "alili-lib-mask";
    const dlg = make("div"); dlg.className = "alli-lib";
    dlg.addEventListener("pointerdown", e => e.stopPropagation());

    const hd = make("div"); hd.className = "alli-lib-hd";
    // 第一行 = 搜索框（原来图库下拉的位置）+ 右侧工具
    const searchWrap = make("div"); searchWrap.className = "alli-lib-searchwrap";
    const ns = "http://www.w3.org/2000/svg";
    const searchIcon = document.createElementNS(ns, "svg");
    searchIcon.setAttribute("viewBox", "0 0 20 20");
    searchIcon.setAttribute("class", "alli-lib-searchicon");
    const iconCircle = document.createElementNS(ns, "circle");
    iconCircle.setAttribute("cx", "8.6"); iconCircle.setAttribute("cy", "8.6"); iconCircle.setAttribute("r", "5.6");
    const iconHandle = document.createElementNS(ns, "path");
    iconHandle.setAttribute("d", "M12.8 12.8 L17 17");
    searchIcon.append(iconCircle, iconHandle);
    const search = document.createElement("input");
    search.className = "alli-lib-search";
    search.placeholder = "搜索名称 / 标签 / 文件名…";
    search.spellcheck = false;
    searchWrap.append(searchIcon, search);

    const tools = make("div"); tools.className = "alli-lib-tools";
    // 明暗切换：单个图标按钮原地切换，位置固定在「刷新」左边；浅色=太阳、暗色=月亮，图标走 /alili/icon
    const themeToggle = make("button"); themeToggle.className = "alli-theme-toggle";
    const themeIco = make("i"); themeIco.className = "alli-theme-ico";
    themeToggle.appendChild(themeIco);
    const syncThemeToggle = () => {
        const light = libUI.theme === "chrome-light";
        themeIco.style.setProperty("--alli-icon", `url("/alili/icon/${light ? "sun" : "moon"}.svg")`);
        themeToggle.title = light ? "经典浅色 · 点击切换到极客暗黑" : "极客暗黑 · 点击切换到经典浅色";
    };
    themeToggle.onclick = () => {
        saveLibUI({ theme: libUI.theme === "chrome-light" ? "chrome-default" : "chrome-light" });
        syncThemeToggle();
    };
    syncThemeToggle();
    const toolSep = make("span"); toolSep.className = "alli-tool-sep";
    const refreshBtn = make("button", {}, "刷新"); refreshBtn.className = "alli-lib-tool";
    refreshBtn.title = "重新扫描文件夹（直接往文件夹里丢图，点刷新就会出现）";
    const importBtn = make("button", {}, "导入图片"); importBtn.className = "alli-lib-tool";
    importBtn.title = "从本机选图导入当前 TAB 对应的文件夹（自动编号）";
    const cfgBtn = make("button", {}, "⚙"); cfgBtn.className = "alli-lib-tool icon";
    cfgBtn.title = "素材库设置（根目录 / 主题 / 字号 / 卡片大小）";
    const x = make("button", {}, "×"); x.className = "alli-lib-x"; x.title = "关闭";
    const fileInput = document.createElement("input");
    fileInput.type = "file"; fileInput.accept = "image/*"; fileInput.multiple = true;
    fileInput.style.display = "none";
    tools.append(themeToggle, toolSep, refreshBtn, importBtn, cfgBtn, x);
    hd.append(searchWrap, tools);

    // 第二行 = 图库（人像 / 发型 / 姿势 / 服装 …），一行铺开居中
    const galleryRow = make("div"); galleryRow.className = "alli-lib-galleries";
    const tabs = make("div"); tabs.className = "alli-lib-tabs";
    const subsubs = make("div"); subsubs.className = "alli-lib-subsubs";
    const subsubsInner = make("div"); subsubsInner.className = "alli-lib-subsubs-inner";
    subsubs.appendChild(subsubsInner);

    const grid = make("div"); grid.className = "alli-lib-grid";

    // 底部抽屉：左 4 个槽位（图1~图4），右 命中的提示词原文
    const drawer = make("div"); drawer.className = "alli-drawer";
    const slotBox = make("div"); slotBox.className = "alli-drawer-slots";
    const promptBox = make("div"); promptBox.className = "alli-drawer-prompt";
    const pTitle = make("div"); pTitle.className = "alli-drawer-ptitle";
    const pText = make("div"); pText.className = "alli-drawer-ptext";
    promptBox.append(pTitle, pText);
    drawer.append(slotBox, promptBox);

    // 抽屉折叠：滚轮浏览素材时收起，点「使用」或点把手展开
    const drawerHandle = make("div"); drawerHandle.className = "alli-drawer-handle show";
    const dhArrow = make("span", {}, "▾"); dhArrow.className = "alli-dh-arrow";
    drawerHandle.append(dhArrow, make("span", {}, "搭配与提示词"));
    const setDrawerFolded = folded => {
        drawer.classList.toggle("folded", folded);
        drawerHandle.classList.toggle("collapsed", folded);
        dhArrow.textContent = folded ? "▴" : "▾";
    };
    drawerHandle.onclick = () => setDrawerFolded(!drawer.classList.contains("folded"));
    // 只在卡片网格区滚动时收起；提示词区内滚动不触发（那里有自己的 overflow）
    grid.addEventListener("wheel", () => { if (!drawer.classList.contains("folded")) setDrawerFolded(true); }, { passive: true });
    setDrawerFolded(true);   // 默认收起：点「使用」才展开

    const foot = make("div"); foot.className = "alli-lib-foot alli-look-foot";
    const info = make("span", {}, ""); info.className = "alli-lib-info";
    const autoLabel = make("label"); autoLabel.className = "alli-switch";
    autoLabel.title = "确定后自动点一次「✦ 优化提示词」；关掉就只填提示词，手动点 ✦";
    const autoSwitch = document.createElement("input"); autoSwitch.type = "checkbox";
    autoSwitch.checked = loadAutoOptimize();
    const autoTrack = make("span"); autoTrack.className = "alli-switch-track";
    // input 必须在 track 前面：CSS 用 input:checked + .alli-switch-track 点亮
    autoLabel.append(autoSwitch, autoTrack, make("span", {}, "自动优化"));
    autoSwitch.onchange = () => saveAutoOptimize(autoSwitch.checked);
    const cancel = make("button", {}, "取消"); cancel.className = "alli-lib-btn";
    const use = make("button", {}, "确定"); use.className = "alli-lib-btn go"; use.disabled = true;
    // 三栏：左空白 | 取消+确定（居中） | 自动优化（贴确定右面）；统计文字不再显示，顶部 TAB 徽章已够
    const footCenter = make("div"); footCenter.className = "alli-look-foot-center";
    footCenter.append(cancel, use);
    foot.append(make("span"), footCenter, autoLabel);

    let categories = [];   // 图库（一级分类）
    let stats = {};        // 每个图库的素材总数
    let subs = [];         // 当前图库的子分类 = TAB
    let rootPath = "";     // 素材根目录（绝对）
    let rootDisplay = "";  // 素材根目录（便携显示，如 models/Alili_Library）
    let gallery = "";      // 当前图库
    let sub = null;        // 当前 TAB：null = 全部，"" = 未分类，其余 = 子分类名
    let third = null;      // 当前三级文件夹：null = 该 TAB 下全部，其余 = 三级文件夹名
    let items = [];
    // 拖拽源：dragover 阶段 dataTransfer 处于保护模式，getData() 恒为空，
    // 所以用普通变量记住当前正拖着的素材，供三级标签的 dragover 判断是否放行。
    let dragAsset = null;
    // 拖拽跟手的半透明卡片虚影很挡视线，用一个 1×1 透明图替换掉
    const invisibleDragImage = new Image();
    invisibleDragImage.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
    let iconSet = new Set();   // icons/ 目录里现有的图标名（renxiang / faxing …）
    let favMode = false;       // 当前看的是「⭐ 已收藏」（只显示当前图库的收藏）
    let favSet = new Set();    // 已收藏素材的 path，卡片上的星据此点亮（全局，跨图库）
    let allFavorites = [];     // 全部收藏快照，按图库过滤用

    // 收藏属于哪个图库：优先快照里的 category，老快照没有就从 path 里找已知图库名
    function favGalleryOf(item) {
        if (item && item.category) return item.category;
        const path = String((item && item.path) || "").replace(/\\/g, "/").split("/");
        for (let i = path.length - 1; i >= 0; i--) {
            if (categories.includes(path[i])) return path[i];
        }
        return "";
    }

    // 抽屉选中态：槽位 → 素材。打开时按节点现有图的 role 回填，所以「确定过什么，再打开就是什么」
    const look = { face: null, cloth: null, pose: null, hair: null };
    const dropped = new Set();   // 被 × 掉的槽位：确定时连节点原有的那张一起去掉
    for (const slot of SLOT_ORDER) {
        const found = images.find((entry, index) => (slotOfRole(entry.role) || (index === 0 ? "face" : "")) === slot);
        if (!found) continue;
        look[slot] = {
            name: found.name,
            w: found.w || 0,
            h: found.h || 0,
            filename: String(found.name).split(/[\\/]/).pop() || "",
            crop: found.crop || null,
        };
    }

    const close = () => { document.removeEventListener("keydown", onKey); closeLibrary(); };
    // 上层还开着设置 / 新建分类 / 浏览目录时，Esc 只关那一层，别把素材库一起关掉
    const onKey = e => {
        if (e.key !== "Escape") return;
        if (document.querySelector(".alli-dlg-back")) return;
        close();
    };
    document.addEventListener("keydown", onKey);
    mask.addEventListener("pointerdown", e => { if (e.target === mask) close(); });
    cancel.onclick = close;
    x.onclick = close;

    // 点卡片本身 → 大图预览（选中/应用改走卡片上的「使用」按钮或预览里的「用这张」）
    const openPreview = it => {
        const back = make("div"); back.className = "alli-lib-mask"; back.style.zIndex = "10170";
        const dlg = make("div"); dlg.className = "alli-preview";
        dlg.addEventListener("pointerdown", e => e.stopPropagation());

        const hd = make("div"); hd.className = "alli-lib-hd";
        hd.appendChild(make("span", {}, it.filename));

        const body = make("div"); body.className = "alli-preview-body";
        const image = make("img"); image.src = it.url || it.thumb; image.draggable = false;
        body.appendChild(image);

        const foot = make("div"); foot.className = "alli-lib-foot";
        const info = make("span", {}, `${it.w} × ${it.h} · ${it.filename}`); info.className = "alli-lib-info";
        const closeBtn = make("button", {}, "关闭"); closeBtn.className = "alli-lib-btn";
        const pickBtn = make("button", {}, "使用"); pickBtn.className = "alli-lib-btn go";
        foot.append(info, make("span", { flex: "1" }), closeBtn, pickBtn);

        const shut = () => { document.removeEventListener("keydown", onKey, true); back.remove(); };
        const onKey = e => { if (e.key === "Escape") { e.preventDefault(); shut(); } };
        closeBtn.onclick = shut;
        pickBtn.onclick = () => { shut(); if (selectItem(it)) copyToast(`已把「${it.filename}」放进槽位`); };
        back.addEventListener("pointerdown", e => { if (e.target === back) shut(); });
        document.addEventListener("keydown", onKey, true);

        dlg.append(hd, body, foot);
        back.appendChild(dlg);
        document.body.appendChild(back);
    };

    // ---- 网格分页：几千张素材一次全塞进 DOM 会把浏览器拖死 ----
    const PAGE_SIZE = 120;
    let shown = 0;
    let sentinel = null;
    let io = null;

    const currentList = () => {
        let list = items;
        // 三级文件夹过滤：rel = "汉服/明制/001.png" → 三级 key = "明制"
        if (sub !== null && third !== null) {
            list = list.filter(it => {
                const parts = String(it.rel || "").split("/");
                return (parts.length >= 3 ? (parts[1] || "") : "") === third;
            });
        }
        const keyword = search.value.trim().toLowerCase();
        if (!keyword) return list;
        return list.filter(it => [it.filename, it.label, ...(it.tags || [])]
            .join(" ").toLowerCase().includes(keyword));
    };
    const makeCard = it => {
            const card = make("div"); card.className = "alli-lib-card";
            // 可拖拽：拖到下方三级文件夹标签上改分类（只限当前 TAB 内，见 renderThirds）
            card.draggable = true;
            card.ondragstart = e => {
                if (!it.path) { e.preventDefault(); return; }
                dragAsset = { path: it.path, rel: it.rel || "", filename: it.filename || "" };
                e.dataTransfer.setData("text/alili-asset-path", it.path);
                e.dataTransfer.setData("text/alili-asset-rel", it.rel || "");
                e.dataTransfer.setData("text/plain", it.filename || "");
                e.dataTransfer.effectAllowed = "move";
                // 藏掉跟手的半透明卡片虚影，不再挡视线（原卡片仍半透明提示正在拖）
                if (invisibleDragImage.complete) {
                    try { e.dataTransfer.setDragImage(invisibleDragImage, 0, 0); } catch {}
                }
                card.classList.add("dragging");
            };
            card.ondragend = () => { card.classList.remove("dragging"); dragAsset = null; };
            // 图片区：2:3 竖版白底、contain 完整显示（对齐 Goohai 卡片，图片不被裁、不压暗）
            const pic = make("div"); pic.className = "alli-card-pic";
            const img = make("img"); img.loading = "lazy"; img.src = it.thumb; img.draggable = false;
            pic.appendChild(img);
            // 右上角操作组（hover 显示）：使用按钮 + 收藏星，对齐 Goohai 的 .ghil-actions
            const actions = make("div"); actions.className = "alli-card-actions";
            const useBtn = make("button", {}, "使用"); useBtn.className = "alli-card-use";
            useBtn.title = "把这张放进对应槽位";
            useBtn.onpointerdown = e => e.stopPropagation();
            useBtn.onclick = e => {
                e.stopPropagation();
                if (selectItem(it)) copyToast(`已把「${it.filename}」放进槽位`);
            };
            actions.appendChild(useBtn);
            // 右上角星：未收藏灰、已收藏金（存素材根 .favorites.json，按图库分开看）
            const fav = make("button"); fav.className = "alli-card-fav" + (favSet.has(it.path) ? " on" : "");
            fav.appendChild(make("span", {}, "⭐"));
            const favTip = on => on ? "取消收藏" : "收藏（在当前图库的「已收藏」里查看）";
            fav.title = favTip(favSet.has(it.path));
            fav.onpointerdown = e => e.stopPropagation();
            fav.onclick = async e => {
                e.stopPropagation();
                const on = !favSet.has(it.path);
                const paint = value => {
                    fav.classList.toggle("on", value);
                    fav.title = favTip(value);
                    if (value) favSet.add(it.path); else favSet.delete(it.path);
                };
                paint(on);
                try {
                    const res = await api.fetchApi(ASSET_FAVORITE_ROUTE, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ path: it.path, on, item: it }),
                    });
                    const data = await res.json().catch(() => ({}));
                    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
                    // 同步收藏快照，让一级图库上的收藏徽章立刻更新
                    if (on) { if (!allFavorites.some(x => x.path === it.path)) allFavorites.push(it); }
                    else allFavorites = allFavorites.filter(x => x.path !== it.path);
                    renderGalleries();
                    if (favMode && !on) {
                        items = items.filter(entry => entry.path !== it.path);
                        renderGrid();
                    }
                } catch (err) {
                    paint(!on);
                    copyToast(`收藏失败：${err.message}`, true);
                }
            };
            // 右键删除素材
            card.oncontextmenu = e => {
                e.preventDefault();
                e.stopPropagation();
                showAssetCardMenu(e.clientX, e.clientY, async () => {
                    if (!window.confirm(`删除「${it.filename}」？\n会先清掉缩略图缓存，原图移到素材库的 .trash/ 目录，不会永久删除。`)) return;
                    try {
                        const res = await api.fetchApi(ASSET_DELETE_ROUTE, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ path: it.path }),
                        });
                        const data = await res.json().catch(() => ({}));
                        if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
                        for (const slot of SLOT_ORDER) if (look[slot]?.name === it.name) look[slot] = null;
                        renderDrawer();
                        if (favMode) await loadFavorites(gallery);
                        else await loadLibrary(gallery, sub);
                    } catch (err) {
                        window.alert(`删除失败：${err.message}`);
                    }
                });
            };
            actions.appendChild(fav);
            pic.appendChild(actions);

            // 底部独立信息条（对齐 Goohai 的 .card-info）：左文件名、右分类，不压在图片上
            const info = make("div"); info.className = "alli-card-info";
            const name = make("span", {}, it.label || it.filename); name.className = "alli-card-name";
            const cat = make("span", {}, it.category || gallery || ""); cat.className = "alli-card-cat";
            info.append(name, cat);

            card.append(pic, info);
            card.title = [
                it.label && it.label !== it.filename ? it.label : "",
                it.filename,
                it.w && it.h ? `${it.w} × ${it.h}` : "",
                (it.tags || []).length ? `标签：${it.tags.join(" / ")}` : "",
                `点击看大图 · 「使用」放进槽位 · 右键删除`,
            ].filter(Boolean).join("\n");
            card.dataset.name = it.name;
            card.dataset.role = it.category || gallery;
            card.onclick = () => openPreview(it);   // 点卡片看大图（放大镜已删）
            return card;
    };

    // 往网格里追加一页；到底了就撤掉哨兵
    const fillPage = () => {
        const list = currentList();
        const end = Math.min(list.length, shown + PAGE_SIZE);
        const frag = document.createDocumentFragment();
        for (let i = shown; i < end; i++) frag.appendChild(makeCard(list[i]));
        if (sentinel) { io?.unobserve(sentinel); sentinel.remove(); sentinel = null; }
        grid.appendChild(frag);
        shown = end;

        const tabName = sub === null ? "全部" : (sub || "未分类");
        const more = list.length > shown ? `（已显示 ${shown}，继续往下滚）` : "";
        info.textContent = favMode
            ? `已收藏 · ${list.length} 张${more}`
            : `${gallery} / ${tabName} · ${list.length} 张${more}`;
        info.title = rootPath ? `素材库：${rootDisplay || rootPath}` : "";

        syncCards();
        if (shown < list.length) {
            sentinel = make("div", {
                gridColumn: "1/-1", padding: "16px 0", textAlign: "center",
                color: "#6f8291", fontSize: "11px",
            }, `滚动加载更多 · 还剩 ${list.length - shown} 张`);
            grid.appendChild(sentinel);
            io?.observe(sentinel);
        }
    };

    io = "IntersectionObserver" in window
        ? new IntersectionObserver(entries => {
            if (sentinel && entries.some(entry => entry.isIntersecting)) {
                io.unobserve(sentinel);
                fillPage();
            }
        }, { root: grid, rootMargin: "900px 0px" })
        : null;

    const renderGrid = () => {
        shown = 0;
        if (sentinel) { io?.unobserve(sentinel); sentinel.remove(); sentinel = null; }
        grid.replaceChildren();
        const keyword = search.value.trim().toLowerCase();
        const tabName = sub === null ? "全部" : (sub || "未分类");
        info.title = rootPath ? `素材库：${rootDisplay || rootPath}` : "";

        if (!gallery && !favMode) {
            info.textContent = "点素材 = 放进它所属的槽位";
            const empty = make("div"); empty.className = "alli-lib-empty";
            empty.textContent = "还没有图库\n把文件夹丢进素材库根目录，点「刷新」就会出现";
            grid.appendChild(empty);
            return;
        }
        const list = currentList();
        if (!list.length) {
            info.textContent = favMode ? "已收藏 · 0 张" : `${gallery} / ${tabName} · 0 张`;
            const empty = make("div"); empty.className = "alli-lib-empty";
            if (keyword) {
                empty.textContent = `没有匹配「${keyword}」的素材`;
            } else if (favMode) {
                empty.textContent = `「${gallery}」里还没有收藏的素材\n点卡片右上角的星标就能收藏，收藏只在本图库显示`;
                empty.style.whiteSpace = "pre-wrap";
            } else {
                const where = sub === null
                    ? `直接把图片丢进 ${rootDisplay || rootPath}/${gallery}/ 文件夹（也可手动建子文件夹），点「刷新」就会出现`
                    : `把图片丢进 ${rootDisplay || rootPath}/${gallery}/${sub || "image"}/ 文件夹，点「刷新」就会出现`;
                empty.textContent = `「${gallery}${sub === null ? "" : " / " + tabName}」还没有素材\n${where}`;
                empty.style.whiteSpace = "pre-wrap";
            }
            grid.appendChild(empty);
            return;
        }
        fillPage();
    };

    // ---- 槽位规划：抽屉选中 + 节点原有的图 → 最终 图1..图4 ----
    // 只覆盖被选中的槽位，没选的保留节点现状（所以「普通图片占位」会被同槽位的选中项顶掉）。
    const planImages = () => {
        const oldSlots = { face: null, cloth: null, pose: null, hair: null };
        const extras = [];
        images.forEach((entry, index) => {
            const slot = slotOfRole(entry.role) || (index === 0 ? "face" : "");
            if (slot && !oldSlots[slot]) oldSlots[slot] = entry;
            else extras.push(entry);
        });

        const list = [];
        const at = { face: -1, cloth: -1, pose: -1, hair: -1 };
        for (const slot of SLOT_ORDER) {
            if (dropped.has(slot)) continue;
            const picked = look[slot];
            const kept = oldSlots[slot];
            let entry = null;
            if (picked) {
                entry = {
                    name: picked.name, w: picked.w || 0, h: picked.h || 0,
                    role: SLOT_LABELS[slot],
                    // 换了图还带着旧的裁剪框就会裁错地方，只有同一张才保留
                    crop: kept && kept.name === picked.name ? (kept.crop || null) : null,
                };
            } else if (kept) {
                entry = { ...kept, role: SLOT_LABELS[slot] };
            }
            if (entry) { at[slot] = list.length; list.push(entry); }
        }
        // 其余旧图（同槽位重复 / 没绑定槽位的）排在四个槽位后面，不参与图1~图4 的编号
        for (const entry of extras) {
            if (list.length >= MAX_IMAGES) break;
            list.push(entry);
        }
        return { list, at };
    };

    const activeSlots = () => planImages().list
        .map(entry => slotOfRole(entry.role))
        .filter(slot => slot && slot !== "face");

    const syncCards = () => {
        // 收藏页里卡片来自不同图库，槽位看卡片自己的图库，不能拿当前 gallery 判断
        grid.querySelectorAll(".alli-lib-card").forEach(card => {
            const slot = slotOfRole(card.dataset.role || "");
            card.classList.toggle("on", !!slot && look[slot]?.name === card.dataset.name);
        });
    };

    const renderDrawer = () => {
        const { list, at } = planImages();
        slotBox.replaceChildren();
        for (const slot of SLOT_ORDER) {
            const index = at[slot];
            const cell = make("div"); cell.className = "alli-slot" + (index >= 0 ? " on" : "");
            if (index >= 0) {
                const img = make("img"); img.src = fileUrl(list[index].name); img.draggable = false;
                const x = make("button", {}, "×"); x.className = "alli-slot-x"; x.title = "从抽屉里去掉这一张";
                x.onclick = event => {
                    event.stopPropagation();
                    look[slot] = null;
                    dropped.add(slot);
                    renderDrawer(); syncCards();
                };
                cell.append(img, x);
                cell.title = `${SLOT_LABELS[slot]} · 图${index + 1}`;
            } else {
                cell.append(make("span", {}, "＋"));
                cell.title = `还没选${SLOT_LABELS[slot]}`;
            }
            const wrap = make("div"); wrap.className = "alli-slot-wrap";
            // 图号就写在标签里（图上不再压角标，免得盖住画面）；没有图1 时不标号
            const label = make("div", {}, index >= 0 && at.face >= 0
                ? `图${index + 1} ${SLOT_LABELS[slot]}`
                : SLOT_LABELS[slot]);
            label.className = "alli-slot-label";
            wrap.append(cell, label);
            slotBox.append(wrap);
        }

        const slots = activeSlots();
        const preset = pickLookPreset(slots);
        pTitle.textContent = preset
            ? `${preset.title} · ${preset.id}`
            : slots.length
                ? "这个组合没有对应的提示词"
                : "选服装 / 姿势 / 发型，这里会显示命中的提示词";
        pText.textContent = preset ? preset.text : "";
        pText.classList.toggle("empty", !preset);
        // 没有图1 就没有「保持图1…」这句的落点，不给确定
        use.disabled = at.face < 0;
    };

    // 点一张素材 = 放进它所属图库对应的槽位（同类再点就是替换）
    const selectItem = it => {
        const owner = it.category || gallery;
        const slot = slotOfRole(owner);
        if (!slot) {
            copyToast(`「${owner || "这个图库"}」没有绑定功能槽位（人像 / 服装 / 姿势 / 发型）`, true);
            return false;
        }
        dropped.delete(slot);
        look[slot] = {
            name: it.name,
            w: it.w || 0,
            h: it.h || 0,
            filename: it.filename || it.label || "",
            crop: null,
        };
        renderDrawer(); syncCards();
        setDrawerFolded(false);   // 点「使用」放进槽位 → 展开抽屉看搭配与提示词
        return true;
    };

    const confirmLook = () => {
        const { list, at } = planImages();
        if (at.face < 0) { copyToast("先选一张人像：它就是提示词里的图1", true); return; }

        images.length = 0;
        images.push(...list);
        persist(); render();
        close();

        const workbench = findWorkbench(node);
        if (!workbench?.__aliliLook) {
            copyToast(`已同步 ${list.length} 张素材；没连「多模态图像工作台」，提示词未生成`, true);
            return;
        }
        const auto = autoSwitch.checked;
        workbench.__aliliLook(auto).then(result => {
            if (!result?.ok) {
                const why = result?.reason === "no-data"
                    ? "没读到 look_prompt 预设"
                    : "没有匹配到提示词（人像作底图不单独匹配）";
                copyToast(`素材已同步；${why}`, true);
                return;
            }
            copyToast(auto && result.optimized
                ? `已填入「${result.preset}」，正在优化…`
                : `已填入「${result.preset}」`, false);
        }).catch(error => copyToast(`提示词未生成：${error.message}`, true));
    };
    use.onclick = confirmLook;

    // ---- 导入本地图片（落到当前 TAB 的文件夹）----
    importBtn.onclick = () => {
        if (!gallery) { info.textContent = "先建一个图库，再导入图片"; return; }
        fileInput.value = "";
        fileInput.click();
    };
    fileInput.onchange = async () => {
        const files = [...(fileInput.files || [])];
        if (!files.length) return;
        let done = 0, failed = 0;
        for (const file of files) {
            const body = new FormData();
            body.append("category", gallery);
            body.append("sub", sub || "");   // 在「全部」TAB 导入 → 落未分类（image/）
            body.append("name", file.name.replace(/\.[^.]+$/, ""));
            body.append("file", file, file.name);
            try {
                const res = await api.fetchApi(ASSET_UPLOAD_ROUTE, { method: "POST", body });
                const data = await res.json().catch(() => ({}));
                if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
                done++;
            } catch (err) {
                failed++;
                console.warn("[Alili] 导入失败：", file.name, err);
            }
            info.textContent = `导入中 ${done + failed}/${files.length}…`;
        }
        info.textContent = failed ? `已导入 ${done} 张，失败 ${failed} 张` : `已导入 ${done} 张`;
        await loadLibrary(gallery, sub);
    };

    // ---- 素材根目录设置 ----
    cfgBtn.onclick = () => openSettingsDialog(async () => {
        await bootstrap(gallery, sub, true);
    });

    // ---- 图库按钮行（不再用下拉菜单）----
    const GALLERY_ICON = {
        "人像": "renxiang", "发型": "faxing", "姿势": "zishi",
        "服装": "fuzhuang",
    };
    const renderGalleries = () => {
        galleryRow.replaceChildren();
        if (!categories.length) {
            const empty = make("span", {}, "还没有图库"); empty.className = "alli-lib-nocat";
            galleryRow.appendChild(empty);
        } else {
            for (const cat of categories) {
                const btn = make("button"); btn.className = "alli-lib-gbtn";
                if (cat === gallery) btn.classList.add("on");   // 收藏模式下也高亮当前图库：收藏视图属于该图库
                btn.title = `${cat} · ${stats[cat] ?? 0} 张`;
                const slug = GALLERY_ICON[cat];
                const wrapIcon = make("span"); wrapIcon.className = "alli-lib-giconwrap";
                if (slug && iconSet.has(slug)) {
                    const ico = make("i"); ico.className = "alli-lib-gicon";
                    ico.style.setProperty("--alli-icon", `url("/alili/icon/${slug}.svg")`);
                    wrapIcon.appendChild(ico);
                } else {
                    const ico = make("span", {}, (cat || "?").slice(0, 1));
                    ico.className = "alli-lib-gicon text";
                    wrapIcon.appendChild(ico);
                }
                btn.appendChild(wrapIcon);
                const name = make("span", {}, cat); name.className = "alli-lib-gname";
                btn.appendChild(name);
                if (typeof stats[cat] === "number") {
                    const badge = make("span", {}, String(stats[cat])); badge.className = "alli-lib-gcount";
                    btn.appendChild(badge);
                }
                // 收藏模式下点别的图库：切到那个图库的收藏视图（服装的收藏 / 发型的收藏互不混）
                btn.onclick = () => {
                    if (favMode) { if (cat !== gallery) loadFavorites(cat); }
                    else if (cat !== gallery) loadLibrary(cat, null);
                };
                galleryRow.appendChild(btn);
            }
        }

        // 行尾：已收藏（只看当前图库的收藏），和一级分类同一行；只放一枚星，不套圆框
        const favBtn = make("button"); favBtn.className = "alli-lib-gbtn fav" + (favMode ? " on" : "");
        favBtn.title = `只看「${gallery || "当前图库"}」的收藏`;
        const starIcon = make("span", {}, "⭐");
        favBtn.appendChild(starIcon);
        const favName = make("span", {}, "已收藏"); favName.className = "alli-lib-gname";
        favBtn.appendChild(favName);
        const galleryFavCount = allFavorites.filter(it => favGalleryOf(it) === gallery).length;
        const favCount = make("span", {}, String(galleryFavCount)); favCount.className = "alli-lib-gcount";
        favBtn.appendChild(favCount);
        favBtn.onclick = () => { if (!favMode) loadFavorites(gallery); else loadLibrary(gallery, null); };
        galleryRow.appendChild(favBtn);
    };

    const renderTabs = () => {
        tabs.replaceChildren();
        tabs.style.display = favMode ? "none" : "";
        if (favMode) return;
        if (!gallery) {
            const empty = make("span", {}, "还没有图库"); empty.className = "alli-lib-nocat";
            tabs.appendChild(empty);
            return;
        }
        // 点一级图库本身就是「全部」，这里不再放「全部」TAB；默认一个二级标签都不选
        for (const item of subs) {
            const tab = make("button"); tab.className = "alli-lib-tab";
            tab.appendChild(make("span", {}, item.name));
            if (typeof item.count === "number") {
                const badge = make("span", {}, String(item.count)); badge.className = "alli-lib-count";
                tab.appendChild(badge);
            }
            if (item.key === sub) tab.classList.add("on");
            tab.onclick = () => loadLibrary(gallery, item.key, null);
            bindDrop(tab, item.key, item.name, "sub");   // 二级 TAB 也可作为拖拽目标，改二级分类
            tabs.appendChild(tab);
        }
    };

    // 拖拽卡片到分类标签：level=sub 改二级 TAB，level=third 改三级文件夹。禁止跨图库（后端再校验一次）
    let dragTargetBtn = null;
    const bindDrop = (btn, key, name, level) => {
        // 关键：dragover 阶段 dataTransfer 处于保护模式，getData() 恒为空，
        // 绝不能用它判断。用 dragAsset（dragstart 时写入）判断是否是本插件卡片。
        // 只有 preventDefault() 了，浏览器才允许 drop、才不会显示禁止符号。
        const allowDrop = e => {
            if (!dragAsset) return;                  // 只接本插件卡片，不接外部文件
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            if (dragTargetBtn !== btn) { dragTargetBtn?.classList.remove("drop-target"); dragTargetBtn = btn; }
            btn.classList.add("drop-target");
        };
        btn.ondragenter = allowDrop;                 // 部分浏览器要求 dragenter 也放行
        btn.ondragover = allowDrop;
        btn.ondragleave = e => {
            // relatedTarget 还在按钮内部时不算离开，避免虚线框闪烁
            if (btn.contains(e.relatedTarget)) return;
            if (dragTargetBtn === btn) { btn.classList.remove("drop-target"); dragTargetBtn = null; }
        };
        btn.ondrop = async e => {
            e.preventDefault();
            btn.classList.remove("drop-target"); dragTargetBtn = null;
            const asset = dragAsset || {};
            const path = asset.path || e.dataTransfer.getData("text/alili-asset-path");
            const rel = asset.rel || e.dataTransfer.getData("text/alili-asset-rel");
            if (!path) return;
            // 已在目标分类：无需移动。rel 形如 二级/三级/文件，sub 看第 0 段、third 看第 1 段
            const parts = String(rel || "").replace(/\\/g, "/").split("/");
            const curSeg = level === "sub" ? parts[0] : parts[1];
            if (curSeg === key) { copyToast(`已经在「${name}」分类了`); dragAsset = null; return; }
            try {
                const res = await api.fetchApi(ASSET_MOVE_ROUTE, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ path, target: key, level }),
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
                copyToast(`已移到「${name}」`);
                await loadLibrary(gallery, sub);   // 刷新：计数、列表、缩略图同步
            } catch (err) {
                copyToast(`移动失败：${err.message}`, true);
            } finally {
                dragAsset = null;
            }
        };
    };

    // 三级文件夹：该二级分类下确实还有子文件夹时才滑出一行，作为最后一层，不再往下套
    const renderThirds = () => {
        subsubsInner.replaceChildren();
        subsubs.classList.remove("show");
        subsubs.style.display = "none";
        if (favMode || !gallery || sub === null || sub === "" || !items.length) return;

        // 只认 rel 里真实的第 3 段目录（如 汉服/单人/001.png → 单人）；
        // 两级以下的平铺图片不算文件夹，不生成「未分类」；也不要「全部」——点上级 TAB 本身就是全部
        const buckets = new Map();
        for (const it of items) {
            const parts = String(it.rel || "").split("/");
            if (parts.length < 3) continue;
            const key = parts[1];
            if (!key) continue;
            buckets.set(key, (buckets.get(key) || 0) + 1);
        }
        if (!buckets.size) return;   // 没有真实子文件夹：整行不显示（性感 / 春装 等）

        const list = [...buckets.entries()]
            .map(([key, count]) => ({ key, name: key, count }))
            .sort((a, b) => a.name.localeCompare(b.name, "zh"));
        for (const item of list) {
            const btn = make("button"); btn.className = "alli-lib-third" + (item.key === third ? " on" : "");
            btn.appendChild(make("span", {}, item.name));
            const badge = make("span", {}, String(item.count)); badge.className = "alli-lib-count";
            btn.appendChild(badge);
            btn.onclick = () => { third = third === item.key ? null : item.key; renderThirds(); renderGrid(); };
            bindDrop(btn, item.key, item.name, "third");
            subsubsInner.appendChild(btn);
        }

        subsubs.style.display = "";
        // 以当前 TAB 为中心对齐这一行：算 TAB 中心相对本行起点的位置，夹在可用宽度内
        const active = tabs.querySelector(".on");
        if (active) {
            const a = active.getBoundingClientRect();
            const s = subsubs.getBoundingClientRect();
            const padL = parseFloat(getComputedStyle(subsubs).paddingLeft) || 0;
            const padR = parseFloat(getComputedStyle(subsubs).paddingRight) || 0;
            const usable = Math.max(0, subsubs.clientWidth - padL - padR);
            const max = Math.max(0, usable - subsubsInner.offsetWidth);
            const centered = (a.left + a.width / 2) - (s.left + padL) - subsubsInner.offsetWidth / 2;
            subsubsInner.style.marginLeft = `${Math.round(Math.min(max, Math.max(0, centered)))}px`;
        }
        void subsubs.offsetWidth;   // 强制重排，让动画每次都重放
        subsubs.classList.add("show");
    };

    const loadLibrary = async (nextGallery, nextSub, nextThird = null) => {
        favMode = false;
        gallery = nextGallery || "";
        sub = nextSub === undefined ? null : nextSub;
        third = nextThird;
        items = [];
        renderGalleries();
        if (!gallery) { subs = []; third = null; renderTabs(); renderThirds(); renderGrid(); return; }

        const loading = make("div", { padding: "60px 10px" }, "读取中…");
        loading.className = "alli-lib-empty";
        grid.replaceChildren(loading);
        try {
            const params = new URLSearchParams({ category: gallery });
            if (sub !== null) params.set("sub", sub);
            const res = await api.fetchApi(`${ASSET_LIBRARY_ROUTE}?${params.toString()}`);
            const data = await res.json();
            if (!data.ok) throw new Error(data.error || "读取失败");
            if (Array.isArray(data.categories) && data.categories.length) categories = data.categories;
            if (data.stats && typeof data.stats === "object") stats = data.stats;
            if (Array.isArray(data.subs)) subs = data.subs;
            if (data.root) rootPath = data.root;
            if (data.root_display) rootDisplay = data.root_display;
            if (Array.isArray(data.icons)) iconSet = new Set(data.icons);
            items = Array.isArray(data.items) ? data.items : [];
        } catch (err) {
            console.warn("[Alili] 读取素材库失败：", err);
            items = [];
        }
        // 当前 TAB 被删空 / 改名后，退回「全部」，别停在已经不存在的 TAB 上
        if (sub !== null && !subs.some(item => item.key === sub)) {
            return loadLibrary(gallery, null);
        }
        renderTabs();
        renderThirds();
        renderGalleries();
        renderGrid();
        syncCards();
        renderDrawer();
    };

    const refreshFavorites = async () => {
        try {
            const res = await api.fetchApi(ASSET_FAVORITES_ROUTE);
            const data = await res.json();
            const list = Array.isArray(data.items) ? data.items : [];
            allFavorites = list;
            favSet = new Set(list.map(item => item.path));
            return list;
        } catch (err) {
            console.warn("[Alili] 读取收藏失败：", err);
            return [];
        }
    };

    // 「★ 已收藏」：只看当前图库的收藏（服装是服装、发型是发型，互不汇总）；点卡片按素材所属图库落槽位
    const loadFavorites = async (whichGallery) => {
        favMode = true;
        if (whichGallery) gallery = whichGallery;   // 保留/切换图库，不再清空
        sub = null;
        third = null;
        items = [];
        renderTabs();
        renderThirds();
        renderGalleries();
        const loading = make("div", { padding: "60px 10px" }, "读取中…");
        loading.className = "alli-lib-empty";
        grid.replaceChildren(loading);
        const all = await refreshFavorites();
        items = all.filter(it => favGalleryOf(it) === gallery);
        renderGalleries();
        renderGrid();
        syncCards();
        renderDrawer();
    };

    const bootstrap = async (preferredGallery, preferredSub = null, keep = false) => {
        await refreshFavorites();
        try {
            const res = await api.fetchApi(`${ASSET_LIBRARY_ROUTE}?category=`);
            const data = await res.json();
            categories = Array.isArray(data.categories) ? data.categories : [];
            stats = data.stats && typeof data.stats === "object" ? data.stats : {};
            if (Array.isArray(data.icons)) iconSet = new Set(data.icons);
            if (data.root) rootPath = data.root;
            if (data.root_display) rootDisplay = data.root_display;
        } catch (err) {
            console.warn("[Alili] 读取素材图库失败：", err);
            categories = [];
        }
        let want = preferredGallery || (categories.includes(gallery) ? gallery : "");
        if (!categories.includes(want)) want = categories[0] || "";
        // 角色图库是空的（比如首次用「人像」）时，优先落到有图的图库，别让人以为库是空的
        if (!keep && !preferredGallery && !((stats[want] || 0) > 0)) {
            const filled = categories.find(cat => (stats[cat] || 0) > 0);
            if (filled) want = filled;
        }
        await loadLibrary(want, preferredSub);
    };

    search.oninput = () => renderGrid();
    refreshBtn.onclick = () => bootstrap(gallery, sub, true);
    dlg.append(hd, galleryRow, tabs, subsubs, grid, drawer, drawerHandle, foot, fileInput);
    mask.appendChild(dlg);
    document.body.appendChild(mask);
    openLib = { mask };

    renderDrawer();
    loadLookPresets().then(renderDrawer);
    bootstrap(ctx.focusSlot ? SLOT_LABELS[ctx.focusSlot] : "")
        .catch(err => console.error("[Alili] 换形象加载失败：", err));
}

// =============================================================================
// 裁剪大窗口
//   拖拽内核（画框 / 移动 / 八向把手 / 比例锁 / Shift 锁比例 / Alt 对称 / 方向键微调）
//   整段移植自 GHIL 的 web/crop.js，几何逻辑一行没改，只把界面从"节点内嵌"搬进独立弹窗。
//   结果仍只存归一化 rect 到槽位，原图一个字节不动。
// =============================================================================
function clampNumber(value, low, high) {
    return Math.max(low, Math.min(high, value));
}

// 拖动把手后的新矩形（自然像素坐标）；ratio=0 = 自由，symmetric=按住 Alt 以中心对称缩放
function resizeRect(rect, handle, point, ratio, width, height, symmetric = false) {
    let left = rect.x, top = rect.y, right = left + rect.w, bottom = top + rect.h;
    if (symmetric) {
        const cx = (left + right) / 2, cy = (top + bottom) / 2;
        const horizontal = /[we]/.test(handle), vertical = /[ns]/.test(handle);
        const maxW = Math.min(cx, width - cx), maxH = Math.min(cy, height - cy);
        let halfW = horizontal ? Math.max(.5, (handle.includes("w") ? -1 : 1) * (point.x - cx)) : rect.w / 2;
        let halfH = vertical ? Math.max(.5, (handle.includes("n") ? -1 : 1) * (point.y - cy)) : rect.h / 2;
        if (ratio) {
            halfW = horizontal ? (vertical ? Math.max(halfW, halfH * ratio) : halfW) : halfH * ratio;
            halfW = Math.min(halfW, maxW, maxH * ratio);
            halfH = halfW / ratio;
        } else {
            halfW = Math.min(halfW, maxW);
            halfH = Math.min(halfH, maxH);
        }
        return { x: cx - halfW, y: cy - halfH, w: halfW * 2, h: halfH * 2 };
    }
    if (!ratio) {
        if (handle.includes("w")) left = clampNumber(point.x, 0, right - 1);
        if (handle.includes("e")) right = clampNumber(point.x, left + 1, width);
        if (handle.includes("n")) top = clampNumber(point.y, 0, bottom - 1);
        if (handle.includes("s")) bottom = clampNumber(point.y, top + 1, height);
        return { x: left, y: top, w: right - left, h: bottom - top };
    }
    const horizontal = /[we]/.test(handle), vertical = /[ns]/.test(handle);
    const anchorX = handle.includes("w") ? right : horizontal ? left : (left + right) / 2;
    const anchorY = handle.includes("n") ? bottom : vertical ? top : (top + bottom) / 2;
    const signX = handle.includes("w") ? -1 : 1, signY = handle.includes("n") ? -1 : 1;
    let w = horizontal ? Math.max(1, signX * (point.x - anchorX)) : Math.max(1, signY * (point.y - anchorY)) * ratio;
    if (horizontal && vertical) w = Math.max(w, Math.max(1, signY * (point.y - anchorY)) * ratio);
    const maxW = horizontal ? (signX > 0 ? width - anchorX : anchorX) : 2 * Math.min(anchorX, width - anchorX);
    const maxH = vertical ? (signY > 0 ? height - anchorY : anchorY) : 2 * Math.min(anchorY, height - anchorY);
    w = Math.min(w, maxW, maxH * ratio);
    const h = w / ratio;
    return { x: horizontal ? (signX < 0 ? anchorX - w : anchorX) : anchorX - w / 2,
        y: vertical ? (signY < 0 ? anchorY - h : anchorY) : anchorY - h / 2, w, h };
}

let closeCropDialog = null;

function openCropDialog(entry, onApply) {
    closeCropDialog?.();

    const maskEl = make("div"); maskEl.className = "alli-crop-mask"; maskEl.id = "alili-crop-mask";
    const dlg = make("div"); dlg.className = "alli-cropdlg";
    dlg.addEventListener("pointerdown", e => e.stopPropagation());

    const hd = make("div"); hd.className = "alli-crop-hd";
    hd.appendChild(make("span", {}, "裁剪参考图"));
    const xBtn = make("button", {}, "×"); xBtn.className = "alli-lib-x"; xBtn.title = "关闭（Esc）";
    hd.appendChild(xBtn);

    const bar = make("div"); bar.className = "alli-crop-bar";
    const ratioBtns = [];
    for (const name of CROP_RATIOS) {
        const b = make("button", {}, name);
        b.className = "alli-crop-ratio"; b.dataset.ratio = name;
        b.onclick = () => setRatio(name);
        ratioBtns.push(b); bar.appendChild(b);
    }
    const resetBtn = make("button", {}, "重置"); resetBtn.className = "alli-crop-reset";
    resetBtn.title = "恢复当前比例的最大选框";
    const clearBtn = make("button", {}, "清除"); clearBtn.className = "alli-crop-reset";
    clearBtn.title = "不用裁剪，回到整张原图（再点应用生效）";
    bar.append(make("span", { flex: "1" }), resetBtn, clearBtn);

    const stage = make("div"); stage.className = "alli-crop-stage";
    const frame = make("div"); frame.className = "alli-crop-frame";
    const img = make("img"); img.className = "alli-crop-img"; img.draggable = false;

    const overlay = make("div"); overlay.className = "alli-crop-overlay";
    const shade = make("div"); shade.className = "alli-crop-shade";
    const selection = make("div"); selection.className = "alli-crop-selection";
    const thirds = make("div"); thirds.className = "alli-crop-thirds";
    const center = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    center.setAttribute("class", "alli-crop-center");
    center.setAttribute("viewBox", "0 0 24 24");
    center.setAttribute("aria-hidden", "true");
    center.innerHTML = '<circle cx="12" cy="12" r="5.5"/><path d="M12 2v4.5M12 17.5V22M2 12h4.5M17.5 12H22"/><circle class="dot" cx="12" cy="12" r="1"/>';
    selection.append(thirds, center);
    for (const handle of ["n", "s", "e", "w", "nw", "ne", "sw", "se"]) {
        const span = make("span");
        span.className = `alli-crop-handle alli-crop-${handle}`;
        span.dataset.handle = handle;
        selection.appendChild(span);
    }
    overlay.append(shade, selection);
    frame.append(img, overlay);
    stage.appendChild(frame);

    const foot = make("div"); foot.className = "alli-crop-foot";
    const dim = make("span", {}, ""); dim.className = "alli-crop-dim";
    const cancel = make("button", {}, "取消"); cancel.className = "alli-lib-btn";
    const applyBtn = make("button", {}, "应用裁剪"); applyBtn.className = "alli-lib-btn go";
    foot.append(dim, make("span", { flex: "1" }), cancel, applyBtn);

    // ---- 状态 ----
    const saved = entry.crop && Array.isArray(entry.crop.rect) && entry.crop.rect.length === 4
        && entry.crop.rect.every(Number.isFinite) && entry.crop.rect[2] > 0 && entry.crop.rect[3] > 0
        ? entry.crop : null;
    let ratioName = saved && CROP_RATIOS.includes(saved.ratio) ? saved.ratio : "自由";
    let rect = null;          // 自然像素坐标 {x,y,w,h}
    let drag = null;
    let original = null;      // img 载入后才有 naturalWidth / naturalHeight

    const ratioValue = () => ratioName === "自由"
        ? 0
        : ratioName.split(":").reduce((a, b) => Number(a) / Number(b));

    const sample = document.createElement("canvas");
    sample.width = sample.height = 8;
    const sampleCtx = sample.getContext("2d", { willReadFrequently: true });

    const paint = () => {
        ratioBtns.forEach(b => b.classList.toggle("on", b.dataset.ratio === ratioName));
        selection.hidden = !rect;
        shade.hidden = !rect || drag?.mode === "draw";
        if (!original) return;
        const nw = original.naturalWidth, nh = original.naturalHeight;
        if (!rect) { dim.textContent = `${nw} × ${nh} px`; return; }

        const left = clampNumber(Math.round(rect.x), 0, nw - 1);
        const top = clampNumber(Math.round(rect.y), 0, nh - 1);
        const right = clampNumber(Math.round(rect.x + rect.w), left + 1, nw);
        const bottom = clampNumber(Math.round(rect.y + rect.h), top + 1, nh);
        dim.textContent = `${right - left} × ${bottom - top} px`;

        const px = rect.x / nw * 100, py = rect.y / nh * 100;
        const pw = rect.w / nw * 100, ph = rect.h / nh * 100;
        selection.style.left = `${px}%`; selection.style.top = `${py}%`;
        selection.style.width = `${pw}%`; selection.style.height = `${ph}%`;
        shade.style.clipPath = "polygon(evenodd, 0% 0%, 100% 0%, 100% 100%, 0% 100%, 0% 0%, "
            + `${px}% ${py}%, ${px}% ${py + ph}%, ${px + pw}% ${py + ph}%, ${px + pw}% ${py}%, ${px}% ${py}%, 0% 0%)`;

        // 中心十字跟着底图明暗自动反色（GHIL 同款 8×8 采样）
        if (drag?.mode !== "draw") {
            const bounds = overlay.getBoundingClientRect();
            const radiusX = 10 * nw / (bounds.width || nw);
            const radiusY = 10 * nh / (bounds.height || nh);
            const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
            const sx = Math.max(0, cx - radiusX), sy = Math.max(0, cy - radiusY);
            const sw = Math.max(1, Math.min(nw, cx + radiusX) - sx);
            const sh = Math.max(1, Math.min(nh, cy + radiusY) - sy);
            try {
                sampleCtx.fillStyle = "#242833"; sampleCtx.fillRect(0, 0, 8, 8);
                sampleCtx.drawImage(original, sx, sy, sw, sh, 0, 0, 8, 8);
                const pixels = sampleCtx.getImageData(0, 0, 8, 8).data;
                let brightness = 0;
                for (let i = 0; i < pixels.length; i += 4) {
                    brightness += .2126 * pixels[i] + .7152 * pixels[i + 1] + .0722 * pixels[i + 2];
                }
                selection.style.setProperty("--alli-center-color", brightness / 64 < 128 ? "#fff" : "#000");
            } catch {
                selection.style.setProperty("--alli-center-color", "#fff");
            }
        }
    };

    const layout = () => {
        if (!original) return;
        const nw = original.naturalWidth, nh = original.naturalHeight;
        const availW = Math.max(1, stage.clientWidth - 24);
        const availH = Math.max(1, stage.clientHeight - 24);
        const k = Math.min(availW / nw, availH / nh);
        frame.style.width = `${Math.max(1, Math.round(nw * k))}px`;
        frame.style.height = `${Math.max(1, Math.round(nh * k))}px`;
        paint();
    };

    const point = event => {
        const bounds = overlay.getBoundingClientRect();
        const nw = original.naturalWidth, nh = original.naturalHeight;
        return {
            x: clampNumber((event.clientX - bounds.left) / (bounds.width || 1), 0, 1) * nw,
            y: clampNumber((event.clientY - bounds.top) / (bounds.height || 1), 0, 1) * nh,
        };
    };

    // 鼠标离哪条边 12px 内就算抓到哪个把手（边缘/角都能拖）
    const edgeHandle = event => {
        if (!rect || !original) return "";
        const bounds = overlay.getBoundingClientRect();
        const nw = original.naturalWidth, nh = original.naturalHeight;
        const left = bounds.left + rect.x / nw * bounds.width;
        const top = bounds.top + rect.y / nh * bounds.height;
        const right = left + rect.w / nw * bounds.width;
        const bottom = top + rect.h / nh * bounds.height;
        const x = event.clientX, y = event.clientY, reach = 12;
        if (x < left - reach || x > right + reach || y < top - reach || y > bottom + reach) return "";
        const vertical = Math.min(Math.abs(y - top), Math.abs(y - bottom)) <= reach
            ? (Math.abs(y - top) <= Math.abs(y - bottom) ? "n" : "s") : "";
        const horizontal = Math.min(Math.abs(x - left), Math.abs(x - right)) <= reach
            ? (Math.abs(x - left) <= Math.abs(x - right) ? "w" : "e") : "";
        return vertical + horizontal;
    };

    const CURSORS = {
        n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize",
        nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize",
    };

    const updateCursor = event => {
        if (!original) return;
        const handle = drag?.mode === "resize" ? drag.handle : edgeHandle(event);
        const p = rect ? point(event) : null;
        const inside = rect && p && p.x >= rect.x && p.x <= rect.x + rect.w
            && p.y >= rect.y && p.y <= rect.y + rect.h;
        overlay.style.cursor = CURSORS[handle] || (inside ? "move" : "crosshair");
    };

    const updateDrag = (p, shiftKey, altKey) => {
        if (!drag || !original) return;
        drag.point = p;
        const width = original.naturalWidth, height = original.naturalHeight;
        const aspect = ratioValue()
            || (shiftKey && drag.rect?.w > 0 && drag.rect?.h > 0 ? drag.rect.w / drag.rect.h : 0);
        if (drag.mode === "move") {
            rect = { ...drag.rect,
                x: clampNumber(drag.rect.x + p.x - drag.start.x, 0, width - drag.rect.w),
                y: clampNumber(drag.rect.y + p.y - drag.start.y, 0, height - drag.rect.h) };
        } else if (drag.mode === "resize") {
            rect = resizeRect(drag.rect, drag.handle, p, aspect, width, height, altKey);
        } else {
            let w = Math.abs(p.x - drag.start.x), h = Math.abs(p.y - drag.start.y);
            const sx = p.x < drag.start.x ? -1 : 1, sy = p.y < drag.start.y ? -1 : 1;
            const maxW = altKey
                ? Math.min(drag.start.x, width - drag.start.x)
                : (sx > 0 ? width - drag.start.x : drag.start.x);
            const maxH = altKey
                ? Math.min(drag.start.y, height - drag.start.y)
                : (sy > 0 ? height - drag.start.y : drag.start.y);
            if (aspect) {
                w = Math.min(Math.max(w, h * aspect), maxW, maxH * aspect);
                h = w / aspect;
            } else {
                w = Math.min(w, maxW); h = Math.min(h, maxH);
            }
            rect = altKey
                ? { x: drag.start.x - w, y: drag.start.y - h, w: w * 2, h: h * 2 }
                : { x: sx < 0 ? drag.start.x - w : drag.start.x, y: sy < 0 ? drag.start.y - h : drag.start.y, w, h };
        }
        paint();
    };

    const setRatio = name => {
        ratioName = name;
        const ratio = ratioValue();
        if (ratio && original) {
            const width = original.naturalWidth, height = original.naturalHeight;
            const w = Math.min(width, height * ratio), h = w / ratio;
            rect = { x: (width - w) / 2, y: (height - h) / 2, w, h };
        } else if (!rect && original) {
            rect = { x: 0, y: 0, w: original.naturalWidth, h: original.naturalHeight };
        }
        paint();
    };

    overlay.addEventListener("pointerdown", event => {
        if (event.button !== 0 || !original) return;
        event.preventDefault(); event.stopPropagation();
        if (event.detail > 1) return;              // 第二下让给 dblclick，别变成"手抖画框"
        const start = point(event);
        const handle = edgeHandle(event);
        const inside = rect && start.x >= rect.x && start.x <= rect.x + rect.w
            && start.y >= rect.y && start.y <= rect.y + rect.h;
        const mode = handle ? "resize" : (inside ? "move" : "draw");
        drag = { mode, handle, start, point: start, rect: rect && { ...rect } };
        if (mode === "draw") rect = { x: start.x, y: start.y, w: 0, h: 0 };
        try { overlay.setPointerCapture(event.pointerId); } catch {}
        paint();
    });

    overlay.addEventListener("pointermove", event => {
        if (!original) return;
        if (!drag) { updateCursor(event); return; }
        event.preventDefault();
        updateDrag(point(event), event.shiftKey, event.altKey);
    });

    const endDrag = event => {
        if (!drag) return;
        drag = null;
        if (rect && (rect.w < 1 || rect.h < 1)) rect = null;
        if (event) updateCursor(event);
        paint();
    };
    overlay.addEventListener("pointerup", endDrag);
    overlay.addEventListener("pointercancel", endDrag);
    overlay.addEventListener("dblclick", event => {
        event.preventDefault(); event.stopPropagation();
        confirmCrop();
    });

    const close = () => {
        document.removeEventListener("keydown", onKey, true);
        document.removeEventListener("keyup", onKeyUp, true);
        window.removeEventListener("resize", layout);
        closeCropDialog = null;
        maskEl.remove();
    };

    const confirmCrop = () => {
        if (!rect || rect.w < 1 || rect.h < 1 || !original) { onApply(null); close(); return; }
        const nw = original.naturalWidth, nh = original.naturalHeight;
        onApply({ ratio: ratioName, rect: [rect.x / nw, rect.y / nh, rect.w / nw, rect.h / nh] });
        close();
    };

    const onKey = event => {
        if (!original) return;
        if (event.target.closest?.("input,textarea,select,[contenteditable=true]")) return;
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
        if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); confirmCrop(); return; }
        if (["Shift", "Alt"].includes(event.key) && drag) {
            event.preventDefault();
            updateDrag(drag.point, event.key === "Shift" || event.shiftKey, event.key === "Alt" || event.altKey);
            return;
        }
        const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
        if (!direction || !rect || drag) return;
        event.preventDefault(); event.stopPropagation();
        const step = event.shiftKey ? 10 : 1;
        rect = { ...rect,
            x: clampNumber(rect.x + direction[0] * step, 0, original.naturalWidth - rect.w),
            y: clampNumber(rect.y + direction[1] * step, 0, original.naturalHeight - rect.h) };
        paint();
    };

    const onKeyUp = event => {
        if (!drag || !["Shift", "Alt"].includes(event.key)) return;
        updateDrag(drag.point, event.key !== "Shift" && event.shiftKey, event.key !== "Alt" && event.altKey);
    };

    xBtn.onclick = close;
    cancel.onclick = close;
    applyBtn.onclick = confirmCrop;
    resetBtn.onclick = () => setRatio(ratioName);
    clearBtn.onclick = () => { rect = null; ratioName = "自由"; drag = null; paint(); };
    maskEl.addEventListener("pointerdown", event => { if (event.target === maskEl) close(); });
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("resize", layout);

    img.onload = () => {
        original = img;
        const nw = img.naturalWidth, nh = img.naturalHeight;
        if (saved) {
            rect = { x: saved.rect[0] * nw, y: saved.rect[1] * nh, w: saved.rect[2] * nw, h: saved.rect[3] * nh };
        } else {
            rect = { x: nw / 6, y: nh / 6, w: nw * 2 / 3, h: nh * 2 / 3 };
        }
        layout();
    };
    img.onerror = () => { dim.textContent = "图片加载失败"; };
    img.src = fileUrl(entry.name);

    dlg.append(hd, bar, stage, foot);
    maskEl.appendChild(dlg);
    document.body.appendChild(maskEl);
    closeCropDialog = close;
    requestAnimationFrame(layout);
}

function injectStyle() {
    if (document.getElementById("alili-load-image-style")) return;
    const style = document.createElement("style");
    style.id = "alili-load-image-style";
    style.textContent = `
      /* ===== 明暗 2 套主题令牌：经典浅色 / 极客暗黑，html[data-alli-theme] 整窗换肤 ===== */
      html[data-alli-theme]{
        --at-bg:linear-gradient(135deg,rgba(36,20,29,.96),rgba(69,28,49,.94),rgba(97,38,66,.96));
        --at-glass:rgba(255,255,255,.07);      --at-glass-hover:rgba(255,255,255,.14);
        --at-border:rgba(255,255,255,.18);     --at-border-2:rgba(255,255,255,.1);
        --at-text:#fff0f3;                     --at-dim:#c8a2b1;
        --at-accent:#ff8a9a;                   --at-accent-ink:#24141d;
        --at-accent-glow:rgba(255,138,154,.35);--at-focus:rgba(255,138,154,.28);
        --at-card:rgba(255,255,255,.05);       --at-card-hover:rgba(255,255,255,.1);
        --at-input:rgba(0,0,0,.26);            --at-overlay:rgba(15,10,12,.66);
        --at-shadow:rgba(0,0,0,.5);            --at-cap:rgba(10,4,8,.92);
        --at-cap-text:#fff0f3;             --at-scroll:rgba(255,138,154,.5);      --at-danger:#ff4d6d;
        --at-track:rgba(255,255,255,.14);      --at-checker-a:rgba(255,255,255,.03);
        --at-checker-b:rgba(0,0,0,.16);        --at-parent:rgba(0,0,0,.3);
        /* 顶栏/内容区分块背景：默认透明（沿用面板渐变），仅经典浅色主题覆盖成 GHIL 配色 */
        --at-hd-bg:transparent;                --at-content-bg:transparent;
        /* 强调色柔底：卡片选中信息条用，跟随各主题强调色 */
        --at-accent-soft:rgba(255,138,154,.18);
      }
      html[data-alli-theme="chrome-light"]{
        --at-bg:linear-gradient(135deg,rgba(241,245,249,.97),rgba(233,238,246,.96),rgba(223,230,239,.97));
        --at-glass:rgba(255,255,255,.85);      --at-glass-hover:#fff;
        --at-border:rgba(255,138,154,.32);     --at-border-2:rgba(65,77,94,.13);
        --at-text:#414d5e;                     --at-dim:#8a8fa3;
        --at-accent:#ff8a9a;                   --at-accent-ink:#2a1119;
        --at-accent-glow:rgba(255,138,154,.35);--at-focus:rgba(255,138,154,.28);
        --at-card:rgba(255,255,255,.9);        --at-card-hover:#fff;
        --at-input:rgba(255,255,255,.95);      --at-overlay:rgba(30,33,48,.38);
        --at-shadow:rgba(30,33,48,.25);        --at-cap:rgba(20,26,38,.9);
        --at-cap-text:#fff;                    --at-scroll:rgba(255,138,154,.4);
        --at-danger:#e5484d;
        --at-track:rgba(65,77,94,.18);         --at-checker-a:rgba(255,255,255,.7);
        --at-checker-b:rgba(65,77,94,.06);     --at-parent:rgba(226,232,240,.9);
        /* 照搬 GHIL 浅色界面：顶部信息栏浅灰绿 + 内容区浅白 */
        --at-hd-bg:#e9efea;                    --at-content-bg:#f5f7fb;
      }
      html[data-alli-theme="chrome-default"]{
        --at-bg:linear-gradient(135deg,rgba(30,31,34,.96),rgba(43,45,49,.94),rgba(24,25,28,.96));
        --at-glass:rgba(255,255,255,.06);      --at-glass-hover:rgba(255,255,255,.12);
        --at-border:rgba(255,255,255,.12);     --at-border-2:rgba(255,255,255,.07);
        --at-text:#e3e3e3;                     --at-dim:#9aa0a6;
        --at-accent:#8ab4f8;                   --at-accent-ink:#0b1620;
        --at-accent-glow:rgba(138,180,248,.32);--at-focus:rgba(138,180,248,.25);
        --at-accent-soft:rgba(138,180,248,.2);
        --at-card:rgba(255,255,255,.04);       --at-card-hover:rgba(255,255,255,.08);
        --at-input:rgba(0,0,0,.28);            --at-overlay:rgba(0,0,0,.66);
        --at-shadow:rgba(0,0,0,.55);           --at-cap:rgba(8,9,11,.92);
        --at-cap-text:#e3e3e3;             --at-scroll:rgba(138,180,248,.5);      --at-danger:#ef4444;
        --at-track:rgba(255,255,255,.14);      --at-checker-a:rgba(255,255,255,.025);
        --at-checker-b:rgba(0,0,0,.14);        --at-parent:rgba(0,0,0,.3);
      }
      .alli-root{width:100%;height:100%;box-sizing:border-box;display:flex;flex-direction:column;color:#d7e3ef;font:12px Arial,sans-serif;user-select:none;min-height:0}
      .alli-toolbar{flex:0 0 auto;display:flex;gap:8px;padding:0 0 6px}
      .alli-tbtn{flex:1 1 0;min-width:0;height:24px;padding:0;border:1px solid rgba(255,255,255,.12);border-radius:10px;color:#e3e3e3;font:bold 12px/22px Arial,sans-serif;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:#2a2c30}
      button.alli-tbtn:disabled,button.alli-tbtn:disabled:hover{background:#2a2c30;opacity:.45;cursor:not-allowed}
      .alli-tbtn.up,.alli-tbtn.lib,.alli-tbtn.rz{background:#2a2c30}
      .alli-tbtn.up:hover,.alli-tbtn.lib:hover,.alli-tbtn.rz:hover{background:#33363b;color:#fff}
      .alli-list{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;box-sizing:border-box;border:none;border-radius:0;background:transparent;padding:0;display:flex;flex-direction:column;gap:6px;scrollbar-width:thin;scrollbar-color:#2a4556 transparent}
      .alli-list::-webkit-scrollbar{width:6px}
      .alli-list::-webkit-scrollbar-thumb{background:#2a4556;border-radius:3px}
      .alli-item{position:relative;flex:0 0 auto;width:100%;box-sizing:border-box;border:none;border-radius:10px;overflow:hidden;background:#1e1f22;touch-action:none;cursor:pointer;aspect-ratio:1/1}
      /* 卡片锁 1:1 让节点排列整齐：没裁剪就整图 contain 进框（留边不裁），裁了就只放裁剪出来的那块 */
      .alli-shot{position:absolute;inset:0;margin:auto;overflow:hidden;line-height:0}
      .alli-shot img{display:block;width:100%;height:100%;object-fit:contain;pointer-events:none;-webkit-user-drag:none}
      .alli-item.alli-ok{outline:2px solid #18bdd3;outline-offset:-2px}
      .alli-item.alli-no-target{outline:2px solid #d4537e;outline-offset:-2px}
      .alli-item.alli-src{opacity:.6;cursor:grabbing}
      .alli-item.alli-target{box-shadow:0 0 0 2px #8ab4f8 inset}
      .alli-no{position:absolute;left:6px;bottom:6px;width:22px;height:22px;padding:0;box-sizing:border-box;border-radius:50%;background:rgba(8,20,30,.82);color:#fff;font:bold 11px Arial,sans-serif;display:flex;align-items:center;justify-content:center;pointer-events:none}
      .alli-res{position:absolute;left:50%;bottom:6px;transform:translateX(-50%);padding:0 8px;height:20px;border-radius:10px;background:rgba(8,20,30,.82);color:#cfe3ef;font:10px/20px Arial,sans-serif;text-align:center;pointer-events:none;white-space:nowrap}
      .alli-x{position:absolute;right:6px;bottom:6px;width:22px;height:22px;padding:0;border:0;border-radius:50%;background:rgba(8,20,30,.82);color:#e6eef5;font:14px Arial,sans-serif;display:flex;align-items:center;justify-content:center;cursor:pointer}
      .alli-x:hover{background:#b53b3b;color:#fff}
      .alli-hint{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;min-height:90px;color:#6f8291;font-size:12px;text-align:center;line-height:1.6}
      .alli-tbtn.rz{background:#2a2c30}
      .alli-tbtn.rz.on{background:#2f7d5b;border-color:#2f7d5b;color:#fff}
      .alli-tbtn.rz.on:hover{background:#3a9a70}
      .alli-tbtn.lib:hover{background:#33363b;border-color:var(--at-accent,#ff8a9a);color:var(--at-accent,#ff8a9a)}
      .alli-tbtn.lib.on{background:var(--at-accent,#ff8a9a);border-color:var(--at-accent,#ff8a9a);color:var(--at-accent-ink,#24141d)}
      .alli-dlg-back{position:fixed;inset:0;z-index:10190;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center}
      .alli-dlg{width:340px;max-width:calc(100vw - 40px);box-sizing:border-box;background:#17222c;color:#dbe8f1;border:1px solid #3a4d5b;border-radius:10px;box-shadow:0 10px 34px rgba(0,0,0,.5);font:13px Arial,sans-serif;padding:16px 18px 18px;user-select:none}
      .alli-dlg-hd{display:flex;align-items:center;justify-content:space-between;padding-bottom:12px;margin-bottom:4px;border-bottom:1px solid #2c3d4a}
      .alli-dlg-x{width:22px;height:22px;padding:0;border:0;border-radius:50%;background:transparent;color:#8fa4b4;font:18px/22px Arial,sans-serif;cursor:pointer}
      .alli-dlg-x:hover{background:#334756;color:#fff}
      .alli-dlg-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px 0}
      .alli-dlg-row+.alli-dlg-row{border-top:1px solid #243542}
      .alli-dlg-lb{font-weight:bold;font-size:calc(12px * var(--alli-ts,1));color:#e6eef5}
      .alli-dlg-sub{font-size:calc(11px * var(--alli-ts,1));color:#8fa4b4;margin-top:3px}
      .alli-sw{position:relative;display:inline-block;width:38px;height:21px;flex:0 0 auto}
      .alli-sw input{opacity:0;width:0;height:0}
      .alli-sw .track{position:absolute;inset:0;background:#3a4d5b;border-radius:11px;transition:background .15s;cursor:pointer}
      .alli-sw .track:before{content:"";position:absolute;width:15px;height:15px;left:3px;top:3px;background:#dbe8f1;border-radius:50%;transition:transform .15s}
      .alli-sw input:checked+.track{background:#2f7d5b}
      .alli-sw input:checked+.track:before{transform:translateX(17px)}
      .alli-sw input:disabled+.track{opacity:.4;cursor:not-allowed}
      .alli-dlg-row.dim{opacity:.4}
      .alli-mp-val{color:#7fd3a6;font-variant-numeric:tabular-nums;font-size:12px}
      .alli-dlg input[type=range]{width:150px;accent-color:#2f7d5b;cursor:pointer}
      .alli-dlg input[type=checkbox].alli-ck{width:16px;height:16px;accent-color:#2f7d5b;cursor:pointer}
      .alli-dlg-note{font-size:11px;line-height:1.6;color:#8fa4b4;padding:10px 0 2px;border-top:1px solid #243542;margin-top:2px}
      .alli-dlg-btns{display:flex;gap:10px;margin-top:14px}
      .alli-dlg-btns button{flex:1;height:30px;border:1px solid #3a4d5b;border-radius:10px;background:#233444;color:#dbe8f1;font:bold 12px/30px Arial,sans-serif;cursor:pointer}
      .alli-dlg-btns button:hover{background:#2c4253}
      .alli-dlg-btns .go{background:#2f7d5b;border-color:#2f7d5b;color:#fff}
      .alli-dlg-btns .go:hover{background:#3a9a70}
      .alli-role{position:absolute;left:6px;top:6px;height:24px;padding:0 10px;border:1px solid #f4a9b8;border-radius:12px;background:#f4a9b8;color:#2b2226;font:bold 11px/22px Arial,sans-serif;cursor:pointer;z-index:2}
      .alli-role:hover{background:#f4a9b8;border-color:#f4a9b8;color:#2b2226}
      .alli-role.on{background:#f4a9b8;border-color:#f4a9b8;color:#2b2226}
      .alli-cropbtn{position:absolute;right:6px;top:6px;height:24px;padding:0 10px;border:1px solid rgba(255,255,255,.16);border-radius:12px;background:rgba(8,20,30,.82);color:#9aa0a6;font:bold 11px/22px Arial,sans-serif;cursor:pointer;z-index:2}
      .alli-cropbtn:hover{background:rgba(8,20,30,.95);border-color:#3a9a70;color:#7fd3a6}
      .alli-cropbtn.on{background:#2f7d5b;border-color:#2f7d5b;color:#fff}

      .alli-lib-mask{position:fixed;inset:0;z-index:10160;background:rgba(0,0,0,.58);display:flex;align-items:center;justify-content:center}
      .alli-lib{width:min(1560px,96vw);height:min(1020px,94vh);box-sizing:border-box;display:flex;flex-direction:column;background:#15202a;color:#dbe8f1;border:1px solid #3a4d5b;border-radius:12px;box-shadow:0 18px 50px rgba(0,0,0,.6);font:calc(13px * var(--alli-ts,1))/1.45 Arial,sans-serif;overflow:hidden}
      .alli-lib-hd{flex:0 0 auto;display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid #2c3d4a}
      .alli-lib-titlewrap{display:none}
      .alli-lib-x{width:24px;height:24px;flex:0 0 auto;padding:0;border:0;border-radius:50%;background:transparent;color:#8fa4b4;font:18px/24px Arial,sans-serif;cursor:pointer}
      .alli-lib-x:hover{background:#334756;color:#fff}
      .alli-lib-galleries{flex:0 0 auto;display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:10px;padding:14px 16px 10px}
      .alli-lib-gbtn{display:inline-flex;align-items:center;gap:7px;height:36px;padding:0 13px;box-sizing:border-box;border:1px solid #2f4557;border-radius:12px;background:linear-gradient(180deg,#1b2c39,#16232e);color:#b9cbd8;font:bold calc(12px * var(--alli-ts,1))/1 Arial,sans-serif;cursor:pointer;box-shadow:0 1px 0 rgba(255,255,255,.05) inset,0 2px 8px rgba(0,0,0,.28);transition:transform .12s,background .16s,border-color .16s,box-shadow .16s}
      .alli-lib-gbtn:hover{border-color:#4f7a92;color:#fff;transform:translateY(-1px)}
      .alli-lib-gbtn.on{background:linear-gradient(180deg,#1f7a97,#14566c);border-color:#57b6cd;color:#fff;box-shadow:0 0 0 1px rgba(87,182,205,.35),0 6px 18px rgba(24,120,150,.4)}
      .alli-lib-giconwrap{width:calc(14px * var(--alli-ts,1));height:calc(14px * var(--alli-ts,1));flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center}
      .alli-lib-gicon{width:calc(14px * var(--alli-ts,1));height:calc(14px * var(--alli-ts,1));display:block;background:currentColor;opacity:.92;-webkit-mask:var(--alli-icon) center/contain no-repeat;mask:var(--alli-icon) center/contain no-repeat}
      .alli-lib-gbtn.on .alli-lib-gicon{opacity:1}
      .alli-lib-gicon.text{-webkit-mask:none;mask:none;width:calc(14px * var(--alli-ts,1));height:calc(14px * var(--alli-ts,1));text-align:center;font-weight:bold;font-size:calc(10px * var(--alli-ts,1));line-height:calc(14px * var(--alli-ts,1));font-family:Arial,sans-serif;background:transparent;opacity:1}
      .alli-lib-gname{white-space:nowrap;letter-spacing:.5px;position:relative;top:calc(1px * var(--alli-ts,1))}
      .alli-lib-gcount{padding:0;background:none;border-radius:0;color:inherit;font:calc(10px * var(--alli-ts,1))/16px Arial,sans-serif;text-align:center;font-variant-numeric:tabular-nums}
      /* 已收藏：一枚星直接上色，不套圆框 */
      .alli-lib-gbtn.fav{gap:6px;padding-left:13px}
      .alli-lib-gbtn.fav>span:first-child{font-size:calc(14px * var(--alli-ts,1));line-height:1}
      .alli-lib-tabs{flex:0 0 auto;display:flex;gap:6px;flex-wrap:nowrap;overflow-x:auto;overflow-y:hidden;padding:4px 16px 8px;scrollbar-width:thin;scrollbar-color:#2a4556 transparent}
      .alli-lib-tabs::-webkit-scrollbar{height:5px}
      .alli-lib-tabs::-webkit-scrollbar-thumb{background:#2a4556;border-radius:3px}
      .alli-lib-tab{flex:0 0 auto;display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 13px;border:1px solid #33495a;border-radius:10px;background:#1b2a36;color:#b9cbd8;font:calc(12px * var(--alli-ts,1))/1 Arial,sans-serif;cursor:pointer}
      .alli-lib-tab:hover{background:#24394a;color:#fff}
      .alli-lib-tab.on{background:#1f6f8b;border-color:#3f9cb8;color:#fff}
      .alli-lib-tab.add{width:28px;padding:0;justify-content:center;border-style:dashed;border-color:#3f5a6d;background:transparent;color:#9fc4d6;font-size:calc(14px * var(--alli-ts,1))}
      .alli-lib-tab.add:hover{background:#1d3242;border-color:#5f8aa0;color:#fff}
      .alli-lib-count{padding:0;background:none;border-radius:0;color:inherit;font:calc(10px * var(--alli-ts,1))/16px Arial,sans-serif;text-align:center}
      .alli-lib-tab>span:first-child{position:relative;top:calc(1px * var(--alli-ts,1))}
      /* 三级文件夹行：仅当二级下真有子文件夹时，以该 TAB 为中心滑出；最后一层 */
      .alli-lib-subsubs{flex:0 0 auto;display:flex;overflow-x:auto;padding:0 16px 8px;scrollbar-width:thin;scrollbar-color:#2a4556 transparent}
      .alli-lib-subsubs::-webkit-scrollbar{height:5px}
      .alli-lib-subsubs::-webkit-scrollbar-thumb{background:#2a4556;border-radius:3px}
      .alli-lib-subsubs-inner{flex:0 0 auto;display:flex;gap:6px;width:max-content}
      .alli-lib-subsubs.show .alli-lib-subsubs-inner{animation:alli-third-in .22s cubic-bezier(.2,.8,.3,1) both}
      @keyframes alli-third-in{from{opacity:0;transform:translateY(-10px)}to{opacity:1;transform:none}}
      .alli-lib-third{flex:0 0 auto;display:inline-flex;align-items:center;gap:5px;height:25px;padding:0 11px;border:1px dashed #3a5668;border-radius:10px;background:#16252f;color:#9fc4d6;font:calc(11px * var(--alli-ts,1))/1 Arial,sans-serif;cursor:pointer}
      .alli-lib-third:hover{background:#1d3242;border-color:#5f8aa0;color:#fff}
      .alli-lib-third.on{background:#1f6f8b;border-color:#3f9cb8;border-style:solid;color:#fff}
      .alli-lib-third>span:first-child{position:relative;top:calc(1px * var(--alli-ts,1))}
      .alli-lib-nocat{color:#6f8291;font-size:calc(12px * var(--alli-ts,1));padding:4px 2px}
      .alli-lib-searchwrap{position:relative;flex:1;min-width:0;max-width:320px;display:flex;align-items:center}
      .alli-lib-searchicon{position:absolute;left:11px;width:14px;height:14px;fill:none;stroke:#6f8ea3;stroke-width:1.7;stroke-linecap:round;pointer-events:none}
      .alli-lib-search{width:100%;box-sizing:border-box;height:32px;padding:0 12px 0 33px;border:1px solid #33495a;border-radius:12px;background:#0e1720;color:#dbe8f1;font:calc(12px * var(--alli-ts,1))/1 Arial,sans-serif;outline:none}
      .alli-lib-search:focus{border-color:#4c8fa0;box-shadow:0 0 0 2px rgba(76,143,160,.22)}
      .alli-lib-grid{flex:1;min-height:0;overflow-y:auto;padding:10px 16px 18px;display:grid;grid-template-columns:repeat(auto-fill,var(--alli-card-w,154px));justify-content:center;gap:10px;align-content:start;scrollbar-width:thin;scrollbar-color:#2a4556 transparent}
      .alli-lib-grid::-webkit-scrollbar{width:10px}
      .alli-lib-grid::-webkit-scrollbar-track{background:transparent}
      .alli-lib-grid::-webkit-scrollbar-thumb{background:#2a4556;border-radius:5px}
      .alli-lib-grid::-webkit-scrollbar-thumb:hover{background:#3a5b70}
      /* 卡片对齐 Goohai：2:3 竖版白底卡 —— 图片区 contain 完整显示，底部独立浅色信息条。
         高度用固定 calc（grid 算行高拿不到列宽，用 aspect-ratio 会把行压扁、卡片叠住）：图区 宽×3/2 + 信息条 38px。 */
      .alli-lib-card{position:relative;box-sizing:border-box;display:flex;flex-direction:column;height:calc(var(--alli-card-w,154px) * 3 / 2 + 38px);border:1px solid #dce2eb;border-radius:8px;overflow:hidden;background:#fff;cursor:pointer}
      .alli-card-pic{position:relative;flex:1 1 auto;min-height:0;background:#fff;overflow:hidden}
      .alli-card-pic img{display:block;width:100%;height:100%;object-fit:contain;object-position:center;pointer-events:none;-webkit-user-drag:none}
      .alli-card-info{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;gap:8px;height:38px;box-sizing:border-box;padding:0 10px;background:#fff;border-top:1px solid #eef1f5}
      .alli-card-name{flex:1 1 auto;min-width:0;color:#23334c;font:600 calc(12px * var(--alli-ts,1))/1.3 Arial,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .alli-card-cat{flex:0 0 auto;color:#8b97a5;font:calc(10px * var(--alli-ts,1))/1.3 Arial,sans-serif;white-space:nowrap}
      .alli-lib-empty{grid-column:1/-1;padding:60px 10px;text-align:center;color:#6f8291;font-size:calc(12px * var(--alli-ts,1));line-height:1.9;white-space:pre-line}
      .alli-lib-foot{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:10px 16px;border-top:1px solid #2c3d4a}
      /* 换形象主底栏：三栏 grid 让「取消/确定」精确居中，自动优化贴右侧；统计文字不再渲染 */
      .alli-look-foot{display:grid;grid-template-columns:1fr auto 1fr;align-items:center}
      .alli-look-foot-center{display:flex;align-items:center;justify-content:center;gap:10px}
      .alli-look-foot>.alli-switch{justify-self:start}
      .alli-lib-info{color:#8fa4b4;font-size:calc(11px * var(--alli-ts,1))}
      .alli-lib-btn{height:30px;padding:0 16px;border:1px solid #3a4d5b;border-radius:10px;background:#233444;color:#dbe8f1;font:bold calc(12px * var(--alli-ts,1))/28px Arial,sans-serif;cursor:pointer}
      .alli-lib-btn:hover{background:#2c4253}
      .alli-lib-btn.go{background:#1f6f8b;border-color:#2f8ba3;color:#fff}
      .alli-lib-btn.go:hover{background:#2a8fb3}
      .alli-lib-btn.go:disabled{background:#27414f;border-color:#33505f;color:#7d94a3;cursor:not-allowed}

      /* ===== 换形象抽屉：左 图1~图4 · 右 提示词原文 ===== */
      .alli-drawer{flex:0 0 auto;display:flex;gap:14px;padding:10px 16px;border-top:1px solid #2c3d4a;background:#111c25;max-height:210px}
      .alli-drawer-slots{flex:0 0 auto;display:flex;gap:10px}
      .alli-slot-wrap{display:flex;flex-direction:column;align-items:center;gap:4px}
      .alli-slot{position:relative;width:calc(72px * var(--alli-ts,1));height:calc(96px * var(--alli-ts,1));box-sizing:border-box;border:1px dashed #3c5666;border-radius:7px;background:#0b141b;display:flex;align-items:center;justify-content:center;color:#4d6a7c;font:20px/1 Arial,sans-serif;overflow:hidden}
      .alli-slot.on{border-style:solid;border-color:#18bdd3;background:#08131a}
      .alli-slot img{display:block;width:100%;height:100%;object-fit:contain;pointer-events:none;-webkit-user-drag:none}
      .alli-slot-label{font-size:calc(10.5px * var(--alli-ts,1));color:#8fa4b4;white-space:nowrap}
      .alli-slot-x{position:absolute;right:2px;top:2px;width:16px;height:16px;padding:0;border:0;border-radius:50%;background:rgba(8,20,30,.82);color:#cfe6f2;font:12px/16px Arial,sans-serif;cursor:pointer;opacity:0}
      .alli-slot:hover .alli-slot-x{opacity:1}
      .alli-slot-x:hover{background:#c0392b;color:#fff}
      .alli-drawer-prompt{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
      .alli-drawer-ptitle{font:bold calc(11.5px * var(--alli-ts,1))/1.4 Arial,"Microsoft YaHei",sans-serif;color:#7fd3f0}
      .alli-drawer-ptext{flex:1;min-height:0;overflow:auto;white-space:pre-wrap;word-break:break-word;padding-right:4px;color:#c9dbe6;font:calc(12px * var(--alli-ts,1))/1.6 Arial,"Microsoft YaHei",sans-serif;scrollbar-width:thin;scrollbar-color:#2a4556 transparent}
      .alli-drawer-ptext.empty{color:#61798a}
      .alli-switch{display:flex;align-items:center;gap:6px;color:#9db3c2;font-size:calc(11px * var(--alli-ts,1));cursor:pointer;user-select:none;white-space:nowrap}
      .alli-switch input{position:absolute;opacity:0;width:0;height:0}
      .alli-switch-track{position:relative;flex:0 0 auto;width:32px;height:17px;border-radius:9px;background:#33485a;transition:background-color .16s}
      .alli-switch-track:before{content:"";position:absolute;left:2px;top:2px;width:13px;height:13px;border-radius:50%;background:#9fb4c4;transition:transform .16s,background-color .16s}
      .alli-switch input:checked + .alli-switch-track{background:#1f6f8b}
      .alli-switch input:checked + .alli-switch-track:before{transform:translateX(15px);background:#eaf7ff}
      html.alli-light .alli-drawer{background:#eef4f8;border-color:#dbe7ef}
      html.alli-light .alli-slot{background:#fff;border-color:#c3d5e1;color:#9db3c2}
      html.alli-light .alli-slot.on{border-color:#18a6c0;background:#fff}
      html.alli-light .alli-slot-label{color:#5c7488}
      html.alli-light .alli-drawer-ptitle{color:#1a7c96}
      html.alli-light .alli-drawer-ptext{color:#2b3d4d}
      html.alli-light .alli-drawer-ptext.empty{color:#8299aa}
      html.alli-light .alli-switch{color:#5c7488}
      html.alli-light .alli-switch-track{background:#c6d6e2}
      html.alli-light .alli-switch input:checked + .alli-switch-track{background:#18a6c0}
      html.alli-light .alli-switch-track:before{background:#fff}
      .alli-lib-btn:disabled{opacity:.45;cursor:default}

      .alli-lib-tools{flex:0 0 auto;display:flex;align-items:center;gap:6px;margin-left:auto}
      .alli-lib-tool{height:26px;padding:0 11px;border:1px solid #33495a;border-radius:10px;background:#1b2a36;color:#b9cbd8;font:calc(11px * var(--alli-ts,1))/1 Arial,sans-serif;cursor:pointer}
      .alli-lib-gcanvas{display:none}
      .alli-scope{display:flex;gap:6px;margin:8px 0 2px}
      .alli-scope-chip{height:26px;padding:0 11px;border:1px solid #33495a;border-radius:10px;background:#1b2a36;color:#b9cbd8;font:calc(11px * var(--alli-ts,1))/24px Arial,sans-serif;cursor:pointer}
      .alli-scope-chip:hover{background:#24394a;color:#fff}
      .alli-scope-chip.on{background:#1f6f8b;border-color:#3f9cb8;color:#fff}
      .alli-lib-tool:hover{background:#24394a;color:#fff}
      .alli-lib-tool.icon{padding:0;width:26px;font:calc(14px * var(--alli-ts,1))/24px Arial,sans-serif}
      /* 卡片右上角操作组（hover 显示）：左「使用」强调色钮 + 右收藏星；强调色统一走 --at-accent */
      .alli-card-actions{position:absolute;left:8px;right:8px;top:8px;display:flex;justify-content:space-between;gap:6px;z-index:2;opacity:0;transition:opacity .15s;pointer-events:none}
      .alli-lib-card:hover .alli-card-actions,.alli-lib-card:focus-within .alli-card-actions{opacity:1}
      .alli-card-actions button{pointer-events:auto;display:flex;align-items:center;justify-content:center;height:28px;border-radius:7px;background:#fffffff2;color:#23334c;border:1px solid #d4dce5;box-shadow:0 2px 8px rgba(0,0,0,.12);cursor:pointer;font:calc(12px * var(--alli-ts,1))/1 Arial,sans-serif;padding:0 10px}
      .alli-card-use{background:var(--at-accent)!important;color:var(--at-accent-ink)!important;border-color:var(--at-accent)!important}
      .alli-card-use:hover{filter:brightness(.95);background:var(--at-accent)!important;border-color:var(--at-accent)!important;color:var(--at-accent-ink)!important}
      .alli-card-fav{width:30px;padding:0!important;font-size:16px;filter:grayscale(1);opacity:.68}
      .alli-card-fav:hover{opacity:1;transform:scale(1.08)}
      .alli-card-fav.on{filter:none;opacity:1}
      .alli-preview{width:min(980px,94vw);max-height:92vh;display:flex;flex-direction:column;background:#15202a;border:1px solid #3a4d5b;border-radius:12px;box-shadow:0 18px 50px rgba(0,0,0,.6);overflow:hidden;color:#dbe8f1;font:13px Arial,sans-serif}
      .alli-preview-body{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;background:#0a1219;padding:12px}
      .alli-preview-body img{max-width:100%;max-height:calc(92vh - 140px);object-fit:contain;display:block}

      .alli-simple-body{padding:10px 0 0}
      .alli-set-sec{padding:2px 0 10px;border-bottom:1px solid #243542;margin-bottom:10px}
      .alli-set-sec:last-of-type{border-bottom:0;margin-bottom:0;padding-bottom:0}
      .alli-set-title{font:bold calc(12px * var(--alli-ts,1))/1 Arial,sans-serif;color:#7fc7da;letter-spacing:.6px;margin:0 0 8px}
      .alli-set-row{display:flex;align-items:center;gap:10px;margin:8px 0}
      .alli-set-label{flex:0 0 62px;color:#9fb4c4;font:calc(11px * var(--alli-ts,1))/1 Arial,sans-serif}
      .alli-seg{display:flex;border:1px solid #33495a;border-radius:8px;overflow:hidden;background:#0e1720}
      .alli-seg button{height:26px;padding:0 16px;border:0;border-right:1px solid #2c3d4a;background:transparent;color:#b9cbd8;font:calc(11px * var(--alli-ts,1))/1 Arial,sans-serif;cursor:pointer}
      .alli-seg button:last-child{border-right:0}
      .alli-seg button:hover{background:#1d3242;color:#fff}
      .alli-seg button.on{background:#1f6f8b;color:#fff}
      .alli-range{flex:1;min-width:0;height:4px;accent-color:#2f9cb8;cursor:pointer}
      .alli-set-val{flex:0 0 46px;text-align:right;color:#8fa4b4;font:calc(11px * var(--alli-ts,1))/1 Consolas,monospace}
      .alli-simple-err{color:#ff9aa8;font-size:calc(11px * var(--alli-ts,1));min-height:14px;margin-top:6px}
      .alli-lib-btn.browse{flex:0 0 auto;padding:0 12px}
      .alli-browse-path{padding:6px 8px;border-radius:6px;background:#0e1720;border:1px solid #2c3d4a;color:#cfe0ec;font:11px/1.5 Consolas,monospace;word-break:break-all}
      .alli-browse-drives{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
      .alli-browse-chip{height:22px;padding:0 8px;border:1px solid #33495a;border-radius:5px;background:#1b2a36;color:#b9cbd8;font:11px/20px Arial,sans-serif;cursor:pointer}
      .alli-browse-chip:hover{background:#24394a;color:#fff}
      .alli-browse-list{margin-top:8px;max-height:260px;overflow-y:auto;border:1px solid #2c3d4a;border-radius:6px;background:#0e1720;padding:4px}
      .alli-browse-row{padding:5px 8px;border-radius:4px;color:#c8d8e4;font:12px/1.5 Arial,sans-serif;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .alli-browse-row:hover{background:#1d3242;color:#fff}
      .alli-browse-empty{padding:10px 8px;color:#6f8291;font-size:11px}

      .alli-crop-mask{position:fixed;inset:0;z-index:10160;background:rgba(0,0,0,.66);display:flex;align-items:center;justify-content:center}
      .alli-cropdlg{width:min(1000px,95vw);height:min(820px,95vh);box-sizing:border-box;display:flex;flex-direction:column;background:#15202a;color:#dbe8f1;border:1px solid #3a4d5b;border-radius:12px;box-shadow:0 18px 50px rgba(0,0,0,.6);overflow:hidden;font:13px Arial,sans-serif}
      .alli-crop-hd{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid #2c3d4a;font-weight:bold;font-size:14px}
      .alli-crop-bar{flex:0 0 auto;display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:9px 16px;border-bottom:1px solid #243542}
      .alli-crop-ratio{height:26px;padding:0 11px;border:1px solid #33495a;border-radius:6px;background:#1b2a36;color:#b9cbd8;font:12px/24px Arial,sans-serif;cursor:pointer}
      .alli-crop-ratio:hover{background:#24394a;color:#fff}
      .alli-crop-ratio.on{background:#5a4a86;border-color:#7a66ad;color:#fff}
      .alli-crop-reset{height:26px;padding:0 12px;border:1px solid #3a4d5b;border-radius:6px;background:#233444;color:#c8d6e0;font:12px/24px Arial,sans-serif;cursor:pointer}
      .alli-crop-reset:hover{background:#2e4457}
      .alli-crop-stage{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;background:repeating-conic-gradient(#0d151d 0% 25%,#111a23 0% 50%) 50%/18px 18px;padding:12px}
      .alli-crop-frame{position:relative;overflow:hidden;line-height:0;touch-action:none}
      .alli-crop-img{display:block;width:100%;height:100%;object-fit:fill;pointer-events:none;-webkit-user-drag:none;user-select:none}
      .alli-crop-overlay{position:absolute;inset:0;touch-action:none;cursor:crosshair}
      .alli-crop-shade{position:absolute;inset:0;background:rgba(0,0,0,.55);pointer-events:none}
      .alli-crop-selection{position:absolute;box-sizing:border-box;border:1px solid rgba(255,255,255,.92);pointer-events:none;--alli-center-color:#fff}
      .alli-crop-thirds{position:absolute;inset:0;pointer-events:none;background-image:linear-gradient(to right,transparent calc(33.333% - .5px),rgba(255,255,255,.32) calc(33.333% - .5px),rgba(255,255,255,.32) calc(33.333% + .5px),transparent calc(33.333% + .5px),transparent calc(66.666% - .5px),rgba(255,255,255,.32) calc(66.666% - .5px),rgba(255,255,255,.32) calc(66.666% + .5px),transparent calc(66.666% + .5px)),linear-gradient(to bottom,transparent calc(33.333% - .5px),rgba(255,255,255,.32) calc(33.333% - .5px),rgba(255,255,255,.32) calc(33.333% + .5px),transparent calc(33.333% + .5px),transparent calc(66.666% - .5px),rgba(255,255,255,.32) calc(66.666% - .5px),rgba(255,255,255,.32) calc(66.666% + .5px),transparent calc(66.666% + .5px))}
      .alli-crop-center{position:absolute;left:50%;top:50%;width:22px;height:22px;margin:-11px 0 0 -11px;fill:none;stroke:var(--alli-center-color);stroke-width:1.1;opacity:.85;pointer-events:none}
      .alli-crop-center .dot{fill:var(--alli-center-color);stroke:none}
      .alli-crop-handle{position:absolute;width:11px;height:11px;border:1px solid rgba(0,0,0,.55);border-radius:2px;background:#fff;box-shadow:0 0 0 1px rgba(255,255,255,.6)}
      .alli-crop-n{left:50%;top:-6px;margin-left:-6px}
      .alli-crop-s{left:50%;bottom:-6px;margin-left:-6px}
      .alli-crop-e{right:-6px;top:50%;margin-top:-6px}
      .alli-crop-w{left:-6px;top:50%;margin-top:-6px}
      .alli-crop-nw{left:-6px;top:-6px}
      .alli-crop-ne{right:-6px;top:-6px}
      .alli-crop-sw{left:-6px;bottom:-6px}
      .alli-crop-se{right:-6px;bottom:-6px}
      .alli-crop-foot{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:10px 16px;border-top:1px solid #2c3d4a}
      .alli-crop-dim{color:#7fd3a6;font-size:11px;font-variant-numeric:tabular-nums}

      /* ===== 浅色主题（齿轮 → 主题：浅色）===== */
      html.alli-light .alli-lib{background:#f4f8fa;color:#22323f;border-color:#c8d7e1;box-shadow:0 18px 50px rgba(16,38,54,.28)}
      html.alli-light .alli-lib-hd,html.alli-light .alli-lib-foot{border-color:#dde8ef}
      html.alli-light .alli-lib-tool,html.alli-light .alli-lib-tab,html.alli-light .alli-lib-btn,html.alli-light .alli-lib-gbtn{background:#eaf1f6;border-color:#cbdae4;color:#31485a;box-shadow:none}
      html.alli-light .alli-lib-tool:hover,html.alli-light .alli-lib-tab:hover,html.alli-light .alli-lib-btn:hover,html.alli-light .alli-lib-gbtn:hover{background:#dfeaf2;color:#16293a}
      html.alli-light .alli-lib-tab.on,html.alli-light .alli-lib-gbtn.on{background:linear-gradient(180deg,#2a93b3,#1c7896);border-color:#2a93b3;color:#fff;box-shadow:0 4px 12px rgba(42,147,179,.3)}
      html.alli-light .alli-lib-gbtn.on .alli-lib-gcount,html.alli-light .alli-lib-tab.on .alli-lib-count{color:#fff}
      html.alli-light .alli-lib-tab.add{border-style:dashed;border-color:#a9c2d2;background:transparent;color:#4d7b93}
      html.alli-light .alli-lib-third{background:#eaf1f6;border-color:#cbdae4;color:#31485a}
      html.alli-light .alli-lib-third:hover{background:#dfeaf2;color:#16293a}
      html.alli-light .alli-lib-third.on{background:linear-gradient(180deg,#2a93b3,#1c7896);border-color:#2a93b3;color:#fff}
      html.alli-light .alli-lib-subsubs::-webkit-scrollbar-thumb{background:#cfdde7}
      html.alli-light .alli-lib-gicon.text{background:transparent}
      html.alli-light .alli-lib-search{background:#fff;border-color:#cbdae4;color:#22323f}
      html.alli-light .alli-lib-search::placeholder{color:#8aa0b0}
      html.alli-light .alli-lib-searchicon{stroke:#7f96a6}
      html.alli-light .alli-lib-x{color:#7b8fa0}
      html.alli-light .alli-lib-x:hover{background:#dfeaf2;color:#1b2b39}
      html.alli-light .alli-lib-card{background:#fff;border-color:#d3e0e9}
      html.alli-light .alli-lib-card:hover{background:#fbfdfe}
      html.alli-light .alli-lib-card.on{background:var(--at-accent-soft)}
      html.alli-light .alli-lib-empty,html.alli-light .alli-lib-nocat,html.alli-light .alli-lib-info{color:#687f8f}
      html.alli-light .alli-lib-btn.go{background:#1f86a5;border-color:#1f86a5;color:#fff}
      html.alli-light .alli-card-fav{opacity:.4}
      html.alli-light .alli-card-fav.on{opacity:1}
      html.alli-light .alli-lib-gbtn.fav>span:first-child{filter:none}
      html.alli-light .alli-lib-grid{scrollbar-color:#cfdde7 transparent}
      html.alli-light .alli-lib-grid::-webkit-scrollbar-thumb{background:#cfdde7}
      html.alli-light .alli-lib-tabs::-webkit-scrollbar-thumb{background:#cfdde7}
      html.alli-light .alli-dlg{background:#fbfdfe;border-color:#c8d7e1;color:#22323f}
      html.alli-light .alli-dlg-hd{border-color:#e2ebf1}
      html.alli-light .alli-dlg-sub,html.alli-light .alli-dlg-note{color:#6c8090}
      html.alli-light .alli-dlg-note{border-color:#e2ebf1}
      html.alli-light .alli-dlg input,html.alli-light .alli-dlg textarea{background:#fff;border-color:#cbdae4;color:#22323f}
      html.alli-light .alli-dlg-btns button{background:#eaf1f6;border-color:#cbdae4;color:#2c3f4e}
      html.alli-light .alli-dlg-btns button:hover{background:#dfeaf2}
      html.alli-light .alli-dlg-btns .go{background:#1f86a5;border-color:#1f86a5;color:#fff}
      /* 弹窗内部漏配的几条：只换背景不换文字，就会出现「白底近白字」看不见的情况 */
      html.alli-light .alli-dlg-lb{color:#1e3346}
      html.alli-light .alli-dlg-x{color:#6c8090}
      html.alli-light .alli-dlg-x:hover{background:#e4eef5;color:#16293a}
      html.alli-light .alli-dlg-row+.alli-dlg-row{border-color:#e6eef4}
      html.alli-light .alli-sw .track{background:#c6d6e2}
      html.alli-light .alli-sw .track:before{background:#fff;box-shadow:0 1px 2px rgba(16,38,54,.25)}
      html.alli-light .alli-sw input:checked+.track{background:#2f9c72}
      html.alli-light .alli-mp-val{color:#1c7a55}
      html.alli-light .alli-simple-err{color:#b3263b}
      html.alli-light .alli-preview{background:#fbfdfe;border-color:#c8d7e1;color:#22323f}
      html.alli-light .alli-preview-body{background:#eef4f8}
      html.alli-light .alli-set-sec{border-color:#e2ebf1}
      html.alli-light .alli-set-title{color:#1c7896}
      html.alli-light .alli-set-label{color:#5d7382}
      html.alli-light .alli-seg{background:#fff;border-color:#cbdae4}
      html.alli-light .alli-seg button{color:#40586a;border-color:#e2ebf1}
      html.alli-light .alli-seg button:hover{background:#eef4f8;color:#16293a}
      html.alli-light .alli-seg button.on{background:#1f86a5;color:#fff}
      html.alli-light .alli-set-val{color:#687f8f}
      /* 裁剪弹窗（卡片右上「裁剪」打开的那只） */
      html.alli-light .alli-crop-mask{background:rgba(120,145,165,.42)}
      html.alli-light .alli-cropdlg{background:#f4f8fa;color:#22323f;border-color:#c8d7e1;box-shadow:0 18px 50px rgba(16,38,54,.26)}
      html.alli-light .alli-crop-hd{border-color:#dde8ef;color:#16293a}
      html.alli-light .alli-crop-bar{border-color:#dde8ef}
      html.alli-light .alli-crop-ratio,html.alli-light .alli-crop-reset{background:#eaf1f6;border-color:#cbdae4;color:#31485a}
      html.alli-light .alli-crop-ratio:hover,html.alli-light .alli-crop-reset:hover{background:#dfeaf2;color:#16293a}
      html.alli-light .alli-crop-ratio.on{background:linear-gradient(180deg,#7d67ad,#6a559e);border-color:#7d67ad;color:#fff;box-shadow:0 3px 10px rgba(106,85,158,.28)}
      html.alli-light .alli-crop-stage{background:repeating-conic-gradient(#f8fbfd 0% 25%,#e8f0f5 0% 50%) 50%/18px 18px}
      html.alli-light .alli-crop-foot{border-color:#dde8ef}
      html.alli-light .alli-crop-dim{color:#1c7a55}
      html.alli-light .alli-crop-handle{background:#fff;border-color:rgba(22,41,58,.62);box-shadow:0 0 0 1px rgba(255,255,255,.85)}
      html.alli-light .alli-cropbtn{background:rgba(255,255,255,.9);border-color:#b9cbd8;color:#3d5670}
      html.alli-light .alli-cropbtn:hover{background:#fff;border-color:#2f7d5b;color:#2f7d5b}
      html.alli-light .alli-cropbtn.on{background:#2f7d5b;border-color:#2f7d5b;color:#fff}

      /* ===== 动效：弹窗进出 + hover / active 反馈 ===== */
      @keyframes alli-fade{from{opacity:0}to{opacity:1}}
      @keyframes alli-pop{from{opacity:0;transform:translateY(10px) scale(.986)}to{opacity:1;transform:translateY(0) scale(1)}}
      .alli-lib-mask,.alli-crop-mask,.alli-dlg-back{animation:alli-fade .16s ease-out backwards}
      .alli-lib,.alli-cropdlg,.alli-dlg,.alli-preview{animation:alli-pop .19s cubic-bezier(.2,.8,.3,1) backwards}

      .alli-lib-tab,.alli-lib-tool,.alli-lib-btn,.alli-lib-x,.alli-dlg-x,
      .alli-dlg-btns button,.alli-seg button,.alli-browse-chip,.alli-browse-row,.alli-scope-chip,
      .alli-crop-ratio,.alli-crop-reset,.alli-role,.alli-cropbtn,.alli-tbtn,.alli-x,.alli-item,
      .alli-lib-card,.alli-card-pic img{transition:background .15s ease,border-color .15s ease,color .15s ease,transform .16s cubic-bezier(.2,.8,.3,1),box-shadow .18s ease,opacity .15s ease}

      .alli-lib-tab:hover,.alli-lib-tool:hover,.alli-crop-ratio:hover,.alli-crop-reset:hover,
      .alli-browse-chip:hover,.alli-lib-btn:hover,.alli-scope-chip:hover{transform:translateY(-1px)}
      .alli-lib-btn.go:hover,.alli-dlg-btns .go:hover{box-shadow:0 4px 12px rgba(31,134,165,.35)}
      .alli-lib-tab:active,.alli-lib-tool:active,.alli-lib-gbtn:active,.alli-lib-btn:active,
      .alli-dlg-btns button:active,.alli-seg button:active,.alli-browse-chip:active,
      .alli-crop-ratio:active,.alli-crop-reset:active,.alli-role:active,.alli-cropbtn:active,
      .alli-tbtn:active,.alli-lib-x:active{transform:translateY(1px) scale(.97)}
      .alli-lib-x:hover,.alli-dlg-x:hover{transform:rotate(90deg)}

      .alli-lib-card:hover{transform:translateY(-3px);box-shadow:0 10px 24px rgba(0,0,0,.18)}
      .alli-lib-card:active{transform:translateY(-1px) scale(.995)}
      html.alli-light .alli-lib-card:hover{box-shadow:0 8px 20px rgba(24,60,80,.16)}

      .alli-item:not(.alli-target):not(.alli-src):hover{background:#26282c;box-shadow:0 3px 12px rgba(0,0,0,.35)}
      .alli-x:hover{transform:scale(1.12)}

      /* ===== 反制动效禁用 =====
         ComfyUI 前端有一条全局规则（设置 → Appearance → Disable animations 打开时，
         body 上会挂 .disable-animations）：
           .disable-animations *{transition-duration:.001ms!important;animation-duration:.001ms!important}
         它带 !important，会把本插件所有卡片 / 按钮动效一起掐掉——和我们自己的 CSS 无关。
         下面用 body 前缀把优先级抬到 0,1,1（对面是 0,1,0），两处都 !important 时优先级高的赢，
         于是只有本插件这几个类恢复动效，ComfyUI 自己该禁的照样禁。 */
      body .alli-lib-tab,body .alli-lib-tool,body .alli-lib-btn,body .alli-lib-x,
      body .alli-lib-card,body .alli-card-pic img,body .alli-lib-gbtn,
      body .alli-scope-chip,body .alli-dlg-x,body .alli-dlg-btns button,body .alli-seg button,
      body .alli-browse-chip,body .alli-browse-row,body .alli-crop-ratio,body .alli-crop-reset,
      body .alli-role,body .alli-cropbtn,body .alli-tbtn,body .alli-x,body .alli-item,
      body .alli-sw .track,body .alli-sw .track:before{transition-duration:.16s!important}
      body .alli-lib-mask,body .alli-crop-mask,body .alli-dlg-back,
      body .alli-lib,body .alli-cropdlg,body .alli-dlg,body .alli-preview{animation-duration:.19s!important}

      /* ===== 主题覆盖层：明暗 2 套令牌统一接管，优先级高于上面所有旧硬编码 =====
         （桌面软件同款：渐变面板 + 玻璃按钮 + 胶囊圆角 + 强调色选中态） */
      /* 遮罩 */
      html[data-alli-theme] .alli-lib-mask,html[data-alli-theme] .alli-crop-mask,
      html[data-alli-theme] .alli-dlg-back{background:var(--at-overlay)}
      /* 主面板 */
      html[data-alli-theme] .alli-lib,html[data-alli-theme] .alli-cropdlg,
      html[data-alli-theme] .alli-preview,html[data-alli-theme] .alli-dlg{
        background:var(--at-bg);color:var(--at-text);border-color:var(--at-border);
        box-shadow:0 18px 50px var(--at-shadow),0 0 0 1px var(--at-border-2) inset}
      /* 分隔线 */
      html[data-alli-theme] .alli-lib-hd,html[data-alli-theme] .alli-lib-foot,
      html[data-alli-theme] .alli-crop-hd,html[data-alli-theme] .alli-crop-bar,
      html[data-alli-theme] .alli-crop-foot,html[data-alli-theme] .alli-dlg-hd,
      html[data-alli-theme] .alli-dlg-row+.alli-dlg-row,html[data-alli-theme] .alli-set-sec,
      html[data-alli-theme] .alli-dlg-note{border-color:var(--at-border-2)}
      /* 常规按钮/标签：玻璃底 + 胶囊 */
      html[data-alli-theme] .alli-lib-tool,html[data-alli-theme] .alli-lib-tab,
      html[data-alli-theme] .alli-lib-btn,html[data-alli-theme] .alli-lib-gbtn,
      html[data-alli-theme] .alli-scope-chip,html[data-alli-theme] .alli-lib-third,
      html[data-alli-theme] .alli-crop-ratio,html[data-alli-theme] .alli-crop-reset,
      html[data-alli-theme] .alli-browse-chip,html[data-alli-theme] .alli-dlg-btns button,
      html[data-alli-theme] .alli-seg button{
        background:var(--at-glass);border-color:var(--at-border);color:var(--at-text);box-shadow:none}
      html[data-alli-theme] .alli-lib-tool:hover,html[data-alli-theme] .alli-lib-tab:hover,
      html[data-alli-theme] .alli-lib-btn:hover,html[data-alli-theme] .alli-lib-gbtn:hover,
      html[data-alli-theme] .alli-scope-chip:hover,html[data-alli-theme] .alli-lib-third:hover,
      html[data-alli-theme] .alli-crop-ratio:hover,html[data-alli-theme] .alli-crop-reset:hover,
      html[data-alli-theme] .alli-browse-chip:hover,html[data-alli-theme] .alli-dlg-btns button:hover,
      html[data-alli-theme] .alli-seg button:hover{background:var(--at-glass-hover);color:var(--at-text)}
      /* 选中态 / 主按钮：强调色填充 */
      html[data-alli-theme] .alli-lib-tab.on,html[data-alli-theme] .alli-lib-gbtn.on,
      html[data-alli-theme] .alli-lib-third.on,html[data-alli-theme] .alli-scope-chip.on,
      html[data-alli-theme] .alli-crop-ratio.on,html[data-alli-theme] .alli-seg button.on,
      html[data-alli-theme] .alli-lib-btn.go,html[data-alli-theme] .alli-dlg-btns .go{
        background:var(--at-accent);border-color:var(--at-accent);color:var(--at-accent-ink);
        box-shadow:0 4px 14px var(--at-accent-glow)}
      html[data-alli-theme] .alli-lib-btn.go:hover,html[data-alli-theme] .alli-dlg-btns .go:hover{
        background:var(--at-accent);border-color:var(--at-accent);filter:brightness(1.08)}
      html[data-alli-theme] .alli-lib-btn.go:disabled{
        background:var(--at-glass);border-color:var(--at-border-2);color:var(--at-dim);box-shadow:none;filter:none}
      html[data-alli-theme] .alli-lib-tab.on .alli-lib-count,
      html[data-alli-theme] .alli-lib-gbtn.on .alli-lib-gcount{color:var(--at-accent-ink)}
      /* 虚线新增标签 */
      html[data-alli-theme] .alli-lib-tab.add{border-style:dashed;border-color:var(--at-border);background:transparent;color:var(--at-dim)}
      /* 搜索框 */
      html[data-alli-theme] .alli-lib-search{background:var(--at-input);border-color:var(--at-border);color:var(--at-text)}
      html[data-alli-theme] .alli-lib-search::placeholder{color:var(--at-dim)}
      html[data-alli-theme] .alli-lib-search:focus{border-color:var(--at-accent);box-shadow:0 0 0 2px var(--at-focus)}
      html[data-alli-theme] .alli-lib-searchicon{stroke:var(--at-dim)}
      /* 卡片：对齐 Goohai —— 白底卡 + 浅灰信息条独立于主题，不被主题染深 */
      html[data-alli-theme] .alli-lib-card{background:#fff;border-color:#dce2eb}
      html[data-alli-theme] .alli-lib-card:hover{background:#fff}
      html[data-alli-theme] .alli-lib-card.on{background:#fff;box-shadow:none}
      html[data-alli-theme] .alli-card-pic img{opacity:1!important;transform:none!important}
      html[data-alli-theme] .alli-lib-card.on .alli-card-info{background:var(--at-accent-soft)}
      /* 文字层级 */
      html[data-alli-theme] .alli-lib-empty,html[data-alli-theme] .alli-lib-nocat,
      html[data-alli-theme] .alli-lib-info,html[data-alli-theme] .alli-dlg-sub,
      html[data-alli-theme] .alli-set-label,html[data-alli-theme] .alli-set-val,
      html[data-alli-theme] .alli-dlg-x,html[data-alli-theme] .alli-lib-x,
      html[data-alli-theme] .alli-simple-err:empty{color:var(--at-dim)}
      html[data-alli-theme] .alli-lib-x:hover{background:var(--at-glass-hover);color:var(--at-text)}
      html[data-alli-theme] .alli-simple-err{color:var(--at-danger)}
      html[data-alli-theme] .alli-set-title,html[data-alli-theme] .alli-drawer-ptitle,
      html[data-alli-theme] .alli-mp-val,html[data-alli-theme] .alli-crop-dim{color:var(--at-accent)}
      /* 抽屉 / 槽位 / 开关 */
      html[data-alli-theme] .alli-drawer{background:var(--at-glass);border-color:var(--at-border-2)}
      html[data-alli-theme] .alli-slot{background:var(--at-input);border-color:var(--at-border);color:var(--at-dim)}
      html[data-alli-theme] .alli-slot.on{border-color:var(--at-accent);background:var(--at-bg)}
      html[data-alli-theme] .alli-slot-x:hover{background:var(--at-danger)}
      html[data-alli-theme] .alli-slot-label,html[data-alli-theme] .alli-switch,
      html[data-alli-theme] .alli-drawer-ptext.empty{color:var(--at-dim)}
      html[data-alli-theme] .alli-drawer-ptext{color:var(--at-text)}
      html[data-alli-theme] .alli-switch-track{background:var(--at-track)}
      html[data-alli-theme] .alli-switch-track:before{background:var(--at-text)}
      html[data-alli-theme] .alli-switch input:checked+.alli-switch-track{background:var(--at-accent)}
      html[data-alli-theme] .alli-switch input:checked+.alli-switch-track:before{background:var(--at-accent-ink)}
      /* 设置分组 / 分段 / 滑条 */
      html[data-alli-theme] .alli-seg{background:var(--at-input);border-color:var(--at-border)}
      html[data-alli-theme] .alli-range,html[data-alli-theme] .alli-dlg input[type=range]{accent-color:var(--at-accent)}
      /* 浏览路径 / 列表 */
      html[data-alli-theme] .alli-browse-path,html[data-alli-theme] .alli-browse-list{background:var(--at-input);border-color:var(--at-border-2);color:var(--at-text)}
      html[data-alli-theme] .alli-browse-row{color:var(--at-text)}
      html[data-alli-theme] .alli-browse-row:hover{background:var(--at-glass-hover);color:var(--at-text)}
      html[data-alli-theme] .alli-browse-empty{color:var(--at-dim)}
      /* 预览 / 裁剪舞台 */
      html[data-alli-theme] .alli-preview-body{background:var(--at-input)}
      html[data-alli-theme] .alli-crop-stage{background:repeating-conic-gradient(var(--at-checker-a) 0% 25%,var(--at-checker-b) 0% 50%) 50%/18px 18px}
      /* 明暗切换器（刷新按钮左边）：单个图标按钮原地切换，太阳=浅色 / 月亮=暗色。无底色、无圆框、无强调色 */
      html[data-alli-theme] .alli-theme-toggle{flex:0 0 auto;width:26px;height:26px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--at-text);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;transition:background .14s,transform .14s}
      html[data-alli-theme] .alli-theme-toggle:hover{background:var(--at-glass-hover);transform:scale(1.08)}
      html[data-alli-theme] .alli-theme-ico{width:16px;height:16px;display:block;background:currentColor;-webkit-mask:var(--alli-icon) center/contain no-repeat;mask:var(--alli-icon) center/contain no-repeat}
      html[data-alli-theme] .alli-tool-sep{flex:0 0 auto;width:1px;height:16px;background:var(--at-border-2);margin:0 2px}
      /* ===== 经典浅色主题：照搬 GHIL 浅色界面 —— 顶部信息栏浅灰绿 + 内容区浅白 =====
         只作用于 chrome-light；其余主题这两个变量为 transparent，全部沿用原渐变，不受影响 */
      html[data-alli-theme="chrome-light"] .alli-lib{background:var(--at-content-bg)}
      html[data-alli-theme="chrome-light"] .alli-lib-hd{background:var(--at-hd-bg)}
      html[data-alli-theme="chrome-light"] .alli-lib-galleries,
      html[data-alli-theme="chrome-light"] .alli-lib-tabs,
      html[data-alli-theme="chrome-light"] .alli-lib-subsubs,
      html[data-alli-theme="chrome-light"] .alli-lib-grid,
      html[data-alli-theme="chrome-light"] .alli-drawer,
      html[data-alli-theme="chrome-light"] .alli-lib-foot{background:var(--at-content-bg)}
      /* 抽屉折叠：滚轮浏览素材时收起，点「使用」或把手再展开 */
      .alli-drawer{max-height:210px;transition:max-height .18s ease,padding .18s ease,opacity .14s ease,border-color .18s ease}
      .alli-drawer.folded{max-height:0;padding-top:0;padding-bottom:0;border-top-color:transparent;opacity:0;overflow:hidden;pointer-events:none}
      .alli-drawer-handle{flex:0 0 auto;display:none;align-items:center;justify-content:center;gap:6px;height:0;padding:0;border-top:1px solid transparent;background:transparent;color:var(--at-dim,#8fa4b4);font-size:calc(11px * var(--alli-ts,1));cursor:pointer;user-select:none;overflow:hidden;transition:height .18s ease,padding .18s ease,opacity .14s ease,border-color .18s ease;opacity:0}
      .alli-drawer-handle.show{display:flex;height:26px;padding:0 16px;border-top-color:var(--at-border-2,#2c3d4a);background:var(--at-glass,rgba(255,255,255,.04));opacity:1}
      .alli-drawer-handle:hover{color:var(--at-accent,#8ab4f8)}
      .alli-drawer-handle .alli-dh-arrow{font-size:9px;line-height:1;transition:transform .18s ease}
      .alli-drawer-handle.collapsed .alli-dh-arrow{transform:rotate(180deg)}

      /* 拖拽改分类：卡片拖动中半透明；二级 TAB / 三级标签作为投放目标时显示虚线框 */
      html[data-alli-theme] .alli-lib-card[draggable="true"]{cursor:grab}
      html[data-alli-theme] .alli-lib-card.dragging{opacity:.4;cursor:grabbing}
      html[data-alli-theme] .alli-lib-third.drop-target,
      html[data-alli-theme] .alli-lib-tab.drop-target,
      html.alli-light .alli-lib-third.drop-target,
      html.alli-light .alli-lib-tab.drop-target{
        background:var(--at-glass-hover,rgba(255,138,154,.14))!important;
        color:var(--at-text,#23334c)!important;
        border:2px dashed var(--at-accent,#ff8a9a)!important;
        border-radius:12px!important;
        transform:scale(1.06);
      }
    `;
    document.head.appendChild(style);
}

// =============================================================================
// 节点面板
// =============================================================================
function createPanel(node) {
    if (typeof node.addDOMWidget !== "function") return false;
    injectStyle();

    const stateWidget = widget(node, STATE_KEY);
    hideWidget(stateWidget);
    dropWidgetSocket(node, STATE_KEY);
    node.properties = node.properties || {};

    let images = [];                 // [{ name, w, h }]
    let resizeCfg = normalizeResize(null);
    let restoring = false;
    let suppressClickUntil = 0;

    const root = make("div"); root.className = "alli-root";
    const list = make("div"); list.className = "alli-list";
    const toolbar = make("div"); toolbar.className = "alli-toolbar";
    const uploadBtn = make("button", {}, "上传图像"); uploadBtn.className = "alli-tbtn up";
    uploadBtn.title = "从电脑选图追加一张（也可以直接拖入 / 粘贴），最多 9 张";
    uploadBtn.onpointerdown = e => e.stopPropagation();
    const libBtn = make("button", {}, "换形象"); libBtn.className = "alli-tbtn lib";
    libBtn.title = "换形象：从素材库选人像 / 服装 / 姿势 / 发型，按图号同步到节点并生成提示词";
    libBtn.onpointerdown = e => e.stopPropagation();
    const resizeBtn = make("button", {}, "缩放图像"); resizeBtn.className = "alli-tbtn rz";
    resizeBtn.title = "按总像素等比缩放参考图（内存缩放，不改原图）";
    resizeBtn.onpointerdown = e => e.stopPropagation();
    toolbar.append(uploadBtn, libBtn, resizeBtn);
    root.append(toolbar, list);

    const updateResizeBtn = () => {
        resizeBtn.classList.toggle("on", resizeCfg.enabled);
        resizeBtn.textContent = resizeCfg.enabled
            ? `${Number(resizeCfg.megapixels).toFixed(1)}MP`
            : "缩放图像";
        resizeBtn.title = resizeCfg.enabled
            ? `已开启：总像素缩放到 ${Number(resizeCfg.megapixels).toFixed(1)}MP（点击调整）`
            : "按总像素等比缩放参考图（内存缩放，不改原图）";
    };
    // 只有「人像 + 至少一个搭配」才算换形象完成；单张图（哪怕来自人像库）不亮按钮、不显示标签
    const hasLookPair = () => images.some(entry => {
        const slot = slotOfRole(entry.role || "");
        return !!slot && slot !== "face";
    });
    // 换形象是「按槽位覆盖」，不再是追加，所以满 9 张也照常能开
    const updateLibBtn = () => {
        libBtn.disabled = false;
        libBtn.classList.toggle("on", hasLookPair());
    };
    libBtn.onclick = () => openLookPicker({ node, images, persist, render });
    resizeBtn.onclick = () => showResizeDialog(resizeCfg, cfg => {
        resizeCfg = normalizeResize(cfg);
        updateResizeBtn();
        persist();
    });

    const domWidget = node.addDOMWidget("alili_load_panel", "alili_load_panel", root, { serialize: false, hideOnZoom: false });
    domWidget.options = domWidget.options || {};
    domWidget.options.serialize = false;
    domWidget.options.getMinHeight = () => MIN_PANEL_HEIGHT;
    domWidget.options.getHeight = () => "100%";

    const serialize = () => JSON.stringify({
        images: images.map((i, index) => ({
            name: i.name,
            w: i.w,
            h: i.h,
            role: i.role || "",
            crop: i.crop || null,
        })),
        resize: resizeCfg,
    });
    const notify = () => { node.setDirtyCanvas?.(true, true); app.graph?.setDirtyCanvas?.(true, true); };
    const persist = () => {
        if (restoring) return;
        const val = serialize();
        node.properties[STATE_KEY] = val;
        if (stateWidget) stateWidget.value = val;
        notify();
    };

    // 对外接口：工作台读取（LLM 推理、提示词标签缩略图、自适应比例）
    // role 统一带出去（第 1 张没标角色时按「人像」算），工作台靠它反推槽位
    node._aliliGetImages = () => images.map((i, index) => {
        const rect = i.crop?.rect;
        const w = rect ? Math.round((Number(i.w) || 0) * Number(rect[2])) : (i.w || 0);
        const h = rect ? Math.round((Number(i.h) || 0) * Number(rect[3])) : (i.h || 0);
        // crop 随图带出（带 image 绑定：换图后旧框自动失效）。
        // 后端 API 提示词优化据此裁出与节点卡片一致的局部图；没裁的图 crop 为 null，原样透传。
        const crop = i.crop && Array.isArray(i.crop.rect) ? { ...i.crop, image: i.name } : null;
        return { name: i.name, w, h, role: i.role || (index === 0 ? "人像" : ""), crop };
    });

    function reorder(from, to) {
        if (from === to || from < 0 || to < 0 || from >= images.length || to >= images.length) return;
        const [moved] = images.splice(from, 1);
        images.splice(to, 0, moved);
        persist(); render();
    }

    // 长按 350ms 后拖到另一张上松手 = 调换顺序
    function installReorder(item, index) {
        item.onpointerdown = event => {
            if (event.target.closest("button") || event.button !== 0 || !event.isPrimary) return;
            const originX = event.clientX, originY = event.clientY;
            let active = false, target = null;
            let timer = window.setTimeout(() => {
                if (!item.isConnected) return;
                active = true; suppressClickUntil = Date.now() + 600;
                item.classList.add("alli-src");
                try { item.setPointerCapture(event.pointerId); } catch {}
            }, 350);
            const setTarget = next => {
                if (target === next) return;
                target?.classList.remove("alli-target"); target = next; target?.classList.add("alli-target");
            };
            const move = e => {
                if (!active) {
                    if (Math.hypot(e.clientX - originX, e.clientY - originY) > 8) { clearTimeout(timer); timer = 0; suppressClickUntil = Date.now() + 250; }
                    return;
                }
                e.preventDefault();
                const cand = document.elementFromPoint(e.clientX, e.clientY)?.closest?.(".alli-item");
                setTarget(cand && list.contains(cand) && cand !== item ? cand : null);
            };
            const finish = e => {
                if (timer) clearTimeout(timer);
                window.removeEventListener("pointermove", move, true);
                window.removeEventListener("pointerup", finish, true);
                window.removeEventListener("pointercancel", finish, true);
                item.classList.remove("alli-src"); target?.classList.remove("alli-target");
                try { item.releasePointerCapture(event.pointerId); } catch {}
                if (!active) return;
                e.preventDefault(); suppressClickUntil = Date.now() + 600;
                if (target) reorder(index, Number(target.dataset.index));
            };
            window.addEventListener("pointermove", move, true);
            window.addEventListener("pointerup", finish, true);
            window.addEventListener("pointercancel", finish, true);
        };
    }

    // 顺着输出口找到下游的工作台，往它的提示词插入 <imageN>
    function insertTagToWorkbench(ordinal) {
        const graph = node.graph || app.graph;
        for (const id of node.outputs?.[0]?.links || []) {
            const link = graph?.getLink ? graph.getLink(id)
                : (graph?.links instanceof Map ? graph.links.get(id) : graph?.links?.[id]);
            const target = link ? graph.getNodeById(link.target_id) : null;
            if (target && (target.comfyClass === WORKBENCH_NODE || target.type === WORKBENCH_NODE) && target._aliliInsertTag) {
                return !!target._aliliInsertTag(ordinal);
            }
        }
        return false;
    }

    function itemEl(entry, index) {
        const item = make("div"); item.className = "alli-item"; item.dataset.index = String(index);
        // 有裁剪时显示裁剪后的实际像素（跟后端切片结果一致），鼠标悬停能看到原图尺寸
        const cropRect = entry.crop?.rect;
        const shot = make("div"); shot.className = "alli-shot";
        const img = make("img"); img.src = fileUrl(entry.name); img.draggable = false;
        // 没有分辨率（旧数据 / 刚恢复）时，图片载入后补上
        img.onload = () => {
            if (!entry.w || !entry.h) {
                entry.w = img.naturalWidth; entry.h = img.naturalHeight;
                persist(); render();
            }
        };
        shot.appendChild(img);
        // 有裁剪：缩略图直接显示「裁剪后」的那一块（取景=裁剪结果），不再整图 + 压暗
        if (cropRect && cropRect.length === 4) {
            const cX = Number(cropRect[0]), cY = Number(cropRect[1]);
            const cW = Number(cropRect[2]), cH = Number(cropRect[3]);
            if (cW > 0 && cH > 0) {
                // 裁剪结果的宽高比（原图尺寸未知时按 1:1 估）
                const ar = (entry.w && entry.h) ? (cW * entry.w) / (cH * entry.h) : cW / cH;
                if (ar >= 1) { shot.style.width = "100%"; shot.style.height = `${100 / ar}%`; }
                else { shot.style.height = "100%"; shot.style.width = `${ar * 100}%`; }
                // 原图放大 1/cw × 1/ch 并平移，框里正好只剩裁剪区
                img.style.position = "absolute";
                img.style.width = `${100 / cW}%`;
                img.style.height = `${100 / cH}%`;
                img.style.left = `${-(cX / cW) * 100}%`;
                img.style.top = `${-(cY / cH) * 100}%`;
            }
        }
        item.appendChild(shot);

        const no = make("div", {}, String(index + 1)); no.className = "alli-no";
        const shownW = cropRect ? Math.round((entry.w || 0) * Number(cropRect[2])) : (entry.w || 0);
        const shownH = cropRect ? Math.round((entry.h || 0) * Number(cropRect[3])) : (entry.h || 0);
        const res = make("div", {}, shownW && shownH ? `${shownW} × ${shownH}` : "…"); res.className = "alli-res";
        if (cropRect && entry.w && entry.h) {
            res.title = `裁剪后 ${shownW} × ${shownH}（原图 ${entry.w} × ${entry.h}）`;
            res.style.color = "#7fd3a6";
        }
        item.append(no, res);

        // 角色按钮（左上角）：只有「人像 + 搭配」这种完整换形象才显示；单张图和外部照片都不显示
        const role = hasLookPair() ? (entry.role || "") : "";
        if (role) {
            const roleBtn = make("button", {}, role);
            roleBtn.className = "alli-role on";
            roleBtn.title = `换形象：打开素材抽屉（这一张现在是 ${role}）`;
            roleBtn.onpointerdown = e => e.stopPropagation();
            roleBtn.onclick = e => {
                e.stopPropagation();
                openLookPicker({ node, images, persist, render, focusSlot: slotOfRole(role) });
            };
            item.appendChild(roleBtn);
        }

        // 裁剪按钮（右上角，跟左边角色按钮同款胶囊）：只影响节点输入，不改原图
        const cropBtn = make("button", {}, "裁剪");
        cropBtn.className = "alli-cropbtn" + (entry.crop ? " on" : "");
        cropBtn.title = entry.crop ? "已裁剪，点击调整或清除" : "裁剪（只影响节点输入，不改原图）";
        cropBtn.onpointerdown = e => e.stopPropagation();
        cropBtn.onclick = e => {
            e.stopPropagation();
            openCropDialog(entry, result => {
                entry.crop = result;
                persist();
                render();
                copyToast(result ? "裁剪已应用（原图未改）" : "已清除裁剪", false);
            });
        };
        item.appendChild(cropBtn);

        item.title = `点击插入 <image${index + 1}> 到工作台提示词`;
        item.onclick = () => {
            if (Date.now() < suppressClickUntil) return;
            const ok = insertTagToWorkbench(index + 1);
            item.classList.add(ok ? "alli-ok" : "alli-no-target");
            setTimeout(() => item.classList.remove("alli-ok", "alli-no-target"), 260);
        };

        const x = make("button", {}, "×"); x.className = "alli-x"; x.title = "移除";
        x.onclick = e => {
            e.stopPropagation();
            if (Date.now() < suppressClickUntil) return;
            images.splice(index, 1);
            persist(); render();
        };
        item.appendChild(x);

        bindCopy(item, entry.name);
        installReorder(item, index);
        return item;
    }

    function render() {
        list.replaceChildren();
        images.forEach((entry, i) => list.appendChild(itemEl(entry, i)));
        if (!images.length) {
            const hint = make("div"); hint.className = "alli-hint";
            hint.append(make("span", {}, "点上方「上传图像」，或把图片拖进来 / 粘贴"), make("span", { fontSize: "10px" }, "最多 9 张 · png / jpg / webp / bmp"));
            list.appendChild(hint);
        }
        updateLibBtn();
        notify();
    }

    function chooseFiles() {
        const input = document.createElement("input");
        input.type = "file"; input.multiple = true; input.accept = "image/*";
        input.onchange = () => acceptFiles(input.files);
        input.click();
    }

    async function acceptFiles(files) {
        for (const file of files || []) {
            if (!isImageFile(file)) continue;
            if (images.length >= MAX_IMAGES) break;
            try {
                const name = await uploadFile(file);
                const size = await probeSize(name);
                images.push({
                    name,
                    w: size.w,
                    h: size.h,
                    role: "",
                    crop: null,
                });
            } catch (err) { console.error("[Alili]", err); }
        }
        persist(); render();
    }

    // 粘贴 / 拖入：只处理鼠标在本节点上的情况，并拦截 ComfyUI 自带的「粘贴出 LoadImage 节点」
    let hovered = false;
    root.addEventListener("pointerenter", () => { hovered = true; });
    root.addEventListener("pointerleave", () => { hovered = false; });
    const onPaste = e => {
        const path = e.composedPath?.() || [];
        if (!(hovered || path.includes(root))) return;
        const files = [...(e.clipboardData?.items || [])].filter(i => i.kind === "file").map(i => i.getAsFile()).filter(f => f && isImageFile(f));
        if (!files.length) return;
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
        acceptFiles(files);
    };
    const onDrag = e => {
        if (!e.target?.closest || !root.contains(e.target)) return;
        e.preventDefault(); e.stopImmediatePropagation();
        if (e.type === "drop") acceptFiles(e.dataTransfer.files);
    };
    window.addEventListener("paste", onPaste, true);
    for (const t of ["dragenter", "dragover", "drop"]) window.addEventListener(t, onDrag, true);

    uploadBtn.onclick = () => chooseFiles();

    // 恢复（新建 / 载入工作流）
    async function restore() {
        let st = {};
        try { st = JSON.parse(stateWidget?.value || node.properties?.[STATE_KEY] || "{}") || {}; } catch {}
        restoring = true;
        images = (Array.isArray(st.images) ? st.images : [])
            .filter(i => i && typeof i.name === "string" && i.name)
            .slice(0, MAX_IMAGES)
            .map((i, index) => ({
                name: i.name,
                w: Number(i.w) || 0,
                h: Number(i.h) || 0,
                role: typeof i.role === "string" ? i.role : "",
                crop: i.crop && typeof i.crop === "object" && Array.isArray(i.crop.rect) ? i.crop : null,
            }));
        resizeCfg = normalizeResize(st.resize);
        updateResizeBtn();
        render();
        let probed = false;
        for (const entry of images) {
            if (!entry.w || !entry.h) { Object.assign(entry, await probeSize(entry.name)); probed = true; }
        }
        restoring = false;
        if (probed) persist();
        render();
    }

    for (const hook of ["onConfigure", "onGraphConfigured"]) {
        const old = node[hook];
        node[hook] = function(...args) {
            const res = old?.apply(this, args);
            hideWidget(widget(node, STATE_KEY));
            dropWidgetSocket(node, STATE_KEY);      // 载入旧工作流时可能又带回圆点
            requestAnimationFrame(restore);
            return res;
        };
    }
    const oldRemoved = node.onRemoved;
    node.onRemoved = function(...args) {
        window.removeEventListener("paste", onPaste, true);
        for (const t of ["dragenter", "dragover", "drop"]) window.removeEventListener(t, onDrag, true);
        closeMenu();
        closeResize();
        closeLibrary();
        closeCropDialog?.();
        closeSimpleDialog?.();
        closeSettings?.();
        closeBrowse?.();
        return oldRemoved?.apply(this, args);
    };

    // 列表能滚动时，滚轮优先滚列表，不缩放画布
    list.addEventListener("wheel", e => {
        const atTop = list.scrollTop <= 0, atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 1;
        if (list.scrollHeight > list.clientHeight && ((e.deltaY < 0 && !atTop) || (e.deltaY > 0 && !atBottom))) e.stopPropagation();
    }, { capture: true, passive: true });

    updateResizeBtn();
    render();
    requestAnimationFrame(restore);
    return true;
}

app.registerExtension({
    name: "Alili.LoadImage",
    async setup() {
        // ALILI_IMAGES 的接口 / 连线颜色：和原生 IMAGE 同为蓝色（类型仍是独立的，不会误接到原生 IMAGE 口）
        for (const map of [globalThis.LGraphCanvas?.link_type_colors, app.canvas?.default_connection_color_byType]) {
            if (map) map.ALILI_IMAGES = IMAGE_BLUE;
        }
    },
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE) return;
        nodeType.slot_start_y = -29;
        const previous = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function() {
            const res = previous?.apply(this, arguments);
            this.size = [...DEFAULT_SIZE];
            const out = this.outputs?.[0];
            if (out) { out.color_on = IMAGE_BLUE; out.color_off = IMAGE_BLUE; }
            if (!this._aliliLoadReady && createPanel(this)) this._aliliLoadReady = true;
            return res;
        };
    },
});
