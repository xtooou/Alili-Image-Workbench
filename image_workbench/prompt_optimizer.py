from __future__ import annotations

import asyncio
import base64
import io
import re
from pathlib import Path

from aiohttp import web
from PIL import Image
from server import PromptServer

from ..api import api as alili_api
from ..Expanded_Node.Load_image import _apply_crop, _load_image

# 发给大模型的参考图：最长边缩放上限（原来前端是 512 / jpeg 0.6，保持一致）
API_IMAGE_MAX_SIDE = 512
API_IMAGE_JPEG_QUALITY = 60



# ==============================================================================
# 提示词库：全部收在 prompt/ 一个目录下，三类各一个子目录
#   prompt/api_prompt/    → 给大模型看的「改写指令」（走 API，前端「编辑」下拉）
#   prompt/fixed_prompt/  → 写好的成品提示词（不走 API，直接送文本编码，前端「生图」下拉）
#   prompt/look_prompt/   → 改造弹窗的组合成品（换装 / 换姿势 / 换发型 …）
# 新增 / 修改文件后，前端下拉会自动刷新，无需重启。
# ==============================================================================
PROMPT_ROOT = Path(__file__).resolve().parents[1] / "prompt"
API_PROMPT_ROOT = PROMPT_ROOT / "api_prompt"
FIXED_PROMPT_ROOT = PROMPT_ROOT / "fixed_prompt"
LOOK_PROMPT_ROOT = PROMPT_ROOT / "look_prompt"
API_ALIASES = {"t2i", "i2i", "api", "api_prompt"}
FIXED_ALIASES = {"fixed", "fixed_prompt"}
LOOK_ALIASES = {"look", "look_prompt"}
TEMPLATE_DEFAULT_TITLE = "自由发挥 (默认)"
TEMPLATE_MAX_CHARS = 65536
_TEMPLATE_BAD_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def _template_dir(kind: str) -> Path:
    key = str(kind or "api").strip().lower()
    if key in API_ALIASES:
        return API_PROMPT_ROOT
    if key in FIXED_ALIASES:
        return FIXED_PROMPT_ROOT
    if key in LOOK_ALIASES:
        return LOOK_PROMPT_ROOT
    raise ValueError(f"未知模板类型: {kind}")


def _clean_template_name(name) -> str:
    value = str(name or "").strip()
    if value.lower().endswith(".md"):
        value = value[:-3].strip()
    if (
        not value
        or len(value) > 80
        or value.startswith(".")
        or value.endswith(".")
        or value == TEMPLATE_DEFAULT_TITLE
        or _TEMPLATE_BAD_CHARS.search(value)
    ):
        raise ValueError('模板名称无效：不能为空，且不能包含 \\ / : * ? " < > | 等字符')
    return value


def _list_templates(kind: str) -> list[str]:
    folder = _template_dir(kind)
    if not folder.is_dir():
        return []
    return sorted((p.stem for p in folder.glob("*.md") if p.is_file()), key=str.casefold)


def _read_template(kind: str, name) -> str:
    path = _template_dir(kind) / f"{_clean_template_name(name)}.md"
    if not path.is_file():
        raise FileNotFoundError(f"模板不存在: {name}")
    return path.read_text(encoding="utf-8-sig")


def _write_template(kind: str, name, content) -> str:
    clean = _clean_template_name(name)
    body = str(content or "")
    if len(body) > TEMPLATE_MAX_CHARS:
        raise ValueError(f"模板内容过长（上限 {TEMPLATE_MAX_CHARS} 字符）")
    folder = _template_dir(kind)
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{clean}.md").write_text(body, encoding="utf-8")
    return clean


def _template_instruction(template: str) -> tuple[str, str]:
    """前端传来的 template 形如 '提取发型'（平铺）或旧格式 'i2i/提取发型'。返回 (显示名, 指令文本)；找不到则指令为空，走通用规则。"""
    value = str(template or "").strip()
    if not value:
        return value, ""
    kind, sep, name = value.partition("/")
    if not sep:
        kind, name = "api", value
    try:
        return name, _read_template(kind, name).strip()
    except (OSError, ValueError):
        return name, ""


def _system_prompt(
    task: str,
    labels: list[str],
    output_language: str = "中文",
    user_prompt: str = "",
    template: str = "",
) -> str:
    is_i2i = bool(labels) or str(task).upper() == "I2I"
    labels_str = ", ".join(labels) if labels else "None"
    lang_rule = (
        "Output all final prompt content in Chinese (简体中文)."
        if output_language == "中文" else
        "Output all final prompt content in natural, descriptive English."
    )
    if is_i2i:
        lang_rule += " Keep technical tags like <imageN> and style markers exact."

    template_name, custom_instruction = _template_instruction(template)

    # 如果当前模板文件里写了具体的 Prompt 指令，优先注入用户的专业指令
    if custom_instruction:
        return (
            f"You are an expert visual prompt engineer for diffusion models (Midjourney, SDXL, Flux).\n"
            f"Active Template Strategy: {template_name}\n"
            f"Available reference labels: {labels_str}\n\n"
            f"Specialized Instructions:\n{custom_instruction}\n\n"
            f"Output Language Requirement: {lang_rule}\n"
            "Return only the final production-ready prompt without markdown blocks or conversational text."
        )

    # 默认/未定义指令时，走底层的通用稳健规则
    if is_i2i:
        return (
            "You are an expert visual prompt engineer for diffusion-based image generation (Midjourney, SDXL, Flux).\n"
            f"Current Mode: Image-to-Image / Multi-Reference Conditioning (I2I).\n"
            f"Available reference labels: {labels_str}.\n\n"
            "Rules:\n"
            "1. Analyze the uploaded reference images corresponding to tags like <image1>, <image2>, etc.\n"
            "2. Identify the key subject identities, composition, art style, lighting, color palette, and textures from the references.\n"
            "3. Seamlessly integrate the user's creative prompt with the visual references. Explicitly specify which traits are inherited "
            "from which <imageN> (e.g., facial features/clothing from <image1>, pose/composition from <image2>).\n"
            "4. Output a single, cohesive, production-ready image generation prompt. Describe subject details, environment, lighting, lens/camera framing, and artistic atmosphere in vivid detail.\n"
            "5. Strict constraints: Do NOT invent tags that are not in the available list. Do NOT output markdown fences, greetings, or explanations. Only return the final refined prompt.\n"
            f"6. {lang_rule}"
        )
    else:
        return (
            "You are an expert visual prompt engineer for state-of-the-art image diffusion models (Midjourney, SDXL, Flux).\n"
            "Current Mode: Text-to-Image (T2I).\n\n"
            "Rules:\n"
            "1. Expand the user's brief idea into a rich, photorealistic or stylistically defined visual description.\n"
            "2. Structure the prompt clearly: Subject (appearance, anatomy, clothing, expression) -> Action/Pose -> Environment/Background -> "
            "Lighting (golden hour, volumetric, softbox, rim light) -> Composition & Camera (shot angle, depth of field, lens focal length) -> Atmosphere/Artistic Mood.\n"
            "3. If the user specified a style (e.g., anime, cinematic photography, oil painting), amplify it with authentic industry terminology.\n"
            "4. Output only the final prompt text. Do not wrap in markdown quotes or add chat commentary.\n"
            f"5. {lang_rule}"
        )


def _media_data_url(item: dict) -> str | None:
    """把一条 media 变成可发给大模型的 data URL。

    两条来源：
      - 新格式：name + crop → 后端按与加载节点 _apply_crop 相同的口径读原图、裁剪、内存缩放。
        这样 API 看到的就是用户在节点卡片里看到的那块，而不是磁盘全图。
      - 旧格式：images（前端 already base64）→ 原样透传，兼容老工作流 / 其它调用方。

    读图 / 裁剪失败一律返回 None：宁可少一张参考图，也不把全图悄悄送给大模型。
    """
    item = item if isinstance(item, dict) else {}

    # 旧格式：前端直接传来的 base64，保持兼容
    legacy = item.get("images")
    if isinstance(legacy, list) and legacy and isinstance(legacy[0], str) and legacy[0].startswith("data:"):
        return legacy[0]

    name = item.get("name")
    if not isinstance(name, str) or not name:
        return None
    try:
        image = _load_image(name)          # torch [1,H,W,C]，含路径白名单校验
        crop = item.get("crop")
        if isinstance(crop, dict):
            # 绑定校验：换图后旧框的 image 与当前 name 不符 → 当作没裁，原图透传
            bound = crop.get("image")
            if bound is not None and str(bound) != name:
                crop = None
            image = _apply_crop(image, crop)
        # 张量 → PIL → 最长边缩放 → JPEG data URL（全程内存，不落盘、不改原图）
        array = (image[0].clamp(0, 1).cpu().numpy() * 255.0).astype("uint8")
        pil = Image.fromarray(array, "RGB")
        scale = min(1.0, API_IMAGE_MAX_SIDE / max(pil.width, pil.height))
        if scale < 1.0:
            pil = pil.resize(
                (max(1, round(pil.width * scale)), max(1, round(pil.height * scale))),
                Image.Resampling.LANCZOS,
            )
        buffer = io.BytesIO()
        pil.save(buffer, format="JPEG", quality=API_IMAGE_JPEG_QUALITY)
        return "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")
    except Exception:
        return None


def _user_parts(prompt: str, media: list[dict], read_media: bool) -> list[dict]:
    parts = [{"type": "text", "text": "User description:\n" + (prompt or "Create a high-quality visual masterpiece.")}]
    for item in media:
        label = str(item.get("label") or "")
        if read_media:
            data_url = _media_data_url(item)
            if data_url:
                parts.append({"type": "text", "text": f"Reference image for {label}:"})
                parts.append({"type": "image_url", "image_url": {"url": data_url, "detail": "low"}})
        else:
            parts.append({"type": "text", "text": f"Reference image slot: {label}."})
    return parts


def _strip_filenames(text: str) -> str:
    return re.sub(
        r"(?<![\w/\\])[\w .()\-\u4e00-\u9fff]+\.(?:png|jpe?g|webp|bmp|gif)(?!\w)",
        "",
        text,
        flags=re.IGNORECASE,
    ).strip()




_ROUTES_REGISTERED = False
_ACTIVE_REQUESTS: dict[str, asyncio.Task] = {}


def _build_messages(payload: dict) -> list[dict]:
    task = str(payload.get("task") or "T2I")
    template = str(payload.get("template") or "")
    media = payload.get("media") if isinstance(payload.get("media"), list) else []
    labels = [str(item.get("label")) for item in media if item.get("label")]
    user_prompt = str(payload.get("prompt") or "")
    system = _system_prompt(task, labels, "中文", user_prompt, template=template)
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": _user_parts(user_prompt, media, True)},
    ]


async def _run_prompt_optimization(payload: dict) -> str:
    ok, message = alili_api.check_settings()
    if not ok:
        raise ValueError(message)
    result = await asyncio.to_thread(alili_api.chat, _build_messages(payload), temperature=0.4)
    cleaned = _strip_filenames(result).strip()
    if not cleaned:
        raise RuntimeError("API 返回了空提示词")
    return cleaned


async def list_prompt_templates(_request):
    api_list = _list_templates("api")
    # api 是平铺的，t2i / i2i 两个键保留只为兼容旧前端
    return web.json_response({"api": api_list, "t2i": api_list, "i2i": api_list})


async def list_fixed_prompts(_request):
    return web.json_response({"items": _list_templates("fixed")})


async def list_prompts_by_kind(request):
    """统一清单：kind = fixed / api / look（Skill 编辑弹窗用）"""
    try:
        return web.json_response({"items": _list_templates(str(request.query.get("kind") or "api"))})
    except Exception as error:
        return web.json_response({"error": str(error)}, status=400)


async def read_prompt_template(request):
    try:
        content = _read_template(str(request.query.get("kind") or ""), request.query.get("name"))
        return web.json_response({"content": content})
    except FileNotFoundError as error:
        return web.json_response({"error": str(error)}, status=404)
    except Exception as error:
        return web.json_response({"error": str(error)}, status=400)


async def save_prompt_template(request):
    try:
        payload = await request.json()
        kind = str(payload.get("kind") or "")
        name = _write_template(kind, payload.get("name"), payload.get("content"))
        return web.json_response({"name": name, "templates": _list_templates(kind)})
    except Exception as error:
        return web.json_response({"error": str(error)}, status=400)


async def optimize_prompt(request):
    request_id = ""
    try:
        payload = await request.json()
        request_id = str(payload.get("request_id") or "")
        task = asyncio.create_task(_run_prompt_optimization(payload))
        if request_id:
            previous = _ACTIVE_REQUESTS.pop(request_id, None)
            if previous is not None:
                previous.cancel()
            _ACTIVE_REQUESTS[request_id] = task
        return web.json_response({"prompt": await task})
    except asyncio.CancelledError:
        return web.json_response({"error": "提示词优化已取消"}, status=499)
    except Exception as error:
        return web.json_response({"error": str(error)}, status=400)
    finally:
        if request_id:
            _ACTIVE_REQUESTS.pop(request_id, None)


async def cancel_prompt_optimization(request):
    payload = await request.json()
    task = _ACTIVE_REQUESTS.pop(str(payload.get("request_id") or ""), None)
    if task is not None:
        task.cancel()
    return web.json_response({"cancelled": task is not None})


def register_prompt_optimizer_routes() -> bool:
    global _ROUTES_REGISTERED
    if _ROUTES_REGISTERED:
        return True
    instance = getattr(PromptServer, "instance", None)
    if instance is None:
        return False
    routes = instance.routes

    prefixes = [
        "/alili/image-workbench/prompt-optimizer",
        "/alili/optimizer",
    ]
    for prefix in prefixes:
        routes.post(f"{prefix}/optimize")(optimize_prompt)
        routes.post(f"{prefix}/cancel")(cancel_prompt_optimization)
        routes.get(f"{prefix}/templates")(list_prompt_templates)
        routes.get(f"{prefix}/fixed")(list_fixed_prompts)
        routes.get(f"{prefix}/list")(list_prompts_by_kind)
        routes.get(f"{prefix}/template")(read_prompt_template)
        routes.post(f"{prefix}/template")(save_prompt_template)

    _ROUTES_REGISTERED = True
    return True


register_prompt_optimizer_routes()
