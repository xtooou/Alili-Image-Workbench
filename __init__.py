"""Alili-Image-Workbench: 多模态图像工作台"""

from comfy_api.latest import ComfyExtension

from .Expanded_Node.Alili_text_encode import AliliTextEncode
from .Expanded_Node.Load_image import AliliLoadImage
from .Expanded_Node.Save_image import AliliSaveImage
from .Expanded_Node.Workbench import AliliImageWorkbench
from .image_workbench import prompt_optimizer  # noqa: F401 (导入即注册提示词优化 HTTP 路由)
from .image_workbench import file_clipboard  # noqa: F401 (导入即注册「复制本地文件到剪贴板」路由)
from .image_workbench import assets  # noqa: F401 (导入即注册素材库全部路由：入库 / 浏览 / 缩略图 / 配置)
from .image_workbench import shop_presets  # noqa: F401 (导入即注册「改造预设」列表与 AI 槽位判定路由)
from .image_workbench import monitor  # noqa: F401 (导入即注册「Alili 资源监控」路由与采样线程)

NODE_CLASS_MAPPINGS = {
    "AliliLoadImage": AliliLoadImage,
    "AliliImageWorkbench": AliliImageWorkbench,
    "AliliTextEncode": AliliTextEncode,
    "AliliSaveImage": AliliSaveImage,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AliliLoadImage": "Alili 加载图像",
    "AliliImageWorkbench": "Alili 多模态图像工作台",
    "AliliTextEncode": "Alili 文本编码",
    "AliliSaveImage": "Alili 保存图像",
}

WEB_DIRECTORY = "./web"


class AliliImageWorkbenchExtension(ComfyExtension):
    async def get_node_list(self):
        return [
            AliliLoadImage,
            AliliImageWorkbench,
            AliliTextEncode,
            AliliSaveImage,
        ]


def comfy_entrypoint():
    return AliliImageWorkbenchExtension()


__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "WEB_DIRECTORY",
    "comfy_entrypoint",
]
