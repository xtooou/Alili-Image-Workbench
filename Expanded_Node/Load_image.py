"""Alili 加载图像节点

只负责维护参考图列表（最多 9 张，顺序即 <imageN> 的 N），原样打包成 ALILI_IMAGES。
不做遮罩、不做扩图、不缩放、不生成。
"""
from __future__ import annotations

import json
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
    path = folder_paths.get_annotated_filepath(str(name))
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


class AliliLoadImage(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="AliliLoadImage",
            display_name="Alili 加载图像",
            category=NODE_CATEGORY,
            description="加载最多 9 张参考图，原样打包 ALILI_IMAGES 交给工作台 / Alili 文本编码。",
            inputs=[
                io.String.Input("alili_state_json", default="", optional=True, extra_dict={"hidden": True}),
            ],
            outputs=[io.Custom(ALILI_IMAGES).Output(display_name="图像")],
        )

    @classmethod
    def execute(cls, alili_state_json=""):
        state = _parse_state(alili_state_json)

        names = []
        for item in (state.get("images") or [])[:MAX_IMAGES]:
            name = item.get("name") if isinstance(item, dict) else item
            if isinstance(name, str) and name:
                names.append(name)
        images = [_load_image(name) for name in names]

        return io.NodeOutput({
            "images": images,
            "names": names,
            "has_image": bool(images),
        })
