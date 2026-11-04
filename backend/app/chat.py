"""政策详情 · AI 对话服务（「问政策」）。

设计要点
--------
1. **事实底座是本条政策**：用户问的是「我这种情况能不能申」，答案只能来自
   当前这条政策的结构化字段（`app/llm/prompts.py → build_chat_messages()` 把它
   拼成一段【当前政策】）。模型不许拿别处的政策来答 —— 系统提示词里写死了这条。

2. **兜底是规则回答，不假装成 AI**：与 `app/brief.py` 的综述完全同一套思路 ——
   本地规则引擎（`LLM_PROVIDER=mock` / 未配 Key）以及远端调用失败、超时、
   返回过短时，一律改用 `rule_answer()` 按问题意图引用本政策的真实字段作答，
   并把这个事实**如实**带给前端（`degraded=true` + 一句原因）。
   宁可直接说「这是规则回答」，也不要让用户以为那是模型写的。

3. **落库只服务登录用户**：`respond(user_id=None, ...)` 表示游客 —— 照常回答，
   但不写 `chat_messages`（前端会明确提示「登录后可保存对话」）。
   落库整段 try/except：库挂了最多是「这次没存上」，**绝不影响回答本身**。

4. **硬超时靠线程 join**：`provider.complete(timeout=N)` 的 N 只是 socket 每次读操作的
   超时，网关注入空白保活时永不触发（实测拖到 178s，见 brief.py 的同款注释）。
   真正的上限是 `thread.join(CHAT_TIMEOUT + 8)`。改这里务必重跑 `tools/verify_chat_flow.mjs`。
"""
from __future__ import annotations

import re
import threading
import time
from typing import Any

from . import bootstrap, config, llm, repo

SOURCE_LLM = "llm"
SOURCE_RULE = "rule"

# 规则兜底时的「引擎名」，与远端模型名区分开（前端气泡上会显示它的来源）
RULE_PROVIDER = "rule"


class ChatDisabled(RuntimeError):
    """对话功能被配置关闭（CHAT_ENABLED=0）。"""


class ChatBadRequest(ValueError):
    """入参非法（空问题 / 超长）。"""


def enabled() -> bool:
    return bool(config.CHAT_ENABLED)


# ============================================================
# 文本清洗：气泡里只该有正文
# ============================================================
_FENCE = re.compile(r"```[a-zA-Z0-9_+-]*\s*")
_MD_HEAD = re.compile(r"^\s{0,3}#{1,6}\s*", re.M)
_MD_BULLET = re.compile(r"^\s{0,3}[-*]\s+", re.M)
_MD_BOLD = re.compile(r"\*\*(.+?)\*\*")
_MD_TICK = re.compile(r"`+")
# 模型爱加的开场白/结尾客套：气泡里是废话，直接去掉
_OPENING = re.compile(r"^(好的[，,。！!]?\s*|当然[，,。！!]?\s*|没问题[，,。！!]?\s*|明白了[，,。！!]?\s*)+")


def clean_text(text: str) -> str:
    """清掉 markdown 记号与开场白，返回可直出的纯正文。"""
    t = str(text or "").strip()
    if not t:
        return ""
    t = _FENCE.sub("", t)
    t = _MD_HEAD.sub("", t)
    t = _MD_BULLET.sub("", t)
    t = _MD_BOLD.sub(r"\1", t)
    t = _MD_TICK.sub("", t)
    t = _OPENING.sub("", t)
    # 压缩三行以上的空行，避免气泡里出现大段留白
    t = re.sub(r"\n{3,}", "\n\n", t)
    return t.strip()


# ============================================================
# 规则兜底回答
# ------------------------------------------------------------
# 意图识别用「关键词命中数最多者胜」，比「第一个命中的赢」稳：
# 「我能不能申，需要什么材料？」两个意图都沾边，计数能挑出用户真正问的那个。
# ============================================================
_INTENT_RULES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("materials", ("材料", "要交", "提交", "要件", "附件", "证明", "申报表", "资料", "清单")),
    ("deadline", ("截止", "什么时候", "多久", "几号", "到期", "还有几天", "时间")),
    ("money", ("多少钱", "补贴多少", "金额", "力度", "标准", "奖补", "返还", "上限", "能拿")),
    ("process", ("流程", "怎么申", "怎么申请", "在哪申", "哪里申", "入口", "渠道", "步骤", "办理", "怎么办", "走什么")),
    ("conditions", ("能申", "能不能", "条件", "资格", "符合", "要求", "门槛", "满足", "我这种情况", "够不够", "可以申")),
)
_INTENT_ORDER = tuple(intent for intent, _ in _INTENT_RULES)


def match_intent(question: str) -> str:
    q = str(question or "")
    best, best_score = "overview", 0
    for intent, keys in _INTENT_RULES:
        score = sum(1 for k in keys if k in q)
        if score > best_score:
            best, best_score = intent, score
    # 乱填 / 无关输入（「666」「你好」「我是人机」）：没有任何意图词命中、
    # 又短得不像一个正经问题 → 不再硬套「政策概述」，改走「未收录」口径。
    if best_score == 0 and len(q.strip()) <= 6:
        return "irrelevant"
    return best


def _strs(value: Any) -> list[str]:
    """统一的「取字符串列表」：去掉空白项，容忍 None / 非列表。"""
    if value is None:
        return []
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, (list, tuple)):
        return []
    return [str(x).strip() for x in value if str(x).strip()]


def rule_answer(policy: dict | None, question: str) -> str:
    """按问题意图引用本条政策的真实字段作答（确定性、离线可用）。

    这个函数的输出会被闸门逐字断言，所以措辞改动要同步 `tools/verify_chat_flow.mjs`。
    """
    p = policy or {}
    name = str(p.get("name") or "").strip()
    if not name:
        return "请先打开一条政策，再针对它提问。我可以帮你核对申报条件、申报材料、办理流程与截止时间。"

    intent = match_intent(question)
    lines: list[str] = []

    if intent == "irrelevant":
        lines.append(f"这个问题我没能从{name}的原文里找到依据（依据本政策未收录）。")
        lines.append("本助手只依据当前政策原文作答，闲聊或与政策无关的问题无法回答。")
        lines.append("你可以接着问：要交什么材料 / 怎么走流程 / 什么时候截止 / 我这种情况能不能申。")

    elif intent == "materials":
        mats = _strs(p.get("materials"))
        if mats:
            lines.append(f"{name}的申报材料共 {len(mats)} 项：")
            lines.extend(f"{i}. {m}" for i, m in enumerate(mats, 1))
            lines.append("材料清单来自原文的结构化抽取；原文没有的项按缺省留空，未做补全。")
        else:
            lines.append(f"{name}的申报材料在原文本轮抽取里未收录，建议以官方发布文本为准。")

    elif intent == "deadline":
        dl = str(p.get("deadline") or "").strip()
        left = p.get("daysLeft")
        if dl:
            tail = f"，距今还有 {left} 天" if isinstance(left, int) else ""
            lines.append(f"{name}的申报截止日期是 {dl}{tail}。")
            lines.append("截止日期取自原文；若原文未写明则以受理单位的最新通知为准。")
        else:
            lines.append(f"{name}的原文未写明申报截止日期，建议以受理单位的最新通知为准。")

    elif intent == "money":
        subsidy = str(p.get("subsidy") or "").strip()
        if subsidy:
            lines.append(f"{name}的支持力度：{subsidy}。")
            lines.append("金额口径原样取自政策原文，未做换算或估算。")
        else:
            lines.append(f"{name}的原文未写明具体补贴标准，建议查看申报指南或咨询受理单位。")

    elif intent == "process":
        steps = _strs(p.get("steps"))
        channels = _strs(p.get("channels"))
        if steps:
            lines.append(f"{name}的申报流程共 {len(steps)} 步：")
            lines.extend(f"{i}. {s}" for i, s in enumerate(steps, 1))
        if channels:
            lines.append("申报入口：")
            lines.extend(f"· {c}" for c in channels)
        if not steps and not channels:
            lines.append(f"{name}的原文未收录申报流程，建议向受理单位确认具体办理方式。")

    elif intent == "conditions":
        conds = _strs(p.get("conditionsFull")) or _strs(p.get("conditions"))
        if conds:
            lines.append(f"{name}的申报条件共 {len(conds)} 条，建议逐条对照自己的情况：")
            lines.extend(f"{i}. {c}" for i, c in enumerate(conds, 1))
            lines.append("其中任何一条不满足都会影响申报，详情页左侧可以逐条勾选自查。")
        else:
            lines.append(f"{name}的申报条件在原文抽取里未收录，建议以官方发布文本为准。")

    else:  # overview
        issuer = str(p.get("issuer") or "").strip()
        level = str(p.get("level") or "").strip()
        lines.append(f"{name}由{issuer}发布，属{level}政策。")
        subsidy = str(p.get("subsidy") or "").strip()
        if subsidy:
            lines.append(f"支持力度：{subsidy}。")
        dl = str(p.get("deadline") or "").strip()
        left = p.get("daysLeft")
        if dl:
            tail = f"（还剩 {left} 天）" if isinstance(left, int) else ""
            lines.append(f"申报截止：{dl}{tail}。")
        conds = _strs(p.get("conditionsFull"))
        mats = _strs(p.get("materials"))
        if conds:
            lines.append(f"申报条件 {len(conds)} 条，申报材料 {len(mats)} 项，都可在详情页左侧逐条核对。")
        lines.append("你可以接着问：要交什么材料 / 怎么走流程 / 什么时候截止 / 我这种情况能不能申。")

    return "\n".join(lines)


# ============================================================
# 远端模型回答（失败一律降级到 rule_answer）
# ============================================================
def ai_answer(
    policy: dict | None, history: list[dict], question: str
) -> tuple[str, str, str, str]:
    """返回 (文案, 来源, 说明, 引擎名)。来源 ∈ {"llm", "rule"}。"""
    try:
        provider = llm.build_provider("chat")   # 对话用途：可单独配模型/开关思考
    except Exception as exc:  # noqa: BLE001 - 没配 Key / 配置非法：直接规则兜底
        return rule_answer(policy, question), SOURCE_RULE, f"模型不可用（{exc}）", RULE_PROVIDER

    if not getattr(provider, "is_remote", False):
        # 本地规则引擎：写不出像样的对话回答，直接用规则文案，不必绕一圈
        return rule_answer(policy, question), SOURCE_RULE, \
            "当前为本地规则引擎（未调用远端模型）", RULE_PROVIDER

    messages = llm.build_chat_messages(
        policy, history, question, max_turns=config.CHAT_CONTEXT_TURNS
    )
    box: dict[str, Any] = {}

    def worker() -> None:
        try:
            box["text"] = provider.complete(
                messages,
                max_tokens=config.CHAT_MAX_TOKENS,
                timeout=config.CHAT_TIMEOUT,
                temperature=0.3,
                retries=0,
            )
        except Exception as exc:  # noqa: BLE001
            box["error"] = exc

    thread = threading.Thread(target=worker, daemon=True, name="policy-chat")
    thread.start()
    # **硬上限**：complete 的 socket 超时只在「每次读操作」上生效，网关注入空白保活
    # 时永不触发（与 brief.py 同款坑）。真正的截止是这道 join。
    thread.join(config.CHAT_TIMEOUT + 8)

    name = str(getattr(provider, "name", "") or "llm")
    if thread.is_alive():
        return rule_answer(policy, question), SOURCE_RULE, \
            f"模型 {config.CHAT_TIMEOUT:.0f}s 内未返回，已改用规则回答", RULE_PROVIDER
    if "error" in box:
        return rule_answer(policy, question), SOURCE_RULE, \
            f"模型调用失败（{box['error']}）", RULE_PROVIDER

    text = clean_text(box.get("text") or "")
    if len(text) < 20:                       # 太短基本是无效输出
        return rule_answer(policy, question), SOURCE_RULE, \
            "模型返回内容过短，已改用规则回答", RULE_PROVIDER
    return text, SOURCE_LLM, "由大模型生成", name


# ============================================================
# 对外入口
# ============================================================
# ============================================================
# 政策上下文解析
# ------------------------------------------------------------
# 与 `POST /api/v1/briefs` 同一个取舍：**清单/上下文由前端带来**
# （见 brief.py 的 policies[]）。理由一致 —— 用户此刻在屏上看到的就是它，
# 后端不可能比它更"准"；而且这样接口不依赖「检索结果还在不在内存里」。
# 但为了不把正确性完全押在客户端上，客户端没带（或带得不全）时，
# 服务端会回退到 bootstrap 样例集里按 id 找一次。
# ============================================================
def _policy_from_bootstrap(policy_id: str) -> dict | None:
    pid = str(policy_id or "").strip()
    if not pid:
        return None
    try:
        items = ((bootstrap.load().get("policies") or {}).get("items")) or []
    except Exception:  # noqa: BLE001 - 数据没准备好也不该让对话挂掉
        return None
    for item in items:
        if isinstance(item, dict) and str(item.get("id")) == pid:
            return item
    return None


def resolve_policy(policy_id: str, client_policy: Any) -> dict:
    """拿到「用户此刻正在看的那条政策」。

    优先级：客户端带来的上下文（与屏上一致）> 服务端 bootstrap 按 id 兜底 > 空。
    只想让模型有事实可依，不做字段校验 —— 缺字段时提示词里自然就是空的，
    模型按系统提示词会回答「原文未收录」而不是编。
    """
    server = _policy_from_bootstrap(policy_id)
    if isinstance(client_policy, dict) and str(client_policy.get("name") or "").strip():
        # 客户端缺的字段用服务端那份补上（前端可能只带展示用得上的部分）
        if server:
            merged = dict(server)
            merged.update({k: v for k, v in client_policy.items() if v not in (None, "", [])})
            return merged
        return client_policy
    return server or {}


def respond(
    user_id: int | None,
    policy: dict | None,
    policy_id: str,
    question: str,
) -> dict:
    """一次问答。

    `user_id=None` 表示游客：照常回答，但**不落库**（返回里 `saved=false`）。
    """
    if not enabled():
        raise ChatDisabled("政策对话功能已被关闭（CHAT_ENABLED=0）")

    q = str(question or "").strip()
    if not q:
        raise ChatBadRequest("提问内容不能为空")
    if len(q) > config.CHAT_MAX_QUESTION_CHARS:
        raise ChatBadRequest(
            f"提问过长（{len(q)} 字），请精简到 {config.CHAT_MAX_QUESTION_CHARS} 字以内"
        )

    t0 = time.monotonic()
    pid = str(policy_id or "")[:64]

    # 上下文只取最近若干轮：既压 token，也压住首字延迟
    history: list[dict] = []
    if user_id is not None:
        try:
            history = repo.list_chat_messages(
                user_id, pid, limit=max(2, config.CHAT_CONTEXT_TURNS * 2)
            )
        except Exception:  # noqa: BLE001 - 读不到历史不影响这一次回答
            history = []

    text, source, reason, engine = ai_answer(policy, history, q)
    elapsed_ms = int((time.monotonic() - t0) * 1000)
    degraded = source != SOURCE_LLM

    saved = False
    if user_id is not None:
        # 落库整段 try/except：库挂了最多「这次没存上」，绝不影响回答
        try:
            pname = str(policy.get("name") or "")
            repo.save_chat_message(user_id, pid, "user", q, policy_name=pname)
            repo.save_chat_message(
                user_id, pid, "assistant", text,
                policy_name=pname,
                provider=engine, degraded=degraded, elapsed_ms=elapsed_ms,
            )
            repo.prune_chat_messages(user_id, pid, config.CHAT_KEEP_PER_POLICY)
            saved = True
        except Exception:  # noqa: BLE001
            saved = False

    return {
        "question": q,
        "answer": text,
        "source": source,             # llm | rule
        "degraded": degraded,
        "reason": reason,             # 降级/来源说明（前端如实展示）
        "provider": engine,
        "elapsedMs": elapsed_ms,
        "saved": saved,               # 是否写入了 MySQL
        "policyId": pid,
    }


def history_of(user_id: int | None, policy_id: str, limit: int = 200) -> list[dict]:
    """某条政策下的历史对话（游客返回空 —— 后端没有他们的对话）。"""
    if user_id is None or not enabled():
        return []
    try:
        return repo.list_chat_messages(user_id, str(policy_id or "")[:64], limit=limit)
    except Exception:  # noqa: BLE001
        return []


def threads_of(user_id: int | None, limit: int = 50) -> list[dict]:
    """按政策聚合的对话列表（检索记录屏「对话记录」页）；游客返回空。"""
    if user_id is None or not enabled():
        return []
    try:
        return repo.list_chat_threads(user_id, limit=limit)
    except Exception:  # noqa: BLE001
        return []


def clear(user_id: int, policy_id: str | None = None) -> int:
    if not enabled():
        raise ChatDisabled("政策对话功能已被关闭（CHAT_ENABLED=0）")
    return repo.clear_chat_messages(user_id, policy_id)


def public_status() -> dict:
    """对话能力探测（给 /api/v1/chat/status）。"""
    try:
        provider = llm.build_provider("chat")
        remote = bool(getattr(provider, "is_remote", False))
        engine = str(getattr(provider, "name", "") or ("llm" if remote else RULE_PROVIDER))
    except Exception:  # noqa: BLE001
        remote, engine = False, RULE_PROVIDER
    return {
        "enabled": enabled(),
        "remote": remote,
        "engine": engine,
        "timeout": config.CHAT_TIMEOUT,
        "maxTokens": config.CHAT_MAX_TOKENS,
        "maxQuestionChars": config.CHAT_MAX_QUESTION_CHARS,
        "contextTurns": config.CHAT_CONTEXT_TURNS,
        "keepPerPolicy": config.CHAT_KEEP_PER_POLICY,
    }
