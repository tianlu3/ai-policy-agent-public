"""原文定位（Grounding）：把抽取出的条款回**原文摘录**里定位，用可验证的证据强度
替代「模型自报的置信度」。

## 为什么要这一层

改造前，详情页那个「⚠ 待核验 · 置信度 0.72」里的 0.72 是**编出来的**：

  · 本地规则引擎走 `random.uniform(0.72, 0.96)` —— 纯随机；
  · 远端模型走提示词里那句「confidence 为 0~1 的小数，信息不完整时给低一些」——
    模型只是顺着这个措辞回了一个数，和「原文里到底有没有这句话」没有任何关系。

同一屏上的「字符偏移 7821–7863」同样是编的（`1200 + index * 437 + rand`），
而原文摘录只有几十个字（实测 10 个主题 min 64 / max 104 字）——
偏移 100% 越界，指向的正文根本不存在。

于是出现用户实测的那个现象：**「有些条件在原文中都看不到」**。
量化一下：10 个主题 30 条「原文条款」，能在原文摘录里找到的是 **0/30**。

## 这一层做什么

对每一条条款，在原文里真的找它：

  1. 归一化后精确子串命中 → exact=True；
  2. 否则用「最长连续重合」做模糊匹配（容忍标点 / 空格 / 全角半角差异）；
  3. 回填**原文真实字符偏移** charStart/charEnd（不是估算出来的）；
     —— 且边界要做一次「对齐」：归一化会丢掉空白与标点，若条款本体以 `）`、
     `，` 这类字符收尾，反推回来的区间会漏掉它（偏移对了、高亮少一个字符）。
     所以拿原文逐字校验一遍再把首尾补回去（`_align_edges`）。
  4. 用「命中度 + 数字一致性 + 唯一性」合成置信度 —— 每个分数都能说清怎么来的。

## 打分口径（单调、可测）

| 情形 | 置信度 | status |
|---|---|---|
| 逐字命中（原文里真的有这句）+ 数字一致 | 0.92 ~ 0.98 | verified |
| 归一化后才命中（差异只在标点空格）+ 数字一致 | 0.80 ~ 0.89 | normalized |
| 命中但**关键数字对不上**（如原文写 200 万、条款写 100 万） | 上者 × 0.85 | digit_mismatch |
| 原文里找不到 | ≤ 0.35 | unmatched |

两个刻意为之的取舍：

  · **「原文里找不到」绝不给高分。** 宁可如实标「原文未命中」并压到 0.35 以下，
    也不拿一个好看的数字糊弄用户 —— 那正是这一层要消灭的东西。
  · **命中多处要扣分。** 同一句话在原文里出现两次以上，说明定位有歧义，
    减 0.03 并在 `factors.hits` 里如实报出位置数。

## 与前端的分工

后端只下发**纯文本**原文（`snapshot`）与真实偏移（`snapshotMarks` / `charStart`），
由前端按偏移插入 `<mark>` —— 这样「偏移」与「高亮」天然一致，
不会再出现「高亮的地方和偏移说的不是同一处」。
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from typing import Any, Iterable

# 归一化时丢弃的字符：空白与不承载语义的标点。
# 注意**刻意保留**数字、字母、汉字、`%`／`％`（「按 60% 返还」里的百分号是判断依据）。
_DROP = set(
    " \t\r\n\u3000\u00a0"
    "，。；：、！？…—～·（）［］【】《》〈〉「」『』“”‘’"
    ",.;:!?()[]{}<>\"'`^&*+=@#$|\\/+_~-"
)
# 句读：扩展到整句时用（含分号，条款常以分号并列）
_BREAK = "。！？；\n"
_DIGIT_RE = re.compile(r"\d+(?:\.\d+)?")

# status 取值（前端按它选文案与样式，闸门按它断言单调性）
STATUS_VERIFIED = "verified"
STATUS_NORMALIZED = "normalized"
STATUS_DIGIT_MISMATCH = "digit_mismatch"
STATUS_UNMATCHED = "unmatched"

UNMATCHED_MAX = 0.35          # 「原文未命中」的置信度上限
_VERIFIED_FLOOR = 0.92        # 逐字命中的起点
_NORMALIZED_FLOOR = 0.80      # 归一化后才命中的起点
_MIN_COVERAGE = 0.72          # 低于这个重合度就算没找到


def _as_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (list, tuple)):
        return " ".join(str(v) for v in value if v)
    return str(value)


def normalize(text: str) -> tuple[str, list[int]]:
    """归一化文本，并返回「归一化下标 → 原文字符下标」的映射表。

    映射表是**真实偏移**的来源：模糊命中到归一化串上的区间，
    靠它换回原文里的 charStart / charEnd，而不是拿估算值糊弄。
    逐字符处理，保证 1:1，映射永不越界。
    """
    buf: list[str] = []
    idx: list[int] = []
    for i, ch in enumerate(_as_text(text)):
        if ch in _DROP or unicodedata.combining(ch):
            continue
        folded = unicodedata.normalize("NFKC", ch)
        if len(folded) != 1:          # NFKC 把 1 个字符展开成多个（如 ㈱）→ 退回原字符
            folded = ch
        buf.append(folded)
        idx.append(i)
    return "".join(buf), idx


def _digits(text: str) -> set[str]:
    """文本里的数字集合（「100 万」→ {"100"}）。用来做数字一致性校验。"""
    return set(_DIGIT_RE.findall(_as_text(text)))


def _lcs_run(needle: str, hay: str) -> tuple[int, int, int]:
    """needle 在 hay 里的**最长连续重合**：返回 (长度, hay 起点, hay 终点开区间)。

    滚动数组 DP，O(len(hay)) 空间。条款与原文摘录都是短文本（几百字），够用。
    """
    if not needle or not hay:
        return 0, -1, -1
    prev = [0] * (len(hay) + 1)
    best, best_end = 0, 0
    for i in range(1, len(needle) + 1):
        cur = [0] * (len(hay) + 1)
        nc = needle[i - 1]
        for j in range(1, len(hay) + 1):
            if nc == hay[j - 1]:
                run = prev[j - 1] + 1
                cur[j] = run
                if run > best:
                    best, best_end = run, j
        prev = cur
    return best, best_end - best, best_end


def _count_hits(hay: str, needle: str) -> int:
    """needle 在 hay 里出现了几次（不重叠计数）。用于「命中是否唯一」的判定。"""
    if not needle:
        return 0
    count, pos = 0, hay.find(needle)
    while pos >= 0:
        count += 1
        pos = hay.find(needle, pos + len(needle))
    return count


def _expand_sentence(text: str, start: int, end: int, cap: int = 140) -> str:
    """把命中区间扩展到所在整句（以 `。！？；` 断句）——「命中的原句」给用户看的就是它。"""
    if start < 0 or end <= start:
        return ""
    left = start
    while left > 0 and text[left - 1] not in _BREAK:
        left -= 1
    right = end
    while right < len(text) and text[right] not in _BREAK:
        right += 1
    if right < len(text):
        right += 1                                    # 收上句末标点
    seg = text[left:right].strip()
    if len(seg) > cap:                                # 长句以命中段为中心裁切
        mid = (start + end) // 2 - left
        half = cap // 2
        cut = seg[max(0, mid - half): max(0, mid - half) + cap].strip()
        seg = "…" + cut + "…"
    return seg


def _edge_drops(text: str) -> tuple[int, int]:
    """条款本体首/尾**被归一化丢弃**的字符数（`_DROP` 里的空白与标点）。

    归一化把这些字符剔掉，映射表只覆盖保留下来的字符 —— 于是「条款以 `）` 结尾」
    这类情况下，从映射反推的区间会**漏掉末尾的 `）`**：字符偏移标得很精确，
    高亮却少一个字符，`snapshot[charStart:charEnd]` 与条款本体不是逐字相同。
    知道首尾各丢了多少个，才有依据把边界补回去。
    """
    n = len(text)
    head = 0
    while head < n and (text[head] in _DROP or unicodedata.combining(text[head])):
        head += 1
    tail = 0
    while tail < n - head and (text[n - 1 - tail] in _DROP
                               or unicodedata.combining(text[n - 1 - tail])):
        tail += 1
    return head, tail


def _align_edges(quote: str, source: str, start: int, end: int) -> tuple[int, int]:
    """把映射出来的区间边界对齐到条款本体的真实首尾。

    **只在原文确实躺着这一段时才采纳**（逐字比对通过），所以这一步不可能把边界
    挪到别的句子上；对不上（数字不一致、内部标点有差异等）就原样返回，
    让 status 如实体现那处差异，而不是靠挪边界把差异盖掉。
    """
    if start < 0 or end <= start:
        return start, end
    head, tail = _edge_drops(quote)
    if not head and not tail:
        return start, end
    s2, e2 = max(0, start - head), min(len(source), end + tail)
    if source[s2:e2] == quote:
        return s2, e2
    return start, end


@dataclass
class Finding:
    """一条条款在原文里的定位结果。字段与前端契约一一对应（camelCase 在 as_dict 里转）。"""

    confidence: float
    status: str
    exact: bool
    char_start: int = -1
    char_end: int = -1
    evidence: str = ""
    coverage: float = 0.0
    hits: int = 0
    factors: dict[str, Any] = field(default_factory=dict)

    @property
    def matched(self) -> bool:
        return self.char_start >= 0 and self.status != STATUS_UNMATCHED

    def as_dict(self, quote: str = "", short: str = "") -> dict:
        """转成下发前端的形状（camelCase + 展示用的 offset 串）。"""
        return {
            "short": short or quote,
            "full": quote,
            "confidence": self.confidence,
            "status": self.status,
            "matched": self.matched,
            "exact": self.exact,
            "charStart": self.char_start,
            "charEnd": self.char_end,
            "offset": f"{self.char_start}–{self.char_end}" if self.matched else "",
            "evidence": self.evidence,
            "coverage": self.coverage,
            "factors": self.factors,
        }


def _strip_digits(norm: str, index_map: list[int]) -> tuple[str, list[int]]:
    """抹掉数字后的归一化串 + 它自己的「下标 → 原文下标」映射。

    用途见 `locate()` 的第 ③ 步：判断「命中了但数字对不上」。
    """
    buf: list[str] = []
    out: list[int] = []
    for k, ch in enumerate(norm):
        if ch.isdigit() or ch == ".":
            continue
        buf.append(ch)
        out.append(index_map[k])
    return "".join(buf), out


def locate(quote: str, source: str, *, min_coverage: float = _MIN_COVERAGE) -> Finding:
    """在 `source`（原文摘录）里定位 `quote`（一条条款），返回证据强度与真实偏移。"""
    raw_quote = _as_text(quote).strip()
    raw_source = _as_text(source)
    if not raw_quote or not raw_source:
        return Finding(0.30, STATUS_UNMATCHED, False,
                       factors={"reason": "空条款或空原文"})

    nq, qmap = normalize(raw_quote)
    ns, smap = normalize(raw_source)
    if not nq or not ns:
        return Finding(0.30, STATUS_UNMATCHED, False,
                       factors={"reason": "归一化后为空"})

    # ── ① 归一化后精确子串命中（最常见、最强）
    pos = ns.find(nq)
    hits = _count_hits(ns, nq)
    if pos >= 0:
        start = smap[pos]
        end = smap[pos + len(nq) - 1] + 1
        return _score(raw_quote, raw_source, start, end, hits,
                      coverage=1.0, exact=(raw_quote in raw_source))

    # ── ② 模糊：最长连续重合（容忍标点 / 空格 / 全角半角差异）
    run, rstart, rend = _lcs_run(nq, ns)
    coverage = run / len(nq)
    if coverage >= min_coverage:
        start = smap[rstart]
        end = smap[rend - 1] + 1
        hits = _count_hits(ns, ns[rstart:rend])
        return _score(raw_quote, raw_source, start, end, hits,
                      coverage=coverage, exact=False)

    # ── ③ 数字不一致的专门判定：把数字从两侧抹掉再比一次。
    # 「上年度研发费用总额不低于 100 万元」碰上原文「200 万元」这类错抽，
    # 若只按字符重合算，会被判成「原文找不到」—— 那等于把最有价值的诊断
    # （数字对不上）降级成一句没信息量的「未命中」。抹掉数字后若高度重合，
    # 就如实报「句意命中了，但数字不一致」，并在 factors.digitsMissing 里点名是哪几个。
    nq_nd, _qidx = _strip_digits(nq, qmap)
    if nq_nd:
        ns_nd, sidx_nd = _strip_digits(ns, smap)
        if ns_nd:
            run2, s2, e2 = _lcs_run(nq_nd, ns_nd)
            cov2 = run2 / len(nq_nd)
            if cov2 >= min_coverage:
                f = _score(raw_quote, raw_source, sidx_nd[s2], sidx_nd[e2 - 1] + 1, 1,
                           coverage=cov2, exact=False)
                f.factors["digitTolerant"] = True
                return f

    # ── ④ 原文里确实找不到
    return Finding(
        round(min(UNMATCHED_MAX, coverage * 0.4), 2), STATUS_UNMATCHED, False,
        coverage=round(coverage, 3), hits=0,
        factors={"run": run, "quoteLen": len(nq), "reason": "原文中找不到该条款"},
    )


def _score(
    quote: str, source: str, start: int, end: int, hits: int, *, coverage: float, exact: bool
) -> Finding:
    """把定位结果折算成置信度：命中度打底，数字一致性与唯一性做修正。"""
    start, end = _align_edges(quote, source, start, end)
    span = source[start:end]
    sentence = _expand_sentence(source, start, end)

    # 数字一致性：条款里的每个数字都要在**命中原句**里出现同值。
    # 「研发费用不低于 100 万」配原文「200 万」是典型的抽取错误，必须压分。
    want, got = _digits(quote), _digits(sentence)
    missing = sorted(want - got)
    digits_ok = not missing

    if exact:
        base = _VERIFIED_FLOOR + 0.06 * coverage          # 0.92 ~ 0.98
        status = STATUS_VERIFIED
    else:
        base = _NORMALIZED_FLOOR + 0.09 * coverage        # 0.80 ~ 0.89
        status = STATUS_NORMALIZED

    if not digits_ok:
        base *= 0.85
        status = STATUS_DIGIT_MISMATCH
    if hits > 1:                                          # 多处命中 = 定位有歧义
        base -= 0.03
    base = min(1.0, max(0.0, base))

    return Finding(
        confidence=round(base, 2),
        status=status,
        exact=exact,
        char_start=start,
        char_end=end,
        evidence=sentence or span,
        coverage=round(coverage, 3),
        hits=hits,
        factors={
            "exact": exact,
            "coverage": round(coverage, 3),
            "hits": hits,
            "digitsOk": digits_ok,
            "digitsMissing": missing,
        },
    )


def grade(pairs: Iterable[tuple[str, str]]) -> list[Finding]:
    """批量定位：`pairs` 是 (条款全文, 原文摘录) 序列。"""
    return [locate(q, s) for q, s in pairs]


def locate_with_evidence(
    quote: str, source: str, evidence: str = "", *, min_coverage: float = _MIN_COVERAGE
) -> Finding:
    """先按条款本体定位；定位不到时，退一步按**模型给出的原文引用**定位。

    真实大模型抽条款时往往是「改写 + 引用」：条款措辞自己写得不像原文，
    但它引用的那句是真的。若直接判「原文未命中」，会把这类情况一并打死。
    于是多一步：拿 evidence 再定位一次。

      · 成功 → 记为 `locatedVia = "evidence"`，并把置信度压到 normalized 档上限
        以下（≤0.85×0.92）。因为我们核验的是「模型引用的那句话在原文里」，
        而不是「条款措辞在原文里」，证据强度确实弱一档，不该和逐字命中同分。
      · 失败 → 这是比单纯「找不到」更强的幻觉信号（条款和它自己给的引用
        都不在原文里），在 factors 里点名，置信度仍是 unmatched 档。

    `evidence` 为空则行为与 `locate()` 完全一致。
    """
    f = locate(quote, source, min_coverage=min_coverage)
    if f.matched:
        f.factors["locatedVia"] = "quote"
        return f
    ev = _as_text(evidence).strip()
    if not ev:
        return f

    g = locate(ev, source, min_coverage=min_coverage)
    if not g.matched:
        f.factors["evidenceChecked"] = True
        f.factors["reason"] = "条款与模型给出的原文引用均未定位到（疑似幻觉）"
        return f

    return Finding(
        confidence=round(min(0.85, g.confidence * 0.92), 2),
        status=STATUS_NORMALIZED,
        exact=False,
        char_start=g.char_start,
        char_end=g.char_end,
        evidence=g.evidence,
        coverage=g.coverage,
        hits=g.hits,
        factors={**g.factors, "locatedVia": "evidence", "evidenceQuoted": ev[:60]},
    )


def rollup(findings: list[Finding]) -> tuple[float, int, int]:
    """政策级汇总：返回 (政策置信度, 已核验条数, 待确认条数)。

    政策置信度**不是**条款分的简单平均 —— 取「平均证据强度 × 0.6 + 最弱一环 × 0.4」。
    一条政策里只要有一条条款在原文里找不到，整条就不该被打成高分：
    用户看的是「这条政策我能不能信」，短板比平均更接近真实体感。

    「已核验」= 在原文里定位到了（逐字命中或仅标点差异），且关键数字一致；
    数字对不上、或压根找不到的，都算「待确认」—— 这正是要让用户人工看的那几条。
    """
    if not findings:
        return 0.0, 0, 0
    confs = [f.confidence for f in findings]
    avg = sum(confs) / len(confs)
    weakest = min(confs)
    policy_conf = round(0.6 * avg + 0.4 * weakest, 2)
    located = sum(1 for f in findings
                  if f.status in (STATUS_VERIFIED, STATUS_NORMALIZED))
    return policy_conf, located, len(findings) - located


def marks(findings: list[Finding], limit: int = 0) -> list[list[int]]:
    """把已定位条款的真实区间整理成**互不重叠**的 [start, end] 列表（供前端插 `<mark>`）。

    重叠时保留先出现的那个（条款按清单顺序排，靠前的通常是主条件）；
    越界或未命中的直接丢掉 —— 宁可少高亮，也不要给出一个指向不存在的区间。
    """
    spans: list[list[int]] = []
    for f in findings:
        if not f.matched or f.char_end <= f.char_start:
            continue
        spans.append([f.char_start, f.char_end])
    spans.sort()
    out: list[list[int]] = []
    for s, e in spans:
        if out and s < out[-1][1]:                          # 与前一个重叠 → 跳过
            continue
        out.append([s, e])
    if limit > 0:
        out = out[:limit]
    return out


def best_offset(findings: list[Finding]) -> str:
    """取「证据最强的那一条」的真实偏移串，作为政策级 offset（旧契约字段）。"""
    hit = [f for f in findings if f.matched]
    if not hit:
        return ""
    top = max(hit, key=lambda f: (f.confidence, -f.char_start))
    return f"{top.char_start}–{top.char_end}"
