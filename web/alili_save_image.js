import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

// =============================================================================
// Alili 保存图像节点 · 前端
//   - 顶部一行：左侧「共 X 张」纯文字，右侧直接显示保存路径（双击原地编辑，不弹窗）
//   - 画廊：单图大图 / 多图网格，每张底部显示分辨率（纯文字，无胶囊背景）
//   - 右键任意图片 → 「复制图像文件」（后端把本地文件放进系统剪贴板）
//   - 没有自动保存开关、没有手动保存按钮、没有路径前缀弹窗
// =============================================================================

const NODE = "AliliSaveImage";
const UI_IMAGES = "alili_images";
const PROP_KEY = "alili_gallery";

// ---- 小工具 ----
function make(tag, css = {}, text = "") {
    const el = document.createElement(tag);
    Object.assign(el.style, css);
    if (text) el.textContent = text;
    return el;
}
function widget(node, name) {
    return node.widgets?.find(w => w.name === name);
}

function viewUrl(item) {
    const params = new URLSearchParams({ filename: item.filename, type: item.type, subfolder: item.subfolder || "" });
    const path = `/view?${params.toString()}`;
    return typeof api.apiURL === "function" ? api.apiURL(path) : path;
}

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
        document.removeEventListener("pointerdown", dismissHandler);
        dismissHandler = null;
    }
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
    let el = document.getElementById("alili-save-copy-toast");
    if (!el) {
        el = make("div", {
            position: "fixed", right: "18px", bottom: "20px", zIndex: "10200",
            maxWidth: "min(420px, calc(100vw - 40px))", padding: "9px 14px",
            borderRadius: "7px", font: "12px/1.5 Arial, sans-serif",
            boxShadow: "0 8px 26px rgba(0,0,0,.45)", pointerEvents: "none",
            wordBreak: "break-all", display: "none",
        });
        el.id = "alili-save-copy-toast";
        document.body.appendChild(el);
    }
    el.textContent = message;
    el.style.display = "block";
    el.style.background = failed ? "#5a2730" : "#1d3c33";
    el.style.color = failed ? "#ffd9de" : "#cdf3e0";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.style.display = "none"; }, 2400);
}
function showCopyMenu(x, y, item) {
    closeMenu();
    const menu = make("div", {
        position: "fixed", left: `${x}px`, top: `${y}px`, zIndex: "10100",
        minWidth: "130px", padding: "4px", background: "#17222c", color: "#dbe8f1",
        border: "1px solid #3a4d5b", borderRadius: "6px", boxShadow: "0 8px 24px rgba(0,0,0,.45)",
        font: "12px Arial, sans-serif",
    });
    // 关键：菜单自身的 pointerdown 不能冒泡到 document，否则外部关闭监听会提前移除菜单，
    // 导致后面的 click 根本派发不到菜单项（表现就是「点了没反应」）
    menu.addEventListener("pointerdown", e => e.stopPropagation());
    menu.addEventListener("contextmenu", e => e.preventDefault());
    const action = make("div", { padding: "6px 10px", cursor: "pointer", borderRadius: "4px" }, "复制图像文件");
    action.title = "把本地文件放进系统剪贴板，可在任意程序 Ctrl+V 粘贴";
    action.onmouseenter = () => { action.style.background = "#274252"; };
    action.onmouseleave = () => { action.style.background = "transparent"; };
    action.onclick = async e => {
        e.stopPropagation();
        closeMenu();
        try {
            const data = await copyFileToClipboard({
                filename: item.filename, subfolder: item.subfolder || "", type: item.type || "output",
            });
            copyToast(`已复制：${data.names?.join("、") || item.filename}（可 Ctrl+V 粘贴为文件）`, false);
        } catch (err) {
            console.warn("[Alili] 复制文件失败：", err);
            copyToast(`复制失败：${err.message}`, true);
        }
    };
    menu.appendChild(action);
    document.body.appendChild(menu);
    openMenu = menu;
    dismissHandler = () => closeMenu();
    setTimeout(() => {
        if (dismissHandler && openMenu === menu) document.addEventListener("pointerdown", dismissHandler);
    }, 0);
}
function bindCopy(el, item) {
    el.addEventListener("contextmenu", e => {
        e.preventDefault();
        e.stopPropagation();
        showCopyMenu(e.clientX, e.clientY, item);
    });
}

function injectStyle() {
    if (document.getElementById("alili-save-image-style")) return;
    const style = document.createElement("style");
    style.id = "alili-save-image-style";
    style.textContent = `
      .als-root { width: 100%; height: 100%; box-sizing: border-box; color: #d7e3ef; font: 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
        display: flex; flex-direction: column; padding: 0; user-select: none; }
      .als-head { flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 8px;
        padding: 2px 4px 6px; font-size: 11px; color: #8ca0b3; }
      .als-count { white-space: nowrap; }
      .als-path { flex: 1; min-width: 0; text-align: right; box-sizing: border-box;
        background: transparent; border: 0; outline: none; color: #cbd8e0; font: 11px Arial, sans-serif;
        padding: 2px 4px; border-radius: 3px; cursor: default; }
      .als-path:focus { background: #1d2731; outline: 1px solid #4c8fa0; cursor: text; }
      .als-gallery { flex: 1; min-height: 0; overflow-y: auto; border: none !important; border-radius: 0;
        background: transparent !important; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(84px, 1fr));
        gap: 6px; align-content: start; }
      .als-gallery.single { display: flex; flex-direction: column; gap: 0; overflow: hidden; align-content: stretch; }
      .als-empty { grid-column: 1 / -1; text-align: center; color: #536473; padding: 26px 8px; font-size: 11px; line-height: 1.7; }
      .als-card { position: relative; aspect-ratio: 1; border: 1px solid #30485c; border-radius: 6px; overflow: hidden;
        background: #071018; }
      .als-card img { width: 100%; height: 100%; object-fit: cover; display: block; }
      .als-idx { position: absolute; left: 3px; top: 3px; min-width: 16px; padding: 0 4px; text-align: center; font-size: 10px;
        line-height: 16px; border-radius: 3px; background: rgba(10,20,30,.72); color: #fff; font-weight: bold; }
      .als-res { position: absolute; left: 0; right: 0; bottom: 0; text-align: center; pointer-events: none;
        font: 10px/16px Arial, sans-serif; color: #fff; text-shadow: 0 1px 3px rgba(0,0,0,.95), 0 0 6px rgba(0,0,0,.8); }
    `;
    document.head.appendChild(style);
}

function addResolution(card, item) {
    if (!item || !item.w || !item.h) return;
    const r = make("div", {}, `${item.w} × ${item.h}`);
    r.className = "als-res";
    card.appendChild(r);
}

// =============================================================================
// 单张出图：大图视图
// =============================================================================

function buildInlineView(item) {
    const frame = make("div", { display: "flex", flexDirection: "column", flex: "1", minHeight: "0", width: "100%" });
    const holder = make("div", {
        flex: "1", minHeight: "0", width: "100%", height: "100%",
        display: "flex", alignItems: "center", justifyContent: "center", padding: "0"
    });

    const stage = make("div", { position: "relative", overflow: "hidden", display: "none", background: "#071018" });
    stage.className = "als-card";
    stage.style.aspectRatio = "auto";
    holder.appendChild(stage);
    frame.append(holder);

    let nw = 0, nh = 0;
    const layout = () => {
        if (!nw) return;
        const cw = holder.clientWidth, ch = holder.clientHeight;
        if (!cw || !ch) return;
        const k = Math.min(cw / nw, ch / nh);
        stage.style.width = `${Math.max(1, Math.floor(nw * k))}px`;
        stage.style.height = `${Math.max(1, Math.floor(nh * k))}px`;
        stage.style.display = "block";
    };

    const probe = new Image();
    probe.onload = () => {
        nw = probe.naturalWidth;
        nh = probe.naturalHeight;
        const result = make("img", { position: "absolute", inset: "0", width: "100%", height: "100%", display: "block", pointerEvents: "none" });
        result.draggable = false;
        result.src = probe.src;
        stage.appendChild(result);
        addResolution(stage, item.w && item.h ? item : { w: nw, h: nh });
        layout();
    };
    probe.src = viewUrl(item);
    bindCopy(stage, item);
    new ResizeObserver(layout).observe(holder);
    return frame;
}

// =============================================================================
// 节点主面板
// =============================================================================

function forwardWheelToCanvas(el, keepNative) {
    el.addEventListener("wheel", e => {
        if (keepNative?.(e)) return;
        app.canvas?.processMouseWheel?.(e);
    }, { passive: false });
}

function createPanel(node) {
    if (typeof node.addDOMWidget !== "function") return false;
    injectStyle();

    const root = make("div"); root.className = "als-root";

    // 顶部信息行：数量 + 路径（双击原地编辑，无弹窗）
    const head = make("div"); head.className = "als-head";
    const count = make("span"); count.className = "als-count";
    const path = document.createElement("input");
    path.className = "als-path";
    path.value = widget(node, "filename_prefix")?.value || "Alili/Alili";
    path.readOnly = true;
    path.title = "双击编辑保存路径";
    path.spellcheck = false;
    path.addEventListener("pointerdown", e => e.stopPropagation());
    path.addEventListener("dblclick", e => {
        e.stopPropagation();
        path.readOnly = false;
        path.focus();
        path.select();
    });
    path.addEventListener("keydown", e => {
        e.stopPropagation();
        if (e.key === "Enter") path.blur();
        else if (e.key === "Escape") { path.value = widget(node, "filename_prefix")?.value || "Alili/Alili"; path.blur(); }
    });
    path.addEventListener("blur", () => {
        path.readOnly = true;
        const val = path.value.trim() || "Alili/Alili";
        path.value = val;
        const w = widget(node, "filename_prefix");
        if (w && w.value !== val) {
            w.value = val;
            w.callback?.(val);
            node.setDirtyCanvas?.(true, true);
        }
    });
    head.append(count, path);

    const gallery = make("div"); gallery.className = "als-gallery";
    root.append(head, gallery);

    forwardWheelToCanvas(root, e => !gallery.classList.contains("single") && gallery.contains(e.target) && gallery.scrollHeight > gallery.clientHeight);

    node.properties = node.properties || {};
    let items = [];
    let idle = true;
    let focusIdx = null;

    const persist = () => {
        node.properties[PROP_KEY] = JSON.stringify({ items });
    };

    function render() {
        gallery.replaceChildren();
        gallery.classList.toggle("single", items.length === 1);
        count.textContent = items.length ? `共 ${items.length} 张` : "";
        node.setDirtyCanvas?.(true, true);

        if (!items.length) {
            const empty = make("div"); empty.className = "als-empty";
            empty.textContent = "出图后会按顺序排在这里\n分镜多图会依次追加，不会互相覆盖";
            empty.style.whiteSpace = "pre-line";
            gallery.appendChild(empty);
            return;
        }

        if (items.length === 1) {
            gallery.appendChild(buildInlineView(items[0]));
            return;
        }

        // 单图原地放大态
        if (focusIdx !== null && items[focusIdx]) {
            const item = items[focusIdx];
            gallery.classList.remove("als-gallery");
            gallery.style.display = "flex";
            gallery.style.alignItems = "center";
            gallery.style.justifyContent = "center";
            gallery.style.cursor = "zoom-out";

            const zoomWrap = make("div", { width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", position: "relative" });
            const img = make("img", { maxWidth: "100%", maxHeight: "100%", objectFit: "contain", borderRadius: "6px", border: "1px solid #30485c" });
            img.src = viewUrl(item);
            zoomWrap.appendChild(img);
            addResolution(zoomWrap, item);
            bindCopy(zoomWrap, item);
            gallery.appendChild(zoomWrap);
            zoomWrap.onclick = () => { focusIdx = null; render(); };
            return;
        }

        // 多图网格态
        gallery.classList.add("als-gallery");
        gallery.style.display = "";
        gallery.style.alignItems = "";
        gallery.style.justifyContent = "";

        items.forEach((item, i) => {
            const card = make("div"); card.className = "als-card";
            const img = make("img"); img.src = viewUrl(item); img.draggable = false; img.loading = "lazy";
            const idx = make("span", {}, String(i + 1)); idx.className = "als-idx";
            card.append(img, idx);
            addResolution(card, item);
            bindCopy(card, item);
            card.style.cursor = "zoom-in";
            card.onclick = () => { focusIdx = i; render(); };
            gallery.appendChild(card);
        });
    }

    const onStatus = e => {
        const info = e.detail?.exec_info ?? e.detail?.status?.exec_info;
        if (info?.queue_remaining === 0) idle = true;
    };
    const onExecuted = e => {
        const d = e.detail;
        const id = String(d?.display_node ?? d?.node ?? "");
        if (id !== String(node.id) && !id.endsWith(`:${node.id}`)) return;
        const list = d?.output?.[UI_IMAGES];
        if (!Array.isArray(list) || !list.length) return;
        if (idle) items = [];
        idle = false;
        for (const it of list) {
            items.push({
                filename: it.filename,
                subfolder: it.subfolder || "",
                type: it.type,
                w: Number(it.w) || 0,
                h: Number(it.h) || 0,
            });
        }
        persist();
        render();
        gallery.scrollTop = gallery.scrollHeight;
    };
    api.addEventListener("status", onStatus);
    api.addEventListener("executed", onExecuted);

    const domWidget = node.addDOMWidget("alili_save_panel", "alili_save_panel", root, { serialize: false, hideOnZoom: false });
    domWidget.options = domWidget.options || {};
    domWidget.options.serialize = false;

    const restore = () => {
        try {
            const saved = JSON.parse(node.properties?.[PROP_KEY] || "{}");
            items = Array.isArray(saved.items) ? saved.items.filter(i => i?.filename) : [];
        } catch { items = []; }
        const w = widget(node, "filename_prefix");
        if (w) path.value = w.value || "Alili/Alili";
        render();
    };
    for (const hook of ["onConfigure", "onGraphConfigured"]) {
        const old = node[hook];
        node[hook] = function(...args) {
            const res = old?.apply(this, args);
            requestAnimationFrame(restore);
            return res;
        };
    }
    const oldRemoved = node.onRemoved;
    node.onRemoved = function(...args) {
        api.removeEventListener("status", onStatus);
        api.removeEventListener("executed", onExecuted);
        closeMenu();
        return oldRemoved?.apply(this, args);
    };

    render();
    return true;
}

// =============================================================================
// 注册扩展
// =============================================================================

app.registerExtension({
    name: "Alili.SaveImage",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE) return;

        const previous = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function() {
            const res = previous?.apply(this, arguments);

            // 路径控件由面板里的 input 原地编辑，隐藏原生 widget
            const w = widget(this, "filename_prefix");
            if (w) {
                w.type = "hidden";
                w.computeSize = () => [0, -4];
            }

            this.size = [360, 400];
            if (!this._aliliSaveReady && createPanel(this)) this._aliliSaveReady = true;
            return res;
        };
    },
});
