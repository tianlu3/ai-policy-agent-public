"""端口与服务探测工具（run.py 与 tools/probe.py 共用）。

启动前先回答两个问题：
  1) 本机是不是已经有本服务在跑？（命中 /healthz → 200）
  2) 如果没有，哪个端口可用？

实现要点：
  · 先做 TCP 层快筛，只对「被占用」的端口发 HTTP 健康检查，
    避免对空闲端口逐个等待 HTTP 超时；
  · 多端口并发探测，整体耗时 ≈ 单次超时，而不是 端口数 × 超时。
"""
from __future__ import annotations

import socket
import urllib.request
from concurrent.futures import ThreadPoolExecutor

HEALTH_TIMEOUT = 1.5
CONNECT_TIMEOUT = 0.35
DEFAULT_SCAN = 20
MAX_WORKERS = 24

# 本服务的身份标识：/healthz 的响应体必须含它才算「本服务在运行」。
# 只看 200 会误认占用端口的其它程序（实例：VMware vmnat 把 8002 转发进
# 虚拟机，转发目标恰好对 /healthz 回 200 → run.py 误判「已在运行」）。
SERVICE_MARK = "ai-policy-agent"


def _opener() -> urllib.request.OpenerDirector:
    """显式禁用系统代理，确保探测 localhost 走直连。

    本机若配置了 http_proxy，普通 urlopen 会把 127.0.0.1 也发给代理，
    导致把「服务在运行」误判成「没在运行」。
    """
    return urllib.request.build_opener(urllib.request.ProxyHandler({}))


def is_service_up(host: str, port: int, timeout: float = HEALTH_TIMEOUT) -> bool:
    """该端口上是否有本服务在运行（/healthz 200 且响应体含身份标识）。"""
    try:
        with _opener().open(f"http://{host}:{port}/healthz", timeout=timeout) as resp:
            if getattr(resp, "status", 200) != 200:
                return False
            body = resp.read(512).decode("utf-8", "ignore")
            return SERVICE_MARK in body
    except Exception:  # noqa: BLE001 - 任何异常都按「没在运行」处理
        return False


def is_port_free(host: str, port: int) -> bool:
    """该端口是否无人监听（可绑定）。"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(CONNECT_TIMEOUT)
        return sock.connect_ex((host, port)) != 0


def _probe_running(host: str, port: int) -> tuple[int, bool]:
    """先看端口有没有人占，再看占着的是不是本服务。"""
    if is_port_free(host, port):
        return port, False
    return port, is_service_up(host, port)


def _ports(start: int, scan: int) -> list[int]:
    return list(range(start, start + max(1, scan)))


def find_running(host: str, start: int, scan: int = DEFAULT_SCAN) -> int | None:
    """在 [start, start+scan) 内找正在运行的本服务端口（按端口先后返回）。"""
    candidates = _ports(start, scan)
    with ThreadPoolExecutor(max_workers=min(MAX_WORKERS, len(candidates))) as pool:
        results = list(pool.map(lambda p: _probe_running(host, p), candidates))
    for port, is_up in results:
        if is_up:
            return port
    return None


def find_free(host: str, start: int, scan: int = DEFAULT_SCAN) -> int | None:
    """在 [start, start+scan) 内找一个空闲端口。"""
    candidates = _ports(start, scan)
    with ThreadPoolExecutor(max_workers=min(MAX_WORKERS, len(candidates))) as pool:
        results = list(pool.map(lambda p: (p, is_port_free(host, p)), candidates))
    for port, free in results:
        if free:
            return port
    return None
