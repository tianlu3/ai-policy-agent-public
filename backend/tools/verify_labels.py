"""「已解析出条件」口径自检（纯本地，不调模型、不连数据库、毫秒级）。

背景（用户实际报过的两轮显示矛盾）
----------------------------------
**第一轮**：首页「条件精确筛选」里行业写着「不限」，检索中面板却显示「行业 = 智能硬件」——
那个值是从查询文本里**猜**出来的，既不显示在筛选栏、用户也改不了，却实实在在地影响了产出。
当时的口径是「行业 / 类型只认筛选栏，一律不猜」，于是又引出**第二轮**：

    我是甘肃的公司，我们是做冬枣销售的，我想知道有没有关于场地的优惠政策

面板上写着 `行业 = 不限 / 类型 = 不限` —— 用户明明交代了行业与诉求，系统一个字没接住，
产出自然与他问的事无关。所以口径**收敛后不是「不猜」，而是「先解析、再检索，且每一步都标来源」**：

  1) 四行固定：地域 / 行业 / 类型 / 时间 —— 与首页四维筛选一一对应；
  2) **筛选栏 > 查询理解**：用户显式勾过的条件永远不被问句覆盖；
  3) 查询理解有两条来源：本地词表（app/query_parse.py，离线确定性）
     与大模型（LLMProvider.parse_query()），由 merge_hints() 叠加、**大模型优先**；
  4) **无论来自哪一侧都标出来源**（`· 来自查询` / `· 来自筛选栏`）——
     以前被诟病的不是「猜」，而是「猜了却不说，用户看不见也改不了」；
  5) 地域标来源，命中的区县很多时收敛成「前两个 等 n 项」。

用法：.venv/Scripts/python tools/verify_labels.py
"""

from __future__ import annotations

import string
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import labels, query_parse, wrap  # noqa: E402
from app.llm import mock  # noqa: E402

QUERY = "我是杭州做智能硬件的，能申什么补贴"
NODES = ["广西壮族自治区", "贺州市", "八步区", "平桂区", "昭平县", "钟山县", "富川瑶族自治县"]
# 用户原话：行业与类型都写在里面，但筛选栏一个字都没设
USER_QUERY = "我是甘肃的公司，我们是做冬枣销售的，我想知道有没有关于场地的优惠政策"

fails: list[str] = []


def _title_broken_tpl() -> str:
    """把模板改成坏槽位名，确认 cond_title 会退回原样拼接而不是抛异常。"""
    good = labels.TITLE_TPL
    try:
        labels.TITLE_TPL = "{prefix}「{grégion} · {índustry} · {týpe}」"
        return labels.cond_title({"region": "A", "industry": "B", "type": "C"})
    finally:
        labels.TITLE_TPL = good


def ok(cond: bool, label: str, extra: object = "") -> None:
    if cond:
        print("  ✓ " + label)
    else:
        fails.append(label)
        print("  ✗ " + label + (f" → {extra!r}" if extra != "" else ""))


def resolve(**kw) -> dict:
    """走唯一的入口：labels.resolve_conditions()。hints 不传 → 内部现算本地词表。"""
    return labels.resolve_conditions(**kw)


def lines(**kw) -> list[str]:
    return labels.condition_labels(resolve(**kw))


KEYS = ("地域", "行业", "类型", "时间")


def check_shape(name: str, out: list[str]) -> None:
    ok(len(out) == 4, f"{name}：四行（地域 / 行业 / 类型 / 时间）", out)
    for i, k in enumerate(KEYS):
        ok(str(out[i]).startswith(f"{k} = ") and out[i].split("= ", 1)[1].strip(),
           f"{name}：第 {i + 1} 行「{k} = …」且值非空", out[i])


print("【① 先解析：只给问句、什么都不设 → 问句里的行业 / 类型被读出来并标「来自查询」】")
a = lines(query=QUERY)
check_shape("空筛选栏", a)
ok(a[0] == "地域 = 杭州市 · 来自查询",
   "地域：筛选栏为空时从查询里识别城市，并标出「来自查询」", a[0])
ok(a[1] == "行业 = 智能硬件 · 来自查询",
   "行业：筛选栏没设，但问句里写了「智能硬件」→ 读出来当条件，并标明来自查询", a[1])
ok(a[2] == "类型 = 补贴 · 来自查询",
   "类型：同理，「补贴」被读出来当条件", a[2])
ok(a[3] == "时间 = 近 12 个月", "时间：问句里没提，就是默认窗口「近 12 个月」（不带来源）", a[3])

print("\n【①' 用户原话：甘肃 + 冬枣销售 + 场地政策（词表里都没有的名词）】")
u = lines(query=USER_QUERY)
ok(u[0] == "地域 = 甘肃省 · 来自查询", "地域：从问句里认出「甘肃省」", u[0])
ok(u[1] == "行业 = 农业 · 来自查询", "行业：「冬枣销售」→ 农业（扩展行业，不在筛选栏枚举里也照实写）", u[1])
ok(u[2] == "类型 = 场地减免 · 来自查询", "类型：「场地」→ 筛选栏枚举原值「场地减免」", u[2])
ok(u[3] == "时间 = 近 12 个月", "时间：没提 → 默认窗口", u[3])

print("\n【② 设了筛选栏：原样回显 + 标「来自筛选栏」，问句不得覆盖（筛选栏 > 查询理解）】")
b = lines(filter_regions=["浙江省", "杭州市"], query=QUERY,
          industries="智能硬件 / 软件信息", types="补贴 / 稳岗", deadline="近 90 天")
check_shape("筛选栏全设", b)
ok(b[0] == "地域 = 浙江省 / 杭州市 · 来自筛选栏", "地域：原样回显 + 标「来自筛选栏」", b[0])
ok(b[1] == "行业 = 智能硬件 / 软件信息 · 来自筛选栏",
   "行业：原样回显（用户的显式选择优先于问句解析结果）", b[1])
ok(b[2] == "类型 = 补贴 / 稳岗 · 来自筛选栏", "类型：原样回显", b[2])
ok(b[3] == "时间 = 近 90 天 · 来自筛选栏", "时间：原样回显", b[3])

print("\n【②' 部分维度设了：设了的用筛选栏、没设的退回查询理解（各标各的来源）】")
mx = lines(filter_regions=["福建省", "福州市"], query=QUERY, types="稳岗")
ok(mx[0] == "地域 = 福建省 / 福州市 · 来自筛选栏",
   "地域：筛选栏有值就不看问句里的「杭州」", mx[0])
ok(mx[1] == "行业 = 智能硬件 · 来自查询", "行业：没设 → 从问句解析（来自查询）", mx[1])
ok(mx[2] == "类型 = 稳岗 · 来自筛选栏", "类型：设了 → 筛选栏优先（问句里的「补贴」被压住）", mx[2])

print("\n【③ 地域：长清单收敛，来源可辨】")
c = lines(filter_regions=NODES, query=QUERY)
ok(c[0] == "地域 = 广西壮族自治区 / 贺州市 等 7 项 · 来自筛选栏",
   "7 个区县收敛成「前两个 等 7 项」，并标明来自筛选栏", c[0])
d = lines(query="帮我看看有什么补贴")
ok(d[0] == "地域 = 全国（不限）", "既没设筛选栏、查询里也没有城市 → 「全国（不限）」", d[0])
e = lines(filter_regions=["不存在的地区名"], query=QUERY)
ok(e[0] == "地域 = 杭州市 · 来自查询",
   "筛选栏里的名字解析不出来时，照旧回落到查询识别（不会静默变成全国）", e[0])

print("\n【④ 抽取引擎不再自己拼条件 —— 四行只有一个来源】")
r = mock.MockProvider().extract(mock.ExtractionRequest(
    query=QUERY, regions=["浙江省", "杭州市"], today="2026-10-13"))
ok(r.parsed == [],
   "mock.extract().parsed 恒为空：条件文案只由 labels 渲染，抽取层不再另拼一套",
   r.parsed)
# 流水线里真正落地的那一份（search.py → task.set_parsed）
pipe = labels.condition_labels(resolve(filter_regions=["浙江省", "杭州市"], query=QUERY,
                                      industries="智能硬件"))
check_shape("流水线落地", pipe)
ok(pipe[1] == "行业 = 智能硬件 · 来自筛选栏",
   "流水线落地的那份：筛选栏设了行业 → 来自筛选栏（用户的显式选择优先）", pipe[1])
ok(pipe == lines(filter_regions=["浙江省", "杭州市"], query=QUERY, industries="智能硬件"),
   "  set_parsed 用的那份与 lines() 逐字相同（同一个 resolve_conditions）", pipe)

print("\n【⑤ 先解析、再检索：解析出的行业真的参与检索（不是只贴在面板上）】")
# 不设筛选栏，行业由问句解析得到 —— 这正是用户要的「先解析再检索」
eff = resolve(query=QUERY)
bare = mock.MockProvider().extract(mock.ExtractionRequest(
    query=QUERY, regions=eff["nodes"] and ["浙江省", "杭州市"] or [],
    industries=eff["industries"], types=eff["types"], today="2026-10-13"))
names_bare = " | ".join(p["name"] for p in bare.policies)
ok(eff["industries"] == "智能硬件" and eff["condSources"]["industry"] == labels.SOURCE_QUERY,
   "生效行业来自查询理解", eff["industries"])
ok(len(bare.policies) > 0 and all("智能硬件" in p["name"] for p in bare.policies),
   "未设筛选栏、问句含行业 → 政策名带这个行业（解析结果真的驱动了产出）",
   names_bare[:90])
ok(all(p["industries"] != "不限" for p in bare.policies),
   "  且 industries 字段也不是「不限」（以前这里正是空转的那一处）",
   sorted({p["industries"] for p in bare.policies}))

# 一条都没解析出来的问句 → 行业仍是「不限」，产出覆盖多个行业
plain = mock.MockProvider().extract(mock.ExtractionRequest(
    query="帮我看看有什么补贴", regions=[], today="2026-10-13"))
ok(len({p["industries"] for p in plain.policies}) > 1,
   "问句里没有行业 → 「不限」的结果覆盖多个行业（各主题自带行业）",
   sorted({p["industries"] for p in plain.policies})[:6])

# 筛选栏设了行业 → 政策名带这个行业
with_ind = mock.MockProvider().extract(mock.ExtractionRequest(
    query=QUERY, regions=["浙江省", "杭州市"], industries="智能硬件", today="2026-10-13"))
ok(all("智能硬件" in p["name"] for p in with_ind.policies),
   "筛选栏设了行业 → 政策名才带这个行业（用户能看见、能改）",
   with_ind.policies[0]["name"])
ok(all(p["conditionsFull"] and "{" not in p["conditionsFull"][0] for p in with_ind.policies),
   "条款模板的 {industry} 全部替换成功（没留下花括号）",
   [p["conditionsFull"][0] for p in with_ind.policies])

# 类型也要真的收窄主题池：以前「融资」是悄悄落空的
fin = mock.MockProvider().extract(mock.ExtractionRequest(
    query="", regions=[], industries="", types="融资", today="2026-10-13"))
fin_types = {t for p in fin.policies for t in p["types"].split(" / ")}
ok(fin_types and fin_types <= {"金融", "贴息", "贷款"},
   "类型「融资」真的收窄了主题池（模板里写的是「金融 / 贴息」，不收窄就等于没设）",
   sorted(fin_types))

print("\n【⑥ 查询理解自身的口径（app/query_parse.py）】")
h = query_parse.parse(USER_QUERY)
ok(h.industries == "农业" and h.types == "场地减免",
   "本地词表：冬枣销售 → 农业；场地 → 场地减免", h.as_dict())
ok(query_parse.parse("").empty(), "空问句 → 空 Hints（不硬凑条件）")
ok(query_parse.normalize_type("场地") == "场地减免", "大模型给的简写「场地」归一到枚举值")
ok(query_parse.normalize_type("稳岗") == "稳岗", "已是枚举值则原样返回")
ok(query_parse.normalize_type("两化融合") == "两化融合", "认不出的原样保留（宁可写实话，不改写）")
ok(query_parse.parse("有没有近半年的稳岗政策").deadline == "近 180 天",
   "时间：「近半年」→ 近 180 天", query_parse.parse("有没有近半年的稳岗政策").as_dict())
ok(query_parse.parse("最近一周有没有新政策").deadline == "近 7 天", "「最近一周」→ 近 7 天")
ok(query_parse.parse("新材料企业有什么补贴").industries == "新材料",
   "最长优先：「新材料」压过「材料」（_hits 的排序规则）",
   query_parse.parse("新材料企业有什么补贴").industries)
ok(query_parse.parse("我是做冬枣的").industries == "农业",
   "词表之外的名词由水果词兜住（冬枣）", query_parse.parse("我是做冬枣的").industries)

# merge_hints：大模型优先于本地词表
low = query_parse.parse("我是做冬枣销售的，想找场地政策")
high = query_parse.from_llm({"industries": ["农业"], "types": ["场地"],
                             "deadline": "近 30 天", "keywords": ["冬枣"]})
merged = query_parse.merge_hints(low, high)
ok(merged.deadline == "近 30 天", "merge：大模型给了时间就用大模型的（本地词表没解析出时间）", merged.as_dict())
ok(merged.types == "场地减免", "merge：类型经归一后与筛选栏枚举同词", merged.types)
ok(query_parse.merge_hints(low, query_parse.Hints()).industries == "农业",
   "merge：大模型没给行业 → 沿用本地词表结果（不会把已有的解读抹掉）")
ok(query_parse.from_llm({"types": ["不存在的类型"]}).types == "不存在的类型",
   "merge：类型只归一、不白名单过滤（模型写实话就照实话写）")
ok(query_parse.from_llm({"deadline": "近 45 天"}).deadline == "",
   "deadline 不在枚举里 → 丢弃（单选维度必须落在筛选栏的原值上）")
ok(query_parse.from_llm({"deadline": "不限"}).deadline == "",
   "deadline 回「不限」= 没说 → 丢弃（否则条件行会印成「近 12 个月 · 来自查询」）",
   query_parse.from_llm({"deadline": "不限"}).as_dict())
ok(query_parse.from_llm({"industries": ["农业"], "deadline": "不限"}).empty() is False,
   "  但「不限」不影响其它字段（industries 仍被采纳）")
_dl = labels.condition_labels(resolve(query="帮我看下有没有场地政策",
                                     hints=query_parse.from_llm(
                                         {"industries": ["农业"], "types": ["场地减免"],
                                          "deadline": "不限"})))
ok(_dl[3] == "时间 = 近 12 个月",
   "  大模型回「不限」时，时间那行仍是默认窗口且**不带**来源后缀", _dl[3])
ok(_dl[0] == "地域 = 全国（不限）", "  地域照旧（没设、问句里也没提地名）", _dl[0])
ok(query_parse.from_llm("不是字典").empty(), "脏返回 → 空 Hints（不炸）")
ok(query_parse.from_llm({"industries": ["A", "B", "C", "D"]}).industries.count("/") == 1,
   "行业最多留 2 项（MAX_INDUSTRY）", query_parse.from_llm({"industries": ["A", "B", "C", "D"]}).industries)

print("\n· 结果列表页头标题（与四行同源，只是地域不带来源后缀）")
parts = labels.head_parts(filter_regions=["浙江省", "杭州市"],
                          industries="智能硬件 / 软件信息", types="补贴 / 场地减免 / 稳岗")
ok(parts["region"] == "浙江省 / 杭州市" and "来自" not in parts["region"],
   "地域列出全部生效节点（省+市）、**不带**「· 来自筛选栏」后缀（标题里太啰嗦）", parts["region"])
ok(parts["industry"] == "智能硬件 / 软件信息", "行业两项不收敛（正好 MAX_LIST 个）", parts["industry"])
ok(parts["type"] == "补贴 / 场地减免 等 3 项",
   "类型三项收敛成「前两个 等 3 项」（与「地域 = …」同一条收敛规则）", parts["type"])

parts_none = labels.head_parts(resolved=resolve(query=QUERY))
ok(parts_none["region"] == "杭州市", "筛选栏空 → 地域退回查询识别（仍是杭州市）", parts_none["region"])
ok(parts_none["industry"] == "智能硬件" and parts_none["type"] == "补贴",
   "  且行业/类型取查询理解的结果 —— 标题与四行同源，不再一个说「不限」一个说「智能硬件」",
   parts_none)

title = labels.result_title(parts)
ok(title == "结果 · 「浙江省 / 杭州市 · 智能硬件 / 软件信息 · 补贴 / 场地减免 等 3 项」",
   "结果列表页头标题渲染成期望文案", title)
ok(sorted(slot for _, slot, _, _ in string.Formatter().parse(labels.TITLE_TPL) if slot)
   == ["industry", "prefix", "region", "type"],
   "标题模板只吃 prefix / region / industry / type 四个槽位（改模板漏填会在这里报出来）",
   labels.TITLE_TPL)
ok("{" not in title and "}" not in title, "  渲染结果里不残留占位符", title)
ok("来自" not in title, "  标题里没有来源后缀（来源只在检索屏四行里交代）", title)
ok(labels.result_title({}) == "结果 · 「 ·  · 」" or "{" not in labels.result_title({}),
   "三个槽位全空也不炸（渲染层不因缺字段崩）", labels.result_title({}))
ok(_title_broken_tpl() == "结果 · 「A · B · C」",
   "模板被改坏（槽位名写错）时退回原样拼接，不让检索失败", _title_broken_tpl())

print()
print("· 检索屏标题：与结果列表**同一枚条件指纹**，只有前缀不同")
stitle = labels.search_title(parts)
ok(stitle == "正在检索 · 「浙江省 / 杭州市 · 智能硬件 / 软件信息 · 补贴 / 场地减免 等 3 项」",
   "检索屏标题渲染成期望文案", stitle)
ok(stitle[stitle.index("「"):] == title[title.index("「"):],
   "  与结果列表页头标题的「…」段逐字相同（用户报过两屏各说一套）")
ok(stitle.startswith(labels.TITLE_PREFIX_SEARCH) and title.startswith(labels.TITLE_PREFIX_RESULT),
   "  前缀分别是「正在检索 · 」/「结果 · 」，前缀也只在 labels.py 一处",
   [labels.TITLE_PREFIX_SEARCH, labels.TITLE_PREFIX_RESULT])
ok(QUERY not in stitle,
   "  标题里不出现用户原话（问句只进 tooltip；原话里的「杭州」曾与生效地域「福建省」打架）",
   stitle)
# 用户实报的场景：筛选栏选了福建、问句里写杭州 → 两屏都必须说福建
fj = labels.head_parts(resolved=resolve(filter_regions=["福建省", "福州市"], query=QUERY))
ok(fj["region"] == "福建省 / 福州市",
   "筛选栏有值时地域不退回问句（用户实报：标题说杭州、条件说福建）", fj["region"])
ok("杭州" not in labels.search_title(fj) and "杭州" not in labels.result_title(fj),
   "  两屏标题都不出现问句里的「杭州」", labels.search_title(fj))
ok(labels.search_title(fj)[labels.search_title(fj).index("「"):]
   == labels.result_title(fj)[labels.result_title(fj).index("「"):],
   "  同一场景下两屏仍是同一枚指纹")

print("\n· wrap.build() 拿到的 resolved 与面板四行同源（不传就现算，结果一致）")
from app.llm.base import ExtractionRequest  # noqa: E402

ex_req = ExtractionRequest(query=QUERY, regions=["浙江省", "杭州市"], industries="",
                           types="", deadline="", today="2026-10-13")
patch = wrap.build(ex_req, mock.MockProvider().extract(ex_req), nodes=[])
ok(patch["search"]["parsed"] == lines(query=QUERY, filter_regions=["浙江省", "杭州市"]),
   "wrap.build 未传 resolved 时现算的那份 == 直接调用 resolve_conditions 的那份",
   patch["search"]["parsed"])
ok(patch["search"]["parsed"][1] == "行业 = 智能硬件 · 来自查询",
   "  行业那行确实来自查询理解（筛选栏为空）", patch["search"]["parsed"][1])
ok(patch["search"]["condTitle"].startswith(labels.TITLE_PREFIX_SEARCH)
   and patch["list"]["head"]["title"].startswith(labels.TITLE_PREFIX_RESULT),
   "  两处标题前缀分工正确", [patch["search"]["condTitle"], patch["list"]["head"]["title"]])
ok(patch["search"]["condTitle"][patch["search"]["condTitle"].index("「"):]
   == patch["list"]["head"]["title"][patch["list"]["head"]["title"].index("「"):],
   "  wrap 产出的两屏标题也是同一枚指纹")

print()
if fails:
    print(f"{len(fails)} 项未通过 ❌")
    for f in fails:
        print("   -", f)
    sys.exit(1)
print("条件标签口径自检通过 ✅")
