import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const NODE = "AliliImageWorkbench";
const ALILI_NODE_IDS = [NODE];
// Alili 文本编码节点由 web/alili_text_encode.js 独立注册，这里只管工作台面板本身
const OPTIMIZER_ROUTE = "/alili/image-workbench/prompt-optimizer";

const DEFAULT_SIZE = [500, 540];   // 仅新建节点时的默认宽高，之后随便拖

const LOAD_NODE = "AliliLoadImage";  // 参考图来自这个节点

// 模板下拉清单：默认项固定，其余由后端扫描 templates/t2i/*.md、templates/i2i/*.md 动态填入
const TEMPLATE_DEFAULT = "自由发挥 (默认)";
const T2I_TEMPLATES = [TEMPLATE_DEFAULT];
const I2I_TEMPLATES = [TEMPLATE_DEFAULT];

const workflowStateHandlers = new Set();
let workflowStateMonitorInstalled = false;
let workflowRunning = false;

function installWorkflowStateMonitor() {
    if (workflowStateMonitorInstalled) return;
    const update = running => {
        workflowRunning = running;
        for (const handler of [...workflowStateHandlers]) {
            try { handler(running); } catch {}
        }
    };
    api.addEventListener("execution_start", () => update(true));
    api.addEventListener("executing", event => { if (event?.detail == null) update(false); });
    for (const name of ["execution_success", "execution_error", "execution_interrupted"]) {
        api.addEventListener(name, () => update(false));
    }
    workflowStateMonitorInstalled = true;
}

async function fetchTemplateLists() {
    const res = await api.fetchApi(`${OPTIMIZER_ROUTE}/templates`);
    if (!res.ok) throw new Error(`模板列表读取失败 (${res.status})`);
    return res.json();
}

// ---- 分镜出图 ----
// 每个开启了分镜的工作台节点注册一个 provider，返回 { id, count } 或 null。
// 入队时拦截 api.queuePrompt：把同一份工作流按镜头数提交 N 次，每次只改该节点的 shot_index（第几镜）。
// 没有任何节点开启分镜时，原样透传，普通单图完全不受影响。
const storyboardProviders = new Set();
let storyboardQueueInstalled = false;

function installStoryboardQueueHook() {
    if (storyboardQueueInstalled || typeof api.queuePrompt !== "function") return;
    const original = api.queuePrompt;
    api.queuePrompt = async function(number, data, ...rest) {
        const plan = [];
        if (data?.output) {
            for (const provider of [...storyboardProviders]) {
                let item = null;
                try { item = provider(); } catch {}
                if (!item) continue;
                for (const key of Object.keys(data.output)) {
                    const matched = key === item.id || key.endsWith(`:${item.id}`);
                    if (matched && data.output[key]?.class_type === NODE) plan.push({ key, count: item.count });
                }
            }
        }
        if (!plan.length) return original.call(this, number, data, ...rest);

        const total = Math.max(...plan.map(item => item.count));
        let last;
        for (let shot = 1; shot <= total; shot++) {
            // 不能用 structuredClone：output 里可能混有响应式代理对象。这份数据本来就要序列化发给后端，用 JSON 拷贝即可
            const output = JSON.parse(JSON.stringify(data.output));
            for (const { key, count } of plan) {
                const inputs = output[key].inputs;
                let st = {};
                try { st = JSON.parse(inputs.alili_state_json || "{}") || {}; } catch {}
                st.shot_index = Math.min(shot, count);
                inputs.alili_state_json = JSON.stringify(st);
            }
            last = await original.call(this, number, { ...data, output }, ...rest);
        }
        return last;
    };
    storyboardQueueInstalled = true;
}

function countShots(text) {
    return (String(text || "").match(/【\s*\d+\s*】/g) || []).length;
}

const livePromptEditors = new Set();
let promptKeyShieldInstalled = false;

function promptEditorFromEvent(event) {
    const path = event?.composedPath?.() || [];
    for (const item of path) {
        if (item?.classList?.contains?.("ghh3-prompt") && livePromptEditors.has(item)) return item;
    }
    const active = document.activeElement;
    if (active && livePromptEditors.has(active)) return active;
    const closest = active?.closest?.(".ghh3-prompt");
    if (closest && livePromptEditors.has(closest)) return closest;
    if (active && active !== document.body && active !== document.documentElement) {
        const editable = active.matches?.("input,textarea,select,button,[contenteditable='true']")
            || active.closest?.("input,textarea,select,button,[contenteditable='true']");
        if (editable) return null;
    }
    for (const editor of livePromptEditors) {
        if (editor.dataset.ghh3Editing === "1") return editor;
    }
    return null;
}

function markPromptEditor(editor, editing) {
    if (!editor) return;
    if (editing) editor.dataset.ghh3Editing = "1";
    else delete editor.dataset.ghh3Editing;
}

function applyStolenPromptKey(editor, event) {
    if (!editor || editor.contentEditable === "false" || event.isComposing) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (typeof editor.setRangeText !== "function") return;
    const start = editor.selectionStart ?? 0;
    const end = editor.selectionEnd ?? start;
    if (event.key === "Backspace") {
        editor.setRangeText("", start === end ? Math.max(0, start - 1) : start, end, "end");
    } else if (event.key === "Delete") {
        editor.setRangeText("", start, start === end ? end + 1 : end, "end");
    } else if (event.key === "Enter") {
        editor.setRangeText("\n", start, end, "end");
    } else if (event.key.length === 1) {
        editor.setRangeText(event.key, start, end, "end");
    } else {
        return;
    }
    editor.dispatchEvent(new Event("input", { bubbles: true }));
}

function patchLiteGraphPromptProcessKey() {
    const proto = globalThis.LGraphCanvas?.prototype;
    if (!proto || proto.__ghh3PromptKeyPatched || typeof proto.processKey !== "function") return;
    proto.__ghh3PromptKeyPatched = true;
    const original = proto.processKey;
    proto.processKey = function processKeyGhh3PromptShield(event) {
        if (promptEditorFromEvent(event)) return;
        return original.apply(this, arguments);
    };
}

function installPromptKeyShield() {
    patchLiteGraphPromptProcessKey();
    if (promptKeyShieldInstalled || typeof window === "undefined") return;
    promptKeyShieldInstalled = true;
    const swallowStolenFocusKeys = event => {
        const editor = promptEditorFromEvent(event);
        if (!editor) return;
        const onEditor = event.target === editor || editor.contains(event.target);
        if (onEditor) return;
        if (editor.contentEditable !== "false") editor.focus({ preventScroll: true });
        const key = String(event.key || "").toLowerCase();
        if ((event.ctrlKey || event.metaKey) && !event.altKey && (key === "z" || key === "y")) return;
        event.stopImmediatePropagation();
        event.preventDefault();
        if (event.type === "keydown") applyStolenPromptKey(editor, event);
    };
    window.addEventListener("keydown", swallowStolenFocusKeys, true);
    window.addEventListener("keyup", swallowStolenFocusKeys, true);
    document.addEventListener("pointerdown", event => {
        const path = event.composedPath?.() || [];
        for (const editor of livePromptEditors) {
            markPromptEditor(editor, path.includes(editor) || editor.contains(event.target));
        }
    }, true);
}

function registerPromptEditor(editor) {
    if (!editor) return;
    livePromptEditors.add(editor);
    installPromptKeyShield();
}

function unregisterPromptEditor(editor) {
    if (!editor) return;
    livePromptEditors.delete(editor);
    delete editor.dataset.ghh3Editing;
}

const DOM_TRANSLATIONS = {
    "Prompt:\nClick an image in Load Image to insert its tag, e.g. <image1>":
        "提示词：\n单击「加载图像」里的图片自动添加标签，如：<image1>、<image2>",
};

function t(text) { return DOM_TRANSLATIONS[text] || text; }

// 顺着「图像」口的连线找到上游的 Alili 加载图像节点（没连 / 连的不是它则返回 null）
function findLoadNode(node) {
    const input = node.inputs?.find(item => item.name === "images");
    if (!input || input.link == null) return null;
    const graph = node.graph || app.graph;
    const link = graph?.getLink ? graph.getLink(input.link)
        : (graph?.links instanceof Map ? graph.links.get(input.link) : graph?.links?.[input.link]);
    const origin = link ? graph.getNodeById(link.origin_id) : null;
    return origin && (origin.comfyClass === LOAD_NODE || origin.type === LOAD_NODE) ? origin : null;
}

// 与后端 calculate_canvas 同一算法：1.0 MP ≈ 1024x1024，再按「倍数取整」对齐
function getCanvasDimensions(node) {
    const aspect = widget(node, "aspect_ratio")?.value || "自适应";
    const megapixels = Number(widget(node, "megapixels")?.value) || 2.0;
    const multiple = Math.max(1, Number(widget(node, "multiple")?.value) || 32);

    let ratio = 1;
    if (aspect === "自适应") {
        // 有参考图时只取首张图的原始宽高比（不再含扩图外补），尺寸按百万像素重算；没有参考图按 1:1
        const first = findLoadNode(node)?._aliliGetImages?.()?.[0];
        if (first?.w && first?.h) ratio = first.w / first.h;
    } else {
        const [a, b] = String(aspect).split(":").map(Number);
        if (a > 0 && b > 0) ratio = a / b;
    }

    const total = megapixels * 1024 * 1024;
    const snap = v => Math.max(multiple, Math.round(v / multiple) * multiple);
    return `${snap(Math.sqrt(total * ratio))}x${snap(Math.sqrt(total / ratio))}`;
}

function widget(node, name) { return node.widgets?.find(w => w.name === name); }
function setPromptWidget(node, value) {
    const w = widget(node, "prompt"); if (!w) return;
    const next = value ?? "";
    if (w.value === next) return;
    w.value = next;
    w.callback?.call(w, w.value);
}
function cleanPrompt(value) { return value && value !== "(none)" ? value : ""; }
function hideWidget(w) {
    if (!w) return;
    w.hidden = true; w.options = w.options || {}; w.options.hidden = true;
    w.computeSize = () => [0, -4]; w.serialize = true;
}
function make(tag, css = {}, text = "") {
    const el = document.createElement(tag); Object.assign(el.style, css);
    if (text) el.textContent = text; return el;
}
function fileUrl(name) {
    if (!name || name === "(none)") return "";
    const parts = String(name).replaceAll("\\", "/").split("/").filter(Boolean);
    const filename = parts.pop() || "";
    const params = new URLSearchParams({ filename, type: "input", subfolder: parts.join("/") });
    const path = `/view?${params.toString()}`;
    return typeof api.apiURL === "function" ? api.apiURL(path) : path;
}

// AI 优化返回内容时的提示音：WebAudio 合成，不依赖音频文件
function playNotificationSound() {
    try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        const ctx = new AudioCtx();
        ctx.resume?.();
        const now = ctx.currentTime;

        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        // 声音波形：正弦波（声音圆润清脆，像水滴/风铃声）
        osc.type = "sine";
        // 频率：从 880Hz (A5) 平滑滑到 1320Hz (E6)，带一点轻微的上扬感
        osc.frequency.setValueAtTime(880, now);
        osc.frequency.exponentialRampToValueAtTime(1320, now + 0.08);

        // 音量包络：快速淡入，0.35 秒内自然淡出
        gain.gain.setValueAtTime(0.001, now);
        gain.gain.linearRampToValueAtTime(0.2, now + 0.02); // 0.2 为适中音量
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start(now);
        osc.stop(now + 0.35);

        // 播放完毕自动释放资源
        setTimeout(() => ctx.close(), 400);
    } catch {}
}

// 在「图像」插槽行最右侧绘制发光青色分辨率
function drawSlotResolutionOverlay(node, ctx) {
    const dimText = getCanvasDimensions(node);

    const slotIndex = node.findInputSlot ? node.findInputSlot("images") : -1;
    let y = 38;
    if (slotIndex >= 0 && typeof node.getConnectionPos === "function") {
        const pos = node.getConnectionPos(true, slotIndex);
        // 关键修复：减去 node.pos[1]，将世界坐标转换为节点内的局部坐标！
        y = pos[1] - node.pos[1];
    }

    const width = Number(node.size?.[0]) || DEFAULT_SIZE[0];
    ctx.save();
    ctx.fillStyle = "#0db5e8";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "bold 12px Arial,sans-serif";
    // 留出 35px 边距，完美避开最右侧的 > 输出插槽圆点
    ctx.fillText(dimText, width / 2, y); // <--- 从正中心开始画
    ctx.restore();
}

// 官方做法（文本 / Markdown 控件同款）：DOM 控件上的滚轮不会自动传给画布，要自己转发给 app.canvas.processMouseWheel；
// keepNative(e) 为 true 时让元素自己滚（比如有光标的文本框、多图的滚动条）
function forwardWheelToCanvas(el, keepNative) {
    el.addEventListener("wheel", e => {
        if (keepNative?.(e)) return;
        app.canvas?.processMouseWheel?.(e);
    }, { passive: false });
}

function createPanel(node) {
    if (typeof node.addDOMWidget !== "function") return false;

    const root = make("div", {
        position: "relative", width: "100%",
        boxSizing: "border-box", color: "#d7e3ef", fontFamily: "Arial,sans-serif",
        fontSize: "12px", userSelect: "none", padding: "1px 0 2px", overflow: "visible",
    });
    Object.assign(root.style, {
        display: "grid",
        gridTemplateRows: "auto minmax(0, 1fr)",
        alignItems: "stretch",
        height: "100%",
        minHeight: "0",
        overflow: "visible",
    });

    const style = make("style");
    style.textContent = `
      .ghh3-modes{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:2px 0 6px}
      .ghh3-template-wrapper{position:relative;display:flex;align-items:center;width:100%}
      .ghh3-template-badge{position:absolute;left:6px;z-index:2;pointer-events:none;padding:1px 6px;font-size:10px;line-height:16px;border-radius:999px;background:#1a2836;color:#8ba2b5;border:1px solid #2d4559;white-space:nowrap;font-weight:500;transition:all .15s}
      .ghh3-template-wrapper.active .ghh3-template-badge{background:rgba(8,180,237,.18);color:#08b4ed;border-color:rgba(8,180,237,.45);font-weight:600}
      .ghh3-template-select{height:30px;border:1px solid #2d4255;border-radius:6px;background:#14202c;color:#d9e5ef;font-size:12px;padding:0 22px 0 46px;cursor:pointer;outline:none;width:100%;box-sizing:border-box;appearance:none;-webkit-appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238697a7' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 6px center;transition:border-color .15s,color .15s}
      .ghh3-template-select:hover{border-color:#3a5c76}
      .ghh3-template-select.active{border-color:#0aa4d6;color:#08b4ed;font-weight:600}
      .ghh3-prompt{display:block;width:100%;height:100%;min-height:0;resize:none;overflow:auto;box-sizing:border-box;border:0;border-radius:6px;background:#1d2731;color:#e1e9ef;padding:7px 7px calc(7px + 14 * 1.4em);font:12px/1.4 Arial,sans-serif;outline:none;user-select:text;scrollbar-width:thin;scrollbar-color:#1f3540 transparent}
      .ghh3-prompt::placeholder{color:#52616d;opacity:1}
      .ghh3-prompt::-webkit-scrollbar{width:5px}
      .ghh3-prompt::-webkit-scrollbar-track{background:transparent}
      .ghh3-prompt::-webkit-scrollbar-thumb{background:#1f3540;border-radius:3px}
      .ghh3-prompt::-webkit-scrollbar-thumb:hover{background:#294955}
      .ghh3-prompt-wrap{position:relative;display:grid;grid-template-rows:22px minmax(0,1fr);width:100%;height:100%;min-height:0;background:#1d2731;border-radius:6px;overflow:hidden}
      .ghh3-prompt-wrap .ghh3-prompt{grid-row:2;border-radius:0 0 6px 6px}
      .ghh3-prompt-tools{grid-row:1;display:flex;align-items:center;justify-content:flex-start;gap:5px;padding:2px 6px;box-sizing:border-box;background:#1d2731;z-index:4}
      .ghh3-prompt-elapsed{display:none;color:#8fa3b3;font:11px/18px Arial,sans-serif;white-space:nowrap}
      .ghh3-prompt-elapsed.visible{display:inline-block}
      .ghh3-prompt-tool{height:18px;min-width:18px;padding:0 9px;box-sizing:border-box;border:0;border-radius:9px;background:#2a3a49;color:#b4c4d1;font:bold 12px/18px Arial,sans-serif;cursor:pointer;flex:0 0 auto}
      .ghh3-prompt-tool:hover{color:#fff;background:#355068}
      .ghh3-prompt-tool:disabled{opacity:.3;cursor:not-allowed}
      .ghh3-prompt-tool.icon{padding:0 8px;font-size:15px}
      .ghh3-pushright{margin-left:auto}
      .ghh3-shot-toggle.active{color:#fff;background:#0a86b0}
      .ghh3-prompt-loading{color:#fff!important;background:#0a86b0!important;animation:ghh3-pulse 1.1s ease-in-out infinite}
      @keyframes ghh3-pulse{50%{opacity:.45}}
      .ghh3-tpl-text{display:block;width:100%;height:280px;box-sizing:border-box;margin-top:8px;background:#1d2b36;color:#dce7ee;border:1px solid #3a4d5b;border-radius:4px;padding:8px;font:12px/1.5 Consolas,monospace;resize:vertical;outline:none}
      .ghh3-tpl-status{min-height:16px;margin-top:6px;font-size:12px;color:#8ba2b5}
      .ghh3-tool-tip{position:fixed;z-index:10100;padding:4px 7px;border-radius:4px;background:#111a22;color:#cbd7df;border:1px solid #344753;font:10px/1.2 Arial,sans-serif;pointer-events:none;white-space:nowrap}
      .ghh3-prompt-wrap{grid-template-columns:minmax(0,1fr)}
      .ghh3-prompt-wrap .ghh3-prompt-rich{position:absolute;grid-row:auto;left:0;right:0;top:22px;bottom:0;width:100%;height:auto;min-height:0;max-height:none;z-index:2;overflow-x:hidden;overflow-y:auto;background:#1d2731;color:#e1e9ef;-webkit-text-fill-color:currentColor;caret-color:#e1e9ef;line-height:2.35;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;padding:7px 7px calc(7px + 14 * 1.4em)}
      .ghh3-prompt-rich.ghh3-prompt-empty:before{content:attr(data-placeholder);position:absolute;left:7px;right:7px;top:7px;color:#52616d;white-space:pre-wrap;pointer-events:none}
      .ghh3-prompt-tag{display:inline-block;box-sizing:border-box;padding:1px 5px;margin:0 2px;border-radius:5px;background:#3b3b3b;color:#cdcdcd;-webkit-text-fill-color:#cdcdcd;font-size:.86em;line-height:1.35;vertical-align:middle;white-space:nowrap}
      .ghh3-prompt-tag-image{background:#31515a}
      .ghh3-prompt-media-token{display:inline-flex;align-items:center;vertical-align:middle;white-space:nowrap}
      .ghh3-prompt-media-preview{position:static;flex:0 0 26px;width:26px;height:26px;margin-left:.5em;margin-right:4px;box-sizing:border-box;border:1px solid rgba(91,124,143,.72);border-radius:5px;background:#14222d;object-fit:cover;display:inline-flex;overflow:hidden;vertical-align:middle;user-select:none}
      .ghh3-opt-overlay{position:fixed;inset:0;z-index:10050;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.58);font:12px Arial,sans-serif}
      .ghh3-opt-dialog{width:min(470px,calc(100vw - 30px));background:#17222c;color:#d7e3ec;border:1px solid #344958;border-radius:9px;box-shadow:0 18px 50px rgba(0,0,0,.5);padding:14px}
      .ghh3-opt-title{font-size:12px;margin-bottom:12px;white-space:nowrap}
      .ghh3-opt-row{display:grid;grid-template-columns:140px minmax(0,1fr);align-items:center;gap:8px;min-height:38px;margin:0}
      .ghh3-opt-row>span{white-space:nowrap}
      .ghh3-opt-row input,.ghh3-opt-row select{width:100%;box-sizing:border-box;background:#1d2b36;color:#dce7ee;border:1px solid #3a4d5b;border-radius:4px;padding:6px;font:inherit}
      .ghh3-opt-actions{display:flex;justify-content:flex-end;gap:7px;margin-top:28px}
      .ghh3-opt-actions button{border:1px solid #3a4d5b;border-radius:4px;background:#1d2b36;color:#cbd8e0;padding:5px 12px;cursor:pointer}
      .ghh3-opt-actions button:last-child{background:#17535a;border-color:#26717a;color:#e0f2f2}
    `;
    root.appendChild(style);

    // 双核模板选择器 (并排替换原来的 TAB 按钮)
    const modes = make("div");
    modes.className = "ghh3-modes";

    const t2iWrap = make("div");
    t2iWrap.className = "ghh3-template-wrapper";
    const t2iBadge = make("span", {}, "生图");
    t2iBadge.className = "ghh3-template-badge";
    const t2iSelect = document.createElement("select");
    t2iSelect.className = "ghh3-template-select";
    T2I_TEMPLATES.forEach(title => t2iSelect.append(new Option(title, title)));
    t2iWrap.append(t2iBadge, t2iSelect);

    const i2iWrap = make("div");
    i2iWrap.className = "ghh3-template-wrapper";
    const i2iBadge = make("span", {}, "编辑");
    i2iBadge.className = "ghh3-template-badge";
    const i2iSelect = document.createElement("select");
    i2iSelect.className = "ghh3-template-select";
    I2I_TEMPLATES.forEach(title => i2iSelect.append(new Option(title, title)));
    i2iWrap.append(i2iBadge, i2iSelect);

    modes.append(t2iWrap, i2iWrap);
    root.append(modes);

    let restoringState = true;
    let restoreEpoch = 0;
    const stateKey = "alili_state_json";

    const savedState = (() => {
        try { return JSON.parse(node.properties?.[stateKey] || "{}"); } catch { return {}; }
    })();
    node.properties = node.properties || {};
    const stateWidget = widget(node, "alili_state_json");
    if (stateWidget?.value) {
        try { Object.assign(savedState, JSON.parse(stateWidget.value)); } catch {}
    }

    let optimizerBefore = savedState.optimizerBefore ?? null;
    let storyboardOn = !!savedState.storyboard;

    // 互斥自动归位与高亮同步逻辑 (选择一边，另一边自动重置回默认；胶囊标签同步高亮)
    const syncTemplateHighlight = () => {
        const t2iActive = t2iSelect.value !== "自由发挥 (默认)";
        const i2iActive = i2iSelect.value !== "自由发挥 (默认)";
        t2iSelect.classList.toggle("active", t2iActive);
        i2iSelect.classList.toggle("active", i2iActive);
        t2iWrap.classList.toggle("active", t2iActive);
        i2iWrap.classList.toggle("active", i2iActive);
    };

    t2iSelect.onchange = () => {
        if (t2iSelect.value !== "自由发挥 (默认)") {
            i2iSelect.value = "自由发挥 (默认)";
        }
        syncTemplateHighlight();
        persistState();
    };

    i2iSelect.onchange = () => {
        if (i2iSelect.value !== "自由发挥 (默认)") {
            t2iSelect.value = "自由发挥 (默认)";
        }
        syncTemplateHighlight();
        persistState();
    };

    // 模板列表：从后端 templates/ 目录同步到两个下拉
    let templatesLoaded = false;
    let templatesFetchedAt = 0;
    const applyTemplateLists = lists => {
        for (const [kind, select, store] of [["t2i", t2iSelect, T2I_TEMPLATES], ["i2i", i2iSelect, I2I_TEMPLATES]]) {
            const names = [TEMPLATE_DEFAULT, ...(Array.isArray(lists?.[kind]) ? lists[kind] : [])];
            const current = select.value;
            store.length = 0; store.push(...names);
            select.replaceChildren(...names.map(title => new Option(title, title)));
            select.value = names.includes(current) ? current : TEMPLATE_DEFAULT;
        }
        templatesLoaded = true;
        syncTemplateHighlight();
    };
    const refreshTemplates = async () => {
        templatesFetchedAt = Date.now();
        try { applyTemplateLists(await fetchTemplateLists()); }
        catch (error) { console.warn("Alili template list unavailable:", error); }
    };
    // 恢复工作流时，列表可能还没加载完：先临时补一个选项，等列表到了再校验
    const restoreTemplate = (select, store, value) => {
        if (!value) return;
        if (!store.includes(value)) {
            if (templatesLoaded) return;
            store.push(value); select.append(new Option(value, value));
        }
        select.value = value;
    };
    // 鼠标移到模板区域时顺手刷新一次（3 秒节流），手动往文件夹里加的模板无需重启即可出现
    modes.addEventListener("pointerenter", () => {
        if (Date.now() - templatesFetchedAt > 3000) refreshTemplates();
    });
    refreshTemplates();

    const domWidget = node.addDOMWidget("alili_panel", "alili_panel", root, { serialize: false, hideOnZoom: false });
    domWidget.options = domWidget.options || {};
    domWidget.options.serialize = false;
    domWidget.options.getHeight = () => "100%";
    root.style.height = "100%";

    const promptWidget = widget(node, "prompt");
    hideWidget(promptWidget);
    for (const name of ["alili_state_json", "shot_index"]) {
        hideWidget(widget(node, name));
    }

    // 提示词编辑器 (Rich Prompt Editor)
    const prompt = make("div");
    prompt.className = "ghh3-prompt ghh3-prompt-rich";
    prompt.contentEditable = "true";
    prompt.spellcheck = false;
    prompt.tabIndex = 0;
    prompt.setAttribute("role", "textbox");
    prompt.setAttribute("aria-multiline", "true");
    prompt.style.userSelect = "text";
    prompt.style.pointerEvents = "auto";
    registerPromptEditor(prompt);

    let promptPlainText = cleanPrompt(promptWidget?.value);
    let promptComposing = false;
    let pendingPromptSnapshot = null;
    const promptHistory = { undo: [], redo: [] };

    const ignoredPromptNode = el => el?.classList?.contains("ghh3-prompt-media-preview") || el?.classList?.contains("ghh3-prompt-caret-sentinel");
    const domText = el => {
        if (!el) return "";
        if (el.nodeType === Node.TEXT_NODE) return el.data;
        if (el.nodeType !== Node.ELEMENT_NODE) return "";
        if (ignoredPromptNode(el)) return "";
        if (el.tagName === "BR") return "\n";
        return [...el.childNodes].map(domText).join("");
    };
    const editorText = () => {
        const val = domText(prompt).replace(/\r/g, "");
        return /^\n*$/.test(val) ? "" : val;
    };

    const textOffsetTo = (targetNode, targetOffset) => {
        let result = "";
        let found = false;
        const visit = n => {
            if (found || !n) return;
            if (n === targetNode) {
                if (n.nodeType === Node.TEXT_NODE) result += n.data.slice(0, targetOffset);
                else if (n.nodeType === Node.ELEMENT_NODE) {
                    for (let idx = 0; idx < Math.min(targetOffset, n.childNodes.length); idx++) result += domText(n.childNodes[idx]);
                }
                found = true;
                return;
            }
            if (n.nodeType === Node.TEXT_NODE) { result += n.data; return; }
            if (n.nodeType !== Node.ELEMENT_NODE || ignoredPromptNode(n)) return;
            if (n.tagName === "BR") { result += "\n"; return; }
            for (const child of n.childNodes) { visit(child); if (found) break; }
        };
        visit(prompt);
        return result.length;
    };

    const selectionOffsets = () => {
        const selection = window.getSelection();
        if (!selection?.rangeCount || !prompt.contains(selection.anchorNode)) return [promptPlainText.length, promptPlainText.length];
        const anchor = textOffsetTo(selection.anchorNode, selection.anchorOffset);
        const focus = textOffsetTo(selection.focusNode, selection.focusOffset);
        return [Math.min(anchor, focus), Math.max(anchor, focus)];
    };
    const promptSnapshot = () => {
        const [start, end] = selectionOffsets();
        return { text: editorText(), start, end };
    };
    const pushPromptUndo = snapshot => {
        if (!snapshot) return;
        const last = promptHistory.undo[promptHistory.undo.length - 1];
        if (!last || last.text !== snapshot.text || last.start !== snapshot.start || last.end !== snapshot.end) {
            promptHistory.undo.push(snapshot);
            if (promptHistory.undo.length > 300) promptHistory.undo.shift();
        }
        promptHistory.redo.length = 0;
        syncHistoryButtons();
    };
    const setEditorSelection = (start, end = start) => {
        const selection = window.getSelection(); if (!selection) return;
        const locate = target => {
            let remaining = Math.max(0, target);
            let location = null;
            const visit = n => {
                if (location || ignoredPromptNode(n)) return;
                if (n.nodeType === Node.TEXT_NODE) {
                    if (remaining <= n.data.length) location = [n, remaining];
                    else remaining -= n.data.length;
                    return;
                }
                if (n.nodeType !== Node.ELEMENT_NODE) return;
                if (n.tagName === "BR") {
                    const parent = n.parentNode, index = [...parent.childNodes].indexOf(n);
                    if (remaining === 0) location = [parent, index];
                    else if (remaining === 1) location = [parent, index + 1];
                    else remaining -= 1;
                    return;
                }
                for (const child of n.childNodes) { visit(child); if (location) return; }
            };
            visit(prompt);
            if (location) return location;
            return [prompt, prompt.childNodes.length];
        };
        const [startNode, startOffset] = locate(start), [endNode, endOffset] = locate(end);
        const range = document.createRange(); range.setStart(startNode, startOffset); range.setEnd(endNode, endOffset);
        selection.removeAllRanges(); selection.addRange(range);
    };

    const restorePromptSnapshot = snapshot => {
        if (!snapshot) return;
        promptPlainText = snapshot.text;
        renderPromptHighlights();
        prompt.focus();
        setEditorSelection(snapshot.start, snapshot.end);
        setPromptWidget(node, prompt.value);
        persistState();
    };
    const stepPromptHistory = redo => {
        const source = redo ? promptHistory.redo : promptHistory.undo;
        const target = source.pop();
        if (!target) return;
        const current = promptSnapshot();
        (redo ? promptHistory.undo : promptHistory.redo).push(current);
        restorePromptSnapshot(target);
        syncHistoryButtons();        
    };

    Object.defineProperties(prompt, {
        value: {
            configurable: true,
            get: () => promptPlainText,
            set: val => { promptPlainText = String(val ?? ""); },
        },
        selectionStart: { configurable: true, get: () => selectionOffsets()[0] },
        selectionEnd: { configurable: true, get: () => selectionOffsets()[1] },
        placeholder: {
            configurable: true,
            get: () => prompt.dataset.placeholder || "",
            set: val => { prompt.dataset.placeholder = String(val ?? ""); },
        },
    });

    prompt.setRangeText = (replacement, start, end, selectionMode = "end") => {
        const next = promptPlainText.slice(0, start) + replacement + promptPlainText.slice(end);
        promptPlainText = next;
        renderPromptHighlights();
        const caret = selectionMode === "select" ? [start, start + replacement.length] : [start + replacement.length, start + replacement.length];
        prompt.focus(); setEditorSelection(caret[0], caret[1]);
    };

    prompt.value = cleanPrompt(savedState.prompt || promptWidget?.value || "");
    prompt.placeholder = t("Prompt:\nClick an image in Load Image to insert its tag, e.g. <image1>");

    // 参考图来自上游「加载图像」节点（只读，这里不上传、不修改）
    const refImages = () => findLoadNode(node)?._aliliGetImages?.() || [];

    const serializedState = () => JSON.stringify({
        prompt: prompt.value,
        t2i_template: t2iSelect.value,
        i2i_template: i2iSelect.value,
        optimizerBefore,
        storyboard: storyboardOn,
    });

    const persistState = () => {
        if (restoringState) return;
        const val = serializedState();
        if (node.properties[stateKey] === val && (!stateWidget || stateWidget.value === val)) return;
        node.properties[stateKey] = val;
        if (stateWidget) stateWidget.value = val;
    };

    let optimizing = false;
    let optimizerRequestId = null;
    let optimizerAbort = null;
    let optimizerTimer = null;

    const promptWrap = make("div"); promptWrap.className = "ghh3-prompt-wrap";
    const promptTools = make("div"); promptTools.className = "ghh3-prompt-tools";
    const elapsedPrompt = make("span"); elapsedPrompt.className = "ghh3-prompt-elapsed";
    const resetPrompt = make("button", {}, "↶"); resetPrompt.className = "ghh3-prompt-tool icon";
    resetPrompt.title = "撤销优化";
    const redoPrompt = make("button", {}, "↷"); redoPrompt.className = "ghh3-prompt-tool icon";
    redoPrompt.title = "重做优化";
    const optimizePrompt = make("button", {}, "✦"); optimizePrompt.className = "ghh3-prompt-tool icon ghh3-pushright";
    optimizePrompt.title = "优化提示词";
    const optimizerGear = make("button", {}, "API"); optimizerGear.className = "ghh3-prompt-tool";
    optimizerGear.title = "提示词优化用的 API 设置";

    // 左：API / Skill / 分镜图（数字直接显示在按钮上）  右：优化 / 重做 / 撤销（撤销在最右）
    const storyboardBtn = make("button", {}, "分镜图"); storyboardBtn.className = "ghh3-prompt-tool ghh3-shot-toggle";
    const templateEditBtn = make("button", {}, "Skill"); templateEditBtn.className = "ghh3-prompt-tool";
    templateEditBtn.title = "编辑提示词模板（Skill）";
    
    const syncHistoryButtons = () => {
        resetPrompt.disabled = promptHistory.undo.length === 0;
        redoPrompt.disabled = promptHistory.redo.length === 0;
    };
    syncHistoryButtons();

    promptTools.append(optimizerGear, templateEditBtn, storyboardBtn, optimizePrompt, elapsedPrompt, resetPrompt, redoPrompt);
    promptWrap.append(promptTools, prompt);

    // 镜头数：按提示词框里的【1】【2】… 自动统计
    const effectiveShotCount = () => (storyboardOn ? countShots(prompt.value) : 0);
    const syncStoryboardUI = () => {
        const detected = countShots(prompt.value);
        storyboardBtn.classList.toggle("active", storyboardOn);
        storyboardBtn.textContent = storyboardOn && detected > 0 ? `分镜图 ${detected}` : "分镜图";
        storyboardBtn.title = !storyboardOn
            ? "分镜出图：关闭（普通单图）。开启后按提示词里的【1】【2】… 逐镜头各出一张"
            : detected < 2
                ? "分镜出图：已开启，但提示词里没有检测到 2 个以上的【n】镜头，将按普通单图运行"
                : "分镜出图：已开启，每次运行会按镜头数连续出图";
    };
    const storyboardProvider = () => {
        const count = effectiveShotCount();
        return count > 1 ? { id: String(node.id), count } : null;
    };
    storyboardProviders.add(storyboardProvider);
    storyboardBtn.onclick = () => { storyboardOn = !storyboardOn; syncStoryboardUI(); persistState(); };
    prompt.addEventListener("input", syncStoryboardUI);
    templateEditBtn.onclick = () => openTemplateEditor();
    syncStoryboardUI();

    function openTemplateEditor() {
        const overlay = make("div"); overlay.className = "ghh3-opt-overlay";
        const dialog = make("div"); dialog.className = "ghh3-opt-dialog";
        dialog.style.width = "min(640px, calc(100vw - 30px))";
        overlay.append(dialog);
        const title = make("div", {}, "编辑提示词模板"); title.className = "ghh3-opt-title"; dialog.append(title);

        const row = (label, control) => {
            const wrap = make("label"); wrap.className = "ghh3-opt-row";
            wrap.append(make("span", {}, label), control); dialog.append(wrap);
            return control;
        };
        const NEW_ITEM = "__new__";
        const kindSel = row("类型", make("select"));
        kindSel.append(new Option("生图Skill (t2i)", "t2i"), new Option("编辑Skill (i2i)", "i2i"));
        const nameSel = row("选择模板", make("select"));
        const nameInp = row("模板名称", make("input"));
        nameInp.placeholder = "即文件名；改成新名字再保存 = 另存为新模板";
        const text = make("textarea"); text.className = "ghh3-tpl-text"; text.spellcheck = false;
        text.placeholder = "写给大模型的专属指令。分镜模板请要求输出  公共设定 + 【1】…【2】…  的格式。";
        for (const type of ["keydown", "keyup"]) text.addEventListener(type, e => e.stopPropagation());
        const status = make("div"); status.className = "ghh3-tpl-status";
        dialog.append(text, status);
        const actions = make("div"); actions.className = "ghh3-opt-actions";
        const closeBtn = make("button", {}, "关闭"); const saveBtn = make("button", {}, "保存");
        actions.append(closeBtn, saveBtn); dialog.append(actions);

        const setStatus = (message, bad = false) => { status.textContent = message; status.style.color = bad ? "#d98d97" : "#8ba2b5"; };
        const guard = fn => async (...args) => { try { await fn(...args); } catch (error) { setStatus(error.message || String(error), true); } };

        const loadContent = async () => {
            if (nameSel.value === NEW_ITEM) {
                nameInp.value = ""; text.value = "";
                setStatus("新建模板：填写名称和内容后保存"); return;
            }
            const res = await api.fetchApi(`${OPTIMIZER_ROUTE}/template?` + new URLSearchParams({ kind: kindSel.value, name: nameSel.value }));
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "读取失败");
            nameInp.value = nameSel.value; text.value = data.content || ""; setStatus("");
        };
        const loadList = async (preferName = "") => {
            const names = (await fetchTemplateLists())[kindSel.value] || [];
            nameSel.replaceChildren(new Option("＋ 新建模板", NEW_ITEM), ...names.map(n => new Option(n, n)));
            nameSel.value = names.includes(preferName) ? preferName : (names[0] || NEW_ITEM);
            await loadContent();
        };

        kindSel.onchange = guard(() => loadList());
        nameSel.onchange = guard(loadContent);
        closeBtn.onclick = () => overlay.remove();
        saveBtn.onclick = guard(async () => {
            const res = await api.fetchApi(`${OPTIMIZER_ROUTE}/template`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ kind: kindSel.value, name: nameInp.value, content: text.value }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "保存失败");
            await loadList(data.name);
            await refreshTemplates();
            setStatus(`已保存：${data.name}`);
        });

        const activeKind = (i2iSelect.value !== TEMPLATE_DEFAULT && t2iSelect.value === TEMPLATE_DEFAULT) ? "i2i" : "t2i";
        kindSel.value = activeKind;
        document.body.append(overlay);
        guard(loadList)(activeKind === "i2i" ? i2iSelect.value : t2iSelect.value);
    }

    // API 设置模块（配置来自根目录 API/ 文件夹）
    const loadApiModule = () => import(typeof api.apiURL === "function" ? api.apiURL("/alili/api/settings.js") : "/alili/api/settings.js");

    const promptMediaMatches = source => {
        const pattern = /<\s*(?:image|picture|图片|图像|图)\s*#?\s*([1-9])\s*>|(?<![\w<])(?:image|picture)\s*#?\s*([1-9])(?!\d)(?!\s*>)|(?:图片|图像|图)\s*#?\s*([1-9])(?!\d)/gi;
        const matches = [];
        let item;
        while ((item = pattern.exec(source))) {
            matches.push({ index: item.index, raw: item[0], ordinal: Number(item[1] || item[2] || item[3]) });
        }
        return matches;
    };

    const renderPromptHighlights = () => {
        const source = String(prompt.value || "");
        const keepFocus = document.activeElement === prompt || prompt.dataset.ghh3Editing === "1";
        const restoreSelection = keepFocus ? selectionOffsets() : null;
        prompt.replaceChildren();

        const appendPlain = txt => {
            const parts = txt.split("\n");
            parts.forEach((p, idx) => {
                if (p) prompt.append(document.createTextNode(p));
                if (idx < parts.length - 1) prompt.append(document.createElement("br"));
            });
        };

        const refList = refImages();
        const matches = promptMediaMatches(source).sort((a, b) => a.index - b.index);
        let cursor = 0;

        for (const match of matches) {
            if (match.index < cursor) continue;
            if (match.index > cursor) appendPlain(source.slice(cursor, match.index));

            const mediaEntry = refList[match.ordinal - 1];

            const token = make("span");
            token.className = "ghh3-prompt-media-token";

            if (mediaEntry?.name) {
                const preview = make("img");
                preview.className = "ghh3-prompt-media-preview";
                preview.src = fileUrl(mediaEntry.name);
                preview.contentEditable = "false";
                token.appendChild(preview);
            }

            const tag = make("span");
            tag.className = "ghh3-prompt-tag ghh3-prompt-tag-image";
            tag.textContent = match.raw;
            token.appendChild(tag);

            prompt.appendChild(token);
            cursor = match.index + match.raw.length;
        }

        if (cursor < source.length) appendPlain(source.slice(cursor));
        if (source.endsWith("\n")) {
            const sentinel = document.createElement("br");
            sentinel.className = "ghh3-prompt-caret-sentinel";
            sentinel.setAttribute("aria-hidden", "true");
            prompt.appendChild(sentinel);
        }

        prompt.classList.toggle("ghh3-prompt-empty", !source);
        if (restoreSelection) {
            if (document.activeElement !== prompt) prompt.focus({ preventScroll: true });
            setEditorSelection(restoreSelection[0], restoreSelection[1]);
        }
    };
    renderPromptHighlights();
    root.appendChild(promptWrap);

    // 输入与撤销重做绑定
    const commitPromptEditorInput = () => {
        const keepFocus = document.activeElement === prompt || prompt.dataset.ghh3Editing === "1";
        promptPlainText = editorText();
        renderPromptHighlights();
        if (keepFocus && document.activeElement !== prompt) prompt.focus({ preventScroll: true });
        prompt.classList.toggle("ghh3-prompt-empty", !promptPlainText);
        if (pendingPromptSnapshot) {
            pushPromptUndo(pendingPromptSnapshot);
            pendingPromptSnapshot = null;
        }
        setPromptWidget(node, prompt.value);
        persistState();
    };

    prompt.addEventListener("compositionstart", () => { pendingPromptSnapshot ||= promptSnapshot(); promptComposing = true; });
    prompt.addEventListener("compositionend", () => { promptComposing = false; commitPromptEditorInput(); });
    prompt.addEventListener("input", () => { if (!promptComposing) commitPromptEditorInput(); });
    prompt.addEventListener("paste", event => {
        const text = event.clipboardData?.getData("text/plain");
        if (text) {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            pendingPromptSnapshot ||= promptSnapshot();
            const [start, end] = selectionOffsets();
            prompt.setRangeText(text, start, end, "end");
            pushPromptUndo(pendingPromptSnapshot);
            pendingPromptSnapshot = null;
            setPromptWidget(node, prompt.value);
            persistState();
        }
    });    
    prompt.addEventListener("beforeinput", event => {
        if (["historyUndo", "historyRedo"].includes(event.inputType)) {
            event.preventDefault(); event.stopImmediatePropagation();
            return;
        }
        pendingPromptSnapshot ||= promptSnapshot();
        if (!["insertParagraph", "insertLineBreak"].includes(event.inputType)) return;
        event.preventDefault();
        const [start, end] = selectionOffsets();
        promptPlainText = editorText();
        prompt.setRangeText("\n", start, end, "end");
        pushPromptUndo(pendingPromptSnapshot);
        pendingPromptSnapshot = null;
        setPromptWidget(node, prompt.value);
        persistState();
    });

    const isPromptHistoryKey = event => {
        const editing = document.activeElement === prompt || prompt.dataset.ghh3Editing === "1";
        if (!editing || !(event.ctrlKey || event.metaKey) || event.altKey) return;
        const key = String(event.key || "").toLowerCase();
        return key === "z" || key === "y";
    };
    window.addEventListener("keydown", event => {
        if (!isPromptHistoryKey(event)) return;
        event.preventDefault(); event.stopImmediatePropagation();
        const key = String(event.key || "").toLowerCase();
        stepPromptHistory(key === "y" || (key === "z" && event.shiftKey));
    }, true);

    // 上游加载图像变化（连线 / 增删图）时刷新提示词里的标签缩略图
    node.onConnectionsChange = (function(old) {
        return function(...args) {
            const res = old?.apply(this, args);
            queueMicrotask(() => refreshUpstream());
            return res;
        };
    })(node.onConnectionsChange);

    prompt.addEventListener("keydown", e => e.stopPropagation());
    prompt.addEventListener("keyup", e => e.stopPropagation());
    prompt.addEventListener("focus", () => markPromptEditor(prompt, true));
    prompt.addEventListener("pointerdown", e => {
        markPromptEditor(prompt, true);
        if (e.button === 1) return;
        e.stopPropagation();
        queueMicrotask(() => {
            if (document.activeElement !== prompt) prompt.focus({ preventScroll: true });
            app.canvas?.canvas?.blur?.();
        });
    });

    // 鼠标中键拖拽平移与滚轮隔离
    let middlePan = null;
    const moveMiddlePan = event => {
        if (!middlePan) return;
        const canvasObj = app.canvas;
        const scale = Number(canvasObj?.ds?.scale) || 1;
        const dx = (event.clientX - middlePan.x) / scale;
        const dy = (event.clientY - middlePan.y) / scale;
        middlePan.x = event.clientX; middlePan.y = event.clientY;
        if (canvasObj?.ds?.offset) {
            canvasObj.ds.offset[0] += dx; canvasObj.ds.offset[1] += dy;
            canvasObj.setDirty?.(true, true);
            node.setDirtyCanvas(true, true);
        }
        event.preventDefault(); event.stopImmediatePropagation();
    };
    const stopMiddlePan = () => {
        if (!middlePan) return;
        middlePan = null;
        document.body.style.removeProperty("cursor");
        window.removeEventListener("pointermove", moveMiddlePan, true);
        window.removeEventListener("pointerup", stopMiddlePan, true);
    };
    prompt.addEventListener("pointerdown", event => {
        if (event.button !== 1) return;
        middlePan = { x: event.clientX, y: event.clientY };
        document.body.style.cursor = "grabbing";
        window.addEventListener("pointermove", moveMiddlePan, true);
        window.addEventListener("pointerup", stopMiddlePan, true);
        event.preventDefault(); event.stopImmediatePropagation();
    }, true);

    // 滚轮：提示词框里有输入光标且还能滚动时，滚文字；其余任何位置都转给工作流画布缩放
    forwardWheelToCanvas(root, event => {
        if (document.activeElement !== prompt || !prompt.contains(event.target) && event.target !== prompt) return false;
        const canUp = prompt.scrollTop > 0;
        const canDown = prompt.scrollTop + prompt.clientHeight < prompt.scrollHeight - 1;
        return (event.deltaY < 0 && canUp) || (event.deltaY > 0 && canDown);
    });

    // 供上游「加载图像」调用：点击里面的图片，往提示词插入 <imageN>（插在最后一次光标处，没有就加在末尾）
    let lastCaret = null;
    const rememberCaret = () => {
        if (document.activeElement === prompt) lastCaret = { a: prompt.selectionStart, b: prompt.selectionEnd };
    };
    for (const type of ["keyup", "mouseup", "input", "focus"]) prompt.addEventListener(type, rememberCaret);

    node._aliliInsertTag = ordinal => {
        const tag = `<image${ordinal}>`;
        const len = prompt.value.length;
        const live = document.activeElement === prompt;
        let a = live ? prompt.selectionStart : (lastCaret ? lastCaret.a : len);
        let b = live ? prompt.selectionEnd : (lastCaret ? lastCaret.b : len);
        a = Math.min(a, len); b = Math.min(Math.max(a, b), len);
        prompt.setRangeText(tag, a, b, "end");
        lastCaret = { a: a + tag.length, b: a + tag.length };
        renderPromptHighlights();
        setPromptWidget(node, prompt.value);
        persistState();
        return true;
    };

    // 上游加载图像变化（连线 / 增删图）时，刷新提示词里标签的缩略图
    let refsSignature = null;
    function refreshUpstream() {
        const key = (findLoadNode(node) ? "1:" : "0:") + refImages().map(e => e.name).join("|");
        if (key === refsSignature) return;
        refsSignature = key;
        renderPromptHighlights();
    }

    // 提示词优化执行 (读取当前激活的模板给大模型)
    async function runPromptOptimization() {
        if (optimizing) return false;
        const before = prompt.value;
        const task = refImages().length > 0 ? "I2I" : "T2I";

        // 获取当前被激活的模板标题
        let activeTemplate = "";
        if (t2iSelect.value !== TEMPLATE_DEFAULT) {
            activeTemplate = `t2i/${t2iSelect.value}`;
        } else if (i2iSelect.value !== TEMPLATE_DEFAULT) {
            activeTemplate = `i2i/${i2iSelect.value}`;
        }

        try {
            optimizing = true;
            optimizerRequestId = globalThis.crypto?.randomUUID?.() || `${Date.now()}`;
            optimizerAbort = new AbortController();

            optimizePrompt.classList.add("ghh3-prompt-loading");
            optimizePrompt.textContent = "0s";
            optimizePrompt.title = "点击停止";            
            const started = performance.now();
            optimizerTimer = setInterval(() => {
                const s = Math.floor((performance.now() - started) / 1000);
                optimizePrompt.textContent = `${s}s`;
            }, 1000);

            const mediaPayload = [];
                for (const [index, entry] of refImages().entries()) {
                    const ordinal = index + 1;
                    const imgUrl = fileUrl(entry.name);
                    const b64 = await new Promise((res, rej) => {
                        const i = new Image(); i.crossOrigin = "anonymous";
                        i.onload = () => {
                            const c = document.createElement("canvas");
                            const scale = Math.min(1, 512 / Math.max(i.naturalWidth, i.naturalHeight));
                            c.width = Math.max(1, Math.round(i.naturalWidth * scale));
                            c.height = Math.max(1, Math.round(i.naturalHeight * scale));
                            c.getContext("2d").drawImage(i, 0, 0, c.width, c.height);
                            res(c.toDataURL("image/jpeg", 0.6));
                        };
                        i.onerror = () => rej(new Error("Image read error"));
                        i.src = imgUrl;
                    });
                    mediaPayload.push({ label: `<image${ordinal}>`, images: [b64] });
                }

            const reqBody = {
                request_id: optimizerRequestId,
                prompt: before,
                task,
                template: activeTemplate, // 传给后端的当前激活模板
                media: mediaPayload,
            };

            const res = await api.fetchApi(`${OPTIMIZER_ROUTE}/optimize`, {
                method: "POST", signal: optimizerAbort.signal,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(reqBody),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "Optimization failed");

            optimizerBefore = before;
            pushPromptUndo({ text: before, start: before.length, end: before.length });
            prompt.value = data.prompt;
            renderPromptHighlights();
            setPromptWidget(node, data.prompt);
            syncStoryboardUI();
            persistState();
            playNotificationSound();
            return true;
        } catch (err) {
            if (err.name !== "AbortError") alert(err.message);
            return false;
        } finally {
            clearInterval(optimizerTimer); optimizerTimer = null; optimizerAbort = null;
            optimizing = false;
            optimizePrompt.classList.remove("ghh3-prompt-loading");
            optimizePrompt.textContent = "✦";
            optimizePrompt.title = "优化提示词";
        }
    }

    function stopPromptOptimization() {
        optimizerAbort?.abort();
        if (optimizerRequestId) {
            api.fetchApi(`${OPTIMIZER_ROUTE}/cancel`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ request_id: optimizerRequestId }),
            }).catch(() => {});
        }
    }

    optimizePrompt.onclick = () => {
        if (optimizing) stopPromptOptimization();
        else runPromptOptimization();
    };
    optimizerGear.onclick = async () => {
        try { await (await loadApiModule()).openApiSettings(); }
        catch (err) { alert("API 设置加载失败：" + err.message); }
    };
    resetPrompt.onclick = () => stepPromptHistory(false);
    redoPrompt.onclick = () => stepPromptHistory(true);    

    // 分辨率三项（比例 / 百万像素 / 倍数取整）变化时刷新右上角的尺寸读数
    for (const wName of ["aspect_ratio", "megapixels", "multiple"]) {
        const w = widget(node, wName);
        if (w) {
            const old = w.callback?.bind(w);
            w.callback = (...args) => { old?.(...args); node.setDirtyCanvas(true, true); };
        }
    }

    // 生命周期配置恢复
    for (const hook of ["onAdded", "onConfigure", "onGraphConfigured"]) {
        const oldHook = node[hook];
        node[hook] = function(...args) {
            const configuredState = hook === "onConfigure" ? args[0]?.properties?.[stateKey] : null;
            const res = oldHook?.apply(this, args);
            for (const n of ["prompt", "alili_state_json", "shot_index"]) {
                hideWidget(widget(node, n));
            }

            if (hook !== "onAdded") {
                restoringState = true;
                const currentRestoreEpoch = ++restoreEpoch;
                requestAnimationFrame(() => {
                    let restored = {};
                    try { restored = JSON.parse(configuredState || widget(node, "alili_state_json")?.value || node.properties?.[stateKey] || "{}"); } catch {}
                    prompt.value = cleanPrompt(restored.prompt || widget(node, "prompt")?.value || "");
                    renderPromptHighlights();
                    setPromptWidget(node, prompt.value);                   

                    // 恢复模板选项
                    restoreTemplate(t2iSelect, T2I_TEMPLATES, restored.t2i_template);
                    restoreTemplate(i2iSelect, I2I_TEMPLATES, restored.i2i_template);
                    syncTemplateHighlight();

                    // 恢复分镜开关与镜头数
                    storyboardOn = !!restored.storyboard;
                    syncStoryboardUI();

                    optimizerBefore = restored.optimizerBefore ?? null;
                    syncHistoryButtons();

                    refsSignature = null; refreshUpstream();
                    if (currentRestoreEpoch === restoreEpoch) restoringState = false;
                });
            }
            return res;
        };
    }

    const oldDraw = node.onDrawForeground;
    node.onDrawForeground = function(ctx, ...args) {
        refreshUpstream();
        const res = oldDraw?.apply(this, [ctx, ...args]);
        drawSlotResolutionOverlay(this, ctx);
        return res;
    };

    const oldRemoved = node.onRemoved;
    node.onRemoved = function(...args) {
        unregisterPromptEditor(prompt);
        storyboardProviders.delete(storyboardProvider);
        return oldRemoved?.apply(this, args);
    };

    refreshUpstream();
    requestAnimationFrame(() => { restoringState = false; });

    return true;
}

app.registerExtension({
    name: "Alili.ImageWorkbench",
    rh: {
        type: "nodes",
        nodes: ALILI_NODE_IDS,
    },
    async setup() {
        installPromptKeyShield();
        installStoryboardQueueHook();
        for (const delay of [0, 100, 500, 1200]) setTimeout(() => patchLiteGraphPromptProcessKey(), delay);
    },
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE) return;
        const previous = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function() {
            const res = previous?.apply(this, arguments);
            if (!this._aliliPanelReady && createPanel(this)) {
                this._aliliPanelReady = true;
                this.setSize([...DEFAULT_SIZE]);
            }
            return res;
        };
    },
});