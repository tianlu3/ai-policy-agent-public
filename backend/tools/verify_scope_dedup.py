"""地域收窄 + 同名去重 · 闸门（纯本地、不联网、秒级）。

钉住的约定（2026-10-15 用户实测两条反馈）：

【1】地域**准确性** —— 筛选栏里下钻到区县后，结果集不得再横向铺开它的兄弟节点。
     用户搜「上海市 / 杨浦区 · 跨境电商 · 补贴」，列表里却出现了松江 / 崇明 /
     徐汇 / 普陀 / 浦东新区 …… 等 15 个毫无关系的区。根因是「下辖全层级展开」
     对选中节点无条件生效。现在：某选中节点的下级**也被显式选中**时，
     只走被选中的那几支（含其间中间层级），其余下辖一概不收。
【2】不能把老行为改坏 —— 没有下钻的情形（只选省 / 两个平级省）仍按原设计铺满全层级。
     2026-10-16 起**市级勾选语义收窄**：只勾市（不勾省、不下钻）= 该市 + 所属省，
     不再铺下辖县区 —— 「只发已生效地域」（用户口径）。
【3】跨两级下钻（浙江省 + 西湖区）必须保住中间层「杭州市」，不能只剩省 + 区。
【4】同名**去重** —— 归一化政策名（抹掉书名号 / 空白 / 标点）后逐字相同即合并，
     保留先出现的那条（模型抽的排在本地清单前面）。发文机关参与比较，
     不误伤「同名但确由不同机关发布」的两份文件。
【5】去重后 id 仍唯一、字段仍完整（列表页 / 详情页一个字段都不能少）。
"""
from __future__ import annotations

import sys
from collections import Counter
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import config, wrap  # noqa: E402
from app.llm import mock  # noqa: E402
from app.llm.base import ExtractionRequest, ExtractionResult  # noqa: E402

pass_n = 0
fail_n = 0


def ok(cond: bool, msg: str, extra: object = None) -> None:
    global pass_n, fail_n
    if cond:
        pass_n += 1
        print(f"  ✓ {msg}")
    else:
        fail_n += 1
        print(f"  ✗ {msg}" + (f" → {extra!r}" if extra is not None else ""))


def build_req(regions: list[str], industries: str = "", types: str = "") -> ExtractionRequest:
    return ExtractionRequest(
        query="跨境电商补贴", regions=regions, industries=industries, types=types,
        today=date.today().isoformat(), max_items=config.SEARCH_MAX_ITEMS,
    )


def scope_names(req: ExtractionRequest) -> list[str]:
    """本次展开出来的地域块名（按层级顺序）。"""
    blocks, _ = mock._pick_targets(req)
    return [str(b["scope"].get(b["level"]) or "") for b in blocks]


def policy_names(req: ExtractionRequest) -> list[str]:
    return [str(p.get("name") or "") for p in mock.MockProvider().extract(req).policies]


def hits(names: list[str], needles: tuple[str, ...]) -> list[str]:
    return [n for n in names if any(x in n for x in needles)]


print("\n【1】用户截图场景：上海市 + 杨浦区（下钻到区县）")
SH = build_req(["上海市", "杨浦区"], "跨境电商", "补贴")
blocks_sh, themes_sh = mock._pick_targets(SH)
scopes_sh = scope_names(SH)
names_sh = policy_names(SH)
OTHER_DISTRICTS = ("黄浦区", "徐汇区", "长宁区", "静安区", "普陀区", "虹口区",
                   "闵行区", "宝山区", "嘉定区", "浦东新区", "金山区", "松江区",
                   "青浦区", "奉贤区", "崇明区")

ok(len(blocks_sh) == 3, "展开只剩 3 个块（全国 + 上海市 + 杨浦区）", len(blocks_sh))
ok("杨浦区" in scopes_sh, "杨浦区在展开范围里", scopes_sh)
ok("上海市" in scopes_sh, "上级「上海市」仍在（市级政策对本区企业适用）", scopes_sh)
stray = hits(names_sh, OTHER_DISTRICTS)
ok(not stray, "★ 结果里不出现任何别的区（松江 / 崇明 / 徐汇 …）", stray[:4])
ok(not hits(scopes_sh, OTHER_DISTRICTS), "  展开的地域块里也没有别的区", hits(scopes_sh, OTHER_DISTRICTS))
ok(0 < len(names_sh) <= 30, "产出条数落在「一个市 + 一个区」的量级", len(names_sh))
ok(all(("上海市" in n or "杨浦区" in n or "全国" in n) for n in names_sh),
   "每一条政策都归属本次生效的地域", [n for n in names_sh if not ("上海市" in n or "杨浦区" in n or "全国" in n)][:3])

print("\n【2】省 + 下辖市（verify_search_flow 的真实载荷）")
ZJ = build_req(["浙江省", "杭州市"], "智能硬件 / 软件信息", "补贴 / 场地减免 / 稳岗")
scopes_zj = scope_names(ZJ)
names_zj = policy_names(ZJ)
OTHER_CITIES = ("宁波市", "温州市", "嘉兴市", "湖州市", "绍兴市", "金华市",
                "衢州市", "舟山市", "台州市", "丽水市")
ok(not hits(names_zj, OTHER_CITIES), "★ 不再铺开浙江省其余 10 个市", hits(names_zj, OTHER_CITIES)[:3])
ok(not hits(scopes_zj, OTHER_CITIES), "  块里也没有别的市", hits(scopes_zj, OTHER_CITIES)[:3])
ok("杭州市" in scopes_zj, "杭州市在范围内")
ok(any("西湖区" in s or "余杭区" in s or "上城区" in s for s in scopes_zj),
   "杭州市的区县照旧铺开", [s for s in scopes_zj if "区" in s][:4])
ok(6 <= len(names_zj) <= 500, "条数仍满足契约下限（≥6）", len(names_zj))

print("\n【3】跨两级下钻：浙江省 + 西湖区（中间层不能丢）")
ZJX = build_req(["浙江省", "西湖区"])
scopes_zjx = scope_names(ZJX)
ok("杭州市" in scopes_zjx, "★ 中间层「杭州市」被保住（不是只剩省 + 区）", scopes_zjx)
ok("西湖区" in scopes_zjx, "目标区县在范围内")
ok(not hits(scopes_zjx, OTHER_CITIES), "  其余地市被收掉", hits(scopes_zjx, OTHER_CITIES)[:3])
ok(not hits(scopes_zjx, ("上城区", "拱墅区", "滨江区", "萧山区", "余杭区")),
   "  杭州其余区县也被收掉", [s for s in scopes_zjx if "区" in s][:4])

print("\n【4】没有下钻的情形照旧铺满（回归守卫：别把老行为改坏）")
PROV = build_req(["浙江省"])
b_prov, _ = mock._pick_targets(PROV)
n_prov = len(policy_names(PROV))
ok(len(b_prov) > 90, "只选一个省 → 仍按全省全层级铺开", len(b_prov))
ok(n_prov > 100, "  条数仍是百条量级", n_prov)

NE = build_req(["内蒙古自治区", "黑龙江省"])
n_ne = len(policy_names(NE))
ok(n_ne > 300, "两个平级省 → 仍是「数百条」量级", n_ne)

CITY2 = build_req(["杭州市", "南京市"])
scopes_city2 = scope_names(CITY2)
ok("杭州市" in scopes_city2 and "南京市" in scopes_city2, "两个平级市都生效", scopes_city2[:4])
ok("浙江省" in scopes_city2 and "江苏省" in scopes_city2, "  各自所属省级块也在（上级政策适用下级）",
   scopes_city2[:4])
stray_cty = hits(scopes_city2, ("玄武区", "上城区", "西湖区", "拱墅区"))
ok(not stray_cty, "★ 单独勾市不铺下辖县区（2026-10-16 口径：只发已生效地域）", stray_cty[:4])

print("\n【4b】只勾一个市（不展开到县）：结果只含该市及上级")
CITY1 = build_req(["杭州市"])
scopes_city1 = scope_names(CITY1)
ok("杭州市" in scopes_city1 and "浙江省" in scopes_city1, "市块与省块都在",
   scopes_city1[:4])
ok(not hits(scopes_city1, ("西湖区", "拱墅区", "余杭区")),
   "  没有展开到县 —— 没下钻就不铺", hits(scopes_city1, ("西湖区", "拱墅区", "余杭区"))[:3])

print("\n【5】政策名归一化键")
ok(wrap.name_key("《上海市促进跨境电子商务发展专项资金管理办法》")
   == wrap.name_key("上海市促进跨境电子商务发展专项资金管理办法"),
   "书名号差异归为同一键")
ok(wrap.name_key("《上海市促进跨境电子商务发展专项资金管理办法》")
   == wrap.name_key("上海市促进跨境电子商务 发展专项资金管理办法"),
   "空白差异归为同一键")
ok(wrap.name_key("政策（试行）") == wrap.name_key("政策试行"), "括号差异归为同一键")
ok(wrap.name_key("政策A") != wrap.name_key("政策B"), "实质不同的名字不合并")
ok(wrap.name_key("") == "", "空名不炸")

print("\n【6】同名去重（wrap.dedup_by_name + build 落地的效果）")


def mk(name: str, issuer: str) -> dict:
    return {
        "name": name, "issuer": issuer, "level": "市级", "levelKey": "city",
        "types": "补贴", "industries": "跨境电商", "publish": "2026-05-01",
        "deadline": "2026-12-01", "subsidy": "详见申报指南",
        "conditions": ["A", "B", "C"],
        "conditionsFull": ["企业依法登记注册满 2 年", "财务制度健全", "无严重失信记录"],
        "materials": ["申报表"], "sources": [{"name": "官网", "kind": "原文链接", "url": "https://x"}],
        "snapshot": "……申报须同时满足：企业依法登记注册满 2 年……",
        "regionCodes": ["31"],
    }


DUP = "《上海市促进跨境电子商务发展专项资金管理办法》"
raws = [
    mk(DUP, "上海市商务委员会"),
    mk("上海市促进跨境电子商务发展专项资金管理办法", "上海市商务委员会"),   # 书名号差异
    mk(DUP, "上海市商务委员会"),                                            # 逐字重复
    mk(DUP, "上海市财政局"),                                                # 同名不同机关
    mk("《杨浦区跨境电商企业数字化转型补助实施细则》", "杨浦区发展和改革委员会"),
]
boot = wrap.build(SH, ExtractionResult(provider="mock", parsed=[], policies=list(raws),
                                       raw="", degraded=False), nodes=[], resolved={})
items = ((boot.get("policies") or {}).get("items")) or []
ok(len(items) == 3, "5 条输入（其中 3 条同名同机关）→ 3 条输出", len(items))
ok(sum(1 for i in items if wrap.name_key(i["name"]) == wrap.name_key(DUP)) == 2,
   "  同名但机关不同的两条都保留（不误伤）", [i["issuer"] for i in items])
ok(len({i["id"] for i in items}) == len(items), "  去重后 id 仍唯一", [i["id"] for i in items])

print("\n【7】去重后字段仍完整（列表页 / 详情页逐字段）")
need = ["id", "name", "issuer", "level", "levelKey", "types", "industries", "publish", "valid",
        "unverified", "dedup", "deadline", "daysLeft", "corner", "subsidy", "conditions",
        "conditionsFull", "materials", "sources", "confidence", "matched", "offset",
        "conditionsDetail", "snapshotMarks", "snapshot", "regionCodes"]
missing = sorted({k for it in items for k in need if it.get(k) is None and k not in ("offset",)})
ok(not missing, "全部渲染字段就位", missing)
ok(all(isinstance(it.get("confidence"), float) for it in items), "confidence 仍是数字")
ok(all(it.get("conditionsDetail") for it in items), "conditionsDetail 仍逐条下发")

print("\n【8】mock 全主题跑一遍：同名去重不会误伤正常结果")
CASES = [
    (["上海市", "杨浦区"], "跨境电商", "补贴"),
    (["浙江省", "杭州市"], "智能硬件 / 软件信息", "补贴 / 场地减免 / 稳岗"),
    (["内蒙古自治区", "黑龙江省"], "", ""),
    (["杭州市", "南京市"], "", ""),
]
bad_dup = []
for regs, inds, typs in CASES:
    req = build_req(regs, inds, typs)
    res = mock.MockProvider().extract(req)
    b = wrap.build(req, res, nodes=[], resolved={})
    its = ((b.get("policies") or {}).get("items")) or []
    keys = Counter((wrap.name_key(i["name"]), i["issuer"]) for i in its)
    dup = [k for k, c in keys.items() if c > 1]
    if dup:
        bad_dup.append((regs, dup[:2]))
    if len(its) != len(res.policies):
        bad_dup.append((regs, f"条数变化 {len(res.policies)} → {len(its)}"))
ok(not bad_dup, "  四个场景的产物里没有同名重复，也没有被误删", bad_dup[:3])

print(f"\n断言 {pass_n} 项通过，{fail_n} 项未通过" + (" ✅" if fail_n == 0 else " ❌"))
raise SystemExit(0 if fail_n == 0 else 1)
