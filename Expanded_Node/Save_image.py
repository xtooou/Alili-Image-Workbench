"""Alili 保存图像节点

- 出图一律直接写进 output 目录（带工作流元数据，和原生 Save Image 一样），没有自动保存开关、
  也没有临时图 / 手动保存按钮。
- 分镜多图：每次执行只把图交给前端，画廊按到达顺序追加，不再一张覆盖一张。
- 每张图的结果里带 w / h，供画廊在缩略图底部显示分辨率。
- 不做遮罩外还原、不做原图对比：工作台不再提供遮罩 / 扩图类功能。
"""
from __future__ import annotations

import json
import os

import folder_paths
import numpy as np
from comfy.cli_args import args
from comfy_api.latest import io
from PIL import Image
from PIL.PngImagePlugin import PngInfo

NODE_CATEGORY = "Alili"
DEFAULT_PREFIX = "Alili/Alili"

# 前端画廊读取的 ui 键名。刻意不用 "images"，避免被 ComfyUI 自带的节点预览覆盖（那就是"出一张覆盖一张"的来源）
UI_IMAGES = "alili_images"


def _tensor_to_pil(tensor) -> Image.Image:
    array = 255.0 * tensor.cpu().numpy()
    return Image.fromarray(np.clip(array, 0, 255).astype(np.uint8))


def _build_metadata(prompt, extra_pnginfo):
    if args.disable_metadata:
        return None
    metadata = PngInfo()
    if prompt is not None:
        metadata.add_text("prompt", json.dumps(prompt))
    if extra_pnginfo is not None:
        for key, value in extra_pnginfo.items():
            metadata.add_text(key, json.dumps(value))
    return metadata


def _save_tensors(images, prefix, metadata):
    """把一批图写进 output 目录，返回带 w/h 的 {filename, subfolder, type} 列表。"""
    height, width = int(images[0].shape[0]), int(images[0].shape[1])
    full_folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(
        prefix, folder_paths.get_output_directory(), width, height
    )
    results = []
    for tensor in images:
        name = f"{filename}_{counter:05}_.png"
        _tensor_to_pil(tensor).save(
            os.path.join(full_folder, name), pnginfo=metadata, compress_level=4
        )
        results.append({
            "filename": name,
            "subfolder": subfolder,
            "type": "output",
            "w": int(tensor.shape[1]),
            "h": int(tensor.shape[0]),
        })
        counter += 1
    return results


class AliliSaveImage(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="AliliSaveImage",
            display_name="Alili 保存图像",
            category=NODE_CATEGORY,
            description="保存出图（始终写入 output）；分镜多图按序排开、带元数据。",
            is_output_node=True,
            inputs=[
                io.Image.Input("images", display_name="保存图像"),
                io.String.Input("filename_prefix", display_name="路径", default=DEFAULT_PREFIX),
            ],
            hidden=[io.Hidden.prompt, io.Hidden.extra_pnginfo],
        )

    @classmethod
    def execute(cls, images, filename_prefix=DEFAULT_PREFIX):
        metadata = _build_metadata(cls.hidden.prompt, cls.hidden.extra_pnginfo)
        results = _save_tensors(images, filename_prefix or DEFAULT_PREFIX, metadata)
        return io.NodeOutput(ui={UI_IMAGES: results})
