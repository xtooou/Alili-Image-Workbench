"""Alili 加载图像节点

维护参考图列表（最多 9 张，顺序即 <imageN> 的 N），打包成 ALILI_IMAGES。
不做遮罩、不做扩图、不生成。唯一的图像处理是「可选的参考图缩放」：
开关关闭时张量原样透传（与旧版一致）；开启时在内存里按总像素等比缩放，
不写任何文件、不覆盖 input 目录里的原图，三家编辑模型统一拿到缩放后的张量。
"""
from __future__ import annotations

import json
import math
import os

import folder_paths
import numpy as np
import torch
from comfy_api.latest import io
from PIL import Image, ImageOps

NODE_CATEGORY = "Alili"
ALILI_IMAGES = "ALILI_IMAGES"
MAX_IMAGES = 9


# ==============================================================================
# 公共函数：工作台 / 展开节点都用这里的
# ==============================================================================

def image_list(load):
    """展开节点用：参考图张量列表（最多 9 张），没有图返回空列表。"""
    if not isinstance(load, dict):
        return []
    return list(load.get("images") or [])[:MAX_IMAGES]


def first_image_size(load):
    """(宽, 高)：首张参考图的原始像素尺寸；没有图返回 (None, None)。

    删掉扩图之后，「自适应」比例只取原图比例，不再包含任何外补。
    """
    refs = image_list(load)
    if not refs:
        return None, None
    first = refs[0]
    return int(first.shape[2]), int(first.shape[1])


# ==============================================================================
# 读文件
# ==============================================================================

def _path_of(name):
    """解析图像路径。

    - 素材库内的绝对路径：放行（白名单校验，只认素材根目录下的文件）
    - 其余按 ComfyUI 惯例走 input / output / temp 相对路径
    """
    raw = str(name)
    if os.path.isabs(raw):
        from ..image_workbench.assets import is_within_root
        if not is_within_root(raw):
            raise ValueError(f"图像不在素材库目录内：{raw}")
        if not os.path.isfile(raw):
            raise ValueError(f"找不到图像文件：{raw}（可能已被删除，请重新选择）")
        return raw

    path = folder_paths.get_annotated_filepath(raw)
    if not path or not os.path.isfile(path):
        raise ValueError(f"找不到图像文件：{name}（可能已被删除，请在加载图像节点里移除后重新添加）")
    return path


def _load_image(name):
    image = ImageOps.exif_transpose(Image.open(_path_of(name)))
    if image.mode == "I":
        image = image.point(lambda i: i * (1 / 255))
    array = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
    return torch.from_numpy(array)[None,]


def _parse_state(text):
    try:
        state = json.loads(text or "{}")
    except (TypeError, ValueError):
        return {}
    return state if isinstance(state, dict) else {}


# ==============================================================================
# 可选的参考图缩放：内存张量，不落盘
# 配置存在 state["resize"] = {enabled, megapixels, include_first}
# ==============================================================================

RESIZE_METHOD = "area"          # 与 H3 官流一致；area 对缩小最稳，留常量以后可开放
RESIZE_MIN_MP = 0.1
RESIZE_MAX_MP = 16.0
RESIZE_DEFAULT_MP = 1.0
RESIZE_ALIGN = 8                # VAE 要求 8 的倍数；内部对齐，不暴露为参数


def _resize_config(state):
    """解析缩放配置；缺省 = 关闭，老工作流行为不变。"""
    cfg = state.get("resize")
    if not isinstance(cfg, dict):
        return {"enabled": False, "megapixels": RESIZE_DEFAULT_MP, "include_first": True}
    try:
        enabled = bool(cfg.get("enabled", False))
    except (TypeError, ValueError):
        enabled = False
    try:
        mp = float(cfg.get("megapixels", RESIZE_DEFAULT_MP))
    except (TypeError, ValueError):
        mp = RESIZE_DEFAULT_MP
    mp = min(RESIZE_MAX_MP, max(RESIZE_MIN_MP, mp))
    try:
        include_first = bool(cfg.get("include_first", True))
    except (TypeError, ValueError):
        include_first = True
    return {"enabled": enabled, "megapixels": mp, "include_first": include_first}


def _target_size(width, height, megapixels):
    """按总像素 + 原比例算目标宽高，按 8 倍数取整（内部约束，不做倍数参数）。"""
    ratio = width / float(height)
    total = max(RESIZE_MIN_MP, float(megapixels)) * 1024 * 1024
    new_w = math.sqrt(total * ratio)
    new_h = math.sqrt(total / ratio)
    new_w = max(RESIZE_ALIGN, int(round(new_w / RESIZE_ALIGN)) * RESIZE_ALIGN)
    new_h = max(RESIZE_ALIGN, int(round(new_h / RESIZE_ALIGN)) * RESIZE_ALIGN)
    return new_w, new_h


def _resize_tensor(image, megapixels):
    """在内存里缩放一张 [1,H,W,C] 的 float 张量，返回同结构张量。

    用 PIL 的 BOX/area 算法（缩小质量与 ComfyUI 的 area 一致），不写文件。
    """
    _, h, w, c = image.shape
    new_w, new_h = _target_size(w, h, megapixels)
    if new_w == w and new_h == h:
        return image
    arr = (image[0].cpu().numpy() * 255.0).clip(0, 255).astype(np.uint8)
    pil = Image.fromarray(arr, mode="RGB" if c == 3 else "RGBA")
    box = getattr(getattr(Image, "Resampling", Image), "BOX", Image.BILINEAR)
    pil = pil.resize((new_w, new_h), box)
    out = np.asarray(pil, dtype=np.float32) / 255.0
    return torch.from_numpy(out[None,])


# ==============================================================================
# 裁剪：归一化 rect（x, y, w, h 都是 0~1）切张量
# 只在内存里切，不改 input 里的原图，也不改文件 mtime。
# 顺序固定「先裁剪、后缩放」：裁剪决定构图，缩放决定总像素。
# ==============================================================================

def _apply_crop(image, crop):
    if not isinstance(crop, dict):
        return image
    rect = crop.get("rect")
    if not isinstance(rect, (list, tuple)) or len(rect) != 4:
        return image
    try:
        x, y, w, h = (min(max(float(value), 0.0), 1.0) for value in rect)
    except (TypeError, ValueError):
        return image

    w = min(w, 1.0 - x)
    h = min(h, 1.0 - y)
    if w <= 0.0 or h <= 0.0:
        return image

    _, height, width, _ = image.shape
    left = min(int(round(x * width)), width - 1)
    top = min(int(round(y * height)), height - 1)
    right = min(width, max(left + 1, int(round((x + w) * width))))
    bottom = min(height, max(top + 1, int(round((y + h) * height))))
    return image[:, top:bottom, left:right, :]


class AliliLoadImage(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="AliliLoadImage",
            display_name="Alili 加载图像",
            category=NODE_CATEGORY,
            description="加载最多 9 张参考图打包 ALILI_IMAGES；可选按总像素内存缩放（不改原图），交给工作台 / Alili 文本编码。",
            inputs=[
                io.String.Input("alili_state_json", default="", optional=True, extra_dict={"hidden": True}),
            ],
            outputs=[io.Custom(ALILI_IMAGES).Output(display_name="图像")],
        )

    @classmethod
    def execute(cls, alili_state_json=""):
        state = _parse_state(alili_state_json)

        names = []
        images = []
        for item in (state.get("images") or [])[:MAX_IMAGES]:
            name = item.get("name") if isinstance(item, dict) else item
            if not isinstance(name, str) or not name:
                continue
            image = _load_image(name)
            if isinstance(item, dict):
                image = _apply_crop(image, item.get("crop"))
            names.append(name)
            images.append(image)

        # 可选缩放：只在内存里做，原图文件一个字节都不动。
        # include_first=False 时第 1 张（主体参考）保持原样，其余按总像素等比缩放。
        cfg = _resize_config(state)
        if cfg["enabled"]:
            scaled = []
            for index, image in enumerate(images):
                if index == 0 and not cfg["include_first"]:
                    scaled.append(image)
                else:
                    scaled.append(_resize_tensor(image, cfg["megapixels"]))
            images = scaled

        return io.NodeOutput({
            "images": images,
            "names": names,
            "has_image": bool(images),
        })
