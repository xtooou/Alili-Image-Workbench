from __future__ import annotations

import asyncio
import re
from pathlib import Path

from aiohttp import web
from server import PromptServer

from ..api import api as alili_api



# ==============================================================================
# 提示词模板库：每个模板是一个独立文件  templates/<kind>/<模板名>.md
#   kind = t2i  → 前端「生图」下拉
#   kind = i2i  → 前端「编辑」下拉
# 文件内容就是给大模型的专属指令。新增 / 修改文件后，前端下拉会自动刷新，无需重启。
# ==============================================================================
TEMPLATE_ROOT = Path(__file__).resolve().parents[1] / "templates"
TEMPLATE_KINDS = ("t2i", "i2i")
TEMPLATE_DEFAULT_TITLE = "自由发挥 (默认)"
TEMPLATE_MAX_CHARS = 65536
_TEMPLATE_BAD_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def _template_dir(kind: str) -> Path:
    if kind not in TEMPLATE_KINDS:
        raise ValueError(f"未知模板类型: {kind}")
    return TEMPLATE_ROOT / kind


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
    """前端传来的 template 形如 't2i/四宫格分镜'。返回 (显示名, 指令文本)；找不到则指令为空，走通用规则。"""
    value = str(template or "").strip()
    kind, _, name = value.partition("/")
    if kind not in TEMPLATE_KINDS or not name:
        return value, ""
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


def _user_parts(prompt: str, media: list[dict], read_media: bool) -> list[dict]:
    parts = [{"type": "text", "text": "User description:\n" + (prompt or "Create a high-quality visual masterpiece.")}]
    for item in media:
        label = str(item.get("label") or "")
        if read_media:
            for index, data_url in enumerate(item.get("images") or []):
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
    return web.json_response({kind: _list_templates(kind) for kind in TEMPLATE_KINDS})


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
        routes.get(f"{prefix}/template")(read_prompt_template)
        routes.post(f"{prefix}/template")(save_prompt_template)

    _ROUTES_REGISTERED = True
    return True


register_prompt_optimizer_routes()
