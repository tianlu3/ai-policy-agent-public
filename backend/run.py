#!/usr/bin/env python
"""本地启动入口。

    python run.py                 # 默认 127.0.0.1:8000（被占用时自动顺延）
    python run.py --port 8080
    python run.py --open          # 启动后自动打开浏览器
    python run.py --reload        # 开发热重载

端口与占用判断都收在这里，start_server.bat 只负责拉起本脚本。
"""
from __future__ import annotations

import argparse
import threading
import webbrowser

import uvicorn

from app import config, netutil

# 退出码：0 = 正常退出；7 = 本服务已在运行（未重复启动）；1 = 失败
EXIT_ALREADY_RUNNING = 7


def _open_browser_later(url: str, delay: float = 2.0) -> None:
    """延迟打开浏览器，等服务完成启动。"""
    threading.Timer(delay, lambda: webbrowser.open(url)).start()


def main() -> int:
    parser = argparse.ArgumentParser(description="AI 政策搜索智能体 · 本地后端")
    parser.add_argument("--host", default=config.HOST)
    parser.add_argument("--port", type=int, default=config.PORT)
    parser.add_argument("--scan", type=int, default=20, help="端口被占用时向后尝试的个数")
    parser.add_argument("--open", action="store_true", help="启动后自动打开浏览器")
    parser.add_argument(
        "--no-port-fallback", action="store_true",
        help="端口被占用时直接报错退出（默认自动换端口）",
    )
    parser.add_argument("--reload", action="store_true", help="开发热重载")
    args = parser.parse_args()

    host = args.host

    # ① 已有本服务在跑 → 不重复启动，直接打开页面
    running = netutil.find_running(host, args.port, args.scan)
    if running is not None:
        url = f"http://{host}:{running}/"
        print(f"[i] 本地服务已在运行：{url}")
        if args.open:
            webbrowser.open(url)
        return EXIT_ALREADY_RUNNING

    # ② 选一个可用端口
    port = args.port
    if not netutil.is_port_free(host, port):
        if args.no_port_fallback:
            print(f"[x] 端口 {port} 已被其它程序占用，请用 --port 指定其它端口")
            return 1
        free = netutil.find_free(host, args.port, args.scan)
        if free is None:
            print(f"[x] 从 {args.port} 起的 {args.scan} 个端口都被占用，无可用端口")
            return 1
        print(f"[i] 端口 {args.port} 已被占用，改用 {free}")
        port = free

    base = f"http://{host}:{port}"
    print(f"→ 前端页面   : {base}/")
    print(f"→ bootstrap  : {base}/api/bootstrap")
    print(f"→ 接口文档   : {base}/docs\n")

    if args.open:
        _open_browser_later(f"{base}/")

    uvicorn.run("app.main:app", host=host, port=port, reload=args.reload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
