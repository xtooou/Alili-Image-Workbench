"""Alili · 把本地图片文件直接放进系统剪贴板

右键「复制图像文件」走这里。旧做法是浏览器 fetch 图片 → canvas 转 PNG →
navigator.clipboard.write，受浏览器权限 / 用户手势 / PNG 编码失败影响，经常静默失效。

新做法由 ComfyUI 后端把磁盘上**真实存在的文件**以 CF_HDROP（文件拖放列表）格式
写进 Windows 剪贴板，同时附一份 CF_UNICODETEXT 路径文本：
  - 资源管理器、微信、QQ、Photoshop 等 → 直接 Ctrl+V 粘贴为文件
  - 只接受文本的编辑器 → 粘贴出完整路径
完全绕开浏览器剪贴板权限，也不重新编码图片（原图、元数据一律保留）。

前端只传 {filename, subfolder, type}（和 /view 接口同一套三元组），
真实路径一律由后端从 folder_paths 解析，前端拿不到也不拼绝对路径。
"""
from __future__ import annotations

import asyncio
import os
import re
import sys
import time
import urllib.parse

from aiohttp import web
from server import PromptServer

import folder_paths

ROUTE = "/alili/image-workbench/copy-files"
MAX_FILES = 9
_REGISTERED = False

# 旧工作流里可能存在 "sub/xxx.png [input]" 这种带注解的文件名
_ANNOTATION = re.compile(r"\s*\[(?:input|output|temp)\]\s*$", re.IGNORECASE)


# ==============================================================================
# 路径解析：只接受 ComfyUI 三个目录里的相对路径，杜绝路径穿越
# ==============================================================================

def _directory_getters():
    output = folder_paths.get_output_directory
    return {
        "input": folder_paths.get_input_directory,
        "output": output,
        "temp": getattr(folder_paths, "get_temp_directory", output),
    }


def resolve_image_path(ref) -> str:
    """把 {filename, subfolder, type} 解析成磁盘绝对路径；找不到 / 越界一律抛错。"""
    if isinstance(ref, str):
        ref = {"filename": ref}
    if not isinstance(ref, dict):
        raise ValueError("文件信息无效")

    kind = str(ref.get("type") or "input").strip().lower()
    getter = _directory_getters().get(kind)
    if getter is None:
        raise ValueError(f"不支持的目录类型：{kind}（只接受 input / output / temp）")
    base = os.path.abspath(str(getter()))

    raw = "/".join(
        part for part in (
            str(ref.get("subfolder") or ""),
            str(ref.get("filename") or ""),
        ) if part
    )
    raw = _ANNOTATION.sub("", raw).replace("\\", "/")
    parts = [p for p in raw.split("/") if p and p != "."]
    if not parts or any(p == ".." for p in parts) or any(":" in p for p in parts):
        raise ValueError("文件名不合法")

    full = os.path.abspath(os.path.join(base, *parts))
    if os.path.normcase(os.path.commonpath([base, full])) != os.path.normcase(base):
        raise ValueError("路径越出了 ComfyUI 目录")
    if not os.path.isfile(full):
        raise FileNotFoundError(f"文件不存在：{full}")
    return full


# ==============================================================================
# Windows：原生 CF_HDROP，不依赖 PowerShell / pywin32 / 浏览器权限
# ==============================================================================

GMEM_MOVEABLE = 0x0002
GMEM_ZEROINIT = 0x0040
CF_UNICODETEXT = 13
CF_HDROP = 15


def _win32_set_files(paths: list[str]) -> None:
    import ctypes
    from ctypes import wintypes

    class DROPFILES(ctypes.Structure):
        _fields_ = [
            ("pFiles", wintypes.DWORD),   # 文件列表相对结构体起点的偏移
            ("pt_x", wintypes.LONG),
            ("pt_y", wintypes.LONG),
            ("fNC", wintypes.BOOL),
            ("fWide", wintypes.BOOL),     # True = 路径是 UTF-16
        ]

    user32, kernel32 = ctypes.windll.user32, ctypes.windll.kernel32
    kernel32.GlobalAlloc.argtypes = [wintypes.UINT, ctypes.c_size_t]
    kernel32.GlobalAlloc.restype = wintypes.HGLOBAL
    kernel32.GlobalLock.argtypes = [wintypes.HGLOBAL]
    kernel32.GlobalLock.restype = ctypes.c_void_p
    kernel32.GlobalUnlock.argtypes = [wintypes.HGLOBAL]
    kernel32.GlobalUnlock.restype = wintypes.BOOL
    kernel32.GlobalFree.argtypes = [wintypes.HGLOBAL]
    kernel32.GlobalFree.restype = wintypes.HGLOBAL
    user32.OpenClipboard.argtypes = [wintypes.HWND]
    user32.OpenClipboard.restype = wintypes.BOOL
    user32.EmptyClipboard.restype = wintypes.BOOL
    user32.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]
    user32.SetClipboardData.restype = wintypes.HANDLE
    user32.CloseClipboard.restype = wintypes.BOOL

    def global_alloc(data: bytes):
        handle = kernel32.GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, len(data))
        if not handle:
            raise OSError("GlobalAlloc 失败")
        ptr = kernel32.GlobalLock(handle)
        if not ptr:
            kernel32.GlobalFree(handle)
            raise OSError("GlobalLock 失败")
        ctypes.memmove(ptr, data, len(data))
        kernel32.GlobalUnlock(handle)
        return handle

    head = DROPFILES()
    head.pFiles = ctypes.sizeof(DROPFILES)
    head.fWide = True
    # CF_HDROP 要求：各路径以 \0 分隔，整体再以 \0 结尾（双 null）
    drop_blob = bytes(head) + ("\0".join(paths) + "\0\0").encode("utf-16-le")
    text_blob = ("\r\n".join(paths) + "\0").encode("utf-16-le")

    h_drop = h_text = None
    try:
        h_drop = global_alloc(drop_blob)
        h_text = global_alloc(text_blob)

        # 剪贴板可能被别的程序短暂占用，重试几次
        for _ in range(10):
            if user32.OpenClipboard(None):
                break
            time.sleep(0.05)
        else:
            raise OSError("剪贴板被其他程序占用，请稍后重试")

        try:
            user32.EmptyClipboard()
            if not user32.SetClipboardData(CF_HDROP, h_drop):
                raise OSError("写入文件列表失败（SetClipboardData / CF_HDROP）")
            h_drop = None  # 成功后内存所有权移交给系统，不能 GlobalFree
            if user32.SetClipboardData(CF_UNICODETEXT, h_text):
                h_text = None
            else:
                kernel32.GlobalFree(h_text)  # 文本只是附赠，失败不影响主功能
                h_text = None
        finally:
            user32.CloseClipboard()
    finally:
        for handle in (h_drop, h_text):
            if handle:
                kernel32.GlobalFree(handle)


def _posix_set_files(paths: list[str]) -> None:
    """Linux / macOS 降级：写 text/uri-list，需要 xclip 或 wl-copy。"""
    import shutil
    import subprocess

    uris = "\r\n".join("file://" + urllib.parse.quote(p.replace("\\", "/")) for p in paths) + "\r\n"
    exe = shutil.which("xclip") or shutil.which("wl-copy")
    if not exe:
        raise OSError("当前系统没有可用的剪贴板工具（需要 xclip 或 wl-copy）")
    cmd = [exe, "-selection", "clipboard", "-t", "text/uri-list"] if "xclip" in exe \
        else [exe, "-t", "text/uri-list"]
    proc = subprocess.run(cmd, input=uris.encode("utf-8"), timeout=5,
                          stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    if proc.returncode:
        raise OSError("写入剪贴板失败：" + proc.stderr.decode("utf-8", "replace")[:200])


def set_files_to_clipboard(paths: list[str]) -> None:
    if not paths:
        raise ValueError("没有可复制的文件")
    if sys.platform == "win32":
        _win32_set_files(paths)
    else:
        _posix_set_files(paths)


# ==============================================================================
# HTTP 路由
# ==============================================================================

async def copy_files(request):
    try:
        payload = await request.json()
    except Exception:
        return web.json_response({"error": "请求内容无效"}, status=400)

    refs = payload.get("files") if isinstance(payload, dict) else None
    if isinstance(refs, dict):
        refs = [refs]
    if not isinstance(refs, list) or not refs:
        return web.json_response({"error": "没有指定要复制的文件"}, status=400)

    try:
        paths = [resolve_image_path(ref) for ref in refs[:MAX_FILES]]
        # 剪贴板是同步 Win32 调用，丢到线程里避免阻塞事件循环
        await asyncio.to_thread(set_files_to_clipboard, paths)
    except FileNotFoundError as error:
        return web.json_response({"error": str(error)}, status=404)
    except (ValueError, OSError) as error:
        return web.json_response({"error": str(error)}, status=400)
    except Exception as error:
        return web.json_response({"error": f"写入剪贴板失败：{error}"}, status=500)

    return web.json_response({
        "ok": True,
        "count": len(paths),
        "paths": paths,
        "names": [os.path.basename(p) for p in paths],
    })


def register_file_clipboard_routes() -> bool:
    global _REGISTERED
    if _REGISTERED:
        return True
    instance = getattr(PromptServer, "instance", None)
    if instance is None:
        return False
    instance.routes.post(ROUTE)(copy_files)
    _REGISTERED = True
    return True


register_file_clipboard_routes()
