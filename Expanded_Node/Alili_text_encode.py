"""Alili 文本编码节点（原「工作台展开」）

把官方文本编码器吞进节点内部：工作台数据包里的 9 张参考图直接打包成官方 `images` 字典，
不再对外暴露 9 个 IMAGE 口。家族由前端读 CLIPLoader 的 `type` 自动识别，内部自动切换。

连线输入：工作台 / CLIP / VAE / 触发词
节点控件：负向提示词（多行，显示在节点下方）
隐藏控件：model_family / cfg（前端写入）、resolution（兼容保留，后端自动推导）
输出：正向条件 / 负向条件 / Latent

CFG <= 1 时负向条件零化，> 1 才启用真实负向。空 latent 规格按家族内部切换：
通用 EmptyLatentImage 或 Flux2 规格；Qwen 2.1 用工作台尺寸生成同规格 64ch/16x 空 latent
（参考图一张不裁，正负条件仍原样来自官方 execute）；H3-Image 直接用官方返回的 latent。
若想使用外部空 latent 节点，把 KSampler 的 Latent 输入接到那个节点即可（本节点输出悬空）。
"""
from __future__ import annotations

import logging
import math

from comfy_api.latest import io

from ..image_workbench import encoders
from .Load_image import image_list

NODE_CATEGORY = "Alili"
WORKBENCH_TYPE = "Alili"


# 参考图面积预算（总像素）：官方节点会把每张参考图缩放到 resolution × resolution 的面积。
# 之前的写法是「每张参考图 = 画布面积」，2MP 画布 + 4 张参考图 = 10MP 的 token，
# 而 Qwen 2.1 的 block_causal 注意力代价随总长度平方增长 → 单步耗时直接翻几倍。
# 这里改成和孤海 GHIL 完全相同的分档规则：图越多，每张摊到的面积越小。
REF_AREA_TWO_IMAGES = 2048 * 2048   # 1~2 张：最多跟画布同面积（单图编辑画质优先）
REF_AREA_FOUR_IMAGES = 1024 * 1024  # 3~4 张：每张 1MP（与 GHIL 默认一致）
REF_AREA_MANY_IMAGES = 768 * 768    # 5 张以上：每张 0.59MP


def _ref_resolution(width: int, height: int, count: int) -> int:
    """按参考图张数摊薄面积，返回官方节点要的 resolution（面积 = resolution²）。

    单图/两张：保持画布面积（画质优先，与旧行为一致，单图编辑不受影响）。
    三张以上：回归 GHIL 的 1024² / 768²，避免多图时 token 爆炸拖慢采样。
    """
    count = max(0, int(count))
    if count <= 0:
        return 1024
    if count <= 2:
        area = min(max(1, int(width) * int(height)), REF_AREA_TWO_IMAGES)
    elif count <= 4:
        area = REF_AREA_FOUR_IMAGES
    else:
        area = REF_AREA_MANY_IMAGES
    side = round(math.sqrt(area) / 32) * 32
    return max(256, min(2048, int(side)))


def _override_resolution(value):
    """工作台可选的「参考图清晰度」覆盖：自动 / 768 / 1024 / 1344 / 2048。"""
    if value is None:
        return None
    text = str(value).strip()
    if not text or text in ("自动", "auto", "0"):
        return None
    try:
        side = int(round(float(text)))
    except (TypeError, ValueError):
        return None
    if side <= 0:
        return None
    return max(256, min(2048, round(side / 32) * 32))


class AliliTextEncode(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="AliliTextEncode",
            display_name="Alili 文本编码",
            category=NODE_CATEGORY,
            description=(
                "内置官方文本编码器并按模型家族自动切换（Qwen Image 2.1 / MOSS-Image / MiniMax-H3-Image），"
                "无参考图走普通 CLIP。输出正向条件、负向条件与空 latent。"
            ),
            inputs=[
                io.Custom(WORKBENCH_TYPE).Input("workbench", display_name="工作台"),
                io.Clip.Input("clip", display_name="CLIP"),
                io.Vae.Input("vae", display_name="VAE", optional=True),
                io.String.Input(
                    "trigger",
                    display_name="触发词",
                    optional=True,
                    force_input=True,
                    tooltip="LoRA 触发词等。会加在面板提示词前面，不会覆盖面板内容",
                ),
                # 负向提示词：CFG > 1 时才生效；CFG = 1 时后端会把负向条件零化
                io.String.Input(
                    "negative_prompt",
                    display_name="负向提示词",
                    multiline=True,
                    dynamic_prompts=True,
                    default="",
                    optional=True,
                    tooltip="CFG 为 1 时负向条件会被零化，写什么都不起作用；CFG 大于 1 才生效",
                ),
                # 以下 3 个是隐藏 widget，不是连线口；model_family / cfg 由前端写入
                io.String.Input("model_family", default="", optional=True, extra_dict={"hidden": True}),
                io.Float.Input("cfg", default=1.0, optional=True, extra_dict={"hidden": True}),
                # 兼容保留：前端不写入，后端按工作台宽高自动推导，旧工作流残留值会被忽略
                io.Int.Input("resolution", default=0, min=0, max=4096, step=32,
                             optional=True, extra_dict={"hidden": True}),
            ],
            outputs=[
                io.Conditioning.Output("positive", display_name="正向条件"),
                io.Conditioning.Output("negative", display_name="负向条件"),
                io.Latent.Output("latent", display_name="Latent"),
            ],
        )

    @classmethod
    def execute(cls, workbench, clip, vae=None, trigger=None, negative_prompt="",
                model_family="", cfg=1.0, resolution=1024):
        data = workbench if isinstance(workbench, dict) else {}

        prompt = str(data.get("prompt") or "")
        if trigger is not None and str(trigger).strip():
            head = str(trigger).strip().rstrip(",，、 ")
            prompt = f"{head}, {prompt}" if prompt else head

        width = int(data.get("width", 1024))
        height = int(data.get("height", 1024))
        refs = image_list(data.get("load"))

        # 参考图分辨率优先级：工作台 ref_res 覆盖 > 按张数自动分档。
        # 只走 Qwen 自己的两条来源。**不读加载节点的「参考图缩放」**：
        # 那个开关是给 MOSS / H3 编辑用的，两家的缩放语义不同
        # （MOSS 按 edit 格式吃固定短边、H3 按面积匹配），
        # 拿它的 MP 换算 Qwen 的 resolution 属于跨家族串味，MOSS 的编辑质量会跟着变。
        ref_res = _override_resolution(data.get("ref_res"))
        source = "工作台设定"
        if not ref_res:
            ref_res = _ref_resolution(width, height, len(refs))
            source = "按张数自动"
        qwen_resolution = ref_res
        if refs:
            tokens = (width // 16) * (height // 16) + len(refs) * (qwen_resolution // 16) ** 2
            logging.info(
                "Alili 文本编码：参考图 %d 张 → 每张 %dpx（面积 %.2fMP，来源：%s），画布 %dx%d，总 token≈%d",
                len(refs), qwen_resolution, qwen_resolution ** 2 / 1048576, source, width, height, tokens,
            )

        positive, negative, latent = encoders.encode(
            family=model_family,
            clip=clip,
            vae=vae,
            prompt=prompt,
            negative_prompt=str(negative_prompt or ""),
            refs=refs,
            width=width,
            height=height,
            cfg=cfg,
            resolution=qwen_resolution,
        )
        return io.NodeOutput(positive, negative, latent)
