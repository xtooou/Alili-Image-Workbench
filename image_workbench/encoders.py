"""Alili 文本编码 · 官方编码器适配层（一个文件，四个分区）

设计原则：**不复制任何官方算法代码**。只 import ComfyUI 内核里的节点类，直接调用它们的
`execute()` / `generate()` / `zero_out()`。官方升级自动跟随，不会抄错也不会抄漏。

分区：
  [1] 普通 CLIP          —— 没有参考图 / 家族未识别时的默认分支
  [2] Qwen Image 2.1     —— comfy_extras.nodes_qwen.TextEncodeQwenImage21
  [3] MOSS-Image Edit    —— comfy_extras.nodes_moss_image.TextEncodeMOSSImageEdit
  [4] MiniMax-H3-Image   —— comfy_extras.nodes_minimax_h3.MiniMaxH3ImageConditioning
  [LT] 空 latent         —— 通用 EmptyLatentImage / Flux2 EmptyFlux2LatentImage

家族由前端读 CLIPLoader 的 `type` widget 得到（Alili-Manager 切换卡片时会自动改它），
经隐藏 widget `model_family` 传到这里。参考图直接来自工作台数据包，不再对外的 9 个 IMAGE 口。
"""
from __future__ import annotations

from nodes import ConditioningZeroOut, EmptyLatentImage

# CLIPLoader 的 type → 内部分区键。以 ComfyUI_Alili_V1.0 内核 nodes.py:1021 为准。
FAMILY_ALIASES = {
    "qwen_image": "qwen21",
    "qwen21": "qwen21",
    "moss_image": "moss",
    "moss": "moss",
    "minimax": "h3image",
    "h3image": "h3image",
    "flux2": "flux2",
    "klein": "flux2",
}

MAX_IMAGES = 9
EDIT_FORMAT = "Moss-Image-Edit"   # MOSS 官方 EDIT_FORMATS 三个选项之一
QWEN_RESOLUTION = 1024


def normalize_family(value) -> str:
    return FAMILY_ALIASES.get(str(value or "").strip().lower(), "plain")


# ==============================================================================
# [LT] 空 latent：直接调用官方节点，两种规格按家族内部切换
# ==============================================================================

def _generic_latent(width: int, height: int) -> dict:
    """图中第一个「空Latent图像」：4 通道 / 8 倍 + downscale_ratio_spacial=8。

    采样器会对全零 latent 自动补通道并换算 stride，所以这一路可覆盖大多数 2D 图像模型。
    """
    return EmptyLatentImage().generate(int(width), int(height), 1)[0]


def _flux2_latent(width: int, height: int) -> dict:
    """「空Latent图像（Flux2）」：128 通道 / 16 倍。MOSS / Flux2 / Klein 走这一路。"""
    from comfy_extras.nodes_flux import EmptyFlux2LatentImage
    return EmptyFlux2LatentImage.execute(int(width), int(height), 1)[0]


def _zero_negative(conditioning):
    """CFG = 1 时把负向条件零化（官方 ConditioningZeroOut）。"""
    return ConditioningZeroOut().zero_out(conditioning)[0]


def _image_slots(refs, start: int) -> dict:
    """工作台的 1-9 张参考图 → 官方 Autogrow 的 images 字典。

    Qwen 2.1 用 TemplateNames（1-based: image_1…），MOSS / H3-Image 用
    TemplatePrefix（0-based: image_0…）；三家都按键名里的数字排序，所以顺序天然对齐
    <image1> … <image9>。
    """
    return {f"image_{i + start}": image for i, image in enumerate(refs[:MAX_IMAGES])}


# ==============================================================================
# [1] 普通 CLIP —— 无参考图 / 未识别家族 / Flux2 类只影响 latent 规格
# ==============================================================================

def _plain(clip, prompt, negative_prompt, width, height, cfg, flux2_latent=False):
    positive = clip.encode_from_tokens_scheduled(clip.tokenize(prompt))
    if cfg > 1.0:
        negative = clip.encode_from_tokens_scheduled(clip.tokenize(negative_prompt or ""))
    else:
        negative = _zero_negative(positive)
    latent = _flux2_latent(width, height) if flux2_latent else _generic_latent(width, height)
    return positive, negative, latent


# ==============================================================================
# [2] Qwen Image 2.1 —— 官方一次就返回 正 / 负 / latent，最省事
# ==============================================================================

def _qwen21(clip, vae, prompt, negative_prompt, refs, resolution):
    from comfy_extras.nodes_qwen import TextEncodeQwenImage21
    out = TextEncodeQwenImage21.execute(
        clip, prompt, negative_prompt or "",
        vae=vae, resolution=resolution, images=_image_slots(refs, 1),
    )
    # latent 是官方按第一张参考图尺寸算好的 64ch/16x，编辑不会偏移
    return out[0], out[1], out[2]


# ==============================================================================
# [3] MOSS-Image Edit —— 官方只返回一个 conditioning，正/负各跑一次
# ==============================================================================

def _moss(clip, vae, prompt, negative_prompt, refs, width, height, cfg):
    from comfy_extras.nodes_moss_image import TextEncodeMOSSImageEdit
    images = _image_slots(refs, 0)
    positive = TextEncodeMOSSImageEdit.execute(
        clip, prompt, EDIT_FORMAT, images, vae=vae, image_strength=1.0,
    )[0]
    if cfg > 1.0:
        negative = TextEncodeMOSSImageEdit.execute(
            clip, negative_prompt or "", EDIT_FORMAT, images, vae=vae, image_strength=1.0,
        )[0]
    else:
        negative = _zero_negative(positive)
    # 官方 MOSS 工作流用 Flux2 空 latent
    return positive, negative, _flux2_latent(width, height)


# ==============================================================================
# [4] MiniMax-H3-Image —— 官方返回 正 + latent（[1,24,1,H/16,W/16]），没有负向
# ==============================================================================

def _h3image(clip, vae, prompt, negative_prompt, refs, width, height, cfg):
    from comfy_extras.nodes_minimax_h3 import MiniMaxH3ImageConditioning
    out = MiniMaxH3ImageConditioning.execute(
        clip, prompt, int(width), int(height), vae=vae, images=_image_slots(refs, 0),
    )
    positive, latent = out[0], out[1]
    if cfg > 1.0:
        # 负向只要纯文本条件，不挂参考 latent
        negative = MiniMaxH3ImageConditioning.execute(
            clip, negative_prompt or "", int(width), int(height), vae=None, images={},
        )[0]
    else:
        negative = _zero_negative(positive)
    return positive, negative, latent


# ==============================================================================
# 统一入口
# ==============================================================================

def encode(*, family, clip, vae, prompt, negative_prompt, refs, width, height,
           cfg=1.0, resolution=QWEN_RESOLUTION):
    """返回 (positive, negative, latent)。CFG <= 1 时负向条件一律零化。"""
    refs = list(refs or [])[:MAX_IMAGES]
    key = normalize_family(family)
    cfg = float(cfg if cfg is not None else 1.0)
    width, height = int(width), int(height)

    # 没有参考图：一律普通 CLIP（用户要求），家族只决定 latent 规格
    if not refs:
        return _plain(clip, prompt, negative_prompt, width, height, cfg,
                      flux2_latent=(key == "flux2"))

    if key == "qwen21":
        positive, negative, latent = _qwen21(clip, vae, prompt, negative_prompt, refs, resolution)
        # CFG = 1（官方模板默认值）→ 负向零化；> 1 才启用真实负向条件
        if cfg <= 1.0:
            negative = _zero_negative(negative)
    elif key == "moss":
        positive, negative, latent = _moss(clip, vae, prompt, negative_prompt, refs, width, height, cfg)
    elif key == "h3image":
        positive, negative, latent = _h3image(clip, vae, prompt, negative_prompt, refs, width, height, cfg)
    else:
        # flux2 / 未识别：普通 CLIP 编码，latent 按需要走 Flux2 规格或通用规格
        return _plain(clip, prompt, negative_prompt, width, height, cfg,
                      flux2_latent=(key == "flux2"))

    # MOSS / H3-Image 分支内部已按 cfg 决定是否零化负向
    return positive, negative, latent
