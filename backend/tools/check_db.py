#!/usr/bin/env python
"""启动脚本调用的 MySQL 就绪探测（供 start_server.bat 显示用）。

只读探测：按 backend/.env 的 DB_* 配置尝试建库（IF NOT EXISTS）、建表（IF NOT EXISTS）
并取得连接池状态；任何失败都不抛给调用方。

输出：一行人类可读状态写入 stdout（供批处理用 set /p 读取显示）。
退出码：0 = 已连接；3 = 未连接（DB_ENABLED=1 但连不上）；4 = 已按 DB_ENABLED=0 停用。
"""
from __future__ import annotations

import logging
import sys
from pathlib import Path

# 允许以 `python tools/check_db.py` 独立运行
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# 探测过程不要往 stderr 打日志（批处理里会丢弃，但保持输出干净）
logging.disable(logging.CRITICAL)

from app import config, db  # noqa: E402


def main() -> int:
    if not config.DB_ENABLED:
        print("已停用（DB_ENABLED=0）· 账号与「检索记录」不可用，检索主链路照常")
        return 4

    target = f"{config.DB_HOST}:{config.DB_PORT}/{config.DB_NAME}"
    try:
        db.init()
        info = db.status()
    except Exception as exc:  # noqa: BLE001 - 探测脚本不应因异常中断启动
        print(f"未连接（{target}）· {type(exc).__name__}: {exc}")
        return 3

    if info.get("available"):
        tables = "/".join(info.get("tables") or []) or "（首次启动将自动建表）"
        print(f"已连接：{target} · 用户 {info.get('user')} · 表 {tables}")
        return 0

    print(f"未连接（{target}）· {info.get('error') or '原因未知'}")
    return 3


if __name__ == "__main__":
    raise SystemExit(main())
