"""诊断：验证守护自愈 —— 强杀后端，计时到新实例可服务。

用法：python tools/diag_guard_heal.py [端口]
判据：前端断连宽限期 15000ms，自愈必须显著小于它，界面才不会亮黄条。
"""
from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
import urllib.request

os.environ["NO_PROXY"] = "127.0.0.1,localhost"
os.environ["no_proxy"] = "127.0.0.1,localhost"

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
BASE = f"http://127.0.0.1:{PORT}"


def listening_pid(port: int) -> int | None:
    cmd = (f"(Get-NetTCPConnection -LocalPort {port} -State Listen "
           f"-ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess")
    out = subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", cmd],
                         capture_output=True, text=True, timeout=20)
    txt = (out.stdout or "").strip()
    return int(txt) if txt.isdigit() and int(txt) > 0 else None


def healthy(timeout: float = 1.0) -> bool:
    try:
        with urllib.request.urlopen(BASE + "/healthz", timeout=timeout) as resp:
            return resp.status == 200
    except Exception:
        return False


def main() -> int:
    pid = listening_pid(PORT)
    if pid is None:
        print(f"[x] 端口 {PORT} 无监听，守护没在跑？")
        return 2
    print(f"[1] 当前后端 PID = {pid}，healthz = {healthy()}")
    print(f"[2] 强杀后端（模拟控制台窗口被关 / 崩溃）…")
    os.kill(pid, signal.SIGTERM)
    t0 = time.time()

    seen_down = False
    healed_at = None
    while time.time() - t0 < 40:
        ok = healthy(timeout=0.8)
        el = time.time() - t0
        if not ok:
            seen_down = True
        elif seen_down:
            healed_at = el
            break
        time.sleep(0.25)

    new_pid = listening_pid(PORT)
    if healed_at is None:
        print(f"[x] 40s 内未恢复 —— 守护未生效。新 PID = {new_pid}")
        return 1

    print(f"[3] 自愈完成：{healed_at * 1000:.0f} ms 后重新可用（新 PID = {new_pid}）")
    grace = 15000
    verdict = "不会亮黄条（在宽限期内静默恢复）" if healed_at * 1000 < grace else "超过宽限期，会短暂亮黄条"
    print(f"[4] 前端宽限期 {grace} ms → {verdict}")
    return 0 if healed_at * 1000 < grace else 1


if __name__ == "__main__":
    sys.exit(main())
