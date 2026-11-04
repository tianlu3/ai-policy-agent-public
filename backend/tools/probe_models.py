"""模型选型探针：用同一把 Key、同一 base URL，横向实测各候选免费/低价模型的
延迟与输出能力（不改任何配置，只打印结果）。

用法：
    .venv/Scripts/python.exe tools/probe_models.py            # 跑默认候选清单
    .venv/Scripts/python.exe tools/probe_models.py glm-4.7-flash glm-4-flash

两个探针：
  A 短输出（查询理解）：要求只吐 JSON，衡量「解析速度」；
  B 长输出（简报综述）：要求写 180–300 字中文综述，衡量「长文写作 + 吞吐」。
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import config  # noqa: E402
from app.llm.openai_compat import OpenAICompatProvider  # noqa: E402

CANDIDATES = ["glm-4-flash", "glm-4.7-flash", "glm-4.5-flash", "glm-4.7-flashx"]

SHORT_PROMPT = (
    "从下面这句话里读出【地域】【行业】【类型】【时间】四项，只输出 JSON，"
    "取不到的写「不限」。\n"
    "问句：我是杭州做智能硬件的，能申什么补贴？\n"
    '输出格式：{"region":"","industry":"","type":"","time":""}'
)
LONG_PROMPT = (
    "你在为一家杭州的智能硬件企业写政策简报综述。请用 180–300 字中文，"
    "客观说明：本批政策的地域分布、主要支持方向、企业最该关注的申报窗口。"
    "只输出正文，不要标题、不要分点符号。"
)


def run(model: str) -> dict:
    row: dict = {"model": model}
    try:
        p = OpenAICompatProvider(
            base_url=config.LLM_BASE_URL,
            api_key=config.LLM_API_KEY,
            model=model,
            timeout=120,
            max_tokens=2048,
            use_proxy=config.LLM_USE_PROXY,
            max_retries=0,
        )
    except Exception as exc:  # noqa: BLE001
        row["error"] = f"构建失败：{exc}"
        return row

    for tag, prompt, max_tokens in (("A", SHORT_PROMPT, 300), ("B", LONG_PROMPT, 900)):
        t0 = time.monotonic()
        try:
            text = p.complete(
                [{"role": "user", "content": prompt}],
                max_tokens=max_tokens,
                temperature=0.3,
                timeout=120,
            )
            dt = time.monotonic() - t0
            row[tag] = {
                "sec": round(dt, 1),
                "chars": len(text.strip()),
                "sample": text.strip().replace("\n", " ")[:110],
            }
        except Exception as exc:  # noqa: BLE001
            row[tag] = {"sec": round(time.monotonic() - t0, 1), "error": str(exc)[:160]}
    return row


def main() -> int:
    models = sys.argv[1:] or CANDIDATES
    print(f"base_url = {config.LLM_BASE_URL}")
    print(f"候选模型 = {models}\n")
    for m in models:
        r = run(m)
        if r.get("error"):
            print(f"[{m}] ✗ {r['error']}")
            continue
        a, b = r["A"], r["B"]
        fmt = lambda d: (f"{d['sec']}s / {d['chars']}字" if "chars" in d else f"✗ {d.get('error')}")
        fa, fb = fmt(a), fmt(b)
        print(f"[{m}]  短输出(查询理解) {fa}   长输出(简报综述) {fb}")
        if "sample" in a:
            print(f"    短输出样例: {a['sample']}")
        if "sample" in b:
            print(f"    长输出样例: {b['sample']}")
        print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
