import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

// =============================================================================
// Alili 保存图像节点 · 前端
//   - 「保存图像」输入口那一行的右侧：先是「共 X 张」，再往右是保存路径（双击原地编辑，不弹窗）
//     这一行和输入口同一个水平线，标题栏只留节点名，不再被数量和路径占着
//   - 画廊：单图大图 / 多图网格，每张底部显示分辨率（纯文字，无胶囊背景）
//   - 右键任意图片 → 「复制图像文件」（后端把本地文件放进系统剪贴板）
//   - 单图右上角 → 「存为素材」：选分类 / 填名字，直接从后端内存缓存写进素材库
//     （分镜多图不显示；output 那份照常保存，两套落盘互不影响）
//   - 没有自动保存开关、没有路径前缀弹窗
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
const ASSET_IMPORT_ROUTE = "/alili/asset/import";
const ASSET_CATEGORIES_ROUTE = "/alili/asset/categories";
const ASSET_SUBS_ROUTE = "/alili/asset/subs";

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
        minWidth: "130px", padding: "4px", background: "#1e1f22", color: "#e3e3e3",
        border: "1px solid rgba(255,255,255,.12)", borderRadius: "6px", boxShadow: "0 8px 24px rgba(0,0,0,.45)",
        font: "12px Arial, sans-serif",
    });
    // 关键：菜单自身的 pointerdown 不能冒泡到 document，否则外部关闭监听会提前移除菜单，
    // 导致后面的 click 根本派发不到菜单项（表现就是「点了没反应」）
    menu.addEventListener("pointerdown", e => e.stopPropagation());
    menu.addEventListener("contextmenu", e => e.preventDefault());
    const action = make("div", { padding: "6px 10px", cursor: "pointer", borderRadius: "4px" }, "复制图像文件");
    action.title = "把本地文件放进系统剪贴板，可在任意程序 Ctrl+V 粘贴";
    action.onmouseenter = () => { action.style.background = "#33363b"; };
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

// ---- 「存为素材」：从后端内存缓存直接写进素材库（不经过 output / 浏览器） ----
async function fetchCategories() {
    try {
        const res = await api.fetchApi(ASSET_CATEGORIES_ROUTE);
        const data = await res.json();
        return Array.isArray(data.categories) ? data.categories : [];
    } catch (err) {
        console.warn("[Alili] 读取素材分类失败：", err);
        return [];
    }
}

// 弹窗里的原生下拉弹层也是浏览器自己画的（尖角 + 系统配色 + 系统字号），CSS 改不到。
// 这里把它包成自绘：select 只留 value 和 change，显示层 / 列表都用 DOM，圆角跟输入框一致。
function enhanceDialogSelect(select) {
  const host = select.parentElement;
  const wrap = make("div"); wrap.className = "als-sel-wrap";
  host.insertBefore(wrap, select);
  wrap.appendChild(select);
  // 内联兜底：样式表万一没注入，也不能让原生 select 露出来抢点击
  Object.assign(select.style, { position: "absolute", inset: "0", width: "100%", height: "100%", opacity: "0", pointerEvents: "none" });
  const disp = make("div"); disp.className = "als-sel-display";
  const label = make("span"); disp.appendChild(label);
  const panel = make("div"); panel.className = "als-sel-panel"; panel.style.display = "none";
  let onDoc = null;
  const sync = () => {
    const opt = select.selectedOptions[0];
    label.textContent = opt ? opt.textContent : "";
  };
  const close = () => {
    panel.style.display = "none";
    disp.classList.remove("open");
    if (onDoc) { document.removeEventListener("pointerdown", onDoc, true); onDoc = null; }
  };
  const build = () => {
    panel.textContent = "";
    [...select.options].forEach(option => {
      const item = make("div", {}, option.textContent);
      item.className = "als-sel-item" + (option.value === select.value ? " active" : "");
      item.onclick = ev => {
        ev.stopPropagation();
        if (select.value !== option.value) {
          select.value = option.value;
          select.dispatchEvent(new Event("change"));
        }
        close();
        sync();
      };
      panel.appendChild(item);
    });
  };
  disp.onclick = ev => {
    ev.stopPropagation();
    if (panel.style.display === "block") { close(); return; }
    build();
    panel.style.display = "block";
    disp.classList.add("open");
    onDoc = e => { if (!wrap.contains(e.target)) close(); };
    document.addEventListener("pointerdown", onDoc, true);
  };
  // 选项被程序重建（换图库时子分类列表会整体替换）也要同步显示文字
  new MutationObserver(sync).observe(select, { childList: true });
  select.addEventListener("change", () => setTimeout(sync, 0));
  wrap.append(disp, panel);
  sync();
  return { disp, panel, sync };
}

async function openAssetDialog(item, button) {
    if (!item?.assetToken) {
        copyToast("这张图没有可入库的缓存，请重新生成后再试", true);
        return;
    }
    if (document.getElementById("alili-asset-mask")) return;

    const categories = await fetchCategories();

    const mask = make("div"); mask.className = "als-mask"; mask.id = "alili-asset-mask";
    const dialog = make("div"); dialog.className = "als-dialog";
    const title = make("h3", {}, "存为素材");

    // ---- 图库：一排按钮（图库不允许新建，所以没有「＋新建」，也没有标签文字）----
    const catField = make("div"); catField.className = "als-field";
    const chipsRow = make("div"); chipsRow.className = "als-seg";
    let catValue = categories[0] || "";
    categories.forEach(name => {
        const chip = make("button", {}, name);
        chip.type = "button";
        chip.className = "als-chip" + (name === catValue ? " active" : "");
        chip.onclick = () => {
            if (catValue === name) return;
            catValue = name;
            [...chipsRow.children].forEach(c => c.classList.toggle("active", c === chip));
            subSelect.value = "";
            subNew.value = "";
            subNew.style.display = "none";
            refreshSubs();
        };
        chipsRow.appendChild(chip);
    });
    if (!categories.length) {
        const empty = make("div", {}, "还没有图库，请先到素材库建一个");
        empty.className = "als-chips-empty";
        chipsRow.appendChild(empty);
    }
    catField.append(chipsRow);

    // ---- 子分类 = 图库下的文件夹 = 素材库里的 TAB（数量不定，保持下拉 + 右侧「新增」）----
    const subField = make("div"); subField.className = "als-field";
    const subLabel = make("label", {}, "子分类 TAB（可选）");
    const subLine = make("div"); subLine.className = "als-row-with-add";
    const subSelect = document.createElement("select");
    subSelect.className = "als-select";
    const subAdd = make("button", {}, "新增");
    subAdd.type = "button";
    subAdd.className = "als-add-btn";
    const subNew = document.createElement("input");
    subNew.className = "als-sub-input";
    subNew.placeholder = "新子分类名字，如：短发";
    subNew.spellcheck = false;
    subNew.style.display = "none";
    const subHint = make("div"); subHint.className = "als-hint";
    subLine.append(subSelect, subAdd);
    subField.append(subLabel, subLine, subNew, subHint);

    // 下拉换成自绘弹层（原生 option 列表是尖角、系统配色，改不动）
    const subPicker = enhanceDialogSelect(subSelect);
    subAdd.onclick = () => {
        subSelect.value = "";
        subPicker.sync();
        subNew.value = "";
        subNew.style.display = "";
        setTimeout(() => subNew.focus(), 0);
    };

    const refreshSubs = async () => {
        const category = catValue.trim();
        subSelect.replaceChildren(new Option("（不分类，直接放图库根目录）", ""));
        if (!category) {
            subPicker.sync();
            subHint.textContent = "先选图库，再选子分类";
            return;
        }
        try {
            const res = await api.fetchApi(`${ASSET_SUBS_ROUTE}?category=${encodeURIComponent(category)}`);
            const data = await res.json();
            const names = (data.subs || []).filter(row => row.key).map(row => row.name);
            const keep = subSelect.value;
            subSelect.replaceChildren(new Option("（不分类，直接放图库根目录）", ""));
            for (const name of names) subSelect.append(new Option(name, name));
            if (names.includes(keep)) subSelect.value = keep;
            subPicker.sync();
            subHint.textContent = names.length
                ? `「${category}」下已有：${names.join("、")}`
                : `「${category}」下还没有子分类，可留空，也可新建一个`;
        } catch (err) {
            subHint.textContent = "";
        }
    };

    subSelect.addEventListener("change", () => {
        if (subSelect.value) {
            subNew.style.display = "none";
            subNew.value = "";
        }
    });
    refreshSubs();

    const nameField = make("div"); nameField.className = "als-field";
    const nameLabel = make("label", {}, "名字（可选）");
    const nameInput = document.createElement("input");
    nameInput.placeholder = "如：小波浪短发";
    nameInput.spellcheck = false;
    const nameHint = make("div"); nameHint.className = "als-hint";
    nameHint.textContent = "留空 → 001.png；填了 → 001_小波浪短发.png（每个 TAB 各自从 001 起）";
    nameField.append(nameLabel, nameInput, nameHint);

    const foot = make("div"); foot.className = "als-dialog-foot";
    const cancelBtn = make("button", {}, "取消"); cancelBtn.className = "als-btn";
    const okBtn = make("button", {}, "入库"); okBtn.className = "als-btn primary";

    const close = () => {
        document.removeEventListener("keydown", onKey);
        mask.remove();
    };
    const onKey = e => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    mask.addEventListener("pointerdown", e => { if (e.target === mask) close(); });
    cancelBtn.onclick = close;

    okBtn.onclick = async () => {
        const category = catValue.trim();
        const sub = (subNew.style.display !== "none" ? subNew.value.trim() : subSelect.value).trim();
        if (!category) {
            copyToast("还没有可用的图库，请先到素材库建一个", true);
            return;
        }
        okBtn.disabled = true;
        okBtn.textContent = "入库中…";
        try {
            const res = await api.fetchApi(ASSET_IMPORT_ROUTE, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    token: item.assetToken,
                    category,
                    sub,
                    name: nameInput.value.trim(),
                }),
            });
            let data = {};
            try { data = await res.json(); } catch {}
            if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
            item.assetToken = null;
            item.assetSaved = true;
            button.textContent = "已入库";
            button.disabled = true;
            copyToast(`已入库 → ${[data.category, data.sub || "image", data.filename].join("/")}`, false);
            close();
        } catch (err) {
            console.warn("[Alili] 入库失败：", err);
            copyToast(`入库失败：${err.message}`, true);
            okBtn.disabled = false;
            okBtn.textContent = "入库";
        }
    };

    foot.append(cancelBtn, okBtn);
    dialog.append(title, catField, subField, nameField, foot);
    mask.appendChild(dialog);
    document.body.appendChild(mask);
    if (!categories.length) okBtn.disabled = true;

    for (const field of [subSelect, subNew]) {
        field.addEventListener("keydown", e => {
            e.stopPropagation();
            if (e.key === "Enter") nameInput.focus();
        });
    }
    nameInput.addEventListener("keydown", e => {
        e.stopPropagation();
        if (e.key === "Enter") okBtn.click();
    });
}

function injectStyle() {
    if (document.getElementById("alili-save-image-style")) return;
    const style = document.createElement("style");
    style.id = "alili-save-image-style";
    style.textContent = `
      .als-root { width: 100%; height: 100%; box-sizing: border-box; color: #d7e3ef; font: 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
        display: flex; flex-direction: column; padding: 0; user-select: none; }
      /* 数量与路径都画在「保存图像」那一行上，这里只剩一个「双击编辑路径」的浮层输入框 */
      .als-path-edit { box-sizing: border-box; padding: 0 5px; text-align: right; border-radius: 3px;
        background: #101a22; color: #e8f3fb; border: 1px solid #4c8fa0; outline: none; z-index: 10500;
        font-family: Arial, sans-serif; box-shadow: 0 3px 10px rgba(0,0,0,.45); }
      .als-gallery { flex: 1; min-height: 0; overflow-y: auto; border: none !important; border-radius: 0;
        background: transparent !important; padding: 4px 0 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(84px, 1fr));
        gap: 6px; align-content: start; }
      .als-gallery.single { display: flex; flex-direction: column; gap: 0; overflow: hidden; align-content: stretch; }
      .als-empty { grid-column: 1 / -1; text-align: center; color: #536473; padding: 26px 8px; font-size: 11px; line-height: 1.7; }
      .als-card { position: relative; aspect-ratio: 1; border: none; border-radius: 6px; overflow: hidden;
        background: #071018; }
      .als-card img { width: 100%; height: 100%; object-fit: cover; display: block; }
      .als-idx { position: absolute; left: 3px; top: 3px; min-width: 16px; padding: 0 4px; text-align: center; font-size: 10px;
        line-height: 16px; border-radius: 3px; background: rgba(10,20,30,.72); color: #fff; font-weight: bold; }
      .als-res { position: absolute; left: 0; right: 0; bottom: 0; text-align: center; pointer-events: none;
        font: 10px/16px Arial, sans-serif; color: #fff; text-shadow: 0 1px 3px rgba(0,0,0,.95), 0 0 6px rgba(0,0,0,.8); }
      .als-asset-btn { position: absolute; right: 6px; top: 6px; z-index: 3;
        padding: 4px 10px; border-radius: 999px; border: 1px solid rgba(120,200,220,.5);
        background: rgba(10,24,34,.82); color: #c7edf6; font: 11px/1.2 Arial, sans-serif; cursor: pointer; }
      .als-asset-btn:hover { background: rgba(28,86,104,.95); border-color: #6fc7da; color: #f0fbff; }
      .als-asset-btn:disabled { opacity: .55; cursor: default; }
      .als-mask { position: fixed; inset: 0; z-index: 10300; background: rgba(4,10,16,.62);
        display: flex; align-items: center; justify-content: center; }
      .als-dialog { width: min(520px, calc(100vw - 32px)); box-sizing: border-box; padding: 17px 19px 16px;
        background: #1e1f22; color: #e3e3e3; border: 1px solid rgba(255,255,255,.12); border-radius: 10px;
        box-shadow: 0 18px 48px rgba(0,0,0,.55); font: 13px/1.6 Arial, sans-serif; }
      .als-dialog h3 { margin: 0 0 13px; font-size: 15px; font-weight: 600; color: #e3e3e3; }
      .als-field { margin-bottom: 14px; }
      .als-field label { display: block; margin-bottom: 7px; color: #9aa0a6; font-size: 13px; }
      .als-field input, .als-field select { width: 100%; height: 42px; box-sizing: border-box; padding: 0 12px; border-radius: 7px;
        border: 1px solid rgba(255,255,255,.12); background: #2a2c30; color: #e3e3e3; font: 15px Arial, sans-serif; outline: none; }
      .als-field input:focus, .als-field select:focus { border-color: #8ab4f8; }
      .als-field select { cursor: pointer; appearance: none; padding-right: 26px;
        background-image: linear-gradient(45deg, transparent 50%, #9aa0a6 50%), linear-gradient(135deg, #9aa0a6 50%, transparent 50%);
        background-position: calc(100% - 15px) calc(50% - 2px), calc(100% - 10px) calc(50% - 2px);
        background-size: 5px 5px, 5px 5px; background-repeat: no-repeat; }
      .als-field select option { background: #1e1f22; color: #e3e3e3; }
      .als-sel-wrap { position: relative; }
      .als-sel-wrap select { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; pointer-events: none; }
      .als-sel-display { position: relative; display: flex; align-items: center; box-sizing: border-box; height: 42px;
        padding: 0 26px 0 12px; border-radius: 7px; border: 1px solid rgba(255,255,255,.12); background: #2a2c30;
        color: #e3e3e3; font: 15px Arial, sans-serif; cursor: pointer; }
      .als-sel-display:hover { border-color: rgba(255,255,255,.24); }
      .als-sel-display.open { border-color: #8ab4f8; }
      .als-sel-display span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .als-sel-display::after { content: ""; position: absolute; right: 15px; top: 50%; width: 5px; height: 5px; margin-top: -4px;
        border-right: 1px solid #9aa0a6; border-bottom: 1px solid #9aa0a6; transform: rotate(45deg); }
      .als-sel-display.open::after { transform: rotate(-135deg); margin-top: -2px; }
      .als-sel-panel { position: absolute; left: 0; right: 0; top: calc(100% + 4px); z-index: 12; box-sizing: border-box;
        padding: 4px; max-height: 240px; overflow-y: auto; background: #1e1f22; border: 1px solid rgba(255,255,255,.12);
        border-radius: 8px; box-shadow: 0 12px 28px rgba(0,0,0,.55); }
      .als-sel-item { padding: 8px 10px; border-radius: 5px; font-size: 15px; color: #e3e3e3; cursor: pointer;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .als-sel-item:hover { background: #33363b; }
      .als-sel-item.active { background: #8ab4f8; color: #0b1620; font-weight: 600; }
      /* 图库按钮：和提示词库「类型」那条三段完全同一套 —— 42px 高、圆角 7、选中浅蓝、居中 */
      .als-seg { display: flex; flex-wrap: wrap; gap: 3px; width: max-content; max-width: 100%; box-sizing: border-box;
        min-height: 42px; margin: 0 auto; padding: 3px; background: #2a2c30; border: 1px solid rgba(255,255,255,.12); border-radius: 7px; }
      .als-chip { height: 36px; padding: 0 16px; border: none; border-radius: 5px; background: transparent;
        color: #9aa0a6; font: 15px Arial, sans-serif; cursor: pointer; flex: 0 0 auto; white-space: nowrap; }
      .als-chip:hover { color: #e3e3e3; }
      .als-chip.active { background: #8ab4f8; color: #0b1620; font-weight: 600; }
      .als-chips-empty { color: #9aa0a6; font-size: 13px; margin: 0 auto; }
      .als-row-with-add { display: flex; align-items: center; gap: 8px; }
      .als-row-with-add .als-sel-wrap { flex: 1; min-width: 0; }
      .als-add-btn { flex: 0 0 auto; height: 42px; padding: 0 18px; border-radius: 7px;
        border: 1px solid rgba(255,255,255,.12); background: #2a2c30; color: #e3e3e3; font: 15px Arial, sans-serif; cursor: pointer; }
      .als-add-btn:hover { background: #33363b; border-color: rgba(255,255,255,.24); }
      .als-sub-input { margin-top: 6px; }
      .als-hint { display: none; }
      .als-dialog-foot { display: flex; justify-content: center; gap: 10px; margin-top: 18px; }
      .als-btn { padding: 8px 26px; border-radius: 7px; border: 1px solid rgba(255,255,255,.12);
        background: #2a2c30; color: #c9ccd1; font: 18px Arial, sans-serif; cursor: pointer; }
      .als-btn:hover { background: #33363b; color: #e3e3e3; }
      .als-btn.primary { background: #8ab4f8; border-color: #8ab4f8; color: #0b1620; font-weight: 600; }
      .als-btn.primary:hover { background: #9cc2fa; border-color: #9cc2fa; }
      .als-btn:disabled { opacity: .55; cursor: default; }
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
        if (item.assetToken) {
            const saveBtn = make("button", {}, "存为素材");
            saveBtn.className = "als-asset-btn";
            saveBtn.title = "把这张图存进素材库（output 里那份照常保留）";
            saveBtn.addEventListener("pointerdown", e => e.stopPropagation());
            saveBtn.onclick = e => {
                e.stopPropagation();
                openAssetDialog(item, saveBtn);
            };
            stage.appendChild(saveBtn);
        }
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

    // 数量和路径都画在 canvas 上，但位置改到「保存图像」输入口那一行的右侧：
    // 左边是 litegraph 画的圆点 + 标签，右边是本文件补的「共 N 张 … 路径」，同一水平线。
    let panelWidget = null;    // 画廊 DOM 面板，用来把节点内的 y 换算成屏幕 y
    const prefixOf = () => String(widget(node, "filename_prefix")?.value || "Alili/Alili");

    const gallery = make("div"); gallery.className = "als-gallery";
    root.append(gallery);

    forwardWheelToCanvas(root, e => !gallery.classList.contains("single") && gallery.contains(e.target) && gallery.scrollHeight > gallery.clientHeight);

    node.properties = node.properties || {};
    let items = [];
    let idle = true;
    let focusIdx = null;
    let editingPath = false;   // 正在改路径时，这一行不再画数量和路径，避免和输入框重影

    // =========================================================================
    // 头部行绘制：litegraph 只画左边的圆点与「保存图像」，
    // 右边剩下的空间由我们补「共 N 张」和保存路径。
    // =========================================================================
    const slotHeight = () => (window.LiteGraph && window.LiteGraph.NODE_SLOT_HEIGHT) || 20;
    // 第一个输入口的圆心 y：slot_start_y + 0.7 个槽位高，和前端 calculateInputSlotPos 一致
    const rowCenterY = () => (node.constructor?.slot_start_y || 0) + slotHeight() * 0.7;

    // 节点局部坐标 → 屏幕坐标（视口坐标）。
    // litegraph 的映射是「屏幕(相对 canvas) = (世界 + offset) * scale」，世界坐标 = node.pos + 局部偏移。
    // 比拿 DOM 面板的 last_y 反推可靠：那一行的 y 只跟节点几何有关，跟 DOM 组件何时布局无关。
    function localToScreen(lx, ly) {
        const ds = app.canvas?.ds;
        const canvasEl = app.canvas?.canvas || app.canvasEl;
        if (!ds || !canvasEl?.getBoundingClientRect) return null;
        const rect = canvasEl.getBoundingClientRect();
        const scale = ds.scale || 1;
        // 界面缩放（设置里的 UI scale）是用 CSS transform 做的，会让 rect 比布局尺寸大，
        // 内部绘制坐标仍是布局像素，这里补一个比例，避免节点被系统缩放后整行偏出去。
        const cssScale = canvasEl.clientWidth ? rect.width / canvasEl.clientWidth : 1;
        const worldX = (node.pos?.[0] || 0) + lx;
        const worldY = (node.pos?.[1] || 0) + ly;
        let px, py;
        try {
            if (typeof ds.convertOffsetToCanvas === "function") {
                [px, py] = ds.convertOffsetToCanvas([worldX, worldY]);
            } else {
                px = (worldX + (ds.offset?.[0] || 0)) * scale;
                py = (worldY + (ds.offset?.[1] || 0)) * scale;
            }
        } catch {
            return null;
        }
        if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
        return { x: rect.left + px * cssScale, y: rect.top + py * cssScale, scale: scale * cssScale };
    }

    // 兜底：canvas 取不到时沿用旧办法（面板顶边 + last_y 反推）
    function legacyRowRect() {
        const rect = root.getBoundingClientRect();
        if (!rect.width) return null;
        const scale = app.canvas?.ds?.scale || 1;
        const baseY = Number.isFinite(panelWidget?.last_y) ? panelWidget.last_y : rowCenterY() + slotHeight();
        return { left: rect.left, right: rect.right, centerY: rect.top + (rowCenterY() - baseY) * scale, scale };
    }

    // 「保存图像」那一行的屏幕矩形：左右边界 + 行中心 y（缩放后的像素）
    function rowScreenRect() {
        const width = node.size?.[0] || 0;
        if (!width) return null;
        const left = localToScreen(0, rowCenterY());
        const right = localToScreen(width, rowCenterY());
        if (!left || !right) return legacyRowRect();
        return { left: left.x, right: right.x, centerY: left.y, scale: left.scale };
    }

    // 路径太长时保留尾部（尾部信息更有用），前面用省略号
    function fitPath(ctx, text, maxWidth) {
        if (ctx.measureText(text).width <= maxWidth) return text;
        let lo = 0, hi = text.length;
        while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            if (ctx.measureText(`…${text.slice(text.length - mid)}`).width <= maxWidth) lo = mid;
            else hi = mid - 1;
        }
        return lo > 0 ? `…${text.slice(text.length - lo)}` : "";
    }

    const paintHeaderRow = ctx => {
        const width = node.size?.[0] || 0;
        if (!width) return;
        if (editingPath) return;      // 输入框正开着，这一行留空，避免重影
        const cy = rowCenterY();
        const countText = items.length ? `共 ${items.length} 张` : "";
        const right = width - 9;
        const labelRight = 74;        // 左边「保存图像」标签占位，别压上去
        ctx.save();
        ctx.textBaseline = "middle";
        ctx.font = "11px Arial, sans-serif";

        // 数量：按节点宽度水平居中
        let countHalf = 0;
        if (countText) {
            ctx.textAlign = "center";
            const countW = ctx.measureText(countText).width;
            const cx = width / 2;
            if (cx - countW / 2 >= labelRight && cx + countW / 2 <= right - 40) {
                ctx.fillStyle = "#8fa7ba";
                ctx.fillText(countText, cx, cy);
                countHalf = countW / 2;
            }
        }

        // 路径：贴最右，左边界让给中间的数量文字；太长就保留尾部
        const text = prefixOf();
        if (text) {
            const from = Math.max(labelRight, countHalf ? width / 2 + countHalf + 10 : labelRight);
            const fitted = fitPath(ctx, text, Math.max(40, right - from));
            if (fitted) {
                ctx.textAlign = "right";
                ctx.fillStyle = "#9dbecf";
                ctx.fillText(fitted, right, cy);
            }
        }
        ctx.restore();
    };

    // 注意：包装 onDrawForeground 的时机放在 addDOMWidget 之后（见下），
    // 否则可能被 DOM 组件自己的绘制钩子覆盖掉。

    // ---- 双击这一行右侧 → 原地改路径（浮层输入框，只活到回车/失焦）----
    function startPathEdit() {
        if (document.querySelector(".als-path-edit")) return;
        const spot = rowScreenRect();
        if (!spot) return;
        const { left, right, centerY, scale } = spot;
        const nodeW = Math.max(120, right - left);
        const boxW = Math.max(120, Math.round(nodeW * 0.46));
        const boxH = Math.max(16, Math.round(17 * scale));
        const input = document.createElement("input");
        input.className = "als-path-edit";
        input.value = prefixOf();
        input.spellcheck = false;
        Object.assign(input.style, {
            position: "fixed",
            left: `${Math.round(right - boxW - 6)}px`,
            top: `${Math.round(centerY - boxH / 2)}px`,
            width: `${Math.round(boxW)}px`,
            height: `${boxH}px`,
            fontSize: `${Math.max(9, Math.round(11 * scale))}px`,
        });
        document.body.appendChild(input);
        editingPath = true;
        node.setDirtyCanvas?.(true, true);

        let done = false;
        const finish = commit => {
            if (done) return;
            done = true;
            if (commit) {
                const val = input.value.trim() || "Alili/Alili";
                const w = widget(node, "filename_prefix");
                if (w && w.value !== val) {
                    w.value = val;
                    w.callback?.(val);
                }
            }
            input.remove();
            editingPath = false;
            node.setDirtyCanvas?.(true, true);
        };
        input.addEventListener("pointerdown", e => e.stopPropagation());
        input.addEventListener("keydown", e => {
            e.stopPropagation();
            if (e.key === "Enter") finish(true);
            else if (e.key === "Escape") finish(false);
        });
        input.addEventListener("blur", () => finish(true));
        setTimeout(() => { input.focus(); input.select(); }, 20);
    }

    // 双击这一行会先被 litegraph / 输入口接走（还会顺带打开 ComfyUI 的节点面板），
    // 所以在 document 捕获阶段拦掉「这一行右半段」的双击，只留给我们自己用。
    // 关键坑：pointerdown 的 detail 在 Chrome 里恒为 0，原来用 detail === 2 判断永远不成立，
    // 整个函数第一行就 return —— 所以双击只能用时间窗口自己数，detail >= 2 只作补充。
    const DOUBLE_MS = 500;
    let lastDown = null;
    let localDown = null;
    let swallowMouseDown = false;
    let swallowTimer = 0;

    const hitHeaderRow = e => {
        const spot = rowScreenRect();
        if (!spot) return false;
        const half = (slotHeight() * spot.scale) / 2 + 6;
        const width = spot.right - spot.left;
        return Math.abs(e.clientY - spot.centerY) <= half
            && e.clientX >= spot.left + width * 0.42
            && e.clientX <= spot.right + 3;
    };

    const onHeaderPointer = e => {
        if (e.button !== 0 || !node.graph) return;
        if (!hitHeaderRow(e)) { lastDown = null; return; }
        const now = performance.now();
        const prev = lastDown;
        lastDown = { x: e.clientX, y: e.clientY, t: now };
        const isDouble = e.detail >= 2 || (!!prev && now - prev.t <= DOUBLE_MS
            && Math.abs(e.clientX - prev.x) <= 6 && Math.abs(e.clientY - prev.y) <= 6);
        if (!isDouble) return;          // 第一下放行，节点照常选中
        lastDown = null;
        e.stopPropagation();
        e.preventDefault();
        // 同一批按下还会紧跟一个 mousedown，一并吃掉，免得 litegraph 再当成别的双击手势
        swallowMouseDown = true;
        clearTimeout(swallowTimer);
        swallowTimer = setTimeout(() => { swallowMouseDown = false; }, 500);
        startPathEdit();
    };

    const onHeaderMouseDown = e => {
        if (!swallowMouseDown || e.button !== 0) return;
        swallowMouseDown = false;
        e.stopPropagation();
        e.preventDefault();
    };

    const DOWN_EVENT = typeof window.PointerEvent === "function" ? "pointerdown" : "mousedown";
    document.addEventListener(DOWN_EVENT, onHeaderPointer, true);
    if (DOWN_EVENT !== "mousedown") document.addEventListener("mousedown", onHeaderMouseDown, true);

    // 兜底通道：直接用节点局部坐标判断，完全不依赖屏幕换算。
    // 画布缩放异常、坐标取不到时，双击照样能编辑。
    const previousMouseDown = node.onMouseDown;
    node.onMouseDown = function (event, pos) {
        if (event?.button === 0 && Array.isArray(pos) && !this.flags?.collapsed) {
            const width = this.size?.[0] || 0;
            const half = slotHeight() / 2 + 4;
            if (Math.abs(pos[1] - rowCenterY()) <= half && pos[0] >= width * 0.42) {
                const now = performance.now();
                const prev = localDown;
                localDown = { t: now };
                if (event.detail >= 2 || (!!prev && now - prev.t <= DOUBLE_MS)) {
                    localDown = null;
                    startPathEdit();
                    return true;
                }
            } else {
                localDown = null;
            }
        }
        return previousMouseDown?.apply(this, arguments);
    };

    const persist = () => {
        // assetToken 是内存缓存凭证，重启即失效，不写进工作流
        node.properties[PROP_KEY] = JSON.stringify({
            items: items.map(({ assetToken, ...rest }) => rest),
        });
    };

    function render() {
        gallery.replaceChildren();
        gallery.classList.toggle("single", items.length === 1);
        node.setDirtyCanvas?.(true, true);   // 头部行的「共 N 张」跟着重画

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
            const img = make("img", { maxWidth: "100%", maxHeight: "100%", objectFit: "contain", borderRadius: "6px", border: "none" });
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
                assetToken: it.assetToken || null,
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
    panelWidget = domWidget;   // 后面靠它的 last_y 把「保存图像」那一行换算到屏幕坐标

    // DOM 组件注册完再包装绘制钩子，保证「共 N 张 / 路径」永远画在最上层
    const previousDraw = node.onDrawForeground;
    node.onDrawForeground = function (ctx) {
        const res = previousDraw?.apply(this, arguments);
        if (!this.flags?.collapsed) paintHeaderRow(ctx);
        return res;
    };

    const restore = () => {
        try {
            const saved = JSON.parse(node.properties?.[PROP_KEY] || "{}");
            items = Array.isArray(saved.items)
                ? saved.items.filter(i => i?.filename).map(i => ({ ...i, assetToken: null }))
                : [];
        } catch { items = []; }
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
        document.removeEventListener(DOWN_EVENT, onHeaderPointer, true);
        document.removeEventListener("mousedown", onHeaderMouseDown, true);
        clearTimeout(swallowTimer);
        node.onMouseDown = previousMouseDown;
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
