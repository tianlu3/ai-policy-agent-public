"""结果包装层：把 LLM 抽取结果包装成与前端 `test_date.js` 同构的十命名空间。

前端 `src/data.js` 的 hydrate() 会按命名空间深合并，所以这里只需返回
「需要被本次检索结果覆盖」的部分；未返回的键（如 regions 区划字典、stats）
自动保留原值。

结构对齐的三个硬约束（前端渲染层依赖，不能违反）：
  · policies.items[].matched 必须含 " · " 分隔（detail 页会 split(' · ')）
  · policies.items[].conditionsFull 至少 2 条（detail 页取 [1] 做溯源高亮）
  · policies.items[].sources 至少 1 条、confidence 必须是数字
"""
from __future__ import annotations

import random
import re
from datetime import date, datetime, timedelta
from typing import Any

from . import bootstrap, ground, labels, sources
from .llm.base import ExtractionRequest, ExtractionResult
from .llm.mock import real_source_url
from .regions import RegionNode

# 原文摘录里可能残留的高亮标记（远端模型按提示词会给 <mark>）：定位前先剥掉，
# 否则标记本身会占掉字符位，算出来的偏移就与「给用户看的纯文本」对不上了。
_MARK_RE = re.compile(r"</?mark[^>]*>", re.I)

_LEVEL_ORDER = {"nation": 0, "province": 1, "city": 2, "county": 3, "park": 4}
_LEVEL_LABEL = {"nation": "国家级", "province": "省级", "city": "市级", "county": "区县级", "park": "园区级"}

# 政策名归一化时抹掉的「非实质字符」：书名号 / 各类括号 / 空白 / 中英标点。
_NAME_NOISE_RE = re.compile(
    r"[《》〈〉＜＞<>「」『』\[\]【】〔〕()（）\s·・、，,。.；;：:!！?？~～^&＋+\-—_/／\\|｜\"'“”‘’]+"
)


def name_key(name: Any) -> str:
    """政策名归一化键：抹掉书名号 / 空白 / 标点，只留实质字符（并统一大小写）。

    用于「同一份政策被抽了两遍」的去重 —— 归一化后**逐字相同**才合并，
    刻意不做模糊相似度：宁可漏合并两条看着像的，也不要把两份真不同的政策揉成一条。
    用户实测：结果列表里《上海市促进跨境电子商务发展专项资金管理办法》连着出现两次，
    一条标「单源收录」一条标「多源合并 3 条」，点进去是同一份文件。
    """
    return _NAME_NOISE_RE.sub("", str(name or "")).lower()


def dedup_by_name(items: list[dict]) -> list[dict]:
    """按「归一化政策名 + 发文机关」去重，保留**先出现**的那条。

    调用点只有一处（build），所以顺序即优先级：调用方已把「模型抽取到的条目」
    排在「本地清单引擎补齐的条目」前面 —— 命中同一个政策名时留下前者更可信。
    发文机关参与比较是为了不误伤「同名但确由不同机关发布」的两份文件。
    """
    out: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for item in items:
        key = (name_key(item.get("name")), str(item.get("issuer") or "").strip())
        if key in seen:
            continue
        seen.add(key)
        out.append(item)
    return out

# 兼容大模型可能返回的中文 levelKey / level
_LEVEL_ALIAS = {
    "nation": "nation", "国家级": "nation", "国家": "nation", "全国": "nation", "中央": "nation",
    "province": "province", "省级": "province", "省": "province",
    "city": "city", "市级": "city", "市": "city",
    "county": "county", "区县级": "county", "区县": "county", "县": "county", "区": "county",
    "park": "park", "园区级": "park", "园区": "park", "开发区": "park",
}


def _source_count() -> int:
    """平台已接入的政策源总数（平台级指标，沿用 bootstrap 口径）。"""
    try:
        return int(bootstrap.load().get("stats", {}).get("policySources") or 0) or len(sources.SOURCES)
    except Exception:  # noqa: BLE001
        return len(sources.SOURCES)


def _page_size() -> int:
    """每页条数：沿用 bootstrap 的结果集元数据，缺省 20。"""
    try:
        n = int(((bootstrap.load().get("list") or {}).get("pager") or {}).get("perPage") or 0)
    except Exception:  # noqa: BLE001
        n = 0
    return n if n > 0 else 20


def _list_title(parts: dict) -> str:
    """结果列表页头标题（渲染口径在 labels.py，与检索屏标题同源）。"""
    return labels.result_title(parts)


def _as_text(value: Any, default: str = "") -> str:
    if value is None:
        return default
    if isinstance(value, (list, tuple)):
        return " / ".join(str(v) for v in value if v)
    return str(value).strip() or default


def _as_list(value: Any) -> list[str]:
    """把「字符串 / 数组」统一成字符串数组（容忍中文分隔符）。"""
    if value is None:
        return []
    if isinstance(value, str):
        text = value
        for sep in ("；", "、", "，", ","):
            text = text.replace(sep, ";")
        return [part.strip() for part in text.split(";") if part.strip()]
    if isinstance(value, (list, tuple)):
        out: list[str] = []
        for item in value:
            text = _as_text(item)
            if text:
                out.append(text)
        return out
    return [_as_text(value)]


def _level_key(raw: dict) -> str:
    key = _as_text(raw.get("levelKey") or raw.get("level"))
    return _LEVEL_ALIAS.get(key.lower(), _LEVEL_ALIAS.get(key, "city"))


def _abbr(level_key: str, ctx: dict) -> str:
    """生成 id 里的地域缩写，如 浙江省 + 杭州市 → "ZJ" + "HZ"。"""
    if level_key == "nation":
        return "GW"
    province: RegionNode | None = ctx.get("province")
    city: RegionNode | None = ctx.get("city")
    prov_code = (province.py if province else "") or "CN"
    if level_key == "province":
        return prov_code
    return prov_code + ((city.py if city else "") or "")


def _normalize(
    raw: dict, index: int, today: date, ctx: dict, rnd: random.Random
) -> dict:
    """把一条「准原始」政策补全为前端契约要求的完整字段。"""
    level_key = _level_key(raw)
    level = _as_text(raw.get("level")) or _LEVEL_LABEL.get(level_key, "市级")

    # ---- 截止时间与剩余天数 ----
    deadline_text = _as_text(raw.get("deadline"))
    deadline: date | None = None
    try:
        deadline = date.fromisoformat(deadline_text[:10]) if deadline_text else None
    except ValueError:
        deadline = None

    if deadline is None:
        deadline = today + timedelta(days=rnd.randint(30, 300))

    days_left = (deadline - today).days
    publish_text = _as_text(raw.get("publish"))
    try:
        publish = date.fromisoformat(publish_text[:10]).isoformat()
    except ValueError:
        publish = (deadline - timedelta(days=rnd.randint(90, 200))).isoformat()

    valid = "已过期" if days_left < 0 else (_as_text(raw.get("valid")) or "有效")

    # ---- 文本型字段兜底 ----
    conditions = _as_list(raw.get("conditions")) or ["符合产业方向", "依法登记注册", "无严重失信记录"]
    conditions_full = _as_list(raw.get("conditionsFull") or raw.get("conditions_full"))
    if len(conditions_full) < 2:                     # detail 页取 [1] 做高亮，必须 ≥ 2
        conditions_full = (conditions_full + conditions + conditions_full)[:2]

    materials = _as_list(raw.get("materials")) or ["申报表（加盖公章）", "营业执照复印件", "财务报表"]

    raw_sources = raw.get("sources") or []
    src_list: list[dict] = []
    if isinstance(raw_sources, list):
        for item in raw_sources:
            if isinstance(item, dict) and _as_text(item.get("name")):
                # url 必须带出去：mock 与演示数据都配了真实官方原文链接，
                # 以前这里只拷 name/kind 把 url 剥掉，前端只好全部落回「搜政策名」的
                # 百度兜底 —— 用户实测点「打开原文」永远到不了原文页（2026-10-14）。
                url = _as_text(item.get("url"))
                if not (url.startswith("http://") or url.startswith("https://")):
                    url = ""
                src_list.append({
                    "name": _as_text(item.get("name")),
                    "kind": _as_text(item.get("kind")) or "原文链接",
                    "url": url,
                })
            elif isinstance(item, str) and item.strip():
                src_list.append({"name": item.strip(), "kind": "原文链接", "url": ""})
    if not src_list:                                  # 简报与列表页都会读 sources[0]
        src_list = [{"name": f"{_as_text(raw.get('issuer'), '政策发布机构')}官网",
                     "kind": "原文链接", "url": ""}]

    # 兜底回填：远端大模型吐的条目（或异常路径丢字段的）没带 url 时，
    # 先按政策名关键词对号入座到真实官方原文；对不上号的（大模型自造的政策名，
    # 十主题池里没有），落到中国政府网站内检索页 —— 仍是官方域、直达该政策名的
    # 检索结果，绝不再把用户送进百度（2026-10-14 用户二度实测踩到）。
    policy_name = _as_text(raw.get("name"))
    fill_url = real_source_url(policy_name)
    if not fill_url:
        from urllib.parse import quote
        fill_url = ("https://sousuo.www.gov.cn/sousuo/search.shtml?code=17da70961a7&searchWord="
                    + quote(policy_name.strip("《》")))
    for s in src_list:
        if not s.get("url"):
            s["url"] = fill_url

    # 模型自报的 confidence 只留档、**不参与打分**（见下方 grounding）。
    # 以前它是唯一的置信度来源，而它其实只是模型顺着提示词里「给个 0~1 的小数」
    # 回的一个数，与「原文里到底有没有这句话」无关。
    try:
        reported_conf = round(min(1.0, max(0.0, float(raw.get("confidence")))), 2)
    except (TypeError, ValueError):
        reported_conf = None

    # ---- 原文定位（Grounding）：置信度与字符偏移都从「这句话能不能在原文里找到」算出来 ----
    #  改造前这里是两个**编造值**：
    #    · confidence 取随机数（mock 走 uniform(0.72,0.96)）或 0.75 兜底；
    #    · offset 取 `1200 + index * 437 + rand` —— 与原文毫无关系。
    #  而原文摘录实测只有 64~104 字，偏移却报到 7000+，指向的正文根本不存在。
    #  用户实测反馈：「有些条件在原文中都看不到」—— 量化后是 30 条条款 0 条命中。
    #  现在逐条回原文定位：命中了才给高分（并回填**真实**字符偏移），
    #  找不到就如实标 unmatched 并压到 0.35 以下，绝不拿好看的数字糊弄。
    source_text = _MARK_RE.sub("", _as_text(raw.get("snapshot") or raw.get("excerpt")))
    # 模型（按提示词要求）可以逐条附上「原句引用」，与 conditionsFull 按索引对齐。
    # 有引用时：条款本体定位不到就退一步按引用定位（见 ground.locate_with_evidence），
    # 这样「改写+引用」的正常情形不会被一刀切成幻觉；引用也不在原文里的，才判幻觉。
    evidences = _as_list(raw.get("conditionsEvidence") or raw.get("evidence"))
    findings = [
        ground.locate_with_evidence(
            cond, source_text,
            evidences[i] if i < len(evidences) else "",
        )
        for i, cond in enumerate(conditions_full)
    ]
    details = [
        f.as_dict(quote=cond, short=(conditions[i] if i < len(conditions) else ""))
        for i, (f, cond) in enumerate(zip(findings, conditions_full))
    ]
    confidence, located_cnt, pending = ground.rollup(findings)
    total_cond = len(conditions_full)
    matched = f"{located_cnt} / {total_cond} 条件满足 · {pending} 条待确认"
    offset = ground.best_offset(findings)
    mark_spans = ground.marks(findings)

    # 原文摘录：逐字下发**纯文本**（不带 <mark>），高亮交给前端按真实偏移插入 ——
    # 这样「偏移说的地方」和「高亮的地方」天然是同一处，不会再各说一套。
    # 拿不到摘录时（远端模型没给 excerpt）才退回合成版，并打上 snapshotSynthetic，
    # 前端据此标「模型归纳 · 无原文摘录」，而不是假装它是原文。
    synthetic = False
    if not source_text:
        core = conditions_full[1] if len(conditions_full) > 1 else conditions_full[0]
        source_text = f"……{core}；{conditions[0] if conditions else '符合申报条件'}……"
        synthetic = True
        mark_spans = []

    snapshot = source_text

    if days_left < 0:
        corner = "已过期"
    elif days_left <= 30:
        corner = f"{days_left} 天后截止"
    else:
        corner = f"{days_left} 天后截止"

    merged = rnd.randint(1, 3)
    dedup = f"多源合并 {merged} 条" if merged > 1 else "单源收录"

    return {
        "id": f"P{today.year}-{_abbr(level_key, ctx)}-{index + 1:06d}",
        "name": _as_text(raw.get("name")) or f"《{_as_text(raw.get('issuer'), '相关政策')}实施细则》",
        "issuer": _as_text(raw.get("issuer")) or "政策发布机构",
        "level": level,
        "levelKey": level_key,
        "types": _as_text(raw.get("types")) or "补贴",
        "industries": _as_text(raw.get("industries")) or "不限",
        "publish": publish,
        "valid": valid,
        "unverified": pending,
        "dedup": dedup,
        "deadline": deadline.isoformat(),
        "daysLeft": days_left,
        "corner": corner,
        "subsidy": _as_text(raw.get("subsidy")) or "详见申报指南",
        "conditions": conditions,
        "conditionsFull": conditions_full,
        "materials": materials,
        "sources": src_list,
        "confidence": confidence,
        "matched": matched,
        "offset": offset,
        # 条件级 grounding：每条条款自己的置信度 / 真实字符偏移 / 命中原句。
        # 前端「申报条件 · 逐条自查」按它逐行渲染 —— 以前只有一个政策级的数，
        # 还只印在第 2 条那一行上，其余两条压根没有置信度可看（2026-10-14）。
        "conditionsDetail": details,
        # 高亮区间（原文里的真实 [start, end]），前端据此插 <mark>；
        # 与 conditionsDetail[].charStart 同源，不会「高亮一处、偏移说另一处」。
        "snapshotMarks": mark_spans,
        # 没有原文摘录、只好用条款本身合成正文时为 True —— 前端标「无原文摘录」，
        # 不假装它是原文。
        "snapshotSynthetic": synthetic,
        # 模型自报值只留档供对照（如详情页展示「模型自报 vs 原文核验」），不参与打分。
        "reportedConfidence": reported_conf,
        "regionCodes": _as_list(raw.get("regionCodes") or raw.get("region_codes")) or ["00"],
        "_snapshot": snapshot,
    }


def _sort_key(item: dict) -> tuple:
    """权威度（国家 > 省 > 市 > 区县 > 园区）优先，其次按截止紧急度。"""
    return (
        _LEVEL_ORDER.get(item["levelKey"], 9),
        item["daysLeft"] if item["daysLeft"] >= 0 else 10 ** 6,
    )


def build(
    req: ExtractionRequest,
    extraction: ExtractionResult,
    nodes: list[RegionNode] | None = None,
    sources_used: list | None = None,
    clean_stats: dict | None = None,
    elapsed_ms: int = 0,
    resolved: dict | None = None,
    understood: bool = True,
) -> dict:
    """组装十命名空间的增量补丁。"""
    today = date.fromisoformat(req.today) if req.today else date.today()
    nodes = nodes or []
    ctx = {
        "province": next((n for n in nodes if n.level == 1), None),
        "city": next((n for n in nodes if n.level == 2), None),
    }
    rnd = random.Random(len(req.query) * 977 + len(extraction.policies))

    items = [
        _normalize(raw, i, today, ctx, rnd)
        for i, raw in enumerate(extraction.policies)
        if isinstance(raw, dict)
    ]
    # 同名去重放在排序**之前**：去重时「先出现的胜出」，而抽取结果的顺序是
    # 「模型抽的在前、本地清单补的在后」，所以胜出的是更可信的那条。
    # 用户实测的重复形态：同一条政策在列表里挨着出现两次（模型抽了两遍），
    # 或者模型抽的与清单补的撞成一条（名字只差书名号 / 空格）。
    items = dedup_by_name(items)
    items.sort(key=_sort_key)

    avg_conf = (sum(i["confidence"] for i in items) / len(items)) if items else 0.0
    valid_count = sum(1 for i in items if i["valid"] == "有效")
    merged_total = sum(
        int(i["dedup"].split()[1]) if i["dedup"].startswith("多源合并") else 1 for i in items
    )
    soon = [i for i in items if 0 <= i["daysLeft"] <= 30]
    # ★ 快照必须跟「本条政策」走：详情页弹层展示的是当前打开这条的原文摘录。
    #   曾经只把第一条的快照塞进 detail.snapshot.text 全局共用 —— 用户打开节能政策，
    #   看到的却是结果集第一条技改政策的「营业收入不低于 2000 万元」，
    #   与下方「申报条件 · 逐条自查」对不上（2026-10-14 用户实测踩到）。
    #   现在每条结果自带 snapshot 字段下发，前端只认 p.snapshot；detail.snapshot.text
    #   仍保留下发（首条）作旧契约兜底，前端已不再消费。
    for _i in items:
        _i["snapshot"] = _i.pop("_snapshot", "")
    lead_snapshot = items[0]["snapshot"] if items else ""

    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    # 条件标签与「已解析出条件」面板同源（app/labels.py）：生效条件 + 每项来源只算一次，
    # 由 search.py 把 `resolve_conditions()` 的结果传进来；没传就现算 ——
    # 无论走哪条路径，检索屏四行与结果列表页头标题都是**同一份生效条件**，
    # 不会出现「面板说 A、标题说 B」。
    resolved = resolved or labels.resolve_conditions(
        filter_regions=req.regions, query=req.query,
        industries=req.industries, types=req.types, deadline=req.deadline,
    )
    head_parts = labels.head_parts(resolved=resolved)
    head_title = _list_title(head_parts)

    source_count = len(sources_used or [])
    return {
        "policies": {"items": items},
        # search.logs 不返回：保留 bootstrap 中的原值，避免把前端检索屏的日志清空
        "search": {
            "parsed": labels.condition_labels(resolved),
            # 检索屏标题：与上面的 list.head.title 是同一枚「条件指纹」，只是前缀不同。
            # 前端不自己拼，取不到就用 test_date.js 的样板值兜底。
            "condTitle": labels.search_title(head_parts),
            "progress": {"from": source_count, "total": source_count},
            # 乱填问句识别（2026-10-16）：false = 问句没有有效检索信号，
            # 前端在结果页顶部显示「您的搜索我不太理解」提示，清单为空属预期。
            "understood": understood,
        },
        "list": {
            "head": {
                # 标题与口径统计都是**本次结果集**的元数据：标题跟着生效条件走，
                # 统计跟着真实条数走 —— 两样都不能沿用内置样例的写死值。
                "title": head_title,
                "meta": f"{valid_count} 条有效 · 跨源去重合并 {merged_total} 条 · 平均置信度 {avg_conf:.2f}",
            },
            # 结果列表顶部「地域」回显的是**本次实际生效的地域**（筛选栏所选，或筛选栏为空时
            # 从查询文本里识别到的城市）—— 与检索屏「已解析出条件」那行同源，两处不会打架。
            "regionsUsed": [n.name for n in nodes],
            # 分页口径必须跟着**本次结果集**走。静态 bootstrap 里的 pager.total 是内置样例集的
            # 规模（96 条），若原样透传回前端，就会出现「页脚写 96 条 / 实际只有 10 条」→ 翻页翻出空页。
            "pager": {"total": len(items), "perPage": _page_size()},
            # 刻意**不下发** defaultPicked —— 结果列表不再替用户预勾选任何政策。
            # 曾经下发 top2，于是刚进应用就「已有 2 条勾选」，简报中心还会拿它们排版，
            # 用户看到两条自己没选过的政策，会以为简报里真有它们。
        },
        "detail": {
            "snapshot": {"text": lead_snapshot},
            "fields": {"avgConfidence": f"{avg_conf:.2f}"},
        },
        "brief": {
            # 同理不再下发 previewIds：简报预览与导出只认用户在结果列表里勾了什么，
            # 没勾就是「暂未选择政策」空态，绝不用演示政策占位。
            "generatedAt": now,
        },
    }
