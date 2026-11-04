"""查询理解：把用户的自然语言问句解析成结构化筛选条件（行业 / 类型 / 时间）。

为什么需要它
------------
「已解析出条件」那四行必须严格等于**本次实际生效**的条件。但此前行业 / 类型只认
首页筛选栏，于是这样一句话：

    我是甘肃的公司，我们是做冬枣销售的，我想知道有没有关于场地的优惠政策

面板上却写着 `行业 = 不限 / 类型 = 不限` —— 用户明明交代了行业与诉求，系统一个字都没接住，
产出自然也就与他说的事无关。**先解析，再检索**：这一层负责把问句读成条件。

职责边界
--------
* **确定性的词表在这里**：离线可用、同一输入必得同一结果（便于回归与演示），
  也是大模型不可用时的兜底 —— 与 `regions.match_in_text()` 是同一类能力，只是换了维度。
* **大模型在线时由它先做一次理解**（`LLMProvider.parse_query()`），覆盖词表认不出的长尾表述
  （比如「冬枣销售」这种词表里没有的名词）。两侧结果用 `merge_hints()` 叠加：**大模型优先**。
* 无论来自哪一侧，最终都会**带上来源标签**（`· 来自查询`，见 app/labels.py），
  用户一眼就能看出这个值不是自己在筛选栏里设的 —— 与地域那行的既有口径完全一致。
* 优先级恒定：**筛选栏 > 查询理解**。用户显式勾过的条件永远不被问句覆盖。

与筛选栏枚举的关系
------------------
行业 / 类型解析出的值，**优先落在 `data/home.json → filter.*.options` 的枚举里**，
这样条件行、页头标题与筛选栏是同一套词汇，不会各说各话。
用户描述的行业落在枚举之外时（农业、商贸零售…），照实写出来 —— 与其硬塞进一个不相关的
枚举值，不如诚实显示「农业」，产出侧也按这个词去匹配主题池。
"""
from __future__ import annotations

from dataclasses import dataclass

# 行业 / 类型最多各取几个：三条以上会把条件行挤满，也说明问句本身就很发散。
MAX_INDUSTRY = 2
MAX_TYPE = 2

# ---------- 类型：问句词 → 首页「类型」枚举值 ----------
# 值必须是 data/home.json → filter.type.options 里的原值，否则条件行会与筛选栏口径打架。
# 顺序即优先级：越具体的排越前（「场地补贴」应当是场地减免，不是补贴）。
_TYPE_RULES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("场地减免", ("场地", "房租", "租金", "厂房", "办公场所", "办公场地", "写字楼", "用地", "土地", "入驻")),
    ("稳岗", ("稳岗", "用工", "社保", "社会保险", "招聘", "就业", "裁员", "参保", "员工")),
    ("融资", ("融资", "贷款", "贴息", "担保", "授信", "股权", "基金", "上市", "信用贷")),
    ("人才", ("人才", "引进", "落户", "职称", "安家", "团队")),
    ("研发加计扣除", ("加计扣除", "研发", "技术创新", "技术改造", "技改", "科技", "创新",
                     "首台套", "首台（套）", "中试", "知识产权")),
    ("税收优惠", ("税收", "减税", "免税", "退税", "增值税", "所得税", "税率", "税费")),
    ("补贴", ("补贴", "补助", "资助", "奖励", "奖金", "资金支持", "财政支持", "以奖代补", "专项资金")),
)

# 类型的合法取值（筛选栏枚举）。大模型返回的简写（「场地」）会被归一到这里。
_TYPE_VALUES: tuple[str, ...] = tuple(value for value, _ in _TYPE_RULES)

# ---------- 行业：问句词 → 首页「行业」枚举值 / 常用行业名 ----------
# 前 8 项与 data/home.json → filter.industry.options 一一对应；
# 之后的「扩展行业」不在筛选栏枚举里，但用户描述里很常见，照实显示。
_INDUSTRY_RULES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("跨境电商", ("跨境电商", "跨境", "外贸", "出口", "出海", "进出口", "海外仓")),
    ("软件信息", ("软件", "信息技术", "信息服务", "互联网", "大数据", "人工智能", "数字化",
                  "云计算", "区块链", "算法", "信息系统", "平台企业")),
    ("智能硬件", ("智能硬件", "智能设备", "传感器", "物联网", "芯片", "集成电路", "机器人")),
    ("生物医药", ("生物医药", "生物", "医药", "制药", "医疗器械", "疫苗", "大健康", "医疗")),
    ("新能源", ("新能源", "光伏", "风电", "储能", "锂电", "氢能", "动力电池", "充电桩")),
    ("新材料", ("新材料", "材料")),
    ("文化创意", ("文化创意", "文创", "文化", "创意", "设计", "动漫", "影视", "广告", "旅游")),
    ("制造业", ("制造", "工厂", "生产", "装备", "机械", "工业", "加工业", "装配", "车间")),
    # ---- 扩展行业（枚举之外，但很常见）----
    ("农业", ("农业", "农产品", "农副", "农资", "种植", "养殖", "畜牧", "水产", "渔业", "合作社",
              "粮食", "蔬菜", "水果", "茶叶", "冬枣", "苹果", "柑橘", "猕猴桃", "葡萄", "草莓")),
    ("商贸零售", ("商贸", "零售", "批发", "门店", "连锁", "超市", "便利店")),
    ("交通物流", ("物流", "运输", "仓储", "货运", "冷链", "快递")),
    ("建筑房地产", ("建筑", "施工", "房地产", "装修", "勘察设计")),
    ("餐饮住宿", ("餐饮", "饭店", "酒店", "民宿", "住宿")),
    ("教育培训", ("教育培训", "培训", "职教", "幼儿园", "学校")),
)

# ---------- 时间：问句词 → 首页「截止时间」枚举值 ----------
_DEADLINE_RULES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("近 7 天", ("近一周", "最近一周", "这一周", "本周", "7 天内", "七天内", "一周内")),
    ("近 30 天", ("近一个月", "最近一个月", "这个月", "本月", "30 天内", "一个月内")),
    ("近 90 天", ("近三个月", "最近三个月", "本季度", "90 天内", "三个月内", "一个季度")),
    ("近 180 天", ("近半年", "最近半年", "180 天内", "半年内", "六个月内", "近六个月")),
)

# 截止时间枚举里表示「没设」的那一项（单选默认值）。
DEADLINE_ANY = "不限"
DEADLINE_OPTIONS = (DEADLINE_ANY, "近 7 天", "近 30 天", "近 90 天", "近 180 天")
# 大模型可以回的那几项：「不限」等于没说，不收 —— 否则条件行会印成
# 「时间 = 近 12 个月 · 来自查询」（值是默认窗口，来源却说是查询给的）。
DEADLINE_PICKABLE = tuple(x for x in DEADLINE_OPTIONS if x != DEADLINE_ANY)

SOURCE_RULES = "query-rules"
SOURCE_LLM = "query-llm"


@dataclass
class Hints:
    """查询理解的结果。空串表示「问句里没看出这一项」。"""

    industries: str = ""
    types: str = ""
    deadline: str = ""
    keywords: tuple[str, ...] = ()
    source: str = ""

    def empty(self) -> bool:
        return not (self.industries or self.types or self.deadline)

    def as_dict(self) -> dict:
        return {
            "industries": self.industries,
            "types": self.types,
            "deadline": self.deadline,
            "keywords": list(self.keywords),
            "source": self.source,
        }


def _hits(text: str, rules) -> list[str]:
    """按「关键词最长优先」在文本里找命中项，返回去重后的值（保持首次命中顺序）。

    最长优先是为了让「新材料」压过「材料」、「新能源汽车」压过「汽车」这类包含关系，
    不至于因为词表里先写了短词而认错。
    """
    pairs = sorted(
        ((kw, val) for val, kws in rules for kw in kws),
        key=lambda kv: len(kv[0]),
        reverse=True,
    )
    picked: list[str] = []
    for kw, val in pairs:
        if kw in text and val not in picked:
            picked.append(val)
    return picked


def parse(query: str) -> Hints:
    """本地词表解析（确定性、离线）。这是兜底路径，也是无网/免费通道下唯一的理解来源。"""
    text = (query or "").strip()
    if not text:
        return Hints()
    inds = _hits(text, _INDUSTRY_RULES)[:MAX_INDUSTRY]
    typs = _hits(text, _TYPE_RULES)[:MAX_TYPE]
    dls = _hits(text, _DEADLINE_RULES)
    return Hints(
        industries=" / ".join(inds),
        types=" / ".join(typs),
        deadline=dls[0] if dls else "",
        keywords=tuple(inds + typs),
        source=SOURCE_RULES if (inds or typs or dls) else "",
    )


# ---------- 乱填问句识别（「我是真人」「666」不该硬出一份检索结果） ----------
# 宽松口径：命中任意一个就当「有信号」，宁可漏判（继续正常检索）不可误伤正经问句。
_SIGNAL_WORDS: tuple[str, ...] = (
    "补贴", "申报", "政策", "扶持", "奖励", "补助", "资助", "条件", "材料", "流程",
    "截止", "资金", "认定", "招标", "采购", "人才", "园区", "企业", "小微", "研发",
    "税", "减免", "贷款", "租金", "用电", "通知", "方案", "指南", "细则", "措施",
    "申领", "申请", "怎么办", "如何", "什么", "哪些", "能不能", "可以吗", "帮我",
    "请问", "想知道", "看看", "查一下", "支持", "优惠",
)


def has_signal(query: str) -> bool:
    """问句里有没有值得去检索的信号（地域词 / 行业类型词 / 政策相关词 / 足够长）。

    判定**故意宽松**：超长问句（>12 字）默认当正经问题；命中任意信号词即通过。
    只拦「又短又什么都认不出」的输入（乱敲的字符、打招呼、测试语句）。
    """
    text = (query or "").strip()
    if not text:
        return True   # 空问句 = 「按已选筛选条件检索」，是有意义的一类检索
    if len(text) > 12:
        return True
    if _hits(text, _INDUSTRY_RULES) or _hits(text, _TYPE_RULES) or _hits(text, _DEADLINE_RULES):
        return True
    return any(w in text for w in _SIGNAL_WORDS)


def _clean_list(value, limit: int, allowed: tuple[str, ...] | None = None) -> str:
    """模型返回的「数组或字符串」→ 「A / B」；不在枚举里的原样保留（扩展行业就是靠这条活下来）。"""
    if value is None:
        return ""
    items = value if isinstance(value, (list, tuple)) else [value]
    out: list[str] = []
    for item in items:
        if isinstance(item, dict):
            item = item.get("name") or item.get("value") or ""
        text = str(item).strip()
        if not text or text in out:
            continue
        if allowed is not None and text not in allowed:
            continue
        out.append(text)
    return " / ".join(out[:limit])


def from_llm(payload: dict) -> Hints:
    """把大模型返回的查询理解结果规整成 Hints（越界/脏值一律丢弃）。

    类型先经 `normalize_type()` 归一：模型很容易回「场地」而不是筛选栏里的「场地减免」，
    直接落库会让条件行与筛选栏各写一套词。
    """
    if not isinstance(payload, dict):
        return Hints()
    typs = [t for t in (normalize_type(x) for x in _split(_clean_list(payload.get("types"), MAX_TYPE + 3))) if t]
    typs = list(dict.fromkeys(typs))[:MAX_TYPE]
    kw = payload.get("keywords")
    kw_items = kw if isinstance(kw, (list, tuple)) else ([kw] if kw else [])
    hints = Hints(
        industries=_clean_list(payload.get("industries"), MAX_INDUSTRY),
        types=" / ".join(typs),
        deadline=_clean_list(payload.get("deadline"), 1, DEADLINE_PICKABLE),
        keywords=tuple(str(x).strip() for x in kw_items if str(x).strip())[:6],
        source=SOURCE_LLM,
    )
    if not (hints.industries or hints.types or hints.deadline):
        hints.source = ""
    return hints


# 类型的合法取值（模型可能返回「场地」这种简写 —— 归一到筛选栏枚举，避免同义不同词）
def normalize_type(value: str) -> str:
    """把大模型给的类型简写归一到枚举值（「场地」→「场地减免」）。认不出就原样返回。"""
    text = (value or "").strip()
    if not text or text in _TYPE_VALUES:
        return text
    for canonical, kws in _TYPE_RULES:
        if any(kw in text or text in kw for kw in kws):
            return canonical
    return text


def merge_hints(low: Hints | None, high: Hints | None) -> Hints:
    """由低到高叠加：`high` 里非空的字段覆盖 `low`（大模型优先于本地词表）。

    类型值先归一（「场地」→「场地减免」），免得条件行与筛选栏枚举各写一套词。
    """
    base = low or Hints()
    top = high or Hints()

    def take(a: str, b: str) -> str:
        return (b or "").strip() or (a or "").strip()

    types = " / ".join(
        t for t in (normalize_type(x) for x in _split(take(base.types, top.types))) if t
    )
    merged = Hints(
        industries=take(base.industries, top.industries),
        types=types,
        deadline=take(base.deadline, top.deadline),
        keywords=tuple(dict.fromkeys(list(base.keywords) + list(top.keywords)))[:6],
        source=(top.source if not top.empty() else base.source),
    )
    return merged


def _split(text: str) -> list[str]:
    """「智能硬件 / 软件信息」→ ["智能硬件", "软件信息"]。"""
    return [t.strip() for t in (text or "").replace("、", "/").replace("，", "/").split("/") if t.strip()]
