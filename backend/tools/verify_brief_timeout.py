"""简报综述的**超时降级**闸门（纯本地、约 20 秒，不碰外网）。

为什么必须单独测：
  `provider.complete()` 的 `timeout` 是 **socket 每次读操作** 的超时。实测有网关注入空白保活，
  于是一旦服务端「慢慢吐字节」，socket 超时永远不会触发 —— 真正的兜底只能靠
  `app/brief.py → ai_summary()` 里那道 `thread.join(BRIEF_SUMMARY_TIMEOUT + 8)`。

本脚本在进程里起一个「每秒吐一个空格、总共吐 20 秒才给完整 JSON」的假模型端点，
断言：即便 socket 上始终有流量，简报也必须在 `BRIEF_SUMMARY_TIMEOUT + 8` 附近返回，
并且**退化到规则文案**而不是把用户挂满 20 秒。

    python tools/verify_brief_timeout.py
"""
from __future__ import annotations

import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app import brief, config, llm  # noqa: E402

SLOW_SECONDS = 20          # 假模型吐完整响应要多久
BRIEF_TIMEOUT = 3.0        # 被测的综述超时
EXPECT_MAX = (BRIEF_TIMEOUT + 8 + 4)  # join 截止 + 余量 + 渲染

LLM_TEXT = ("这是一段由假模型返回的综述，用于验证快速路径真的把模型文案用上了："
            "本批政策集中在技改补贴与稳岗返还，建议优先核对申报窗口与材料清单。")

failures: list[str] = []
passed = 0


def check(name: str, cond: bool, extra: str = "") -> None:
    global passed
    if cond:
        passed += 1
        print(f"  ✓ {name}" + (f"   → {extra}" if extra else ""))
    else:
        failures.append(name)
        print(f"  ✗ {name}" + (f"   → {extra}" if extra else ""))


class _Stall(BaseHTTPRequestHandler):
    """每秒吐 1 个空格，SLOW_SECONDS 秒后才把真正的内容写完。

    这样 socket 上始终有流量 ⇒ `provider.complete(timeout=BRIEF_TIMEOUT)` 的读超时不会触发。
    慢的通道每 2 秒吐一次、快的通道立即返回，用来分别验证「降级」与「正常」两条路。
    """
    protocol_version = "HTTP/1.1"
    slow = True

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        self.rfile.read(length)
        body = json.dumps({
            "id": "stub", "object": "chat.completion",
            "choices": [{"index": 0, "finish_reason": "stop",
                         "message": {"role": "assistant", "content": LLM_TEXT}}],
        }, ensure_ascii=False).encode("utf-8")

        if self.slow:
            pad = b" " * SLOW_SECONDS
            total = len(pad) + len(body)
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(total))
            self.end_headers()
            for _ in range(SLOW_SECONDS):
                self.wfile.write(b" ")
                self.wfile.flush()
                time.sleep(1)
            self.wfile.write(body)
        else:
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        self.wfile.flush()

    def log_message(self, *args) -> None:  # noqa: D102
        pass


PAYLOAD = {
    "format": "xlsx",
    "template": "onepage",
    "scope": "picked",
    "scopeLabel": "测试范围",
    "conditions": ["地域：全国（不限）", "行业：不限", "类型：不限", "时间：不限"],
    "policies": [{
        "name": "测试政策甲", "level": "市级", "issuer": "某市经信局", "types": "资金补助",
        "publish": "2026-01-01", "deadline": "2026-12-31", "daysLeft": 79,
        "subsidy": "最高 100 万元", "confidence": "高",
    }],
}


def main() -> int:
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Stall)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print(f"假模型端点：http://127.0.0.1:{port}（慢通道 {SLOW_SECONDS}s 才给完响应）")
    print(f"被测综述超时：BRIEF_SUMMARY_TIMEOUT={BRIEF_TIMEOUT}s → 期望在 {EXPECT_MAX:.0f}s 内返回\n")

    # 进程内改配置：把 provider 指到这个假端点，并把综述超时压到 3 秒
    config.LLM_PROVIDER = "auto"
    config.LLM_API_KEY = "stub-key"
    config.LLM_BASE_URL = f"http://127.0.0.1:{port}"
    config.LLM_MODEL = "stub"
    config.LLM_USE_PROXY = "0"
    config.BRIEF_SUMMARY_TIMEOUT = BRIEF_TIMEOUT

    try:
        print("[慢通道] socket 上有保活流量，读超时不会触发 —— 只能靠 join 截止")
        _Stall.slow = True
        t0 = time.monotonic()
        res = brief.create_brief(dict(PAYLOAD))
        wall = time.monotonic() - t0
        print(f"  实测 {wall:.1f}s（服务端自报 {res['elapsedMs']}ms）· 综述来源={res['summarySource']}")
        print(f"  说明：{res['summaryNote']}")
        check("硬超时生效：没有等满假模型的 20s", wall < EXPECT_MAX, f"{wall:.1f}s < {EXPECT_MAX:.0f}s")
        check("确实退化到规则文案", res["summarySource"] == "rule", res["summarySource"])
        check("说明里写清了超时原因", "未返回" in (res["summaryNote"] or ""), res["summaryNote"])
        check("纯本地路径也有可用文案（不是空）", len(res["summary"]) >= 40, f"{len(res['summary'])} 字")
        check("文件照常产出", res["bytes"] > 1000 and res["format"] == "xlsx", f"{res['bytes']} B")

        print("\n[快通道] 模型 1 秒内就回 —— 应当用上模型文案")
        _Stall.slow = False
        t0 = time.monotonic()
        res2 = brief.create_brief(dict(PAYLOAD))
        wall2 = time.monotonic() - t0
        print(f"  实测 {wall2:.1f}s · 综述来源={res2['summarySource']}")
        print(f"  说明：{res2['summaryNote']}")
        check("快速路径用的是模型文案", res2["summarySource"] == "llm", res2["summarySource"])
        check("模型文案原样进入简报", LLM_TEXT in res2["summary"], res2["summary"][:40])
        check("快速路径秒级返回", wall2 < 5, f"{wall2:.1f}s")
    finally:
        server.shutdown()

    print(f"\n结果：通过 {passed} 项，失败 {len(failures)} 项")
    if failures:
        print("失败项：\n  - " + "\n  - ".join(failures))
        return 1
    print("简报超时降级闸门通过 ✅")
    return 0


if __name__ == "__main__":
    sys.exit(main())
