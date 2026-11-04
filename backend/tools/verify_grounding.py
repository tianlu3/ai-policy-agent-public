"""原文定位（Grounding）· 证据链闸门（纯本地、不联网、秒级）。

钉住的约定（2026-10-14「有些条件在原文中都看不到」的修复）：

【1】定位的四种情形各自成立：逐字命中 / 仅标点差异 / 数字不一致 / 原文没有；
【2】字符偏移**可回溯**：`snapshot[charStart:charEnd]` 切出来必须就是那条条款。
     ★ `exact=True`（原文里逐字存在这句）的条款，切出来必须与条款本体**逐字相同**
     —— 归一化会丢掉空白与标点，反推的区间曾漏掉条款末尾的 `）`（偏移对了、
     高亮少一个字符）。这里只比「归一化后互相包含」是拦不住的，必须逐字比。
【3】状态与分数单调：verified ≥ 0.92 > normalized ≥ 0.80 > digit_mismatch，
     未命中 ≤ 0.35 且一定没有偏移；
【4】`snapshotMarks` 与 `conditionsDetail` 同源（同一组区间），互不重叠且在正文范围内；
【5】政策级置信度 = 0.6×平均 + 0.4×最弱；含未命中条款的政策不得被判成高分；
【6】★ 回归守卫：**任何一个偏移都不得越界**。改造前是 `1200 + index*437 + rand`
     的编造值（实测报到 7821，而原文摘录只有 64~104 字）——
     用户看到的「字符偏移 7821–7863」就是这么来的；
【7】旧契约字段一个不少（confidence / offset / matched / conditionsFull / sources …）；
【8】条款命中率 ≥ 95%（主题池里刻意留了一条「原文未命中」用于覆盖该路径）；
【9】evidence 通道：条款本体定位不到、但模型给出的原文引用能定位时，
     `locatedVia` 记为 `evidence` 且分数被压在 normalized 档。
"""
from __future__ import annotations

import sys
from collections import Counter
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import ground, wrap  # noqa: E402
from app.llm import mock  # noqa: E402
from app.llm.base import ExtractionRequest  # noqa: E402

pass_n = 0
fail_n = 0


def ok(cond: bool, msg: str, extra: object = None) -> None:
    global pass_n, fail_n
    if cond:
        pass_n += 1
        print(f"  ok   {msg}" + ("" if extra is None else f"   → {extra}"))
    else:
        fail_n += 1
        print(f"  FAIL {msg}" + ("" if extra is None else f"   → {extra}"))


# ---------------------------------------------------------------- 构建一份真实结果集
SRC_TECH = ("……本细则适用于省内注册运营的制造企业。申报须同时满足："
            "在省内依法注册登记满 2 年；上年度营业收入不低于 2000 万元，"
            "其中制造业相关业务收入占比不低于 50%。近两年内无重大安全生产事故……")

print("【1】定位的四种情形")

f = ground.locate("上年度营业收入不低于 2000 万元", SRC_TECH)
ok(f.status == ground.STATUS_VERIFIED and f.confidence >= 0.92,
   "逐字命中 → verified 且 ≥ 0.92", {"status": f.status, "conf": f.confidence})
ok(SRC_TECH[f.char_start:f.char_end] == "上年度营业收入不低于 2000 万元",
   "  偏移切出来就是原句（真实可回溯）", SRC_TECH[f.char_start:f.char_end])
ok(f.exact is True and f.factors.get("matches") is None,
   "  标记为逐字命中（exact=True）", {"exact": f.exact, "coverage": f.coverage})

f2 = ground.locate("上年度营业收入不低于2000万元。", SRC_TECH)
ok(f2.status == ground.STATUS_NORMALIZED and 0.80 <= f2.confidence < 0.90,
   "仅标点/空格差异 → normalized 且落在 0.80~0.89", {"status": f2.status, "conf": f2.confidence})
ok(f2.char_start == f.char_start, "  仍定位到同一处（没有因为标点差别就判「找不到」）")

f3 = ground.locate("上年度营业收入不低于 5000 万元", SRC_TECH)
ok(f3.status == ground.STATUS_DIGIT_MISMATCH,
   "数字对不上 → 专门判为 digit_mismatch（不是含糊的「未命中」）",
   {"status": f3.status, "conf": f3.confidence})
ok(f3.factors.get("digitsMissing") == ["5000"] and f3.confidence < 0.80,
   "  factors 点名是哪个数字对不上，且分数被压下来", f3.factors)
ok(f3.matched and f3.char_start >= 0,
   "  句意命中了仍给偏移（用户能自己去看原文到底写多少）")

f4 = ground.locate("企业须连续三年获得省级以上技术创新示范企业称号", SRC_TECH)
ok(f4.status == ground.STATUS_UNMATCHED and f4.confidence <= ground.UNMATCHED_MAX,
   "原文里确实没有 → unmatched 且 ≤ 0.35", {"status": f4.status, "conf": f4.confidence})
ok(f4.char_start == -1 and f4.evidence == "" and f4.matched is False,
   "  未命中时不给偏移、不给原句（绝不编一个出来）")

print("\n【2】evidence 通道：条款本体定位不到，但模型给的原文引用能定位")

f5 = ground.locate_with_evidence(
    "企业须为上年度营业收入 2000 万元以上的制造企业", SRC_TECH,
    evidence="上年度营业收入不低于 2000 万元",
)
ok(f5.matched and f5.factors.get("locatedVia") == "evidence",
   "退一步按引用定位成功，locatedVia = evidence", f5.factors.get("locatedVia"))
ok(f5.confidence <= 0.85, "  分数被压在引用档（≤0.85，不与逐字命中同分）", f5.confidence)

f5b = ground.locate_with_evidence("上年度营业收入不低于 2000 万元", SRC_TECH)
ok(f5b.factors.get("locatedVia") == "quote",
   "条款本体就能定位时，locatedVia 记为 quote（走不到引用那一步）", f5b.factors.get("locatedVia"))

f6 = ground.locate_with_evidence("企业须获得省级以上示范称号", SRC_TECH,
                                evidence="企业须获得省级以上示范称号")
ok(not f6.matched and f6.factors.get("evidenceChecked") is True,
   "条款与它给的引用都不在原文里 → 判未命中并点名「疑似幻觉」", f6.factors.get("reason"))

# ---------------------------------------------------------------- 全量结果集
print("\n【3】全量结果集的偏移可回溯性与单调性")

provider = mock.MockProvider()
req = ExtractionRequest(
    query="我是杭州做智能硬件的，能申什么补贴",
    regions=["浙江省"], industries="智能硬件", types="补贴",
    today=date.today().isoformat(), max_items=12,
)
extraction = provider.extract(req, [])
bootstrap = wrap.build(req, extraction, nodes=[], resolved={"regions": ["浙江省"]})
items = ((bootstrap.get("policies") or {}).get("items")) or []
ok(len(items) > 0, "mock 引擎产出了结果集（用于全量断言）", f"{len(items)} 条")

stat: Counter = Counter()
n_clause = 0
bad_slice: list = []
bad_mono: list = []
bad_unmatched: list = []
bad_mark: list = []
bad_range: list = []
policy_conf_bad: list = []

for it in items:
    details = it.get("conditionsDetail") or []
    source = it.get("snapshot") or ""
    if not details:
        bad_slice.append((it["name"], "conditionsDetail 为空"))
        continue
    for d in details:
        n_clause += 1
        st, conf = d["status"], d["confidence"]
        stat[st] += 1

        # 【2】偏移可回溯
        if d["matched"]:
            slc = source[d["charStart"]:d["charEnd"]]
            if d["exact"]:
                # 原文里逐字存在这句 → 切出来必须逐字相同（连首尾标点都不许少）
                if slc != d["full"]:
                    bad_slice.append((it["name"], "逐字命中却切片不一致",
                                      d["full"][-16:], slc[-16:]))
            else:
                a, _ = ground.normalize(slc)
                b, _ = ground.normalize(d["full"])
                if not a or not b or not (b in a or a in b):
                    bad_slice.append((it["name"], d["full"][:24], slc[:24]))
            if not (0 <= d["charStart"] < d["charEnd"] <= len(source)):
                bad_range.append((it["name"], d["charStart"], d["charEnd"], len(source)))
        else:
            # 【3】未命中必无偏移
            if d["offset"] != "" or d["charStart"] != -1:
                bad_unmatched.append((it["name"], d["offset"]))

        # 【3】状态与分数单调
        if st == ground.STATUS_VERIFIED and conf < 0.92:
            bad_mono.append((st, conf))
        elif st == ground.STATUS_NORMALIZED and not (0.80 <= conf < 0.92):
            bad_mono.append((st, conf))
        elif st == ground.STATUS_UNMATCHED and conf > ground.UNMATCHED_MAX:
            bad_mono.append((st, conf))
        elif st == ground.STATUS_DIGIT_MISMATCH and conf >= 0.80:
            bad_mono.append((st, conf))

    # 【5】政策级置信度公式
    confs = [d["confidence"] for d in details]
    want = round(0.6 * (sum(confs) / len(confs)) + 0.4 * min(confs), 2)
    if abs(want - it["confidence"]) > 0.011:
        policy_conf_bad.append((it["name"], want, it["confidence"]))
    if any(d["status"] == ground.STATUS_UNMATCHED for d in details) and it["confidence"] >= 0.90:
        policy_conf_bad.append((it["name"], "含未命中条款却 ≥0.90", it["confidence"]))

    # 【4】marks 与 detail 同源、互不重叠、在范围内
    marks = it.get("snapshotMarks") or []
    detail_spans = {(d["charStart"], d["charEnd"]) for d in details if d["matched"]}
    for s, e in marks:
        if (s, e) not in detail_spans:
            bad_mark.append((it["name"], (s, e), "不在 conditionsDetail 里"))
        if not (0 <= s < e <= len(source)):
            bad_mark.append((it["name"], (s, e), "越界"))
    for i in range(1, len(marks)):
        if marks[i][0] < marks[i - 1][1]:
            bad_mark.append((it["name"], marks[i], "与前一段重叠"))

    # 【6】回归守卫：偏移不得越界（编造偏移的典型症状）
    for d in details:
        if d["charEnd"] > len(source):
            bad_range.append((it["name"], d["charStart"], d["charEnd"], len(source)))

ok(not bad_slice, "每条已定位条款的偏移切出来就对得上（exact 的必须逐字相同）",
   bad_slice[:3] or f"{n_clause} 条全过")
ok(not bad_range, "★ 没有任何偏移越界（编造偏移的回归守卫）", bad_range[:3] or "全过")
ok(not bad_mono, "状态与分数单调（verified ≥0.92 / normalized 0.80~0.89 / unmatched ≤0.35）",
   bad_mono[:3] or "全过")
ok(not bad_unmatched, "未命中的条款一律不给偏移（不编造）", bad_unmatched[:3] or "全过")
ok(not bad_mark, "snapshotMarks 与 conditionsDetail 同源、互不重叠、在正文范围内",
   bad_mark[:3] or "全过")
ok(not policy_conf_bad, "政策级置信度 = 0.6×平均 + 0.4×最弱；含未命中条款的不判高分",
   policy_conf_bad[:3] or "全过")

# ---------------------------------------------------------------- 全主题横扫
# 上面那份结果集只有 19 条政策，而主题池里还有若干条（含 3 个区县变体）。
# 这里把**每个主题的每条条款**都拿它的原文摘录过一遍定位，专门盯边界对齐：
# 归一化会丢掉空白与标点，条款若以 `）`／`，` 收尾，反推的区间曾漏掉那个字符。
print("\n【3.5】全主题横扫：exact 的条款切出来必须逐字相同")

sweep_clause = 0
sweep_exact = 0
sweep_edge = 0                      # 首/尾确实有「被归一化丢掉的标点」的条款数
sweep_bad: list = []
sweep_unmatch: list = []
for theme in mock._THEMES:
    snap = theme.snapshot.format(region="浙江省", industry="智能硬件")
    for tpl in theme.conditions_full:
        quote = tpl.format(region="浙江省", industry="智能硬件")
        sweep_clause += 1
        head, tail = ground._edge_drops(quote)
        if head or tail:
            sweep_edge += 1
        f = ground.locate(quote, snap)
        if not f.matched:
            sweep_unmatch.append((theme.core, quote[:22]))
            continue
        slc = snap[f.char_start:f.char_end]
        if f.exact:
            sweep_exact += 1
            if slc != quote:
                sweep_bad.append((theme.core, "尾", quote[-14:], slc[-14:]))
        if not (0 <= f.char_start < f.char_end <= len(snap)):
            sweep_bad.append((theme.core, "越界", f.char_start, f.char_end, len(snap)))

ok(sweep_edge > 0, f"主题池里确有「首/尾带标点、归一化会丢掉」的条款（{sweep_edge} 条）",
   "否则这条守卫会退化成空跑")
ok(not sweep_bad, f"全主题 {sweep_clause} 条条款：exact 的切片一律与条款本体逐字相同",
   sweep_bad[:3] or f"exact {sweep_exact} 条全过")
ok(len(sweep_unmatch) == 1,
   "  主题池里只留 1 条「原文未命中」（其余条款都在原文里能找到）",
   sweep_unmatch)

print("\n【4】命中率与旧契约字段")

hit = stat[ground.STATUS_VERIFIED] + stat[ground.STATUS_NORMALIZED]
rate = hit / n_clause if n_clause else 0
ok(rate >= 0.95, f"条款命中率 ≥ 95%（实测 {rate * 100:.1f}%）",
   dict(stat))

# 上面那份结果集带「智能硬件」行业过滤，会把「产业人才引进补贴」主题整条筛掉 ——
# 而**刻意保留的那条「原文未命中」条款**正好在那个主题里。所以另取一份不限行业的结果集，
# 专门覆盖 unmatched 路径（否则这条路径永远测不到）。
req_all = ExtractionRequest(
    query="", regions=["浙江省"], industries="", types="",
    today=date.today().isoformat(), max_items=12,
)
boot_all = wrap.build(req_all, provider.extract(req_all, []), nodes=[],
                      resolved={"regions": ["浙江省"]})
items_all = ((boot_all.get("policies") or {}).get("items")) or []
un_all = [(it, d) for it in items_all
          for d in (it.get("conditionsDetail") or [])
          if d["status"] == ground.STATUS_UNMATCHED]
ok(bool(un_all), "主题池里保留了一条「原文未命中」的条款，用于覆盖该路径",
   f"{len(un_all)} 条 / {len(items_all)} 条政策")
ok(all(d["offset"] == "" and d["confidence"] <= ground.UNMATCHED_MAX for _, d in un_all),
   "  未命中条款：无偏移 + 低分", [d["confidence"] for _, d in un_all[:3]])
ok(all(it["confidence"] < 0.90 and it["unverified"] > 0 for it, _ in un_all),
   "  含未命中条款的政策整体降分，且 unverified 计数同步",
   [(it["confidence"], it["unverified"]) for it, _ in un_all[:3]])
ok(all("unmatched" not in {d["status"] for d in (it.get("conditionsDetail") or [])}
       or it["unverified"] > 0 for it in items),
   "有未命中条款的政策，unverified 计数同步反映出来",
   sum(1 for it in items if it["unverified"]))

REQUIRED = ["id", "name", "issuer", "level", "levelKey", "types", "industries", "publish",
            "valid", "unverified", "dedup", "deadline", "daysLeft", "corner", "subsidy",
            "conditions", "conditionsFull", "materials", "sources", "confidence", "matched",
            "offset", "regionCodes", "snapshot", "snapshotMarks", "conditionsDetail"]
missing = sorted({f for it in items for f in REQUIRED if f not in it})
ok(not missing, "旧契约字段一个不少，新字段齐全", missing or "全过")
ok(all(isinstance(it["confidence"], (int, float)) and 0 <= it["confidence"] <= 1 for it in items),
   "confidence 仍是 0~1 的数字（旧契约）")
ok(all(" · " in it["matched"] for it in items),
   'matched 仍含 " · "（详情页 split 依赖）', items[0]["matched"])
ok(not any(d.get("reported") for d in items[0]["conditionsDetail"]),
   "conditionsDetail 不下发模型自报值（打分只认证据）")

print("\n【5】重复命中要扣分")

dup_src = "……企业上年度营业收入不低于 2000 万元。另有条款：上年度营业收入不低于 2000 万元……"
fd = ground.locate("上年度营业收入不低于 2000 万元", dup_src)
ok(fd.hits == 2, "同一句在原文出现两次 → hits = 2", fd.hits)
ok(fd.confidence <= 0.95, "  多处命中扣分（定位有歧义）", fd.confidence)

print(f"\n断言 {pass_n} 项通过，{fail_n} 项未通过" + (" ✅" if fail_n == 0 else " ❌"))
raise SystemExit(0 if fail_n == 0 else 1)
