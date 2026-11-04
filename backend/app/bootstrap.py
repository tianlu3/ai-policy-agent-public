"""Bootstrap 数据提供者。

当前数据源 = 文件（bootstrap.json，由 test_date.js 转换而来）。
后续接数据库时，只需把 load() 内部换成 Repository 查询，对外契约不变。
"""
from __future__ import annotations

import json
import logging
import threading
from typing import Any

from . import config, jsconvert

log = logging.getLogger("backend.bootstrap")

# 前端契约要求的命名空间（键名不得改动）
# 任务监控 / 订阅提醒 / 异常降级三屏已删，对应命名空间一并移除。
NAMESPACES = [
    "stats", "policies", "regions", "search", "list",
    "detail", "brief",
]

_lock = threading.Lock()
_cache: dict[str, Any] | None = None


def _maybe_refresh() -> None:
    """开发期便利：test_date.js 更新且本机有 node 时自动重转换。"""
    if not config.AUTO_REFRESH or not config.TEST_DATA_JS.exists():
        return
    json_path = config.BOOTSTRAP_JSON
    if json_path.exists() and json_path.stat().st_mtime >= config.TEST_DATA_JS.stat().st_mtime:
        return
    if not jsconvert.node_available():
        log.warning("test_date.js 已更新，但环境无 node，继续使用 %s", json_path.name)
        return
    jsconvert.test_data_js_to_json(config.TEST_DATA_JS, json_path)
    log.info("已从 test_date.js 重新生成 %s", json_path.name)


def load(force: bool = False) -> dict[str, Any]:
    """加载并缓存 bootstrap 数据；force=True 时强制重读文件。"""
    global _cache
    with _lock:
        if _cache is not None and not force:
            return _cache
        try:
            _maybe_refresh()
        except Exception as exc:  # noqa: BLE001 - 刷新失败不应阻断启动
            log.warning("自动刷新 bootstrap 失败（继续用现有文件）：%s", exc)

        path = config.BOOTSTRAP_JSON
        if not path.exists():
            raise RuntimeError(
                f"bootstrap 数据不存在：{path}"
                f"；请先执行 `python tools/convert_test_data.py`（需本机 node）生成。"
            )
        data = json.loads(path.read_text(encoding="utf-8"))
        missing = [k for k in NAMESPACES if k not in data]
        if missing:
            log.warning("bootstrap 缺少命名空间（前端可能报错）：%s", missing)
        _cache = data
        return _cache


def is_ready() -> bool:
    return config.BOOTSTRAP_JSON.exists()
