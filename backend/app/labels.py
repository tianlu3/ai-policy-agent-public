"""「已解析出条件」这四行文案的唯一口径。

为什么要有这个模块
------------------
这四行必须**严格等于实际生效的检索条件**，并且把每个条件的**来源**说清楚：

    地域 = 广西壮族自治区 / 贺州市 等 7 项 · 来自筛选栏
    行业 = 农业 · 来自查询
    类型 = 场地减免 · 来自查询
    时间 = 近 12 个月

**先解析，再检索**（`resolve_conditions`）
------------------------------------------
用户写「我是甘肃的公司，我们是做冬枣销售的，我想知道有没有关于场地的优惠政策」时，
行业与类型显然该被读出来 —— 只认筛选栏的旧口径会让面板写着「行业 = 不限 / 类型 = 不限」，
用户交代的事系统一个字没接住。现在的规则：

* **筛选栏 > 查询理解**：用户显式勾过的条件永远不被问句覆盖；
* 查询理解的来源有两条：本地词表（`app/query_parse.py`，离线确定性）
  与大模型（`LLMProvider.parse_query()`，认得出词表没有的长尾表述），
  由 `query_parse.merge_hints()` 叠加（大模型优先）；
* **无论来自哪一侧都标出来源**（`· 来自查询`）—— 这是这套口径的关键：
  以前被诟病的不是「猜」，而是「猜了却不说，用户看不见也改不了」。
  地域那行早就这么标注了，行业 / 类型 / 时间现在与它一致。

改动之前，「地域」由流水线第 0 步拼、「行业」由抽取引擎拼，两处各写各的，
于是出现了一组自相矛盾的显示：首页「条件精确筛选」里行业写着「不限」，
检索中面板却显示「行业 = 智能硬件」—— 那个值从查询文本里猜出来，面板却只字未提。
"""
from __future__ import annotations

from . import regions

SOURCE_FILTER = "来自筛选栏"
SOURCE_QUERY = "来自查询"
NO_REGION = "全国（不限）"
NO_VALUE = "不限"
DEFAULT_WINDOW = "近 12 个月"

# 逐项最多列几个，超出收成「等 n 项」。
# 7 个区县名铺满一行会把后面的条件挤出视野，反而看不清。
MAX_LIST = 2

# 截止时间是把「不限」当默认值的单选：选了「不限」等于「这一维没设」，应当继续看问句里怎么说。
DEADLINE_ANY = "不限"


def effective_regions(filter_names=None, query: str = "") -> tuple[list, str]:
    """实际生效的地域节点 + 来源标签（'', SOURCE_FILTER, SOURCE_QUERY 之一）。"""
    names = [n for n in (filter_names or []) if n]
    nodes = []
    if names:
        try:
            nodes = [n for n in regions.resolve(names) if n.level >= 1]
        except Exception:  # noqa: BLE001 - 解析异常按「未限定」处理，不阻断检索
            nodes = []
    if nodes:
        return nodes, SOURCE_FILTER
    hit = []
    try:
        hit = [n for n in regions.match_in_text(query or "") if n.level >= 1]
    except Exception:  # noqa: BLE001
        hit = []
    if hit:
        return hit, SOURCE_QUERY
    return [], ""


def resolve_conditions(filter_regions=None, query: str = "", industries: str = "",
                       types: str = "", deadline: str = "", hints=None) -> dict:
    """**本次检索实际生效的条件** + 每一项的来源 —— 全套口径的唯一入口。

    参数里的 industries / types / deadline 是**首页筛选栏的原始值**（不是生效值）；
    问句解析结果由 `hints` 传入（已由 `query_parse.merge_hints()` 合并好大模型与本地词表），
    不传就现算一次本地词表解析。

    返回：
        nodes            生效地域节点（供产出与标题使用）
        industries/types/deadline   生效值（空串 = 该维「不限」）
        condSources      {industry/type/deadline: 来源标签}，空串表示没有来源可言
        regionSource     地域来源标签
    """
    from . import query_parse  # 函数内导入：query_parse 不认识 labels，不构成环

    nodes, region_source = effective_regions(filter_regions, query)
    if hints is None:
        hints = query_parse.parse(query)

    def pick(panel_value: str, hint_value: str, blank=()) -> tuple[str, str]:
        """筛选栏设了就用筛选栏的；否则用查询理解的结果（带来源）。

        `blank` 里的值等于「这一维没设」（截止时间的单选「不限」）——
        **两侧都判**：模型回一句「不限」跟没回是一样的，若只判筛选栏一侧，
        条件行就会印成「时间 = 近 12 个月 · 来自查询」（值是默认窗口，来源却说是查询给的）。
        """
        panel_value = (panel_value or "").strip()
        if panel_value and panel_value not in blank:
            return panel_value, SOURCE_FILTER
        hint_value = (hint_value or "").strip()
        if hint_value and hint_value not in blank:
            return hint_value, SOURCE_QUERY
        return "", ""

    eff_industries, industry_source = pick(industries, getattr(hints, "industries", ""))
    eff_types, type_source = pick(types, getattr(hints, "types", ""))
    eff_deadline, deadline_source = pick(deadline, getattr(hints, "deadline", ""), blank=(DEADLINE_ANY,))

    return {
        "nodes": nodes,
        "regionSource": region_source,
        "industries": eff_industries,
        "types": eff_types,
        "deadline": eff_deadline,
        "condSources": {
            "industry": industry_source,
            "type": type_source,
            "deadline": deadline_source,
        },
    }


def region_text(nodes: list, source: str = "") -> str:
    """节点集合 → 「广西壮族自治区 / 贺州市 等 7 项 · 来自筛选栏」。"""
    if not nodes:
        return NO_REGION
    names = [n.name for n in nodes]
    head = " / ".join(names[:MAX_LIST])
    tail = f" 等 {len(names)} 项" if len(names) > MAX_LIST else ""
    return head + tail + (f" · {source}" if source else "")


def condition_labels(resolved: dict) -> list[str]:
    """→ 面板上那四行。地域 / 行业 / 类型 / 时间，与首页「条件精确筛选」同构。

    只接受 `resolve_conditions()` 的结果：生效值与来源必须一起传进来，
    否则「这个值是谁设的」就无从判断 —— 而来源恰恰是这套口径的重点。
    """
    r = resolved or {}
    src = r.get("condSources") or {}

    def line(value: str, source: str) -> str:
        return value + (f" · {source}" if source else "")

    industries = (r.get("industries") or "").strip() or NO_VALUE
    types = (r.get("types") or "").strip() or NO_VALUE
    deadline = (r.get("deadline") or "").strip()
    if deadline in ("", DEADLINE_ANY):
        # 截止时间单选的「不限」在文案上是「近 12 个月」这个默认窗口
        deadline = DEFAULT_WINDOW

    return [
        f"地域 = {region_text(list(r.get('nodes') or []), r.get('regionSource') or '')}",
        f"行业 = {line(industries, src.get('industry') or '')}",
        f"类型 = {line(types, src.get('type') or '')}",
        f"时间 = {line(deadline, src.get('deadline') or '')}",
    ]


def parsed_value(parsed, key: str, default: str = "") -> str:
    """从 ['地域 = …', '行业 = …', …] 里取某一项的值（wrap.py 复用它拼订阅/提醒标题）。"""
    prefix = f"{key} = "
    for line in parsed or []:
        if isinstance(line, str) and line.startswith(prefix):
            return line[len(prefix):].strip()
    return default


def _brief(raw: str, fallback: str) -> str:
    """把「A / B / C」收成「A / B 等 3 项」—— 标题里不铺满整行。"""
    raw = (raw or "").strip()
    if not raw:
        return fallback
    parts = [p.strip() for p in raw.split("/") if p.strip()]
    if not parts:
        return fallback
    head = " / ".join(parts[:MAX_LIST])
    return head + (f" 等 {len(parts)} 项" if len(parts) > MAX_LIST else "")


def head_parts(filter_regions=None, query: str = "", industries: str = "",
               types: str = "", resolved: dict | None = None) -> dict:
    """结果列表页头标题的三个槽位。

    与「已解析出条件」**同源**，只是地域不带「· 来自筛选栏 / 来自查询」后缀 ——
    那是给「为什么会有这个条件」看的说明，放进标题太啰嗦。
    留空仍按「不限」渲染（标题要能独立读懂，不能出现空槽）。

    `resolved` 优先：传了就用它里面的生效值（`resolve_conditions()` 的结果），
    免得调用方再各自重复一遍「谁优先」的判断。
    """
    if resolved is not None:
        nodes = list(resolved.get("nodes") or [])
        industries = resolved.get("industries") or ""
        types = resolved.get("types") or ""
    else:
        nodes, _ = effective_regions(filter_regions, query)
    return {
        "region": region_text(nodes),
        "industry": _brief(industries, NO_VALUE),
        "type": _brief(types, NO_VALUE),
    }


# ---------- 「条件指纹」标题 ----------
# 检索屏的标题与结果列表的页头标题是**同一句话**，只是前缀不同：
#
#     正在检索 · 「福建省 / 福州市 · 不限 · 不限」      ← 检索屏（边跑边显示）
#     结果     · 「福建省 / 福州市 · 不限 · 不限」      ← 结果列表
#
# 以前检索屏那行回显的是**用户原话**（「正在检索：「我是杭州做智能硬件的…」」），
# 而用户实际选的条件可能是福建省/福州市 —— 标题说杭州、下面的条件说福建，
# 同一屏自相矛盾。现在两处都渲染同一份「生效条件指纹」，前缀放这里一处，
# 前端只负责把后端给的字符串印出来（见 test_date.js → search.condTitle）。
TITLE_TPL = "{prefix}「{region} · {industry} · {type}」"
TITLE_PREFIX_RESULT = "结果 · "
TITLE_PREFIX_SEARCH = "正在检索 · "


def cond_title(parts: dict, prefix: str = TITLE_PREFIX_RESULT) -> str:
    """槽位 + 前缀 → 标题。模板被改坏（槽位名写错）时退回原样拼接，绝不抛异常。"""
    slots = {k: (parts or {}).get(k, "") for k in ("region", "industry", "type")}
    try:
        return TITLE_TPL.format(prefix=prefix, **slots)
    except Exception:  # noqa: BLE001
        return prefix + "「" + " · ".join(slots.values()) + "」"


def result_title(parts: dict) -> str:
    """结果列表页头标题。"""
    return cond_title(parts, TITLE_PREFIX_RESULT)


def search_title(parts: dict) -> str:
    """检索屏标题（与结果列表同一枚指纹）。"""
    return cond_title(parts, TITLE_PREFIX_SEARCH)
