"""Alili 资源监控 —— 由 comfyui-advanced-monitor 并入并改造。

三条路由：
    GET   /alili_monitor/status   实时快照（CPU / 内存 / GPU / 显存 / 温度 / 驻留模型）
    PATCH /alili_monitor/config   刷新间隔
    POST  /alili_monitor/free     三种清理动作（unload_models / purge_vram / purge_ram）

后台线程按固定间隔通过 websocket 推送 `alili.monitor` 事件。
"""

import gc
import json
import logging
import os
import sys
import threading
import time

import psutil

from server import PromptServer
from aiohttp import web

EVENT_NAME = "alili.monitor"
DEFAULT_RATE = 1.0

log = logging.getLogger("AliliMonitor")


class GPUCollector:
    """基于 NVML 的显卡采样；没有 NVIDIA 显卡/驱动时安静降级。"""

    def __init__(self):
        self.available = False
        self.pynvml = None
        self.handles = []
        self.names = []
        try:
            import pynvml

            pynvml.nvmlInit()
            self.pynvml = pynvml
            count = pynvml.nvmlDeviceGetCount()
            for i in range(count):
                handle = pynvml.nvmlDeviceGetHandleByIndex(i)
                name = pynvml.nvmlDeviceGetName(handle)
                if isinstance(name, bytes):
                    name = name.decode("utf-8", errors="replace")
                self.handles.append(handle)
                self.names.append(name)
            self.available = count > 0
        except Exception as e:
            log.info("Alili 监控：NVML 不可用，显卡监测已关闭（%s）", e)

    def sample(self):
        gpus = []
        if not self.available:
            return gpus
        nv = self.pynvml
        for i, handle in enumerate(self.handles):
            entry = {
                "index": i,
                "name": self.names[i],
                "utilization": -1,
                "temperature": -1,
                "vram_used": 0,
                "vram_total": 0,
                "vram_percent": -1,
            }
            try:
                entry["utilization"] = nv.nvmlDeviceGetUtilizationRates(handle).gpu
            except Exception:
                pass
            try:
                mem = nv.nvmlDeviceGetMemoryInfo(handle)
                entry["vram_used"] = mem.used
                entry["vram_total"] = mem.total
                if mem.total:
                    entry["vram_percent"] = mem.used / mem.total * 100
            except Exception:
                pass
            try:
                entry["temperature"] = nv.nvmlDeviceGetTemperature(
                    handle, nv.NVML_TEMPERATURE_GPU
                )
            except Exception:
                pass
            gpus.append(entry)
        return gpus


def loaded_models():
    """当前被 ComfyUI 驻留在显存里的模型（用于判断「驻留是否干净」）。"""

    mm = sys.modules.get("comfy.model_management")
    if mm is None:
        try:
            import comfy.model_management as mm  # noqa: F401
        except Exception:
            return []

    out = []
    for item in getattr(mm, "current_loaded_models", None) or []:
        model = getattr(item, "model", None)
        name = None
        model_type = getattr(model, "model_type", None)
        if model_type is not None:
            name = getattr(model_type, "name", None)
        if not name:
            name = type(model).__name__ if model is not None else "unknown"
        vram = 0
        for attr in ("model_loaded_memory", "model_memory"):
            fn = getattr(item, attr, None)
            if not callable(fn):
                continue
            try:
                vram = int(fn() or 0)
                break
            except Exception:
                continue
        out.append({"name": str(name), "vram": vram})
    return out


class Monitor:
    def __init__(self):
        self.rate = DEFAULT_RATE
        self.gpu = GPUCollector()
        self.disk_path = os.path.dirname(os.path.abspath(__file__))
        self._thread = None
        psutil.cpu_percent(interval=None)

    def snapshot(self):
        vm = psutil.virtual_memory()
        data = {
            "cpu": psutil.cpu_percent(interval=None),
            "ram": {
                "percent": vm.percent,
                "used": vm.total - vm.available,
                "total": vm.total,
            },
            "gpus": self.gpu.sample(),
            "models": loaded_models(),
        }
        try:
            disk = psutil.disk_usage(self.disk_path)
            data["hdd"] = {
                "percent": disk.percent,
                "used": disk.used,
                "total": disk.total,
            }
        except Exception:
            data["hdd"] = None
        return data

    def start(self):
        if self._thread is not None:
            return
        self._thread = threading.Thread(
            target=self._loop, name="AliliMonitor", daemon=True
        )
        self._thread.start()

    def _loop(self):
        while True:
            rate = self.rate
            if rate <= 0:
                time.sleep(0.5)
                continue
            try:
                # 没有前端连着就不采样，省 CPU
                sockets = getattr(PromptServer.instance, "sockets", None)
                if sockets is not None and len(sockets) == 0:
                    time.sleep(0.5)
                    continue
                PromptServer.instance.send_sync(EVENT_NAME, self.snapshot())
            except Exception as e:
                log.warning("Alili 监控：采样失败（%s）", e)
                time.sleep(2.0)
            time.sleep(rate)


monitor = Monitor()

routes = PromptServer.instance.routes


@routes.get("/alili_monitor/status")
async def alili_get_status(request):
    return web.json_response(
        {
            "rate": monitor.rate,
            "gpu_available": monitor.gpu.available,
            "gpu_names": monitor.gpu.names,
            "snapshot": monitor.snapshot(),
        }
    )


@routes.patch("/alili_monitor/config")
async def alili_patch_config(request):
    try:
        body = json.loads(await request.text())
    except Exception:
        return web.json_response({"error": "invalid json"}, status=400)
    rate = body.get("rate")
    if rate is not None:
        try:
            monitor.rate = max(0.0, min(30.0, float(rate)))
        except (TypeError, ValueError):
            return web.json_response({"error": "invalid rate"}, status=400)
    return web.json_response({"rate": monitor.rate})


@routes.post("/alili_monitor/free")
async def alili_post_free(request):
    try:
        body = json.loads(await request.text())
    except Exception:
        return web.json_response({"error": "invalid json"}, status=400)
    action = body.get("action")

    if action == "unload_models":
        # 由 prompt worker 在任务之间处理，与 ComfyUI 原生「卸载模型」同一机制
        PromptServer.instance.prompt_queue.set_flag("unload_models", True)
    elif action == "purge_ram":
        # free_memory 会重置执行器的节点/输出缓存，并隐含卸载 + gc
        PromptServer.instance.prompt_queue.set_flag("unload_models", True)
        PromptServer.instance.prompt_queue.set_flag("free_memory", True)
    elif action == "purge_vram":
        try:
            import comfy.model_management as mm

            gc.collect()
            mm.soft_empty_cache()
        except Exception as e:
            log.warning("Alili 监控：显存清理失败（%s）", e)
            return web.json_response({"error": str(e)}, status=500)
    else:
        return web.json_response({"error": "unknown action"}, status=400)
    return web.json_response({"ok": True, "action": action})


monitor.start()

# ---------------------------------------------------------------------------
# 每任务开跑前卸载显存（验证阶段开关：插件目录下的 unload.on，存在即开）
#
# 为什么挂 PromptExecutor.execute：worker 的循环是 q.get() → execute → 读 flags，
# 所以「任务边界 flag」只能在任务跑完之后生效。execute 的开头才是任务真正开始、
# 模型还没加载的那一刻，是唯一能做「开跑前」清理的位置。
# 全 ComfyUI 只有 main.py 的 worker 调这一次，不会重复触发。
# ---------------------------------------------------------------------------

UNLOAD_FLAG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "unload.on")


def _unload_flag_on() -> bool:
    return os.path.exists(UNLOAD_FLAG)


def _purge_vram_before_task() -> None:
    mm = sys.modules.get("comfy.model_management")
    if mm is None:
        import comfy.model_management as mm

    models = loaded_models()
    if not models:
        return

    total = sum(int(m.get("vram") or 0) for m in models)
    names = ", ".join(str(m.get("name")) for m in models)

    mm.unload_all_models()
    gc.collect()
    mm.soft_empty_cache()

    log.info(
        "Alili：开跑前卸显存 → %d 个 / %.1f GB（%s）",
        len(models),
        total / (1024 ** 3),
        names,
    )


def _install_unload_hook() -> None:
    execution = sys.modules.get("execution")
    if execution is None:
        try:
            import execution  # noqa: F401
        except Exception as e:
            log.warning("Alili：拿不到 execution 模块，开跑前卸载钩子没挂上（%s）", e)
            return

    cls = getattr(execution, "PromptExecutor", None)
    if cls is None:
        log.warning("Alili：没找到 PromptExecutor，开跑前卸载钩子没挂上")
        return
    if getattr(cls, "_alili_unload_patched", False):
        return

    orig = cls.execute

    def execute(self, *args, **kwargs):
        if _unload_flag_on():
            try:
                _purge_vram_before_task()
            except Exception as e:
                log.warning("Alili：开跑前卸显存失败（%s）", e)
        return orig(self, *args, **kwargs)

    cls.execute = execute
    cls._alili_unload_patched = True
_install_unload_hook()


@routes.get("/alili_monitor/auto")
async def alili_get_auto(request):
    """读「每个任务开跑前卸载显存」的真实开关状态（真值是 unload.on 是否存在）。"""
    return web.json_response({"vram": _unload_flag_on()})


@routes.post("/alili_monitor/auto")
async def alili_post_auto(request):
    """切换开关：开 → 建 unload.on，关 → 删 unload.on。"""
    try:
        body = json.loads(await request.text())
    except Exception:
        return web.json_response({"error": "invalid json"}, status=400)

    vram = body.get("vram")
    if not isinstance(vram, bool):
        return web.json_response({"error": "missing vram"}, status=400)

    try:
        if vram:
            if not os.path.exists(UNLOAD_FLAG):
                with open(UNLOAD_FLAG, "a", encoding="utf-8"):
                    pass
        else:
            if os.path.exists(UNLOAD_FLAG):
                os.remove(UNLOAD_FLAG)
    except Exception as e:
        log.warning("Alili：切换「开跑前卸显存」失败（%s）", e)
        return web.json_response({"error": str(e)}, status=500)

    log.info("Alili：「开跑前卸显存」已%s", "开启" if _unload_flag_on() else "关闭")
    return web.json_response({"ok": True, "vram": _unload_flag_on()})
