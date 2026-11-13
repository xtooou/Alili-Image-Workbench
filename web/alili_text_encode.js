import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

// =============================================================================
// Alili 文本编码 · 前端
//
// 只做两件「自动」的事，不给用户下拉菜单：
//   1) 顺着 CLIP 输入连线找到 CLIPLoader，读它的 type widget → 模型家族
//      （Alili-Manager 切换模型卡片时会自动改写这个 type，所以不用合并插件）
//   2) 顺着输出连线找到下游采样器，读 cfg widget → 决定负向条件是否零化
// 结果写进隐藏 widget model_family / cfg，随工作流提交到后端；并在节点上画一行只读提示。
// =============================================================================

const NODE = "AliliTextEncode";
const FAMILY_LABEL = {
    qwen_image: "Qwen 2.1",
    moss_image: "MOSS-Image",
    minimax: "MiniMax-H3-Image",
    flux2: "Flux2 空LT规格",
};

function getLink(graph, id) {
    if (!graph) return null;
    if (typeof graph.getLink === "function") return graph.getLink(id);
    if (graph.links instanceof Map) return graph.links.get(id);
    return graph.links?.[id] ?? null;
}
const byName = (node, name) => node?.widgets?.find(w => w.name === name);
const byRe = (node, re) => node?.widgets?.find(w => re.test(w.name));

function upstream(node, inputName) {
    const slot = node.inputs?.find(i => i.name === inputName);
    if (!slot || slot.link == null) return null;
    const g = node.graph || app.graph;
    const link = getLink(g, slot.link);
    return link ? g?.getNodeById?.(link.origin_id) : null;
}

function downstreamNodes(node) {
    const g = node.graph || app.graph;
    const out = [];
    for (const o of node.outputs || []) {
        for (const id of o.links || []) {
            const link = getLink(g, id);
            const t = link ? g?.getNodeById?.(link.target_id) : null;
            if (t && !out.includes(t)) out.push(t);
        }
    }
    return out;
}

// 识别 + 写隐藏 widget，返回用于绘制的标签
function detect(node) {
    const loader = upstream(node, "clip");
    const type = String(byRe(loader, /^(type|类型)$/i)?.value || "").trim();

    let cfg = 1.0;
    for (const target of downstreamNodes(node)) {
        const w = byName(target, "cfg");
        if (w && typeof Number(w.value) === "number" && !Number.isNaN(Number(w.value))) {
            cfg = Number(w.value);
            break;
        }
    }

    const wf = byName(node, "model_family");
    const wc = byName(node, "cfg");
    if (wf) wf.value = type;
    if (wc) wc.value = cfg;

    return {
        family: type,
        cfg,
        label: FAMILY_LABEL[type.toLowerCase()] || (type ? type : "普通 CLIP（未识别/无图）"),
        known: !!type,
    };
}

// 提交前再同步一次：节点折叠 / 从未绘制过时 onDrawForeground 不会跑
let hookInstalled = false;
function installQueueHook() {
    if (hookInstalled || typeof api.queuePrompt !== "function") return;
    hookInstalled = true;
    const original = api.queuePrompt;
    api.queuePrompt = async function (number, data, ...rest) {
        try {
            for (const [id, node] of Object.entries(data?.output || {})) {
                if (node?.class_type !== NODE) continue;
                const live = app.graph?.getNodeById?.(Number(id) || id);
                const info = live ? detect(live) : null;
                node.inputs.model_family = info?.family ?? String(node.inputs?.model_family || "");
                node.inputs.cfg = info?.cfg ?? Number(node.inputs?.cfg ?? 1.0);
            }
        } catch (err) {
            console.warn("[Alili] 模型家族 / CFG 同步失败，已按提交数据原样运行：", err);
        }
        return original.call(this, number, data, ...rest);
    };
}

app.registerExtension({
    name: "Alili.TextEncode",
    rh: { type: "nodes", nodes: [NODE] },
    async setup() {
        installQueueHook();
        for (const delay of [0, 100, 500, 1200]) setTimeout(installQueueHook, delay);
    },
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE) return;

        const created = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const res = created?.apply(this, arguments);
            // 正文要放得下负向提示词多行框
            this.size = [320, Math.max(220, this.size?.[1] || 220)];
            return res;
        };

        const prevDraw = nodeType.prototype.onDrawForeground;
        nodeType.prototype.onDrawForeground = function (ctx) {
            if (prevDraw) prevDraw.apply(this, arguments);
            if (this.flags?.collapsed) return;
            const info = detect(this);
            // 画在标题栏右侧，避免压住正文里的负向提示词框
            const th = (window.LiteGraph && window.LiteGraph.NODE_TITLE_HEIGHT) || 30;
            ctx.save();
            ctx.font = "10px Arial, sans-serif";
            ctx.textAlign = "right";
            ctx.textBaseline = "middle";
            ctx.fillStyle = info.known ? "#8fd9a8" : "#e5b06a";
            ctx.fillText(`${info.label} · CFG ${info.cfg}`, this.size[0] - 10, -th / 2);
            ctx.restore();
        };
    },
});
