"""Alili 多模态图像工作台节点

只管：提示词、分辨率、把参考图原样递给Alili 文本编码。不做任何图像处理，也不做任何文本编码。
"""
from __future__ import annotations

import json
import math
import re

from comfy_api.latest import io

from ..image_workbench.core import DEFAULT_CANVAS_MULTIPLE, MAX_RESOLUTION, round_to_multiple
from .Load_image import ALILI_IMAGES, first_image_size

NODE_CATEGORY = "Alili"
WORKBENCH_TYPE = "Alili"  # 工作台 → Alili 文本编码 的数据包类型

# 分辨率：比例 / 百万像素（按总像素算）/ 倍数取整（算法同 ComfyUI 官方 Resolution Selector：1.0 MP ≈ 1024x1024）
ASPECT_ADAPTIVE = "自适应"
ASPECTS = [ASPECT_ADAPTIVE, "1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16", "21:9"]
DEFAULT_MEGAPIXELS = 2.0


def calculate_canvas(
    aspect_ratio: str,
    megapixels: float,
    multiple: int,
    source_width: int | None = None,
    source_height: int | None = None,
) -> tuple[int, int]:
    """由 比例 + 总像素 算出画布宽高，并按「倍数取整」对齐。

    - 自适应：有参考图时沿用首张参考图的原始宽高比（只取比例，尺寸按百万像素重算）；没有参考图时按 1:1
    - 尺寸固定按总像素（百万像素）计算
    """
    if aspect_ratio == ASPECT_ADAPTIVE:
        if source_width and source_height and source_width > 0 and source_height > 0:
            ratio = source_width / source_height
        else:
            ratio = 1.0
    else:
        try:
            a, b = str(aspect_ratio).split(":")
            ratio = float(a) / float(b)
        except (ValueError, ZeroDivisionError):
            ratio = 1.0

    multiple = max(1, int(multiple or DEFAULT_CANVAS_MULTIPLE))
    total_pixels = max(0.01, float(megapixels or DEFAULT_MEGAPIXELS)) * 1024 * 1024
    width = round_to_multiple(math.sqrt(total_pixels * ratio), multiple)
    height = round_to_multiple(math.sqrt(total_pixels / ratio), multiple)
    return min(width, MAX_RESOLUTION), min(height, MAX_RESOLUTION)


# ---- 分镜出图：提示词形如  公共设定 【1】镜头一 【2】镜头二 ... ----
# 提示词里的图片引用：<image1> / <图片1> / image 1 / 图1 / 图片1 … 统一写成 <imageN>（只认 1-9）
_IMAGE_TAG = re.compile(
    r"<\s*(?:image|picture|图片|图像|图)\s*#?\s*([1-9])\s*>|"
    r"(?<![\w<])(?:image|picture)\s*#?\s*([1-9])(?!\d)(?!\s*>)|"
    r"(?:图片|图像|图)\s*#?\s*([1-9])(?!\d)",
    re.IGNORECASE,
)


def normalize_image_tags(prompt):
    return _IMAGE_TAG.sub(lambda m: f"<image{m.group(1) or m.group(2) or m.group(3)}>", prompt or "")


_SHOT_MARK = re.compile(r"【\s*\d+\s*】")


def split_shots(text):
    """返回 (公共前缀, [各镜头文本])；没有【n】标记时镜头列表为空。按出现顺序切分，不依赖标记里的数字。"""
    text = str(text or "")
    marks = list(_SHOT_MARK.finditer(text))
    if not marks:
        return text.strip(), []
    prefix = text[:marks[0].start()].strip()
    shots = []
    for i, mark in enumerate(marks):
        end = marks[i + 1].start() if i + 1 < len(marks) else len(text)
        shots.append(text[mark.end():end].strip())
    return prefix, shots


def pick_shot(text, shot_index):
    """shot_index = 0 或没有【n】标记：原样返回（普通单图，行为不变）。
    shot_index = n：取第 n 个镜头，并把公共前缀拼在前面；n 超出镜头数时取最后一个。"""
    try:
        index = int(shot_index or 0)
    except (TypeError, ValueError):
        index = 0
    if index <= 0:
        return text
    prefix, shots = split_shots(text)
    shots = [shot for shot in shots if shot]
    if not shots:
        return text
    shot = shots[min(index, len(shots)) - 1]
    return f"{prefix}\n{shot}" if prefix else shot


def _parse_state(alili_state_json):
    try:
        state = json.loads(alili_state_json or "{}")
    except (TypeError, ValueError):
        return {}
    return state if isinstance(state, dict) else {}


def _extract_shot_index(state):
    try:
        return int(state.get("shot_index", 0))
    except (TypeError, ValueError):
        return 0


class AliliImageWorkbench(io.ComfyNode):
    """只管：提示词、分辨率、把参考图原样递给Alili 文本编码。不做任何图像处理。"""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="AliliImageWorkbench",
            display_name="Alili 多模态图像工作台",
            category=NODE_CATEGORY,
            description="Alili 文生图 / 图生图 一体化多模态交互工作台。输出数据包交给「Alili 文本编码」。",
            inputs=[
                io.Custom(ALILI_IMAGES).Input(
                    "images",
                    display_name="图像",
                    optional=True,
                    tooltip="接 Alili 加载图像的输出口：用于提示词优化时的视觉参考、自适应比例，并原样传给Alili 文本编码",
                ),
                io.Combo.Input("aspect_ratio", display_name="比例", options=ASPECTS, default=ASPECT_ADAPTIVE),
                io.Float.Input("megapixels", display_name="百万像素", default=DEFAULT_MEGAPIXELS, min=0.1, max=16.0, step=0.1),
                io.Int.Input("multiple", display_name="倍数取整", default=DEFAULT_CANVAS_MULTIPLE, min=8, max=256, step=8),
                io.String.Input("prompt", multiline=True, dynamic_prompts=True, default="", extra_dict={"hidden": True}),
                io.String.Input("alili_state_json", default="", optional=True, extra_dict={"hidden": True}),
            ],
            outputs=[io.Custom(WORKBENCH_TYPE).Output(display_name="工作台")],
        )

    @classmethod
    def execute(cls, aspect_ratio, megapixels, multiple, prompt, alili_state_json="", images=None):
        state = _parse_state(alili_state_json)
        if isinstance(state.get("prompt"), str):
            prompt = state["prompt"]
        prompt = pick_shot(prompt, _extract_shot_index(state))
        prompt = normalize_image_tags(prompt)

        # 自适应：沿用首张参考图的原始宽高比（不再包含扩图外补）
        source_w, source_h = first_image_size(images)
        width, height = calculate_canvas(aspect_ratio, megapixels, multiple, source_w, source_h)

        return io.NodeOutput({
            "prompt": prompt,
            "width": width,
            "height": height,
            "load": images,
        })
