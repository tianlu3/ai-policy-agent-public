"""「清单补全」自检（纯本地，不调模型、不连数据库，秒级）。

用法：.venv/Scripts/python.exe tools/verify_catalog_expand.py

不需要设置任何环境变量：两个用例都在进程内锁定 Provider（FakeRemote / MockProvider），
跟 .env 里的 LLM_PROVIDER 无关。用 `DB_ENABLED=0` 跑可顺带避免写库。

背景：`auto` 真实模型路径下的「清单补全」。

免费档延迟波动大（实测 145s~336s，超 300s 会回退本地引擎），所以这里**进程内替换 provider**，
把「远端模型只返回 3 条」这一确定场景灌进完整流水线，验证：

  ① 模型抽取的条目原样保留（排在前面）；
  ② 本地清单引擎把它铺满到「地域全层级 × 主题」的规模（与 mock 路径一致）；
  ③ 总量受 SEARCH_RESULT_MAX 封顶；
  ④ 走本地引擎 / 降级时不会被重复铺；
  ⑤ 包装成十命名空间后 pager.total 跟得上结果集。
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import config, llm, wrap  # noqa: E402
from app.llm.base import ExtractionRequest, ExtractionResult  # noqa: E402
from app.llm.mock import MockProvider  # noqa: E402
from app.search import SearchRequest, SearchService  # noqa: E402

MODEL_ITEMS = 3


class FakeRemote:
    """假装是远端模型：返回极少量条目（模拟受输出 token 上限约束）。"""

    name = "fake-remote"
    is_remote = True

    def extract(self, req, messages=None):
        rows = []
        for i in range(MODEL_ITEMS):
            rows.append({
                "name": f"《关于支持中小微企业发展的若干政策措施（{i + 1}）》",
                "issuer": "内蒙古自治区发展和改革委员会",
                "level": "省级", "levelKey": "province",
                "types": "补贴 / 稳岗", "industries": "不限",
                "publish": "2026-01-05", "deadline": "2026-12-31",
                "subsidy": "按实际情况给予支持",
                "conditions": ["依法登记注册", "无严重失信记录"],
                "conditionsFull": ["在内蒙古自治区依法登记注册且正常经营满 1 年",
                                   "无严重失信记录，未重复享受同类财政资金"],
                "materials": ["申报表"], "confidence": 0.88,
                "snapshot": "……<mark>按实际情况给予支持</mark>……",
                "regionCodes": ["15"],
                "sources": [{"name": "内蒙古自治区人民政府网", "kind": "转载页"}],
            })
        return ExtractionResult(provider=self.name, parsed=[], policies=rows, degraded=False)


def run_case(label: str, patch_remote: bool, expect_degraded: bool = False) -> dict:
    # 两个用例都**在进程内锁定 Provider**，不依赖外部 LLM_PROVIDER 环境变量。
    # 原因：`patch_remote=False` 的用例走的是「本地规则引擎」，如果. env 是 auto（配了 Key），
    # 这里就会真的去打远端免费档（实测单次 145s~336s），60s 等待窗一到就停在 running，
    # 报出「AssertionError: running」这种与环境耦合的假失败。
    # ★ 补丁必须**接住用途参数**：调用点已改成 `build_provider("query"|"extract"|...)`
    #   （2026-10-14 按用途分模型），零参 lambda 会直接 TypeError 把流水线打成 failed。
    original = llm.build_provider
    llm.build_provider = (
        (lambda purpose="extract": FakeRemote()) if patch_remote
        else (lambda purpose="extract": MockProvider())
    )
    service = SearchService()
    try:
        task = service.start(SearchRequest.from_payload({
            "query": "", "regions": ["内蒙古自治区", "黑龙江省"],
            "industries": "", "types": "", "deadline": "",
        }))
        deadline = time.time() + 60
        while task.status == "running" and time.time() < deadline:
            time.sleep(0.2)
    finally:
        service.shutdown()
        llm.build_provider = original

    items = ((task.result or {}).get("policies") or {}).get("items") or []
    pager = ((task.result or {}).get("list") or {}).get("pager") or {}
    model_rows = [p for p in items if p["name"].startswith("《关于支持中小微企业发展")]
    added = [p for p in items if p["name"].endswith("实施细则》")]
    print(f"\n[{label}] provider={task.provider} degraded={task.degraded} status={task.status}")
    print(f"  总条数={len(items)} · 模型条目={len(model_rows)} · 本地清单条目={len(added)} · pager={pager}")
    for log in (task.logs or []):                       # 日志项结构是 {t, s, r}
        if "补全" in log.get("s", ""):
            print(f"  检索日志: {log['s']}")
    if expect_degraded:
        assert task.degraded is True, "本用例应走降级回退"
    # 通用断言
    assert task.status == "succeeded", task.status
    assert pager.get("total") == len(items), "pager.total 必须等于结果集条数"
    assert len(items) <= config.SEARCH_RESULT_MAX, "不得超过结果集硬上限"
    assert any(s.startswith("内蒙古") for s in [p["issuer"] for p in items]), "必须有内蒙古条目"
    assert any(s.startswith("黑龙江") for s in [p["issuer"] for p in items]), "必须有黑龙江条目"
    return {"items": items, "model_rows": model_rows, "added": added, "task": task}


print("=" * 78)
r1 = run_case("远端模型只出 3 条 → 应被铺满", patch_remote=True)
assert len(r1["model_rows"]) == MODEL_ITEMS, "模型条目必须原样保留"
assert len(r1["added"]) > 300, "本地清单引擎必须把结果铺到「数百条」"
# 注意：合并后 wrap.build 会按权威度（国家→省→市→区县）统一重排，
# 所以「模型条目排在前面」是**合并顺序**、不是最终展示顺序 —— 这里只断言它没被丢掉。
assert len(r1["items"]) == MODEL_ITEMS + len(r1["added"]), "合并不丢不重"
lv = {p["level"] for p in r1["model_rows"]} | {p["level"] for p in r1["added"]}
assert {"国家级", "省级", "市级", "区县级"} <= lv, f"层级应齐全，实际 {lv}"
print(f"  ✓ 模型 {MODEL_ITEMS} 条保留（合并时在前）+ 本地引擎补 {len(r1['added'])} 条"
      f" = {len(r1['items'])} 条，层级齐全")

print("=" * 78)
r2 = run_case("本地规则引擎（mock）→ 不应重复铺", patch_remote=False)
assert len(r2["added"]) == len(r2["items"]), "本地引擎路径不应出现模型条目、也不应翻倍"
assert len(r2["items"]) > 300, "本地引擎路径本身就该是数百条"
print(f"  ✓ 本地引擎路径 {len(r2['items'])} 条，未被重复铺")

print("=" * 78)
print("全部通过 ✅")
