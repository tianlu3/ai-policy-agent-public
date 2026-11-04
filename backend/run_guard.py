"""后端守护进程（演示专用）。

作用：把后端拉起来并盯住它 —— 进程意外退出（控制台窗口被关 / Ctrl+C 误触 /
崩溃 / 被任务管理器结束）后 2 秒内自动重启。前端有 15s 断连宽限期
（search.json 的 connGraceMs），所以这种秒级重启在界面上是静默的：
不亮「与服务器的连接中断」黄条，检索进度条原地等一下就继续。

典型用法（不弹黑窗，关不掉也就不会误关）：
    .venv\\Scripts\\pythonw.exe run_guard.py
    —— 由同级的「守护启动.bat」负责调用

前台调试（能看到日志滚动）：
    .venv\\Scripts\\python.exe run_guard.py

停止：
    stop_guard.py / 同级「停止服务.bat」

日志：backend/_run8000_live.log
"""
from __future__ import annotations

import os
import socket
import subprocess
import sys
import time
from pathlib import Path

BASE = Path(__file__).resolve().parent
LOG = BASE / "_run8000_live.log"

HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8000"))
# 单实例锁：守护自己占住 PORT+99（默认 8099），进程消失即自动释放
LOCK_PORT = int(os.environ.get("LOCK_PORT", str(PORT + 99)))

RESTART_DELAY = 2.0      # 崩溃后多久重启：必须明显小于前端宽限期 15s
FAST_CRASH_LIMIT = 3     # 连续「启动不到 15s 就挂」超过这个次数则放弃（配置类错误重试无意义）
FAST_CRASH_WINDOW = 15.0
EXIT_ALREADY_RUNNING = 7  # run.py 约定：已有实例在跑


LOG_MAX_BYTES = 2 * 1024 * 1024   # 超 2MB 轮转一次，避免演示包越跑越大


def _rotate_if_needed() -> None:
    try:
        if LOG.exists() and LOG.stat().st_size > LOG_MAX_BYTES:
            LOG.replace(LOG.with_name(LOG.name + ".1"))   # 只保留一份历史
    except OSError:
        pass


def log(msg: str) -> None:
    """写日志：pythonw 下没有 stdout，必须落文件。"""
    _rotate_if_needed()
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] [guard] {msg}"
    try:
        with LOG.open("a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except OSError:
        pass


def port_open(port: int, host: str = HOST, timeout: float = 0.6) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def python_exe() -> str:
    """优先用虚拟环境里的 python.exe（run.py 需要项目依赖）。"""
    for cand in (BASE / ".venv" / "Scripts" / "python.exe",
                 BASE / "venv" / "Scripts" / "python.exe"):
        if cand.exists():
            return str(cand)
    return sys.executable


def take_single_instance_lock() -> socket.socket | None:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.bind((HOST, LOCK_PORT))
        sock.listen(1)  # 只是占位，不接受连接
        return sock
    except OSError:
        sock.close()
        return None


def main() -> int:
    lock = take_single_instance_lock()
    if lock is None:
        log(f"单实例锁端口 {LOCK_PORT} 已被占用 —— 已有守护在运行，本实例退出")
        return 0

    if port_open(PORT):
        log(f"端口 {PORT} 已有服务在听 —— 判定服务已就绪，守护不重复启动")
        return 0

    env = dict(os.environ)
    env["NO_PROXY"] = "127.0.0.1,localhost"
    env["no_proxy"] = "127.0.0.1,localhost"
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"

    cmd = [
        python_exe(), str(BASE / "run.py"),
        "--host", HOST, "--port", str(PORT),
        # 演示必须钉死端口：换端口会让页面里的 API 地址失配 → 满屏断连
        "--no-port-fallback",
    ]

    log(f"守护启动 · 端口 {PORT} · 崩溃后 {RESTART_DELAY:.0f}s 自动重启 · 日志 {LOG.name}")
    fast_crashes = 0

    while True:
        log("拉起后端 …")
        started = time.time()
        try:
            with LOG.open("a", encoding="utf-8") as fh:
                fh.write(f"\n{'=' * 64}\n"
                         f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] [guard] 启动后端\n")
                fh.flush()
                code = subprocess.call(
                    cmd, cwd=str(BASE), env=env,
                    stdout=fh, stderr=subprocess.STDOUT,
                )
        except KeyboardInterrupt:
            log("守护收到中断信号，退出（后端已同时停止）")
            return 0
        except Exception as exc:  # 解释器都起不来之类
            log(f"无法启动后端进程：{type(exc).__name__}: {exc}")
            return 1

        uptime = time.time() - started

        if code == EXIT_ALREADY_RUNNING:
            log("后端报告「已有实例在运行」—— 守护结束，服务由既有实例提供")
            return 0

        if uptime < FAST_CRASH_WINDOW:
            fast_crashes += 1
            log(f"后端启动 {uptime:.1f}s 即退出（code={code}，连续第 {fast_crashes} 次）")
            if fast_crashes >= FAST_CRASH_LIMIT:
                log("连续启动即退出，守护放弃（多为配置错误）。请看本日志上方的 uvicorn 报错")
                return 1
        else:
            fast_crashes = 0
            log(f"后端运行 {uptime / 60:.1f} 分钟后退出（code={code}），准备自动重启")

        time.sleep(RESTART_DELAY)


if __name__ == "__main__":
    sys.exit(main())
