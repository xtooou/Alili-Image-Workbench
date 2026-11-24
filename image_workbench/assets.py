"""Alili 素材库 · 存储层 + HTTP 路由（单文件）
一句话：素材在这个插件里只有一个入口 —— 这个文件。

目录结构（两层，对应界面上的「图库」和「TAB」）：

    <素材根目录>/<图库>/<子分类>/001_小波浪短发.png    ← 图库=发型  子分类=短发（TAB）
    <素材根目录>/<图库>/image/001_小波浪短发.png      ← 未分类（TAB 里的「未分类」）
    <素材根目录>/<图库>/001_小波浪短发.png            ← 直接丢在图库根上，也算未分类
    <素材根目录>/<图库>/index.json                    ← 图库索引，自动生成与维护

图库 = 根目录下的一级文件夹（人像 / 服装 / 发型 / 姿势 …）
TAB  = 图库下的子文件夹（短发 / 长发 / 春装 / 夏装 …），不建也能用，直接丢进图库根即可

素材根目录不写死，优先级：
    1. 设置面板保存的路径（alili_settings.json 里的 asset_root）
    2. 环境变量 ALILI_ASSET_ROOT
    3. 默认 <ComfyUI>/models/Alili_Library

存盘一律存**相对 ComfyUI 根目录**的便携路径（如 models/Alili_Library），
别人盘符不同、整包搬到别的电脑都不用改；只有指向 ComfyUI 之外的目录才存绝对路径。
index.json 记录每个素材的显示名、标签、尺寸与 mtime：
  - 用户手工丢进来的图，第一次列目录时自动登记（名字取文件名去掉编号前缀）
  - 尺寸缓存住，几千张素材第二次打开不用再逐张开图，秒出
  - 文件被删/改名，索引里对应条目自动移除

缩略图刻意不落进素材目录：统一缓存在 ~/.ai_cache/alili_thumbs/<md5(绝对路径+mtime)>.webp，
首次访问生成 400px WebP（卡片显示才 ~154px，单张 ~10KB，比旧 640px JPEG 小 4 倍），之后命中缓存。
这样发给用户的素材包只有图和索引两层，缓存不进包；素材被替换（mtime 变化）时自动换 key，不会读到旧图。

HTTP 路由（前半段是入库 / 删除，后半段是浏览 / 配置 / 上传）：

- POST /alili/asset/import                出图缓存 → 素材库（保存节点的 token）
- GET  /alili/asset/categories            图库清单
- POST /alili/asset/delete                真删除（移进 .trash）
- GET  /alili/asset/library?category=&sub 列素材
- GET  /alili/asset/thumb?path=           缩略图（命中缓存直返）
- GET  /alili/asset/file?path=            原图直链
- GET  /alili/asset/config                读素材根目录（含便携显示路径）
- POST /alili/asset/config                改素材根目录（空串=恢复默认）
- GET  /alili/asset/browse?path=          浏览目录（快捷入口 + 盘符 + 子文件夹）
- POST /alili/asset/upload                浏览器上传图片入库（multipart）
- POST /alili/asset/import-file           导入磁盘已有图片（JSON path）
- POST /alili/asset/update                改素材显示名 / 标签
- GET  /alili/asset/favorites             收藏列表（跨图库汇总，存根目录 .favorites.json）
- POST /alili/asset/favorite              收藏 / 取消收藏
- GET  /alili/asset/subs?category=        图库下的 TAB 列表
- GET  /alili/icon/<name>.svg             图库图标

浏览 / 缩略图 / 原图三个读接口只放行素材根目录内的路径，外部路径一律 403。
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import shutil
import time
from pathlib import Path
from urllib.parse import quote

from aiohttp import web
from PIL import Image
from server import PromptServer

import folder_paths

DEFAULT_LIBRARY_DIRNAME = "Alili_Library"
SETTINGS_FILENAME = "alili_settings.json"
INDEX_FILENAME = "index.json"
CATEGORY_IMAGE_SUBDIR = "image"
UNGROUPED_LABEL = "未分类"

DEFAULT_CATEGORIES = ["人像", "服装", "发型", "姿势"]
RESERVED_CATEGORY_NAMES = {CATEGORY_IMAGE_SUBDIR, ".trash", ".cache"}
SKIP_DIRS = {".trash", ".cache"}
MAX_SCAN_DEPTH = 3

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}

_BAD_CHARS = re.compile(r'[\\/:*?"<>|\x00-\x1f]+')
_SPACES = re.compile(r"\s+")
_INDEX_RE = re.compile(r"^(\d{3,})(?=[_\-. ]|$)")
_LEADING_INDEX_RE = re.compile(r"^\d{3,}[_\-. ]*")
_TOKEN_SPLIT_RE = re.compile(r"[_\-\s.]+")

THUMB_SIZE = 400          # 卡片显示才 ~154px，400px 足够 2x 屏，体积比原来 640px 小 4 倍
THUMB_QUALITY = 80
THUMB_FORMAT = "WEBP"     # 与 GHIL 同款：同尺寸比 JPEG 小得多，生成也快

INDEX_VERSION = 1


# ==============================================================================
# 根目录 / 分类
# ==============================================================================

_PLUGIN_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _settings_path() -> str:
    return os.path.join(_PLUGIN_DIR, SETTINGS_FILENAME)


def load_settings() -> dict:
    try:
        with open(_settings_path(), "r", encoding="utf-8") as handle:
            data = json.load(handle)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save_settings(patch: dict) -> dict:
    data = load_settings()
    data.update(patch or {})
    try:
        with open(_settings_path(), "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)
    except OSError:
        pass
    return data


def configured_root() -> str:
    """设置面板里存过的根目录；没设置过返回空串。"""
    value = load_settings().get("asset_root")
    return value.strip() if isinstance(value, str) else ""


def comfy_root() -> str:
    return os.path.abspath(getattr(folder_paths, "base_path", os.getcwd()))


def models_dir() -> str:
    value = getattr(folder_paths, "models_dir", "")
    return os.path.abspath(value) if value else os.path.join(comfy_root(), "models")


def default_root() -> str:
    """默认放在 models/Alili_Library —— 跟模型/素材一起，挪包不丢。"""
    return os.path.join(models_dir(), DEFAULT_LIBRARY_DIRNAME)


def portable_path(path) -> str:
    """绝对路径 → 相对 ComfyUI 根（便携）；在根目录之外就原样返回绝对路径。"""
    full = os.path.abspath(os.path.expanduser(str(path or "")))
    base = comfy_root()
    try:
        rel = os.path.relpath(full, base)
    except ValueError:
        return full
    if rel == ".." or rel.startswith(".." + os.sep) or rel.startswith("../"):
        return full
    return rel.replace("\\", "/")


def resolve_path(text) -> str:
    """便携路径 / 绝对路径都能解析：相对路径按 ComfyUI 根目录展开。"""
    raw = str(text or "").strip()
    if not raw:
        return default_root()
    raw = os.path.expanduser(raw)
    if os.path.isabs(raw) or re.match(r"^[a-zA-Z]:[\\/]", raw):
        return os.path.abspath(raw)
    return os.path.abspath(os.path.join(comfy_root(), raw.replace("/", os.sep)))


def asset_root() -> str:
    root = configured_root() or os.environ.get("ALILI_ASSET_ROOT", "").strip() or default_root()
    root = resolve_path(root)
    os.makedirs(root, exist_ok=True)
    return root


def root_display() -> str:
    """给界面显示用：能便携就便携（models/Alili_Library），不写盘符。"""
    return portable_path(asset_root())


def set_asset_root(raw) -> str:
    """保存素材根目录；传空串 = 恢复默认（models/Alili_Library）。"""
    text = str(raw or "").strip()
    if not text:
        save_settings({"asset_root": ""})
        return asset_root()
    root = resolve_path(text)
    if os.path.exists(root) and not os.path.isdir(root):
        raise ValueError("目标路径不是文件夹")
    os.makedirs(root, exist_ok=True)
    # 存便携路径：同一台机器换盘符 / 换电脑都不会失效
    save_settings({"asset_root": portable_path(root)})
    return root


def _drives() -> list[str]:
    if os.name != "nt":
        return []
    import string

    found = []
    for letter in string.ascii_uppercase:
        root = f"{letter}:\\"
        if os.path.exists(root):
            found.append(root)
    return found


def list_subdirs(path: str = "") -> dict:
    """给「浏览目录」用：返回当前目录、上级目录、子文件夹、盘符、常用快捷入口。"""
    raw = str(path or "").strip()
    target = resolve_path(raw) if raw else asset_root()
    if not os.path.isdir(target):
        target = asset_root()
    dirs = []
    try:
        with os.scandir(target) as entries:
            for entry in entries:
                if entry.is_dir() and not entry.name.startswith("."):
                    dirs.append({"name": entry.name, "path": entry.path})
    except OSError:
        pass
    dirs.sort(key=lambda item: item["name"].lower())
    parent = os.path.dirname(target)
    if parent == target or os.path.normcase(parent) == os.path.normcase(target):
        parent = ""
    shortcuts = [
        {"name": "ComfyUI 根目录", "path": comfy_root()},
        {"name": "models", "path": models_dir()},
        {"name": "当前素材库", "path": asset_root()},
    ]
    return {
        "path": target,
        "display": portable_path(target),
        "parent": parent,
        "parent_display": portable_path(parent) if parent else "",
        "dirs": dirs,
        "drives": _drives(),
        "shortcuts": shortcuts,
    }


def _thumb_dir() -> str:
    path = Path.home() / ".ai_cache" / "alili_thumbs"
    path.mkdir(parents=True, exist_ok=True)
    return str(path)


def safe_category(raw) -> str:
    name = _SPACES.sub(" ", _BAD_CHARS.sub("_", str(raw or ""))).strip(" .")
    if not name:
        raise ValueError("分类名不能为空")
    if name in RESERVED_CATEGORY_NAMES:
        raise ValueError(f"分类名「{name}」是保留名，请换一个")
    return name[:40]


def safe_label(raw) -> str:
    name = _SPACES.sub(" ", _BAD_CHARS.sub(" ", str(raw or ""))).strip(" .")
    return name[:60]


def category_dir(category: str) -> str:
    return os.path.join(asset_root(), safe_category(category))


def list_categories() -> list[str]:
    """根目录下的分类文件夹；缺的默认角色分类自动补上。"""
    root = asset_root()
    names = []
    try:
        with os.scandir(root) as entries:
            for entry in entries:
                if entry.is_dir() and not entry.name.startswith("."):
                    names.append(entry.name)
    except OSError:
        pass

    for default in DEFAULT_CATEGORIES:
        if default not in names:
            try:
                _ensure_category_dir(default)
                names.append(default)
            except (ValueError, OSError):
                pass

    return sorted(names)


def category_stats() -> dict:
    """每个图库的素材数量，给「图库切换」菜单显示。"""
    stats = {}
    for name in list_categories():
        try:
            stats[name] = len(_iter_image_files(name, refresh=False))
        except OSError:
            stats[name] = 0
    return stats


# ==============================================================================
# 子分类（界面上的 TAB）
# ==============================================================================


def sub_of_rel(rel: str) -> str:
    """素材属于哪个子分类：取相对路径第一段。

    `短发/001.png` → 短发；`image/001.png` 与顶层直放的 `001.png` → ""（未分类）。
    """
    parts = str(rel or "").replace("\\", "/").split("/")
    if len(parts) < 2:
        return ""
    head = parts[0]
    return "" if head == CATEGORY_IMAGE_SUBDIR else head


def list_subs(category: str) -> list[dict]:
    """图库下的 TAB 列表：[{key, name, count}]，未分类排最前，其余按名字排。"""
    cat = safe_category(category)
    buckets: dict[str, int] = {}
    for rel in _iter_image_files(cat, refresh=False):
        key = sub_of_rel(rel)
        buckets[key] = buckets.get(key, 0) + 1
    subs = [
        {"key": key, "name": key or UNGROUPED_LABEL, "count": count}
        for key, count in buckets.items()
    ]
    subs.sort(key=lambda item: (item["key"] != "", item["name"].lower()))
    return subs


def sub_dir(category: str, sub: str = "") -> str:
    """子分类的实际目录；未分类落在 `<图库>/image/`。"""
    base = category_dir(category)
    if not str(sub or "").strip():
        return os.path.join(base, CATEGORY_IMAGE_SUBDIR)
    return os.path.join(base, safe_category(sub))


# ==============================================================================
# 索引（index.json）
# ==============================================================================


def index_path(category: str) -> str:
    return os.path.join(category_dir(category), INDEX_FILENAME)


def display_name(filename: str) -> str:
    """`001_小波浪短发.png` → `小波浪短发`；纯编号则保留编号。"""
    stem = os.path.splitext(os.path.basename(filename))[0].strip()
    cleaned = _LEADING_INDEX_RE.sub("", stem).strip(" _-.")
    return cleaned or stem


def derive_tags(filename: str) -> list[str]:
    stem = os.path.splitext(os.path.basename(filename))[0]
    parts = [p for p in _TOKEN_SPLIT_RE.split(stem) if p and not p.isdigit()]
    return parts[:8]


def _sort_key(rel: str):
    group = sub_of_rel(rel)
    base = os.path.basename(rel)
    match = _INDEX_RE.match(base)
    seq = (0, int(match.group(1)), base.lower()) if match else (1, 0, base.lower())
    # 「全部」里按子分类聚在一起，未分类排最后
    return (1 if group == "" else 0, group.lower(), seq)


def _iter_image_files(category: str, refresh: bool = True) -> list[str]:
    """分类下所有素材的相对路径。

    直放 `分类/xxx.png`、`分类/image/xxx.png`、以及再往下最多两层子文件夹都认，
    这样用户原来按「服装/婚纱/xxx.png」整理好的库不用重排也能直接用。
    """
    base = category_dir(category)
    if not os.path.isdir(base):
        return []

    found: list[str] = []
    base_depth = base.rstrip("\\/").count(os.sep)

    for folder, dirs, files in os.walk(base):
        depth = folder.rstrip("\\/").count(os.sep) - base_depth
        if depth >= MAX_SCAN_DEPTH:
            dirs[:] = []
        dirs[:] = [d for d in dirs if not d.startswith(".") and d not in SKIP_DIRS]

        for name in files:
            if name.startswith(".") or name == INDEX_FILENAME:
                continue
            if os.path.splitext(name)[1].lower() not in IMAGE_EXTS:
                continue
            rel = os.path.relpath(os.path.join(folder, name), base).replace("\\", "/")
            found.append(rel)

    found.sort(key=_sort_key)
    return found


def _read_index(category: str) -> dict:
    """返回 {相对路径: 条目}；兼容 file / filename 两种字段名。"""
    path = index_path(category)
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return {}
    entries = data.get("items") if isinstance(data, dict) else data
    if not isinstance(entries, list):
        return {}
    out = {}
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        key = entry.get("file") or entry.get("filename") or entry.get("path")
        if isinstance(key, str) and key:
            out[key.replace("\\", "/")] = entry
    return out


def _write_index(category: str, entries: list[dict]) -> None:
    path = index_path(category)
    payload = {
        "version": INDEX_VERSION,
        "category": category,
        "count": len(entries),
        "updated": time.strftime("%Y-%m-%d %H:%M:%S"),
        "items": entries,
    }
    tmp = path + ".tmp"
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    except OSError:
        try:
            os.remove(tmp)
        except OSError:
            pass


def sync_index(category: str, write: bool = True) -> list[dict]:
    """扫描真实文件 + 合并 index.json，返回完整条目（含 path / 尺寸）。

    自动处理三件事：新文件登记、消失的文件剔除、尺寸按 mtime 缓存复用。
    """
    cat = safe_category(category)
    base = category_dir(cat)
    files = _iter_image_files(cat)
    old = _read_index(cat)

    entries: list[dict] = []
    dirty = set(old) != set(files)

    for rel in files:
        full = os.path.join(base, rel.replace("/", os.sep))
        try:
            stat = os.stat(full)
        except OSError:
            dirty = True
            continue

        previous = old.get(rel) or {}
        width = int(previous.get("w") or 0)
        height = int(previous.get("h") or 0)
        mtime = int(stat.st_mtime * 1000)
        if not width or not height or int(previous.get("mtime") or 0) != mtime:
            try:
                with Image.open(full) as image:
                    width, height = image.size
            except Exception:
                width, height = 0, 0
            dirty = True

        label = str(previous.get("name") or "").strip() or display_name(rel)
        tags = previous.get("tags")
        if not isinstance(tags, list):
            tags = derive_tags(rel)

        entry = {
            "file": rel,
            "name": label,
            "tags": tags,
            "w": width,
            "h": height,
            "mtime": mtime,
        }
        entry["added"] = previous.get("added") or time.strftime("%Y-%m-%d %H:%M:%S")

        if previous.get("name") != label or previous.get("w") != width or previous.get("h") != height:
            dirty = True

        entry["path"] = full
        entry["filename"] = os.path.basename(rel)
        entries.append(entry)

    if write and (dirty or not os.path.isfile(index_path(cat))):
        _write_index(cat, [
            {k: v for k, v in entry.items() if k not in ("path", "filename")} for entry in entries
        ])
    return entries


def update_index_entry(category: str, rel: str, patch: dict) -> bool:
    """改某个素材的显示名 / 标签，写回 index.json。"""
    cat = safe_category(category)
    entries = sync_index(cat, write=False)
    found = False
    for entry in entries:
        if entry["file"] == rel:
            if "name" in patch:
                entry["name"] = safe_label(patch["name"]) or display_name(rel)
            if "tags" in patch and isinstance(patch["tags"], list):
                entry["tags"] = [safe_label(tag) for tag in patch["tags"] if safe_label(tag)][:12]
            found = True
            break
    if not found:
        return False
    _write_index(cat, [
        {k: v for k, v in entry.items() if k not in ("path", "filename")} for entry in entries
    ])
    return True


# ==============================================================================
# 编号 / 写盘
# ==============================================================================


def next_index(category: str, sub: str = "") -> int:
    """同一子分类目录内独立取号（未分类 = image/ 与图库根两处一起算）。

    这样`发型/短发` 与 `发型/长发` 各自 001 起，不会串号。
    """
    top = 0
    base = category_dir(category)
    name = str(sub or "").strip()
    if name:
        folders = [os.path.join(base, safe_category(name))]
    else:
        folders = [base, os.path.join(base, CATEGORY_IMAGE_SUBDIR)]
    for folder in folders:
        if not os.path.isdir(folder):
            continue
        with os.scandir(folder) as entries:
            for entry in entries:
                match = _INDEX_RE.match(entry.name)
                if match:
                    top = max(top, int(match.group(1)))
    return top + 1


def _ensure_category_dir(category: str) -> str:
    cat = safe_category(category)
    base = os.path.join(asset_root(), cat)
    os.makedirs(os.path.join(base, CATEGORY_IMAGE_SUBDIR), exist_ok=True)
    if not os.path.isfile(os.path.join(base, INDEX_FILENAME)):
        _write_index(cat, [])
    return base


def write_asset(category: str, label: str, data: bytes, ext: str = ".png", sub: str = "") -> dict:
    """写一张素材进图库；sub 非空则放进对应子分类文件夹（= 指定 TAB）。"""
    cat = safe_category(category)
    label = safe_label(label)
    ext = ext.lower() if ext and ext.lower() in IMAGE_EXTS else ".png"

    _ensure_category_dir(cat)
    group = safe_category(sub) if str(sub or "").strip() else ""
    image_dir = sub_dir(cat, group)
    os.makedirs(image_dir, exist_ok=True)

    index = next_index(cat, group)
    while True:
        filename = f"{index:03d}" + (f"_{label}" if label else "") + ext
        target = os.path.join(image_dir, filename)
        if not os.path.exists(target):
            break
        index += 1

    with open(target, "wb") as handle:
        handle.write(data)

    sync_index(cat)

    return {
        "ok": True,
        "category": cat,
        "sub": group,
        "filename": filename,
        "label": label or display_name(filename),
        "index": index,
        "path": target,
    }


def import_local_file(category: str, label: str, source_path: str, sub: str = "") -> dict:
    """导入磁盘上已有的图片（素材管理页的「导入本地图片」）。"""
    full = os.path.abspath(os.path.expanduser(str(source_path or "")))
    if not os.path.isfile(full):
        raise ValueError("源文件不存在")
    ext = os.path.splitext(full)[1].lower()
    if ext not in IMAGE_EXTS:
        raise ValueError(f"不支持的图片格式：{ext or '无扩展名'}")
    with open(full, "rb") as handle:
        data = handle.read()
    return write_asset(category, label, data, ext, sub)


# ==============================================================================
# 路径解析：素材库内绝对路径的准入判断
# ==============================================================================


def is_within_root(path: str) -> bool:
    root = os.path.normcase(os.path.abspath(asset_root()))
    full = os.path.normcase(os.path.abspath(path))
    try:
        return os.path.commonpath([root, full]) == root
    except ValueError:
        return False


def asset_name(full_path: str) -> str:
    """给前端 / 节点用的名称：在 input 下用相对路径，否则用绝对路径。"""
    full = os.path.abspath(full_path)
    try:
        rel = os.path.relpath(full, folder_paths.get_input_directory()).replace("\\", "/")
        if rel != ".." and not rel.startswith("../"):
            return rel
    except ValueError:
        pass
    return full


# ==============================================================================
# 列表 / 缩略图
# ==============================================================================


def list_assets(category: str, sub=None) -> list[dict]:
    """列图库素材；sub 为 None = 全部，"" = 只未分类，其余 = 该子分类。"""
    cat = safe_category(category)
    want = None if sub is None else str(sub)
    items = []
    for entry in sync_index(cat):
        group = sub_of_rel(entry["file"])
        if want is not None and group != want:
            continue
        items.append({
            "filename": entry["filename"],
            "rel": entry["file"],
            "label": entry["name"],
            "category": cat,
            "tags": list(entry.get("tags") or []),
            "name": asset_name(entry["path"]),
            "path": entry["path"],
            "sub": group,
            "w": entry["w"],
            "h": entry["h"],
            "mtime": entry["mtime"] / 1000.0,
        })
    return items


def thumb_path(full_path: str) -> str:
    stat = os.stat(full_path)
    # key 刻意不含目录路径：只用「文件名 + 大小 + mtime」。
    # 这样素材被移动/改分类（换文件夹）时 key 不变，缩略图缓存直接命中，
    # 不会为同一张图在不同路径下重复生成一堆孤儿缓存。
    key = hashlib.md5(
        f"{os.path.basename(full_path)}|{stat.st_size}|{int(stat.st_mtime * 1000)}".encode("utf-8")
    ).hexdigest()
    return os.path.join(_thumb_dir(), key + ".webp")


def _legacy_thumb_path(full_path: str) -> str:
    """旧缓存名（key 含绝对路径），仅用于一次性迁移，迁完即可淘汰。"""
    stat = os.stat(full_path)
    key = hashlib.md5(
        f"{os.path.abspath(full_path)}|{int(stat.st_mtime * 1000)}".encode("utf-8")
    ).hexdigest()
    return os.path.join(_thumb_dir(), key + ".webp")


def ensure_thumb(full_path: str) -> str:
    cache = thumb_path(full_path)
    if os.path.isfile(cache):
        return cache
    # 存量缓存迁移：旧 key（含路径）存在就改名复用，避免全库重生成一次
    legacy = _legacy_thumb_path(full_path)
    if os.path.isfile(legacy) and os.path.abspath(legacy) != os.path.abspath(cache):
        try:
            os.replace(legacy, cache)
            return cache
        except OSError:
            pass
    resample = getattr(getattr(Image, "Resampling", Image), "LANCZOS", Image.BILINEAR)
    with Image.open(full_path) as image:
        image = image.convert("RGB")
        image.thumbnail((THUMB_SIZE, THUMB_SIZE), resample)
        image.save(cache, THUMB_FORMAT, quality=THUMB_QUALITY, method=4)
    return cache


def drop_thumb(full_path: str) -> None:
    """删除素材时同步清缓存（新旧两种 key 都清），避免留下孤儿文件。"""
    for path in (thumb_path(full_path), _legacy_thumb_path(full_path)):
        try:
            os.remove(path)
        except OSError:
            pass


# ==============================================================================
# 收藏（跨图库汇总 · 卡片右上角 ⭐）
#   存 <素材根>/.favorites.json：{"items": {"<绝对路径>": {快照}}}
#   存快照是为了「已收藏」TAB 不用扫全部分类；文件没了就顺手剔除。
# ==============================================================================
FAVORITES_FILENAME = ".favorites.json"
FAVORITES_ROUTE = "/alili/asset/favorites"
FAVORITE_ROUTE = "/alili/asset/favorite"


def _favorites_path() -> str:
    return os.path.join(asset_root(), FAVORITES_FILENAME)


def _fav_key(path: str) -> str:
    return os.path.abspath(path)


def _load_favorites() -> dict:
    try:
        with open(_favorites_path(), "r", encoding="utf-8") as handle:
            raw = json.load(handle)
    except (OSError, ValueError):
        return {}
    items = raw.get("items") if isinstance(raw, dict) else None
    if not isinstance(items, dict):
        return {}
    return {key: value for key, value in items.items() if isinstance(value, dict)}


def _save_favorites(items: dict) -> None:
    path = _favorites_path()
    tmp = path + ".tmp"
    payload = {"version": 1, "count": len(items), "items": items}
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    except OSError:
        try:
            os.remove(tmp)
        except OSError:
            pass


def list_favorites() -> list[dict]:
    """收藏列表（快照 + 现算 thumb / url），文件已不存在的顺手剔除。"""
    raw = _load_favorites()
    alive = {key: value for key, value in raw.items() if os.path.isfile(key)}
    if len(alive) != len(raw):
        _save_favorites(alive)
    items = []
    for path, snapshot in alive.items():
        item = dict(snapshot)
        item["path"] = path
        item["thumb"] = _thumb_url(path)
        item["url"] = _file_url(path)
        items.append(item)
    items.sort(key=lambda item: item.get("added") or 0, reverse=True)
    return items


def set_favorite(path: str, snapshot: dict | None, on: bool) -> dict:
    items = _load_favorites()
    key = _fav_key(path)
    if on:
        entry = dict(snapshot or {})
        entry.pop("thumb", None)
        entry.pop("url", None)
        entry["path"] = key
        entry["added"] = time.time()
        items[key] = entry
    else:
        items.pop(key, None)
    _save_favorites(items)
    return {"ok": True, "on": on, "count": len(items)}


# ==============================================================================
# HTTP 路由 · 入库 / 删除
# ==============================================================================
IMPORT_ROUTE = "/alili/asset/import"
CATEGORIES_ROUTE = "/alili/asset/categories"
DELETE_ROUTE = "/alili/asset/delete"
MOVE_ROUTE = "/alili/asset/move"


async def import_asset(request):
    try:
        payload = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "请求体不是合法 JSON"}, status=400)

    token = str(payload.get("token") or "").strip()
    if not token:
        return web.json_response({"ok": False, "error": "缺少 token"}, status=400)

    from ..Expanded_Node.Save_image import drop_pending, get_pending

    data = get_pending(token)
    if not data:
        return web.json_response(
            {"ok": False, "error": "图片缓存已失效，请重新生成后再入库"}, status=410
        )

    try:
        result = await asyncio.to_thread(
            write_asset,
            payload.get("category") or "",
            payload.get("name") or "",
            data,
            ".png",
            payload.get("sub") or "",
        )
    except ValueError as error:
        return web.json_response({"ok": False, "error": str(error)}, status=400)
    except Exception as error:
        return web.json_response({"ok": False, "error": f"写盘失败：{error}"}, status=500)

    drop_pending(token)
    return web.json_response(result)


async def list_asset_categories(request):
    return web.json_response({"ok": True, "categories": list_categories()})


def _remove(path: str) -> str:
    """同步删除：清缩略图缓存 → 移 .trash → 同步该图库 index.json，返回落点。"""
    drop_thumb(path)

    trash_dir = os.path.join(asset_root(), ".trash")
    os.makedirs(trash_dir, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    target = os.path.join(trash_dir, f"{stamp}_{os.path.basename(path)}")
    shutil.move(path, target)

    # 删掉的素材同时从收藏里摘掉，别在「已收藏」里留个打不开的幽灵
    favorites = _load_favorites()
    key = _fav_key(path)
    if key in favorites:
        favorites.pop(key)
        _save_favorites(favorites)

    # 图库 = 相对素材根的**第一段**（子分类是第二段，别把 `短发` 当成图库建出来）
    try:
        rel = os.path.relpath(path, asset_root()).replace("\\", "/")
        category = rel.split("/")[0] if "/" in rel else ""
        if category:
            sync_index(safe_category(category))
    except (ValueError, OSError):
        pass
    return target


def _move(path: str, target: str, level: str = "third") -> str:
    """把素材移到同一图库下的另一个分类。level=third 改三级文件夹（二级 TAB 不变）；
    level=sub 改二级 TAB（目标 TAB 下不再保留原三级文件夹）。图库始终取源图库，天然禁止跨图库。
    返回移动后的绝对路径。缩略图 key 不含路径，无需重建；收藏的绝对路径 key 同步迁移。
    """
    root = asset_root()
    full = os.path.abspath(path)
    rel_root = os.path.relpath(full, root).replace("\\", "/")
    parts = rel_root.split("/")
    # 期望至少：图库/子分类/文件名（3 段）；三级文件夹是可有可无的第 3 段
    if len(parts) < 3 or parts[0] in (".trash", ".cache"):
        raise ValueError("素材不在可整理的结构里")
    category = parts[0]
    sub = parts[1] if len(parts) >= 3 else ""
    name = os.path.basename(full)

    target = safe_category(target) if str(target or "").strip() else ""
    if level == "sub":
        # 改二级 TAB：目标目录 = 图库/目标TAB（丢弃原三级文件夹层级）
        if not target:
            raise ValueError("二级分类名不能为空")
        target_dir = os.path.join(root, category, target)
    else:
        # 改三级文件夹：目标目录 = 图库/原子分类/目标三级（target 为空=移回该 TAB 根）
        target_dir = os.path.join(root, category, sub, target) if target else os.path.join(root, category, sub)
    os.makedirs(target_dir, exist_ok=True)
    dst = os.path.abspath(os.path.join(target_dir, name))

    # 目标不能越出素材根，也不能和已有文件同名（避免覆盖）
    if not is_within_root(dst):
        raise ValueError("目标位置在素材库之外")
    if os.path.abspath(dst) == full:
        return full
    if os.path.exists(dst):
        raise ValueError("目标文件夹已有同名素材，未覆盖")

    shutil.move(full, dst)

    # 收藏快照的 key 是绝对路径，跟着迁移
    favorites = _load_favorites()
    old_key, new_key = _fav_key(full), _fav_key(dst)
    if old_key in favorites:
        favorites[new_key] = favorites.pop(old_key)
        _save_favorites(favorites)

    # 重建该图库索引：file 字段自动指向新路径（缩略图 key 不含路径，缓存照常命中）
    sync_index(safe_category(category))
    return dst


async def move_asset(request):
    """拖拽卡片到二级 TAB 或三级标签：同图库内改分类。level=sub 改二级 TAB，level=third 改三级文件夹。禁止跨图库。"""
    try:
        payload = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "请求体不是合法 JSON"}, status=400)

    path = str(payload.get("path") or "").strip()
    target = str(payload.get("target") or "").strip()
    level = str(payload.get("level") or "third").strip()
    if level not in ("sub", "third"):
        level = "third"
    if not path or not os.path.isfile(path):
        return web.json_response({"ok": False, "error": "文件不存在"}, status=404)
    if not is_within_root(path):
        return web.json_response({"ok": False, "error": "文件不在素材库目录内"}, status=403)

    # 边界校验：源至少落在「图库/子分类/文件」三段结构里
    rel_root = os.path.relpath(os.path.abspath(path), asset_root()).replace("\\", "/").split("/")
    if len(rel_root) < 3 or rel_root[0] in (".trash", ".cache"):
        return web.json_response({"ok": False, "error": "该素材不是分类文件夹结构，无法移动"}, status=400)

    try:
        dst = await asyncio.to_thread(_move, path, target, level)
    except ValueError as error:
        return web.json_response({"ok": False, "error": str(error)}, status=400)
    except Exception as error:
        return web.json_response({"ok": False, "error": f"移动失败：{error}"}, status=500)

    return web.json_response({"ok": True, "moved_to": dst, "path": dst})


async def delete_asset(request):
    """素材管理页的真删除：先清缩略图缓存，再把原图移进根目录下的 .trash（不永久删）。"""
    try:
        payload = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "请求体不是合法 JSON"}, status=400)

    path = str(payload.get("path") or "").strip()
    if not path or not os.path.isfile(path):
        return web.json_response({"ok": False, "error": "文件不存在"}, status=404)
    if not is_within_root(path):
        return web.json_response({"ok": False, "error": "文件不在素材库目录内"}, status=403)

    try:
        target = await asyncio.to_thread(_remove, path)
    except Exception as error:
        return web.json_response({"ok": False, "error": f"删除失败：{error}"}, status=500)

    return web.json_response({"ok": True, "moved_to": target})


# ==============================================================================
# HTTP 路由 · 浏览 / 配置 / 上传
# ==============================================================================
LIBRARY_ROUTE = "/alili/asset/library"
THUMB_ROUTE = "/alili/asset/thumb"
FILE_ROUTE = "/alili/asset/file"
CONFIG_ROUTE = "/alili/asset/config"
BROWSE_ROUTE = "/alili/asset/browse"
UPLOAD_ROUTE = "/alili/asset/upload"
IMPORT_FILE_ROUTE = "/alili/asset/import-file"
UPDATE_ROUTE = "/alili/asset/update"
SUBS_ROUTE = "/alili/asset/subs"
ICON_ROUTE = "/alili/icon"

# 图库图标：插件根目录 /icons/<拼音>.svg（renxiang / faxing / zishi / fuzhuang …）
ICON_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")
_ICON_NAME_RE = re.compile(r"^[a-z0-9_]+\.svg$")


def list_icon_names() -> list[str]:
    """图标名（不带 .svg），给前端决定哪些图库有图标。"""
    try:
        with os.scandir(ICON_DIR) as entries:
            return sorted(
                os.path.splitext(entry.name)[0].lower()
                for entry in entries
                if entry.is_file() and _ICON_NAME_RE.match(entry.name.lower())
            )
    except OSError:
        return []


def _thumb_url(path: str) -> str:
    return f"{THUMB_ROUTE}?path={quote(path)}"


def _file_url(path: str) -> str:
    return f"{FILE_ROUTE}?path={quote(path)}"


def _snapshot(category: str, has_sub: bool, sub: str) -> dict:
    """扫盘（stat + 读尺寸 + 建索引）放到线程里跑 —— 几千张素材时不阻塞事件循环。"""
    items = list_assets(category, sub if has_sub else None) if category else []
    for item in items:
        item["thumb"] = _thumb_url(item["path"])
        item["url"] = _file_url(item["path"])
    return {
        "items": items,
        "subs": list_subs(category) if category else [],
        "categories": list_categories(),
        "stats": category_stats(),
    }


async def library(request):
    category = (request.query.get("category") or "").strip()
    # 带不带 sub 是两种意思：不带 = 图库全部，带空串 = 只要未分类
    has_sub = "sub" in request.query
    sub = (request.query.get("sub") or "").strip()
    try:
        data = await asyncio.to_thread(_snapshot, category, has_sub, sub)
    except ValueError as error:
        return web.json_response({"ok": False, "error": str(error)}, status=400)

    return web.json_response({
        "ok": True,
        "root": asset_root(),
        "root_display": root_display(),
        "category": category,
        "sub": sub if has_sub else None,
        "icons": list_icon_names(),
        **data,
    })


async def favorites(request):
    try:
        items = await asyncio.to_thread(list_favorites)
    except OSError as error:
        return web.json_response({"ok": False, "error": f"读取收藏失败：{error}"}, status=500)
    return web.json_response({"ok": True, "items": items})


async def favorite(request):
    try:
        payload = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "请求体不是合法 JSON"}, status=400)

    path = str(payload.get("path") or "").strip()
    if not path:
        return web.json_response({"ok": False, "error": "缺少 path"}, status=400)
    if not is_within_root(path):
        return web.json_response({"ok": False, "error": "文件不在素材库目录内"}, status=403)

    snapshot = payload.get("item") if isinstance(payload.get("item"), dict) else None
    result = await asyncio.to_thread(set_favorite, path, snapshot, bool(payload.get("on")))
    return web.json_response(result)


def _resolve(request) -> str:
    path = (request.query.get("path") or "").strip()
    if not path:
        raise web.HTTPBadRequest(text="缺少 path")
    if not os.path.isfile(path):
        raise web.HTTPNotFound(text="文件不存在")
    if not is_within_root(path):
        raise web.HTTPForbidden(text="文件不在素材库目录内")
    return path


async def thumb(request):
    path = _resolve(request)
    try:
        cache = await asyncio.to_thread(ensure_thumb, path)
    except Exception as error:
        return web.json_response({"ok": False, "error": f"生成缩略图失败：{error}"}, status=500)
    return web.FileResponse(cache, headers={"Cache-Control": "public, max-age=86400"})


async def file(request):
    return web.FileResponse(_resolve(request))


def _config_payload() -> dict:
    return {
        "ok": True,
        "root": asset_root(),
        "root_display": root_display(),
        "configured": configured_root(),
        "default": default_root(),
        "default_display": portable_path(default_root()),
        "base": comfy_root(),
    }


async def config(request):
    if request.method == "GET":
        return web.json_response(_config_payload())
    try:
        payload = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "请求体不是合法 JSON"}, status=400)
    try:
        set_asset_root(payload.get("root") or "")
    except (ValueError, OSError) as error:
        return web.json_response({"ok": False, "error": str(error)}, status=400)
    return web.json_response({
        **_config_payload(),
        "categories": await asyncio.to_thread(list_categories),
        "stats": await asyncio.to_thread(category_stats),
    })


async def browse(request):
    path = (request.query.get("path") or "").strip()
    return web.json_response({"ok": True, **list_subdirs(path)})


async def upload(request):
    """浏览器选图上传：multipart（category / sub / name / file）。"""
    category = ""
    label = ""
    sub = ""
    data = None
    ext = ".png"

    if (request.content_type or "").startswith("multipart/"):
        reader = await request.multipart()
        while True:
            part = await reader.next()
            if part is None:
                break
            if part.name == "category":
                category = await part.text()
            elif part.name == "sub":
                sub = await part.text()
            elif part.name == "name":
                label = await part.text()
            elif part.name == "file":
                ext = os.path.splitext(part.filename or "")[1].lower() or ".png"
                data = await part.read()
    else:
        return web.json_response({"ok": False, "error": "请用 multipart 上传"}, status=400)

    if not data:
        return web.json_response({"ok": False, "error": "没有收到图片数据"}, status=400)

    try:
        return web.json_response(await asyncio.to_thread(write_asset, category, label, data, ext, sub))
    except ValueError as error:
        return web.json_response({"ok": False, "error": str(error)}, status=400)
    except Exception as error:
        return web.json_response({"ok": False, "error": f"写盘失败：{error}"}, status=500)


async def import_file(request):
    try:
        payload = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "请求体不是合法 JSON"}, status=400)
    try:
        result = await asyncio.to_thread(
            import_local_file,
            payload.get("category") or "",
            payload.get("name") or "",
            payload.get("path") or "",
            payload.get("sub") or "",
        )
    except ValueError as error:
        return web.json_response({"ok": False, "error": str(error)}, status=400)
    except Exception as error:
        return web.json_response({"ok": False, "error": f"导入失败：{error}"}, status=500)
    return web.json_response(result)


async def update_entry(request):
    """改素材的显示名 / 标签，写回该图库的 index.json。"""
    try:
        payload = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "请求体不是合法 JSON"}, status=400)
    try:
        category = safe_category(payload.get("category") or "")
        rel = str(payload.get("rel") or "").replace("\\", "/")
        patch = {}
        if "name" in payload:
            patch["name"] = payload.get("name")
        if "tags" in payload:
            tags = payload.get("tags")
            if isinstance(tags, str):
                tags = [part.strip() for part in tags.replace("，", ",").split(",") if part.strip()]
            patch["tags"] = tags if isinstance(tags, list) else []
        if not rel or not patch:
            return web.json_response({"ok": False, "error": "缺少 rel 或要修改的字段"}, status=400)
        ok = await asyncio.to_thread(update_index_entry, category, rel, patch)
    except ValueError as error:
        return web.json_response({"ok": False, "error": str(error)}, status=400)
    if not ok:
        return web.json_response({"ok": False, "error": "索引里没有这条素材"}, status=404)
    return web.json_response({
        "ok": True,
        "items": await asyncio.to_thread(list_assets, category),
        "subs": await asyncio.to_thread(list_subs, category),
    })


async def subs(request):
    """某个图库下的 TAB 列表（给「存为素材」弹窗的二级下拉用）。"""
    category = (request.query.get("category") or "").strip()
    if not category:
        return web.json_response({"ok": True, "subs": []})
    try:
        return web.json_response({"ok": True, "subs": list_subs(category)})
    except ValueError as error:
        return web.json_response({"ok": False, "error": str(error)}, status=400)


async def icon(request):
    """图库图标：/alili/icon/renxiang.svg（也接受不带扩展名）。"""
    name = (request.match_info.get("name") or "").strip().lower()
    if not name.endswith(".svg"):
        name += ".svg"
    if not _ICON_NAME_RE.match(name):
        raise web.HTTPNotFound()
    path = os.path.join(ICON_DIR, name)
    if not os.path.isfile(path):
        raise web.HTTPNotFound()
    return web.FileResponse(path, headers={
        "Content-Type": "image/svg+xml",
        "Cache-Control": "public, max-age=604800",
    })


def register_routes() -> bool:
    """把素材库的全部路由挂到 ComfyUI 的 aiohttp 实例上；实例还没起来时由 __init__ 下次再试。"""
    global _ROUTES_REGISTERED
    if _ROUTES_REGISTERED:
        return True
    instance = getattr(PromptServer, "instance", None)
    if instance is None:
        return False

    # 入库 / 删除
    instance.routes.post(IMPORT_ROUTE)(import_asset)
    instance.routes.get(CATEGORIES_ROUTE)(list_asset_categories)
    instance.routes.post(DELETE_ROUTE)(delete_asset)
    instance.routes.post(MOVE_ROUTE)(move_asset)

    # 浏览 / 配置 / 上传
    instance.routes.get(LIBRARY_ROUTE)(library)
    instance.routes.get(SUBS_ROUTE)(subs)
    instance.routes.get(THUMB_ROUTE)(thumb)
    instance.routes.get(FILE_ROUTE)(file)
    instance.routes.route("*", CONFIG_ROUTE)(config)
    instance.routes.get(FAVORITES_ROUTE)(favorites)
    instance.routes.post(FAVORITE_ROUTE)(favorite)
    instance.routes.get(BROWSE_ROUTE)(browse)
    instance.routes.post(UPLOAD_ROUTE)(upload)
    instance.routes.post(IMPORT_FILE_ROUTE)(import_file)
    instance.routes.post(UPDATE_ROUTE)(update_entry)
    instance.routes.get(ICON_ROUTE + "/{name}")(icon)

    _ROUTES_REGISTERED = True
    return True


_ROUTES_REGISTERED = False
register_routes()
