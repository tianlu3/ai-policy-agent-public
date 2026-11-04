"""数据仓储：用户 / 会话 / 检索记录的读写。

约定：
  · 全部 SQL 显式书写（无 ORM），便于评审与答辩时逐条对照表结构；
  · 对外一律返回**驼峰命名的普通字典**，与前端 / API 的字段风格一致；
  · 绝不返回 `password_hash`（只有 `find_user_for_login` 会带出来，且仅供内部校验）；
  · 唯一键冲突（MySQL 1062）转成 `ConflictError`，由接口层译成 409/400。
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta
from typing import Any

from . import config, db
from .security import hash_password, new_token, token_hash


class ConflictError(Exception):
    """唯一键冲突：用户名或邮箱已被占用。"""

    def __init__(self, field: str, message: str) -> None:
        super().__init__(message)
        self.field = field


class NotFoundError(Exception):
    """记录不存在或不属于当前用户。"""


# ============================================================
# 工具
# ============================================================
def _dt(value: Any) -> str | None:
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d %H:%M:%S")
    return str(value) if value else None


def _parse_dt(value: Any) -> datetime | None:
    """列值 → datetime（MySQL 驱动给 datetime，SQLite 兜底引擎给文本）。"""
    if isinstance(value, datetime):
        return value
    text = str(value or "").strip()
    if not text:
        return None
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(text[:19], fmt)
        except ValueError:
            continue
    return None


def _iso(value: Any) -> str | None:
    if isinstance(value, datetime):
        return value.isoformat(timespec="seconds")
    return str(value) if value else None


def as_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def as_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


# ============================================================
# 用户
# ============================================================
USER_COLUMNS = (
    "id, username, email, phone, display_name, company, industry, "
    "region_code, region_name, status, created_at, updated_at, last_login_at"
)


def public_user(row: dict | None) -> dict | None:
    """行 → 对外用户对象（不含任何口令类字段）。"""
    if not row:
        return None
    return {
        "id": row.get("id"),
        "username": row.get("username"),
        "displayName": row.get("display_name") or row.get("username"),
        "email": row.get("email"),
        "phone": row.get("phone"),
        "company": row.get("company"),
        "industry": row.get("industry"),
        "regionCode": row.get("region_code"),
        "regionName": row.get("region_name"),
        "createdAt": _dt(row.get("created_at")),
        "lastLoginAt": _dt(row.get("last_login_at")),
    }


def create_user(
    *,
    username: str,
    password: str,
    display_name: str,
    email: str | None = None,
    phone: str | None = None,
    company: str | None = None,
    industry: str | None = None,
    region_code: str | None = None,
    region_name: str | None = None,
) -> dict:
    """注册：写入 users 表并返回对外用户对象。"""
    sql = """
        INSERT INTO users
            (username, email, phone, display_name, password_hash,
             company, industry, region_code, region_name)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
    """
    params = (
        username, email or None, phone or None, display_name, hash_password(password),
        company or None, industry or None, region_code or None, region_name or None,
    )
    try:
        user_id = db.insert(sql, params)
    except db.DuplicateKeyError as exc:
        text = str(exc)
        if "email" in text:
            raise ConflictError("email", "该邮箱已被注册") from exc
        raise ConflictError("username", "该用户名已被占用") from exc
    return public_user(get_user(user_id))  # type: ignore[return-value]


def find_user_for_login(username: str) -> dict | None:
    """登录校验专用：**带** password_hash，禁止直接回传接口。"""
    return db.query_one(
        f"SELECT {USER_COLUMNS}, password_hash FROM users "
        "WHERE username = %s OR email = %s LIMIT 1",
        (username, username),
    )


def get_user(user_id: int) -> dict | None:
    return db.query_one(f"SELECT {USER_COLUMNS} FROM users WHERE id = %s", (user_id,))


def get_user_by_name(username: str) -> dict | None:
    return db.query_one(
        f"SELECT {USER_COLUMNS} FROM users WHERE username = %s LIMIT 1", (username,)
    )


def touch_login(user_id: int) -> None:
    db.execute("UPDATE users SET last_login_at = NOW() WHERE id = %s", (user_id,))


def update_password(user_id: int, password: str) -> None:
    db.execute(
        "UPDATE users SET password_hash = %s WHERE id = %s", (hash_password(password), user_id)
    )


PROFILE_FIELDS = {
    "company": "company",
    "industry": "industry",
    "regionCode": "region_code",
    "regionName": "region_name",
    "displayName": "display_name",
    "email": "email",
    "phone": "phone",
}


def update_profile(user_id: int, patch: dict) -> dict | None:
    """按需更新企业档案（用户「填一次」，之后登录自动带出）。"""
    sets, params = [], []
    for key, column in PROFILE_FIELDS.items():
        if key in patch:
            value = patch.get(key)
            value = (str(value).strip() or None) if value is not None else None
            sets.append(f"`{column}` = %s")
            params.append(value)
    if not sets:
        return public_user(get_user(user_id))
    params.append(user_id)
    db.execute(f"UPDATE users SET {', '.join(sets)} WHERE id = %s", tuple(params))
    return public_user(get_user(user_id))


# ============================================================
# 会话
# ============================================================
def create_session(user_id: int, *, user_agent: str = "") -> dict:
    """签发 Token 并把摘要写入 sessions 表。返回明文 Token（仅此一次可见）。"""
    token = new_token()
    expires_at = datetime.now() + timedelta(days=max(1, config.AUTH_TOKEN_TTL_DAYS))
    # 时间统一按「YYYY-MM-DD HH:MM:SS」文本落库：MySQL DATETIME 与 SQLite 兜底引擎都吃这个格式
    expires_text = expires_at.strftime("%Y-%m-%d %H:%M:%S")
    db.execute(
        "INSERT INTO sessions (token_hash, user_id, expires_at, user_agent) "
        "VALUES (%s, %s, %s, %s)",
        (token_hash(token), user_id, expires_text, (user_agent or "")[:255] or None),
    )
    return {
        "token": token,
        "expiresAt": expires_text,
        "ttlDays": max(1, config.AUTH_TOKEN_TTL_DAYS),
    }


def resolve_session(token: str) -> dict | None:
    """Token → 用户。同时刷新 last_seen_at，过期会话顺手清理。"""
    if not token:
        return None
    digest = token_hash(token)
    row = db.query_one(
        "SELECT token_hash, user_id, expires_at FROM sessions WHERE token_hash = %s", (digest,)
    )
    if not row:
        return None
    expires_at = _parse_dt(row.get("expires_at"))
    if expires_at is not None and expires_at <= datetime.now():
        delete_session(token)
        return None
    db.execute("UPDATE sessions SET last_seen_at = NOW() WHERE token_hash = %s", (digest,))
    return get_user(as_int(row.get("user_id")))


def delete_session(token: str) -> bool:
    if not token:
        return False
    return db.execute("DELETE FROM sessions WHERE token_hash = %s", (token_hash(token),)) > 0


def delete_user_sessions(user_id: int) -> int:
    """踢下线：删除该用户全部会话。"""
    return db.execute("DELETE FROM sessions WHERE user_id = %s", (user_id,))


def delete_user_sessions_except(user_id: int, keep_token_hash: str) -> int:
    """修改密码后踢掉其他设备：保留当前会话，删除该用户其余会话。"""
    return db.execute(
        "DELETE FROM sessions WHERE user_id = %s AND token_hash <> %s",
        (user_id, keep_token_hash),
    )


def purge_expired_sessions() -> int:
    return db.execute("DELETE FROM sessions WHERE expires_at < NOW()")


# ============================================================
# 检索记录
# ============================================================
RECORD_COLUMNS = (
    "id, user_id, task_id, query, regions_json, industries, types, deadline, "
    "status, provider, degraded, item_count, avg_confidence, elapsed_ms, summary, created_at"
)


def _regions_from_query(query: Any) -> list[str]:
    """从查询文本里识别地名（与检索时的口径同源：`regions.match_in_text`）。

    只用于**展示兜底**（老记录没存生效地域时），识别失败一律返回空列表。
    """
    text = str(query or "").strip()
    if not text:
        return []
    try:
        from . import regions as regions_mod   # 延迟导入：避免模块级循环
        return [n.name for n in regions_mod.match_in_text(text)]
    except Exception:  # noqa: BLE001
        return []


def record_meta(row: dict) -> dict:
    """行 → 历史列表项（**不含** result_json，列表接口保持轻量）。"""
    try:
        regions = json.loads(row.get("regions_json") or "[]")
    except Exception:  # noqa: BLE001
        regions = []
    if not isinstance(regions, list):
        regions = []
    regions = [str(r) for r in regions if r]
    if not regions:
        # 老记录落库时存的是「筛选栏原样」，筛选栏没选就存成空 —— 但那次检索实际是
        # 按查询文本里的地名（如「杭州」→ 杭州市）跑的。这里按同一口径补一次，
        # 让历史卡片的「地域」与当次结果一致，不必重新检索。
        regions = _regions_from_query(row.get("query"))
    return {
        "id": row.get("id"),
        "taskId": row.get("task_id"),
        "query": row.get("query"),
        "regions": regions,
        "industries": row.get("industries"),
        "types": row.get("types"),
        "deadline": row.get("deadline"),
        "status": row.get("status"),
        "provider": row.get("provider"),
        "degraded": bool(row.get("degraded")),
        "itemCount": as_int(row.get("item_count")),
        "avgConfidence": round(as_float(row.get("avg_confidence")), 2),
        "elapsedMs": as_int(row.get("elapsed_ms")),
        "summary": row.get("summary"),
        "createdAt": _dt(row.get("created_at")),
        "hasResult": bool(row.get("has_result")) if "has_result" in row else True,
    }


def save_search_record(user_id: int, payload: dict) -> int:
    """把一次检索的条件与结果快照落库。payload 由 search.py 组装。

    upsert 的方言分支：MySQL 用 ON DUPLICATE KEY UPDATE（uk_records_task 唯一键），
    SQLite 兜底引擎用等价的 ON CONFLICT(task_id) DO UPDATE（excluded.*）。
    """
    values = (
        user_id,
        str(payload.get("taskId") or "")[:40],
        str(payload.get("query") or "")[:500],
        json.dumps(payload.get("regions") or [], ensure_ascii=False)[:512],
        (str(payload.get("industries") or "")[:120]) or None,
        (str(payload.get("types") or "")[:120]) or None,
        (str(payload.get("deadline") or "")[:40]) or None,
        str(payload.get("status") or "succeeded")[:16],
        (str(payload.get("provider") or "")[:64]) or None,
        1 if payload.get("degraded") else 0,
        as_int(payload.get("itemCount")),
        round(as_float(payload.get("avgConfidence")), 3),
        as_int(payload.get("elapsedMs")),
        (str(payload.get("summary") or "")[:255]) or None,
        payload.get("resultJson"),
    )
    if db.engine() == "sqlite":
        sql = """
            INSERT INTO search_records
                (user_id, task_id, query, regions_json, industries, types, deadline,
                 status, provider, degraded, item_count, avg_confidence, elapsed_ms,
                 summary, result_json)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT(task_id) DO UPDATE SET
                status = excluded.status, provider = excluded.provider,
                degraded = excluded.degraded, item_count = excluded.item_count,
                avg_confidence = excluded.avg_confidence, elapsed_ms = excluded.elapsed_ms,
                summary = excluded.summary, result_json = excluded.result_json
        """
    else:
        sql = """
            INSERT INTO search_records
                (user_id, task_id, query, regions_json, industries, types, deadline,
                 status, provider, degraded, item_count, avg_confidence, elapsed_ms,
                 summary, result_json)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON DUPLICATE KEY UPDATE
                status = VALUES(status), provider = VALUES(provider),
                degraded = VALUES(degraded), item_count = VALUES(item_count),
                avg_confidence = VALUES(avg_confidence), elapsed_ms = VALUES(elapsed_ms),
                summary = VALUES(summary), result_json = VALUES(result_json)
        """
    db.execute(sql, values)
    row = db.query_one(
        "SELECT id FROM search_records WHERE user_id = %s AND task_id = %s",
        (user_id, values[1]),
    )
    record_id = as_int((row or {}).get("id"))
    prune_search_records(user_id)
    return record_id


def prune_search_records(user_id: int) -> int:
    """按配置的保留条数裁掉最旧记录（默认 200）。"""
    keep = max(0, config.HISTORY_KEEP_PER_USER)
    if not keep:
        return 0
    return db.execute(
        "DELETE FROM search_records WHERE user_id = %s AND id NOT IN ("
        "  SELECT id FROM (SELECT id FROM search_records WHERE user_id = %s "
        "  ORDER BY id DESC LIMIT %s) AS keep_rows)",
        (user_id, user_id, keep),
    )


def list_search_records(
    user_id: int, *, limit: int = 20, offset: int = 0, keyword: str = ""
) -> dict:
    limit = max(1, min(100, as_int(limit, 20)))
    offset = max(0, as_int(offset, 0))
    where = "user_id = %s"
    params: list[Any] = [user_id]
    if keyword:
        where += " AND (query LIKE %s OR summary LIKE %s)"
        like = f"%{keyword}%"
        params.extend([like, like])

    total_row = db.query_one(f"SELECT COUNT(*) AS n FROM search_records WHERE {where}", tuple(params))
    rows = db.query_all(
        f"SELECT {RECORD_COLUMNS}, (result_json IS NOT NULL) AS has_result "
        f"FROM search_records WHERE {where} ORDER BY id DESC LIMIT %s OFFSET %s",
        tuple(params + [limit, offset]),
    )
    return {
        "total": as_int((total_row or {}).get("n")),
        "limit": limit,
        "offset": offset,
        "items": [record_meta(r) for r in rows],
    }


def get_search_record(user_id: int, record_id: int, *, with_result: bool = True) -> dict | None:
    columns = RECORD_COLUMNS + (", result_json" if with_result else ", (result_json IS NOT NULL) AS has_result")
    row = db.query_one(
        f"SELECT {columns} FROM search_records WHERE id = %s AND user_id = %s",
        (record_id, user_id),
    )
    if not row:
        return None
    meta = record_meta(row)
    if with_result:
        raw = row.get("result_json")
        try:
            meta["bootstrap"] = json.loads(raw) if raw else None
        except Exception:  # noqa: BLE001
            meta["bootstrap"] = None
    return meta


def latest_search_record(user_id: int) -> dict | None:
    row = db.query_one(
        f"SELECT {RECORD_COLUMNS}, (result_json IS NOT NULL) AS has_result "
        "FROM search_records WHERE user_id = %s AND status = 'succeeded' "
        "ORDER BY id DESC LIMIT 1",
        (user_id,),
    )
    return record_meta(row) if row else None


def delete_search_record(user_id: int, record_id: int) -> bool:
    return db.execute(
        "DELETE FROM search_records WHERE id = %s AND user_id = %s", (record_id, user_id)
    ) > 0


def clear_search_records(user_id: int) -> int:
    return db.execute("DELETE FROM search_records WHERE user_id = %s", (user_id,))


def user_stats(user_id: int) -> dict:
    row = db.query_one(
        "SELECT COUNT(*) AS total, "
        "SUM(status = 'succeeded') AS succeeded, "
        "SUM(status = 'failed') AS failed, "
        "MAX(created_at) AS last_at "
        "FROM search_records WHERE user_id = %s",
        (user_id,),
    ) or {}
    sessions = db.query_one(
        "SELECT COUNT(*) AS n FROM sessions WHERE user_id = %s AND expires_at > NOW()",
        (user_id,),
    ) or {}
    return {
        "searches": as_int(row.get("total")),
        "succeeded": as_int(row.get("succeeded")),
        "failed": as_int(row.get("failed")),
        "lastSearchAt": _dt(row.get("last_at")),
        "activeSessions": as_int(sessions.get("n")),
    }


# ============================================================
# 政策对话（chat_messages）
#   · 一轮问答 = 两行：role='user' 一行、role='assistant' 一行
#   · 按 (user_id, policy_id) 隔离：同一条政策下接着聊，换政策就是新会话
#   · 只服务**登录用户** —— 游客不写这张表，由接口层决定（见 app/chat.py）
# ============================================================

CHAT_COLUMNS = "id, policy_id, policy_name, role, content, provider, degraded, elapsed_ms, created_at"


def chat_message(row: dict) -> dict:
    """行 → 前端对话气泡（驼峰命名，与其它接口一致）。"""
    return {
        "id": as_int(row.get("id")),
        "policyId": str(row.get("policy_id") or ""),
        "policyName": str(row.get("policy_name") or ""),
        "role": str(row.get("role") or "assistant"),
        "content": str(row.get("content") or ""),
        "provider": str(row.get("provider") or ""),
        # 降级标记要如实带出去：前端据此在气泡上标「规则兜底」，不假装是模型原文
        "degraded": bool(as_int(row.get("degraded"))),
        "elapsedMs": as_int(row.get("elapsed_ms")),
        "createdAt": _dt(row.get("created_at")),
    }


def save_chat_message(
    user_id: int,
    policy_id: str,
    role: str,
    content: str,
    *,
    policy_name: str = "",
    provider: str = "",
    degraded: bool = False,
    elapsed_ms: int = 0,
) -> int:
    """写入一条对话（用户提问或助手回答），返回自增 id。

    `policy_name` 是**写入时**的政策名快照 —— 「对话记录」页要按政策列出会话，
    若展示时才回查 bootstrap，政策池一换（换检索条件 / 换样例集）名字就对不上了。
    """
    sql = (
        "INSERT INTO chat_messages "
        "(user_id, policy_id, policy_name, role, content, provider, degraded, elapsed_ms) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s, %s)"
    )
    return db.insert(
        sql,
        (user_id, (policy_id or "")[:64], (policy_name or "")[:255], role, content,
         (provider or "")[:64] or None, 1 if degraded else 0, as_int(elapsed_ms)),
    )


def list_chat_messages(
    user_id: int, policy_id: str, *, limit: int = 200
) -> list[dict]:
    """取某条政策下该用户的对话，**按时间正序**返回（前端直接从上往下铺）。

    实现上是先按 id 倒序取最近 limit 条、再翻回正序 —— 直接用 ORDER BY id ASC
    在对话变长时会把最旧的那些取出来（而用户要看的是最近聊的内容）。
    """
    rows = db.query_all(
        f"SELECT {CHAT_COLUMNS} FROM chat_messages "
        "WHERE user_id = %s AND policy_id = %s ORDER BY id DESC LIMIT %s",
        (user_id, policy_id or "", max(1, as_int(limit, 200))),
    )
    return [chat_message(r) for r in reversed(rows)]


def count_chat_messages(user_id: int, policy_id: str) -> int:
    row = db.query_one(
        "SELECT COUNT(*) AS n FROM chat_messages WHERE user_id = %s AND policy_id = %s",
        (user_id, policy_id or ""),
    ) or {}
    return as_int(row.get("n"))


def list_chat_threads(user_id: int, *, limit: int = 50) -> list[dict]:
    """按政策聚合该用户的对话 → 检索记录屏「对话记录」页的卡片列表（最近聊过的在前）。

    用户反馈：对话按政策隔离后，想看上次的问答得先找到那条政策，很不方便 ——
    这里把「他在哪些政策下聊过、各聊了几句、最后问了什么」一次带出来，
    前端点卡片直接跳那条政策的详情页接着聊。
    """
    rows = db.query_all(
        "SELECT policy_id, MAX(policy_name) AS policy_name, COUNT(*) AS cnt, "
        "SUM(role = 'user') AS questions, MAX(created_at) AS last_at "
        "FROM chat_messages WHERE user_id = %s "
        "GROUP BY policy_id ORDER BY last_at DESC, MAX(id) DESC LIMIT %s",
        (user_id, max(1, as_int(limit, 50))),
    )
    if not rows:
        return []

    # 每条线程的最后一句提问与最后一句回答（预览用，全文在详情页里）
    tail = db.query_all(
        "SELECT m.policy_id, m.role, m.content FROM chat_messages m "
        "JOIN ("
        "  SELECT policy_id,"
        "         MAX(CASE WHEN role = 'user' THEN id END) AS uid,"
        "         MAX(CASE WHEN role = 'assistant' THEN id END) AS aid"
        "  FROM chat_messages WHERE user_id = %s GROUP BY policy_id"
        ") x ON m.id IN (x.uid, x.aid)"
        " WHERE m.user_id = %s",
        (user_id, user_id),
    )
    last: dict[str, dict[str, str]] = {}
    for r in tail:
        d = last.setdefault(str(r.get("policy_id") or ""), {})
        d[str(r.get("role") or "")] = str(r.get("content") or "")

    out = []
    for r in rows:
        pid = str(r.get("policy_id") or "")
        d = last.get(pid, {})
        out.append({
            "policyId": pid,
            "policyName": str(r.get("policy_name") or "") or pid,
            "messages": as_int(r.get("cnt")),
            "questions": as_int(r.get("questions")),
            "lastQuestion": d.get("user", ""),
            "lastAnswer": d.get("assistant", ""),
            "lastAt": _dt(r.get("last_at")),
        })
    return out


def prune_chat_messages(user_id: int, policy_id: str, keep: int) -> int:
    """只保留最近 keep 条。超出部分按时间裁掉最旧的（对话会把表撑大）。"""
    keep = max(1, as_int(keep, 200))
    return db.execute(
        "DELETE FROM chat_messages WHERE user_id = %s AND policy_id = %s "
        "AND id <= (SELECT id FROM ("
        "  SELECT id FROM chat_messages WHERE user_id = %s AND policy_id = %s "
        "  ORDER BY id DESC LIMIT 1 OFFSET %s"
        ") AS t)",
        (user_id, policy_id or "", user_id, policy_id or "", keep - 1),
    )


def clear_chat_messages(user_id: int, policy_id: str | None = None) -> int:
    """清空对话：给了 policy_id 就只清那条政策，不给就清该用户全部对话。"""
    if policy_id is None:
        return db.execute("DELETE FROM chat_messages WHERE user_id = %s", (user_id,))
    return db.execute(
        "DELETE FROM chat_messages WHERE user_id = %s AND policy_id = %s",
        (user_id, policy_id or ""),
    )
