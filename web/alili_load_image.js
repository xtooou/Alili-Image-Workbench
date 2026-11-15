import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

// =============================================================================
// Alili 加载图像节点 · 前端
//   - 竖排图像列表，每张都是 1:1 方图，超出出滚动条；缩略图宽度跟随节点宽度（拉宽节点图片一起放大）
//   - 左下角编号（= 提示词里 <imageN> 的 N），右上角 ×，右下角分辨率；点击图片 = 往工作台提示词插入 <imageN>
//   - 右键缩略图 → 「复制图像文件」（后端把本地文件放进系统剪贴板）
//   - 只做参考图收集：不做遮罩、不做画板、不做扩图
//   - 对外接口：node._aliliGetImages()，供工作台读取缩略图 / LLM 推理 / 自适应比例
// =============================================================================

const NODE = "AliliLoadImage";
const STATE_KEY = "alili_state_json";
const MAX_IMAGES = 9;
const DEFAULT_SIZE = [340, 420];
const MIN_PANEL_HEIGHT = 160;
const IMAGE_BLUE = "#64B5F6";            // 与 ComfyUI 原生 IMAGE 接口同色
const WORKBENCH_NODE = "AliliImageWorkbench";

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
        position: "fixed", left: `${x}px`, top: `${y}px`, zIndex: "10100",
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
    dismissHandler = () => closeMenu();
    setTimeout(() => {
        if (dismissHandler && openMenu === menu) document.addEventListener("pointerdown", dismissHandler);
    }, 0);
}
function bindCopy(el, name) {
    el.addEventListener("contextmenu", e => {
        e.preventDefault();
        e.stopPropagation();
        showCopyMenu(e.clientX, e.clientY, fileRef(name));
    });
}

function injectStyle() {
    if (document.getElementById("alili-load-image-style")) return;
    const style = document.createElement("style");
    style.id = "alili-load-image-style";
    style.textContent = `
      .alli-root{width:100%;height:100%;box-sizing:border-box;display:flex;flex-direction:column;color:#d7e3ef;font:12px Arial,sans-serif;user-select:none;min-height:0}
      .alli-toolbar{flex:0 0 auto;display:flex;justify-content:center;gap:8px;padding:0 0 6px}
      .alli-tbtn{width:110px;height:24px;padding:0;border:0;border-radius:5px;color:#fff;font:bold 12px/24px Arial,sans-serif;cursor:pointer}
      .alli-tbtn.up{background:#1f6f8b}.alli-tbtn.up:hover{background:#2a8fb3}
      .alli-list{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;box-sizing:border-box;border:1px solid #334a5d;border-radius:8px;background:#111c27;padding:6px;display:flex;flex-direction:column;gap:6px;scrollbar-width:thin;scrollbar-color:#2a4556 transparent}
      .alli-list::-webkit-scrollbar{width:6px}
      .alli-list::-webkit-scrollbar-thumb{background:#2a4556;border-radius:3px}
      .alli-item{position:relative;flex:0 0 auto;width:100%;box-sizing:border-box;border:1px solid #30485c;border-radius:6px;overflow:hidden;background:#071018;touch-action:none;cursor:pointer}
      .alli-item img{display:block;width:100%;aspect-ratio:1/1;object-fit:cover;pointer-events:none;-webkit-user-drag:none}
      .alli-item.alli-ok{outline:2px solid #18bdd3;outline-offset:-2px}
      .alli-item.alli-no-target{outline:2px solid #d4537e;outline-offset:-2px}
      .alli-item.alli-src{opacity:.6;cursor:grabbing}
      .alli-item.alli-target{border-color:#18bdd3;box-shadow:0 0 0 2px rgba(24,189,211,.5) inset}
      .alli-no{position:absolute;left:6px;bottom:6px;min-width:22px;height:22px;padding:0 6px;box-sizing:border-box;border-radius:11px;background:rgba(8,20,30,.8);color:#fff;font:bold 12px/22px Arial,sans-serif;text-align:center;pointer-events:none}
      .alli-res{position:absolute;right:6px;bottom:6px;padding:0 6px;height:18px;border-radius:9px;background:rgba(8,20,30,.8);color:#cfe3ef;font:11px/18px Arial,sans-serif;pointer-events:none}
      .alli-x{position:absolute;right:6px;top:6px;width:26px;height:26px;padding:0;border:0;border-radius:50%;background:rgba(8,20,30,.78);color:#e6eef5;font:18px/26px Arial,sans-serif;text-align:center;cursor:pointer}
      .alli-x:hover{background:#b53b3b;color:#fff}
      .alli-hint{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;min-height:90px;color:#6f8291;font-size:12px;text-align:center;line-height:1.6}
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
    let restoring = false;
    let suppressClickUntil = 0;

    const root = make("div"); root.className = "alli-root";
    const list = make("div"); list.className = "alli-list";
    const toolbar = make("div"); toolbar.className = "alli-toolbar";
    const uploadBtn = make("button", {}, "上传参考图"); uploadBtn.className = "alli-tbtn up";
    uploadBtn.title = "选择图片上传（也可以直接拖入 / 粘贴），最多 9 张";
    uploadBtn.onpointerdown = e => e.stopPropagation();
    toolbar.append(uploadBtn);
    root.append(toolbar, list);

    const domWidget = node.addDOMWidget("alili_load_panel", "alili_load_panel", root, { serialize: false, hideOnZoom: false });
    domWidget.options = domWidget.options || {};
    domWidget.options.serialize = false;
    domWidget.options.getMinHeight = () => MIN_PANEL_HEIGHT;
    domWidget.options.getHeight = () => "100%";

    const serialize = () => JSON.stringify({
        images: images.map(i => ({ name: i.name, w: i.w, h: i.h })),
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
    node._aliliGetImages = () => images.map(i => ({ name: i.name, w: i.w, h: i.h }));

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
        const img = make("img"); img.src = fileUrl(entry.name); img.draggable = false;
        // 没有分辨率（旧数据 / 刚恢复）时，图片载入后补上
        img.onload = () => {
            if (!entry.w || !entry.h) {
                entry.w = img.naturalWidth; entry.h = img.naturalHeight;
                persist(); render();
            }
        };
        item.appendChild(img);

        const no = make("div", {}, String(index + 1)); no.className = "alli-no";
        const res = make("div", {}, entry.w && entry.h ? `${entry.w} × ${entry.h}` : "…"); res.className = "alli-res";
        item.append(no, res);

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
            hint.append(make("span", {}, "点上方「上传参考图」，或把图片拖进来 / 粘贴"), make("span", { fontSize: "10px" }, "最多 9 张 · png / jpg / webp / bmp"));
            list.appendChild(hint);
        }
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
                images.push({ name, w: size.w, h: size.h });
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
            .map(i => ({ name: i.name, w: Number(i.w) || 0, h: Number(i.h) || 0 }));
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
        return oldRemoved?.apply(this, args);
    };

    // 列表能滚动时，滚轮优先滚列表，不缩放画布
    list.addEventListener("wheel", e => {
        const atTop = list.scrollTop <= 0, atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 1;
        if (list.scrollHeight > list.clientHeight && ((e.deltaY < 0 && !atTop) || (e.deltaY > 0 && !atBottom))) e.stopPropagation();
    }, { capture: true, passive: true });

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
