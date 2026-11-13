"""Alili 文本编码节点（原「工作台展开」）

把官方文本编码器吞进节点内部：工作台数据包里的 9 张参考图直接打包成官方 `images` 字典，
不再对外暴露 9 个 IMAGE 口。家族由前端读 CLIPLoader 的 `type` 自动识别，内部自动切换。

连线输入：工作台 / CLIP / VAE / 触发词
节点控件：负向提示词（多行，显示在节点下方）
隐藏控件：model_family / cfg / resolution（由前端自动写入）
输出：正向条件 / 负向条件 / Latent

CFG <= 1 时负向条件零化，> 1 才启用真实负向。空 latent 规格按家族内部切换：
通用 EmptyLatentImage 或 Flux2 规格；Qwen 2.1 与 H3-Image 直接用官方返回的 latent。
若想使用外部空 latent 节点，把 KSampler 的 Latent 输入接到那个节点即可（本节点输出悬空）。
"""
from __future__ import annotations

from comfy_api.latest import io

from ..image_workbench import encoders
from .Load_image import image_list

NODE_CATEGORY = "Alili"
WORKBENCH_TYPE = "Alili"


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
                # 以下 3 个是隐藏 widget，不是连线口；由前端自动写入
                io.String.Input("model_family", default="", optional=True, extra_dict={"hidden": True}),
                io.Float.Input("cfg", default=1.0, optional=True, extra_dict={"hidden": True}),
                io.Int.Input("resolution", default=1024, optional=True, extra_dict={"hidden": True}),
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
            resolution=int(resolution or 1024),
        )
        return io.NodeOutput(positive, negative, latent)
