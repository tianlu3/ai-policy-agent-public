#!/usr/bin/env python
"""启动前探测小工具（与 run.py 共用 app/netutil.py）。

输出恰好一行：
    RUNNING <port>   本地服务已在运行
    FREE    <port>   找到可用端口
    NONE             扫描范围内没有可用端口

用法：
    python tools/probe.py --port 8000 --scan 20
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import netutil  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="本地服务启动前探测")
    parser.add_argument("--port", type=int, default=8000, help="起始端口")
    parser.add_argument("--scan", type=int, default=20, help="向后扫描的端口数量")
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()

    running = netutil.find_running(args.host, args.port, args.scan)
    if running is not None:
        print(f"RUNNING {running}")
        return 0

    free = netutil.find_free(args.host, args.port, args.scan)
    if free is not None:
        print(f"FREE {free}")
        return 0

    print("NONE")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
