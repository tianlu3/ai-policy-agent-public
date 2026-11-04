"""停止「守护 + 后端」这套演示服务。

顺序很重要：先杀守护，再杀后端。反过来的话守护会在 2 秒后把后端又拉起来。
守护用单实例锁端口定位（默认 8099），后端用 8000 定位 —— 都通过
Get-NetTCPConnection 查 OwningProcess，不靠命令行匹配，避免误杀别的 python。
"""
from __future__ import annotations

import os
import subprocess
import sys
import time

PORT = int(os.environ.get("PORT", "8000"))
LOCK_PORT = int(os.environ.get("LOCK_PORT", str(PORT + 99)))


def listening_pid(port: int) -> int | None:
    """查某端口的监听进程 PID（Windows Get-NetTCPConnection）。"""
    cmd = (
        f"(Get-NetTCPConnection -LocalPort {port} -State Listen "
        f"-ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess"
    )
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", cmd],
            capture_output=True, text=True, timeout=20,
        )
    except Exception as exc:
        print(f"[!] 查询端口 {port} 失败：{type(exc).__name__}: {exc}")
        return None
    txt = (out.stdout or "").strip()
    return int(txt) if txt.isdigit() and int(txt) > 0 else None


def kill(pid: int, label: str) -> bool:
    res = subprocess.run(
        ["taskkill", "/PID", str(pid), "/F", "/T"],
        capture_output=True, text=True,
    )
    ok = res.returncode == 0
    print(f"[{'✓' if ok else 'x'}] {label} PID {pid} {'已停止' if ok else '停止失败'}")
    return ok


def main() -> int:
    guard_pid = listening_pid(LOCK_PORT)
    server_pid = listening_pid(PORT)

    if guard_pid is None and server_pid is None:
        print(f"[i] 未发现守护（锁端口 {LOCK_PORT}）或后端（端口 {PORT}）在运行，无需操作")
        return 0

    if guard_pid:
        kill(guard_pid, "守护进程")
        time.sleep(0.8)   # 让守护先死透，避免它抢在后端之前重启
    if server_pid:
        kill(server_pid, "后端服务")

    time.sleep(0.5)
    if listening_pid(PORT) is None:
        print(f"[✓] 端口 {PORT} 已释放，服务已完全停止")
        return 0
    print(f"[!] 端口 {PORT} 仍有监听，可能被其它程序占用")
    return 1


if __name__ == "__main__":
    sys.exit(main())
