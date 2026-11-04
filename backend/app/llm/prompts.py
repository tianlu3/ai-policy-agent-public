"""提示词组装：把「用户输入 + 服务端上下文」整合成交给大模型的提示词。

这里是「服务端把用户数据整合成提示词」的唯一落点：

    用户侧        自然语言查询 + 表单条件（地域 / 行业 / 类型 / 截止）
    服务端补全    今日日期、行政区划码、字段 Schema、条数与排序要求、输出格式

输出严格对齐前端契约所需的字段（详见 wrap.py 的补齐逻辑）。
"""
from __future__ import annotations

import json

from .. import config, regions
from .base import ExtractionRequest

# `_filter_options()` 的进程内缓存（提示词里的候选枚举，进程启动后读一次即可）
_OPTIONS_CACHE: dict | None = None

SYSTEM_PROMPT = """你是中国各级政府扶持政策的结构化抽取引擎，服务于「中小微企业政策速配」产品。
你的任务：根据用户的经营情况，产出该企业**最可能符合申报条件**的政策清单，并完成字段级结构化。

硬性约束（违反即视为无效输出）：
1. 只输出一个 JSON 对象，不要 markdown 代码围栏、不要任何解释性文字。
2. policies 数组给 5~8 条（**绝不超过 8 条**），按权威度排序：国家级 > 省级 > 市级 > 区县级 > 园区级。
   更大规模的清单由服务端本地清单引擎补齐 —— 你多写一条只是多烧一段生成时间，
   不要为凑数降低质量或复述模板。
3. 每条政策的 conditionsFull 至少 2 条完整条款；sources 至少 1 条；conditions 为 ≤12 字的要点。
4. deadline 必须晚于 publish，且**晚于「今日」**；有效政策 valid 一律填「有效」。
5. regionCodes 必须使用**服务端给出的行政区划码**，不得自行编造；国家级政策固定填 ["00"]。
6. **snapshot 必须是「包含上述条款的原文段落」**：要逐字包含 conditionsFull 里的每一条，
   不要只写补贴比例、也不要只写其中一条。**不要**自己加 <mark> —— 高亮位置由服务端
   按条款在摘录中的真实字符偏移生成，你自己标的反而会与偏移对不上。
7. **conditionsEvidence 通常直接省略**：服务端会拿条款本身回原文定位，一般不需要你重复抄一遍。
   只有当原文里存在**比条款更完整、更贴近原文**的原句、值得单独作引用时才给 ——
   给了就必须与 conditionsFull 逐条对齐、从 snapshot 逐字复制（不许改写、不许润色）。
   抄不出来就说明原文里没有这句，该条会被标成「原文未命中」并显著降低置信度。
8. **不要填 confidence**：它已改由服务端按「条款能否在原文里定位到」计算，
   你自己报的数字不会被采用。宁可把 snapshot 写全。
9. 不得编造具体网站链接；sources.name 写机构官网名称即可（如「杭州市经信局官网」）。
10. 政策名称用书名号包裹，写实、可核验；subsidy 用一句话说清资助方式与上限。

输出 JSON Schema（conditionsEvidence 可选，通常整条省略）：
{
  "policies": [
    {
      "name": "《杭州市智能硬件企业技术改造补贴实施办法》",
      "issuer": "杭州市经济和信息化局",
      "level": "市级",
      "levelKey": "city",
      "types": "补贴 / 技改",
      "industries": "制造业 / 智能硬件",
      "publish": "2026-03-01",
      "valid": "有效",
      "deadline": "2026-12-31",
      "subsidy": "按设备投资额 10% 给予补助，单户上限 200 万元",
      "conditions": ["注册满 2 年", "营收 ≥ 2000 万", "设备投入 ≥ 300 万"],
      "conditionsFull": [
        "在杭州市依法注册登记满 2 年，具有独立法人资格",
        "上年度营业收入不低于 2000 万元，且智能硬件相关营收占比不低于 50%"
      ],
      "materials": ["补贴申请表（加盖公章）", "设备投资发票及审计报告复印件"],
      "sources": [{"name": "杭州市经信局官网", "kind": "原文链接"}],
      "snapshot": "……申报企业须同时满足：在杭州市依法注册登记满 2 年，具有独立法人资格；上年度营业收入不低于 2000 万元，且智能硬件相关营收占比不低于 50%。符合条件的企业按设备投资额的 10% 给予补助……",
      "regionCodes": ["33", "3301"]
    }
  ]
}

level 与 levelKey 必须成对：国家级/nation、省级/province、市级/city、区县级/county、园区级/park。"""


def _domain_block(req: ExtractionRequest) -> str:
    """用户条件：自然语言 + 表单条件。"""
    lines = [f"【用户描述】{req.query.strip() or '（未填写，按通用中小微企业处理）'}"]

    form = []
    if req.regions:
        form.append(f"地域 = {' / '.join(req.regions)}")
    if req.industries:
        form.append(f"行业 = {req.industries}")
    if req.types:
        form.append(f"政策类型 = {req.types}")
    if req.deadline:
        form.append(f"截止偏好 = {req.deadline}")
    lines.append("【表单条件】" + ("；".join(form) if form else "（未勾选，按描述推断）"))
    return "\n".join(lines)


def _region_block(req: ExtractionRequest) -> str:
    """服务端补全的行政区划参考（避免大模型编造区划码）。"""
    nodes = regions.resolve(req.regions) if req.regions else []
    if not nodes:
        # 用户没给地域时，从自然语言里抽一次地名
        nodes = regions.match_in_text(req.query)

    if not nodes:
        return (
            "【行政区划参考】用户未指定地域 → 以国家级政策为主（regionCodes 用 [\"00\"]），"
            "可少量给出典型省级政策。"
        )

    rows = []
    for node in nodes:
        codes = " / ".join(node.codes_with_ancestors())
        rows.append(f"  · {node.name}（{node.level_label}，regionCodes = [\"{codes.replace(' / ', '\", \"')}\"]）")
    rule = [
        "【行政区划参考】用户指定地域如下，regionCodes 必须取自这里：",
        *rows,
        "  · 国家级政策 → [\"00\"]；省级 → 取省的 2 位码；市级 → 省码 + 市码；区县级 / 园区级 → 省码 + 市码 + 县码",
    ]
    return "\n".join(rule)


def _distribute(total: int, weights: tuple[int, ...]) -> list[int]:
    """按权重把 total 拆成整数份额，余数补到前面权重大的层级，保证 sum == total。"""
    wsum = sum(weights) or 1
    raw = [total * w // wsum for w in weights]
    for _ in range(total - sum(raw)):
        raw[0] += 1
    return raw


def _scope_block(req: ExtractionRequest) -> str:
    # 模型只出**权威头部**（5~8 条）：清单的完整规模由服务端本地清单引擎补齐
    # （search.py::_expand_catalog），模型多写一条只是多烧一段生成时间 ——
    # 免费档实测要求 15 条时仅「AI 结构化」一步就要 170s+，收窄到 8 条内可省约一半等待。
    ask = max(5, min(8, req.max_items))
    if req.regions:
        # 国家 / 省 / 市 / 区县 / 园区
        weights: tuple[int, ...] = (2, 2, 3, 2, 1)
        note = ""
    else:
        # 未指定地域：以国家级 + 省级为主
        weights = (4, 3, 1, 1, 0)
        note = "（用户未指定地域，已提高国家级与省级占比）"
    n, p, c, y, k = _distribute(ask, weights)
    return (
        "【产出要求】\n"
        f"  · 条数：{ask} 条（**上限就是 {ask} 条**，其余由服务端本地清单引擎按地域全层级补齐，不要凑数）\n"
        f"  · 今日：{req.today}（用于判断政策是否仍在有效期内）\n"
        f"  · 覆盖层级：国家级 {n} 条、省级 {p} 条、市级 {c} 条、区县级 {y} 条、园区级 {k} 条{note}\n"
        "  · 优先给出**该企业所在地、该行业最常申报**的政策"
    )


def build_user_prompt(req: ExtractionRequest) -> str:
    """把用户条件与服务端上下文拼成一条完整的 user 提示词。"""
    return "\n\n".join([
        _domain_block(req),
        _region_block(req),
        _scope_block(req),
        "请按 Schema 输出 JSON。",
    ])


def build_messages(req: ExtractionRequest) -> list[dict[str, str]]:
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": build_user_prompt(req)},
    ]


# ============================================================
# 查询理解（**先解析，再检索**）—— 与「政策清单抽取」是两条用途
# ------------------------------------------------------------
# 用户写的是自然语言（「我是甘肃的公司，我们是做冬枣销售的，我想知道有没有关于场地的
# 优惠政策」），而检索需要结构化条件（地域 / 行业 / 类型 / 时间）。
# 这一步只做理解：输出几十个 token 的 JSON，**不产出任何政策**。
# 好处是输出极短 —— 快、可给硬上限、失败也不心疼（沿用语词表解析结果）。
# ============================================================

QUERY_PARSE_SYSTEM_PROMPT = """你是「中小微企业政策速配」产品的查询理解模块。
你的任务：把用户的一句话读成结构化检索条件。**只做理解 —— 不要检索、不要编造政策。**

硬性约束（违反即视为无效输出）：
1. 只输出一个 JSON 对象，不要 markdown 代码围栏、不要任何解释性文字。
2. **只填能从用户描述里明确看出的项**：看不出来就留空数组 / 空串。
   绝不为了把字段凑满而猜一个用户没说过的行业或类型 —— 漏填只是少一条筛选项，
   猜错会让用户看到一份与自己无关的政策清单。
3. industries：企业所属行业。**优先使用给定的行业枚举值**；枚举里确实没有的，
   照实写行业常用词（如「农业」「商贸零售」）。最多 2 个。
4. types：企业想要的扶持方式。**必须从给定类型枚举里选**，并做同义归一
   （「场地」→「场地减免」、「贷款贴息」→「融资」、「稳岗补贴」→「稳岗」）。最多 2 个。
5. deadline：用户对时间窗口的要求，只能取「不限 / 近 7 天 / 近 30 天 / 近 90 天 / 近 180 天」
   之一；用户没提就填「不限」。
6. keywords：从描述里抽 0~6 个代表诉求的关键词（产品名、经营环节等，如「冬枣」「技改」）。

输出 JSON Schema：
{
  "industries": ["农业"],
  "types": ["场地减免"],
  "deadline": "不限",
  "keywords": ["冬枣", "销售"]
}"""


def _filter_options() -> tuple[list[str], list[str]]:
    """首页筛选栏的行业 / 类型枚举。

    直接从前端 `data/home.json → filter.*.options` 读，**不在这里另维护一份**：
    提示词里给出的候选值必须与用户能在筛选栏里选到的完全一致，
    否则模型会回一个界面上不存在的词，条件行与筛选栏又各说各话。
    读不到（比如只部署了后端）就退化为「不给候选值」，不影响检索。
    """
    global _OPTIONS_CACHE
    if _OPTIONS_CACHE is None:
        inds: list[str] = []
        typs: list[str] = []
        try:
            path = config.GUI_DIR / "data" / "home.json"
            data = json.loads(path.read_text(encoding="utf-8"))
            flt = data.get("filter") or {}
            inds = [str(x) for x in ((flt.get("industry") or {}).get("options") or [])]
            typs = [str(x) for x in ((flt.get("type") or {}).get("options") or [])]
        except Exception:  # noqa: BLE001 - 文案文件缺失不该让检索失败
            inds, typs = [], []
        _OPTIONS_CACHE = {"industries": inds, "types": typs}
    return _OPTIONS_CACHE["industries"], _OPTIONS_CACHE["types"]


def build_query_messages(query: str, today: str = "") -> list[dict[str, str]]:
    """查询理解的提示词：用户原话 + 服务端给的候选枚举。"""
    inds, typs = _filter_options()
    blocks = [f"【用户描述】{(query or '').strip() or '（空）'}"]
    if today:
        blocks.append(f"【今日】{today}")
    blocks.append("【行业枚举】" + ("、".join(inds) if inds else "（未提供，请按行业常用词作答）"))
    blocks.append("【类型枚举】" + ("、".join(typs) if typs else "（未提供，请按常用政策类型作答）"))
    blocks.append("【时间可选值】不限、近 7 天、近 30 天、近 90 天、近 180 天")
    blocks.append("请按 Schema 输出 JSON。")
    return [
        {"role": "system", "content": QUERY_PARSE_SYSTEM_PROMPT},
        {"role": "user", "content": "\n\n".join(blocks)},
    ]


# ============================================================
# 简报综述（与「政策清单抽取」是两条用途）
# ------------------------------------------------------------
# 清单由结构化数据直接拼装（条目、金额、日期不丢不失真），
# 大模型只负责写这段**短综述** —— 输出短、等待可控，且不需要它复述全部条目。
# ============================================================

# 送进提示词的政策条数上限：综述是「看趋势」用的，不必把 300 条全塞给模型，
# 但也别只给 3 条（那样总结不出共性）。按权威度取前 N 条。
BRIEF_DIGEST_MAX = 20

BRIEF_SYSTEM_PROMPT = """你是政策研究助理，服务于「中小微企业政策速配」产品。
你的任务：为用户选定的政策清单写一段**简报综述**，帮他在最短时间内判断「先看哪几条、该准备什么」。

硬性约束（违反即视为无效输出）：
1. 只输出正文，不要标题、不要 markdown 符号（#、*、-）、不要代码围栏、不要开场白。
2. 长度 180~300 字，中文，分 3 层意思：① 这批政策整体在支持什么方向；② 最值得优先申报的 2~3 条及理由；③ 共性材料与时间提醒。
3. **只能使用清单里给出的信息**：不得编造政策名称、金额、日期、发文机关；清单里没有的数字一律不要写。
4. 提到某条政策时用书名号**原样引用**它的名称，不要改写、不要简称。
5. 语气务实克制，不要营销化表达，不要写「建议咨询专业机构」这类空话。"""


def _brief_lines(payload: dict) -> list[str]:
    """政策清单压缩成一行一条（只保留判断用得上的字段，控制 token）。"""
    rows: list[str] = []
    for p in (payload.get("policies") or [])[:BRIEF_DIGEST_MAX]:
        name = str(p.get("name") or "").strip()
        if not name:
            continue
        parts = [name]
        for key, label in (("level", ""), ("issuer", ""), ("deadline", "截止"), ("subsidy", "补贴")):
            value = str(p.get(key) or "").strip()
            if value:
                parts.append(f"{label}{value}" if label else value)
        rows.append("  · " + "｜".join(parts))
    return rows


def build_brief_messages(payload: dict) -> list[dict[str, str]]:
    """简报综述的提示词：条件摘要 + 政策清单（压缩）+ 任务说明。"""
    conditions = [str(x) for x in (payload.get("conditions") or []) if str(x).strip()]
    policies = payload.get("policies") or []
    scope_label = str(payload.get("scopeLabel") or "").strip() or "本次结果"

    blocks = []
    if conditions:
        blocks.append("【本次条件】\n" + "\n".join(f"  {c}" for c in conditions))
    blocks.append(f"【导出范围】{scope_label}")

    rows = _brief_lines(payload)
    if len(policies) > len(rows):
        blocks.append(
            f"【政策清单】共 {len(policies)} 条，以下是按权威度排序的前 {len(rows)} 条：\n"
            + "\n".join(rows)
        )
    else:
        blocks.append(f"【政策清单】共 {len(rows)} 条：\n" + "\n".join(rows))

    blocks.append("【任务】请写这段简报综述（180~300 字，只输出正文）。")
    return [
        {"role": "system", "content": BRIEF_SYSTEM_PROMPT},
        {"role": "user", "content": "\n\n".join(blocks)},
    ]


def render_preview(req: ExtractionRequest) -> dict:
    """给 /api/v1/prompts/preview 用：把「整合后的提示词」原样展示出来。"""
    messages = build_messages(req)
    return {
        "system": messages[0]["content"],
        "user": messages[1]["content"],
        "chars": sum(len(m["content"]) for m in messages),
        "empty": not req.query.strip(),
    }


# ============================================================
# 政策对话（详情页「问政策」）
# ------------------------------------------------------------
# 与上面三段的分工：
#   · 抽取   → 吐结构化清单（长输出）
#   · 查询理解 → 读问句成条件（几十 token）
#   · 简报综述 → 写一段短综述（单轮，无历史）
#   · 政策对话 → **多轮**，且必须把「当前这条政策」的全部结构化字段作为
#     事实底座 —— 用户问的是「我这种情况能不能申」，答案只能来自这条政策，
#     模型不许拿别处的政策来答。
# 输出要短（用户盯着气泡等），所以 CHAT_MAX_TOKENS 给得比抽取小得多。
# ============================================================

CHAT_SYSTEM_PROMPT = """你是「中小微企业政策速配」产品里的政策申报助理，坐在**某一条具体政策的详情页**上。
用户正在看这条政策，你可以直接问他关心的问题（能不能申、要交什么材料、怎么走流程、能拿多少钱、什么时候截止）。

硬性约束（违反即视为无效输出）：
1. 只输出正文，不要标题、不要 markdown 符号（#、*、-）、不要代码围栏、不要开场白。
2. 只依据下面【当前政策】里给出的字段回答。**字段里没有的信息一律说「这项信息原文未收录，建议以官方发布文本为准」**，
   绝不编造金额、日期、发文机关、联系电话、申报网址。
3. 用户如果描述了自己的情况（行业、规模、地域、营收等），要**逐条对照申报条件**给出判断：
   能明确判定的说「符合 / 不符合」并点出依据哪一条；判不了的说「需按第 N 条核对」。
4. 提到政策名称时用书名号原样引用，不要改写、不要简称。
5. 长度控制在 250 字以内，中文，务实克制，不要营销化表达，不写「建议咨询专业机构」这类空话。
6. 和当前政策无关的问题（例如问别的政策、闲聊），礼貌说明你只负责这条政策，并引导用户回到本条政策上。"""


def _chat_policy_block(policy: dict | None) -> str:
    """把当前政策压成一段「事实底座」。只放模型回答得上的字段。"""
    p = policy or {}
    if not str(p.get("name") or "").strip():
        return "【当前政策】\n  （未提供政策上下文，请只回答「请先打开一条政策再提问」。）"

    rows: list[str] = []
    for key, label in (
        ("name", "政策名称"), ("level", "政策层级"), ("issuer", "发文机关"),
        ("publish", "发布日期"), ("deadline", "截止日期"), ("subsidy", "支持力度"),
        ("types", "政策类型"), ("industries", "适用行业"),
    ):
        value = str(p.get(key) or "").strip()
        if value:
            rows.append(f"  {label}：{value}")
    if p.get("daysLeft") is not None:
        rows.append(f"  剩余天数：{p.get('daysLeft')} 天")

    conditions = [str(x) for x in (p.get("conditionsFull") or p.get("conditions") or []) if str(x).strip()]
    if conditions:
        rows.append("  申报条件（逐条）：")
        rows.extend(f"    {i}. {c}" for i, c in enumerate(conditions, 1))

    materials = [str(x) for x in (p.get("materials") or []) if str(x).strip()]
    if materials:
        rows.append("  申报材料：")
        rows.extend(f"    · {m}" for m in materials)

    steps = [str(x) for x in (p.get("steps") or []) if str(x).strip()]
    if steps:
        rows.append("  申报流程：")
        rows.extend(f"    {i}. {s}" for i, s in enumerate(steps, 1))

    channels = [str(x) for x in (p.get("channels") or []) if str(x).strip()]
    if channels:
        rows.append("  申报入口：")
        rows.extend(f"    · {c}" for c in channels)

    sources = p.get("sources") or []
    names = [str((s or {}).get("name") or s) for s in sources if str((s or {}).get("name") or s).strip()]
    if names:
        rows.append("  来源站点：" + " / ".join(names[:3]))

    return "【当前政策】\n" + "\n".join(rows)


def build_chat_messages(
    policy: dict | None,
    history: list[dict] | None,
    question: str,
    *,
    max_turns: int = 6,
) -> list[dict[str, str]]:
    """政策对话的提示词：系统约束 + 当前政策事实底座 + 最近若干轮 + 本次提问。

    历史**只带最近 max_turns 轮**：既压 token、也把首字延迟压住；
    更早的对话没必要影响「这条政策我能不能申」这类问题的答案。
    """
    messages: list[dict[str, str]] = [
        {"role": "system", "content": CHAT_SYSTEM_PROMPT},
        {"role": "system", "content": _chat_policy_block(policy)},
    ]
    turns: list[dict[str, str]] = []
    for item in (history or []):
        role = str(item.get("role") or "").strip()
        content = str(item.get("content") or "").strip()
        if role in ("user", "assistant") and content:
            turns.append({"role": role, "content": content[:1200]})
    keep = max(0, max_turns) * 2
    if keep:
        turns = turns[-keep:]
    else:
        turns = []
    messages.extend(turns)
    messages.append({"role": "user", "content": question.strip()})
    return messages
