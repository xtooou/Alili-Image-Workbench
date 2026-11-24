"""改造预设（Shop Presets）——从磁盘挑一条成品，原样返回，不做拼接、不做改写。

prompt/look_prompt/*.md 是手写的成品提示词，一条对应一个组合：

    ---
    title: 换装
    slots: cloth
    ---
    保持图1构图、人物面部、发型……替换为图2的同款服饰……

正文里直接写「图1 / 图2 / 图3 / 图4」，没有占位符、不需要任何替换：
图1 是底图，后续参考图按 服装 → 姿势 → 发型 的顺序排（图2、图3、图4）。

槽位标签只有三个，用来和勾选的组合做匹配（不是图库分类）：

    cloth 服装 / pose 姿势 / hair 发型

2^3-1 = 7 种非空组合，正好对应 7 个文件。前端按勾选的组合找到 slots 完全一致的
那一条，把正文整段填进提示词——一个字都不改。

本模块不生成文案、不调用 LLM、不读参考图、不判断角色。
"""

from __future__ import annotations

import re
from pathlib import Path

from aiohttp import web
from server import PromptServer

SLOT_ORDER = ("base", "cloth", "pose", "hair")
ACTIVE_ORDER = ("cloth", "pose", "hair")
SLOT_LABELS = {"base": "底图", "cloth": "服装", "pose": "姿势", "hair": "发型"}

PRESET_ROOT = Path(__file__).resolve().parents[1] / "prompt" / "look_prompt"
PRESET_MAX_CHARS = 65536

_INDEX_PREFIX = re.compile(r"^\d+\s*[-_.、]?\s*")
_SLOT_SPLIT = re.compile(r"[,，、\s]+")


def _parse(path: Path) -> dict | None:
    text = path.read_text(encoding="utf-8-sig")
    meta: dict[str, str] = {}
    body = text.strip()
    if body.startswith("---"):
        head, _, tail = body[3:].partition("\n---")
        body = tail.strip()
        for line in head.splitlines():
            if ":" in line:
                key, value = line.split(":", 1)
                meta[key.strip().lower()] = value.strip()

    slots = [s for s in _SLOT_SPLIT.split(str(meta.get("slots") or "")) if s in ACTIVE_ORDER]
    if not slots or not body:
        return None            # 没有 slots 的 md 不是组合预设，忽略
    if len(body) > PRESET_MAX_CHARS:
        body = body[:PRESET_MAX_CHARS]

    title = (meta.get("title") or _INDEX_PREFIX.sub("", path.stem)).strip()
    return {
        "id": path.stem,
        "title": title,
        "slots": [s for s in ACTIVE_ORDER if s in set(slots)],
        "text": body,
    }


def list_presets() -> list[dict]:
    if not PRESET_ROOT.is_dir():
        return []
    out: list[dict] = []
    for path in sorted(PRESET_ROOT.glob("*.md"), key=lambda p: p.stem):
        try:
            item = _parse(path)
        except OSError:
            continue
        if item:
            out.append(item)
    return out


async def get_presets(_request):
    return web.json_response(
        {
            "presets": list_presets(),
            "slots_order": list(SLOT_ORDER),
            "active_order": list(ACTIVE_ORDER),
            "slots_labels": SLOT_LABELS,
        }
    )


_ROUTES_REGISTERED = False


def register_shop_routes() -> bool:
    global _ROUTES_REGISTERED
    if _ROUTES_REGISTERED:
        return True
    instance = getattr(PromptServer, "instance", None)
    if instance is None:
        return False
    routes = instance.routes
    for prefix in ("/alili/image-workbench/shop", "/alili/shop"):
        routes.get(f"{prefix}/presets")(get_presets)
    _ROUTES_REGISTERED = True
    return True


register_shop_routes()
