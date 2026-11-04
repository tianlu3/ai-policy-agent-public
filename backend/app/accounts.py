"""账号域服务：注册 / 登录 / 登出 / 当前用户。

本模块把「表单校验 → 安全原语 → 仓储读写」串成一个可直接被路由调用的用例层，
路由（main.py）只负责把异常翻译成 HTTP 状态码，便于单独测试与后续替换实现。

鉴权方式：`Authorization: Bearer <token>`
  · Token 明文只在下发时出现一次，库里存 SHA-256 摘要；
  · 受保护接口依赖 `current_user`，游客接口依赖 `optional_user`（未登录返回 None）。
"""
from __future__ import annotations

import re
import secrets
import time
from typing import Any

from fastapi import Header, HTTPException

from . import config, db, repo, security

__all__ = [
    "ValidationError",
    "AuthError",
    "register",
    "login",
    "logout",
    "forgot_password",
    "reset_password",
    "update_profile",
    "send_email_bind_code",
    "change_password",
    "me_payload",
    "bearer_token",
    "current_user",
    "optional_user",
]


class ValidationError(Exception):
    """入参不合法（字段级）。"""

    def __init__(self, field: str, message: str) -> None:
        super().__init__(message)
        self.field = field
        self.message = message


class AuthError(Exception):
    """凭证错误 / 账号不可用。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _text(payload: dict, key: str) -> str:
    value = payload.get(key)
    return str(value).strip() if value is not None else ""


# ============================================================
# 用例
# ============================================================
def register(payload: dict, *, user_agent: str = "") -> dict:
    """注册 → 直接登录（返回 Token），避免注册完还要再输一遍密码。"""
    username = _text(payload, "username")
    password = payload.get("password") or ""
    display_name = _text(payload, "displayName") or username

    for field, error in (
        ("username", security.validate_username(username)),
        ("password", security.validate_password(password)),
        ("displayName", security.validate_display_name(display_name)),
    ):
        if error:
            raise ValidationError(field, error)

    try:
        email = security.normalize_email(_text(payload, "email"))
    except ValueError as exc:
        raise ValidationError("email", str(exc)) from exc

    user = repo.create_user(
        username=username,
        password=str(password),
        display_name=display_name,
        email=email,
        phone=_text(payload, "phone") or None,
        company=_text(payload, "company") or None,
        industry=_text(payload, "industry") or None,
        region_code=_text(payload, "regionCode") or None,
        region_name=_text(payload, "regionName") or None,
    )
    repo.touch_login(int(user["id"]))
    session = repo.create_session(int(user["id"]), user_agent=user_agent)
    return {"user": repo.public_user(repo.get_user(int(user["id"]))), **session, "created": True}


def login(payload: dict, *, user_agent: str = "") -> dict:
    username = _text(payload, "username")
    password = payload.get("password") or ""
    if not username or not password:
        raise ValidationError("username" if not username else "password",
                              "请输入用户名与密码")

    row = repo.find_user_for_login(username)
    if not row or not security.verify_password(str(password), row.get("password_hash") or ""):
        # 不区分「用户不存在」与「密码错误」，避免撞库时枚举账号
        raise AuthError("BAD_CREDENTIALS", "用户名或密码不正确")
    if not int(row.get("status") or 0):
        raise AuthError("ACCOUNT_DISABLED", "该账号已被禁用，请联系管理员")

    user_id = int(row["id"])
    # 迭代次数升级时透明重哈希（用户无感）
    if security.needs_rehash(row.get("password_hash") or ""):
        repo.update_password(user_id, str(password))
    repo.touch_login(user_id)
    session = repo.create_session(user_id, user_agent=user_agent)
    return {"user": repo.public_user(repo.get_user(user_id)), **session, "created": False}


def logout(token: str | None) -> bool:
    return repo.delete_session(token or "")


# ============================================================
# 档案修改（昵称 / 企业档案 / 邮箱 / 手机号）
# ============================================================
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_PHONE_RE = re.compile(r"^\+?\d{6,15}$")


def _normalize_phone(raw: str) -> str:
    """去掉空格与短横线再校验，如 `138 0013-8000` → `13800138000`。"""
    return re.sub(r"[\s-]", "", raw or "")


def _check_email_free(email: str, user_id: int) -> None:
    """邮箱格式 + 占用校验（邮箱是登录名与找回密码通道，变更需谨慎）。"""
    other = db.query_one(
        "SELECT id FROM users WHERE email = %s AND id <> %s LIMIT 1",
        (email, user_id),
    )
    if other:
        raise repo.ConflictError("email", "该邮箱已被其他账号绑定")


def update_profile(user_id: int, payload: dict) -> dict | None:
    """档案更新：基础字段直接透传；邮箱/手机号先格式与占用校验再落库。

    邮箱是找回密码通道，变更规则（2026-10-15 起）：
      · 当前未绑定邮箱 → 首次补填直接绑定，无需验证码；
      · 已绑定 → 改绑需先向**新邮箱**发验证码（emailCode）；
      · 清空绑定 → 需向**当前绑定邮箱**发验证码（证明本人）。
    邮箱被唯一索引约束——改前主动查重，给 409 可读冲突而不是 500。
    """
    patch = dict(payload or {})

    if "email" in patch:
        email = str(patch.get("email") or "").strip()
        current = str((repo.get_user(user_id) or {}).get("email") or "").strip()
        if email:
            if not _EMAIL_RE.match(email):
                raise ValidationError("email", "邮箱格式不正确，如 name@example.com")
            _check_email_free(email, user_id)
        if email != current and current:
            # 已绑定过的邮箱发生变更/清空 → 必须验证本人身份
            target = email if email else current
            code = str(patch.get("emailCode") or "").strip()
            entry = _EMAIL_BIND_CODES.get((user_id, target.lower()))
            if not code:
                raise AuthError("EMAIL_CODE_REQUIRED",
                                f"修改绑定邮箱需验证：请先向 {target} 获取验证码")
            if not entry or entry["expires"] <= time.time():
                _EMAIL_BIND_CODES.pop((user_id, target.lower()), None)
                raise AuthError("EMAIL_CODE_REQUIRED", "验证码已过期，请重新获取")
            if entry["attempts"] >= _EMAIL_BIND_MAX_ATTEMPTS:
                _EMAIL_BIND_CODES.pop((user_id, target.lower()), None)
                raise AuthError("EMAIL_CODE_REQUIRED", "错误次数过多，请重新获取验证码")
            if not secrets.compare_digest(entry["code"], code):
                entry["attempts"] += 1
                raise AuthError("EMAIL_CODE_MISMATCH", "验证码不正确")
            _EMAIL_BIND_CODES.pop((user_id, target.lower()), None)
        patch["email"] = email
    patch.pop("emailCode", None)   # 中间字段不落库

    if "phone" in patch:
        phone = _normalize_phone(str(patch.get("phone") or "")).strip()
        if phone and not _PHONE_RE.match(phone):
            raise ValidationError("phone", "手机号格式不正确（6~15 位数字，可带 + 区号）")
        patch["phone"] = phone

    return repo.update_profile(user_id, patch)


# ============================================================
# 更换绑定邮箱 · 验证码（发往新邮箱证明所有权；清空绑定时发往旧邮箱）
#   · 进程内存存储，规则与忘记密码验证码一致（TTL/冷却/错次上限）；
#   · echo 通道回显验证码供回归；email 通道真发。
# ============================================================
_EMAIL_BIND_TTL = 300
_EMAIL_BIND_RESEND = 60
_EMAIL_BIND_MAX_ATTEMPTS = 5
# (user_id, 邮箱小写) -> {code, expires, issued, attempts}
_EMAIL_BIND_CODES: dict[tuple[int, str], dict] = {}


def send_email_bind_code(user_id: int, payload: dict) -> dict:
    """向（新）邮箱发送绑定验证码。邮箱占用与格式在此先行校验。"""
    email = str((payload or {}).get("email") or "").strip()
    if not email:
        raise ValidationError("email", "请先填写新邮箱")
    if not _EMAIL_RE.match(email):
        raise ValidationError("email", "邮箱格式不正确，如 name@example.com")
    _check_email_free(email, user_id)

    key = (user_id, email.lower())
    prev = _EMAIL_BIND_CODES.get(key)
    now = time.time()
    if prev and now - prev["issued"] < _EMAIL_BIND_RESEND:
        raise AuthError("EMAIL_CODE_COOLDOWN", "验证码已发送，请稍后再试")

    account = (repo.get_user(user_id) or {}).get("username") or f"user{user_id}"
    code = "".join(secrets.choice("0123456789") for _ in range(6))
    _EMAIL_BIND_CODES[key] = {"code": code, "expires": now + _EMAIL_BIND_TTL,
                              "issued": now, "attempts": 0}

    if config.CODE_CHANNEL == "email" and config.SMTP_USER and config.SMTP_PASS:
        _send_code_email(email, code, str(account), purpose="bind")
        return {"ok": True, "channel": "email", "sentTo": _mask_email(email),
                "expiresIn": _EMAIL_BIND_TTL}
    return {"ok": True, "channel": "echo", "code": code, "expiresIn": _EMAIL_BIND_TTL,
            "note": "原型演示：验证码通道为 echo 回显"}


# ============================================================
# 修改密码（输旧密码设新密码；成功后踢掉其他设备会话，当前会话保留）
# ============================================================
def change_password(user_id: int, payload: dict, current_token: str = "") -> dict:
    old = str((payload or {}).get("oldPassword") or "")
    new = str((payload or {}).get("newPassword") or "")

    if not old:
        raise ValidationError("oldPassword", "请输入当前密码")
    row = db.query_one("SELECT password_hash FROM users WHERE id = %s", (user_id,))
    if not row or not security.verify_password(old, row.get("password_hash") or ""):
        raise AuthError("BAD_CREDENTIALS", "当前密码不正确")
    if new and security.verify_password(new, row.get("password_hash") or ""):
        raise ValidationError("newPassword", "新密码不能与当前密码相同")
    error = security.validate_password(new)
    if error:
        raise ValidationError("newPassword", error)

    repo.update_password(user_id, new)
    keep = repo.token_hash(current_token) if current_token else "___none___"
    kicked = repo.delete_user_sessions_except(user_id, keep)
    return {"ok": True, "changed": True, "sessionsRevoked": max(0, int(kicked))}


# ============================================================
# 忘记密码（原型级：验证码存进程内存，未接入短信/邮件网关）
#   · 真实产品把下发通道换成短信/邮件即可，校验与重置逻辑不变；
#   · 单进程内有效，重启后端即清空（演示可接受，契约闸门不依赖跨进程状态）。
# ============================================================
_RESET_TTL = 300          # 验证码有效期（秒）
_RESET_RESEND = 60        # 重发冷却（秒）
_RESET_MAX_ATTEMPTS = 5   # 验证码错误次数上限，超过作废
_RESET_CODES: dict[str, dict] = {}   # account(小写) -> {code, expires, issued, attempts, user_id}


def _reset_entry(account: str) -> dict | None:
    entry = _RESET_CODES.get(account.lower())
    if entry and entry["expires"] <= time.time():
        _RESET_CODES.pop(account.lower(), None)
        return None
    return entry


def _mask_email(addr: str) -> str:
    """脱敏收件地址：`123456789@qq.com` → `355*****43@qq.com`。"""
    local, _, domain = addr.partition("@")
    if not domain or len(local) <= 4:
        return f"***@{domain}" if domain else "***"
    keep = 2 if len(local) > 6 else 1
    return f"{local[:keep]}*****{local[-2:]}@{domain}"


def _send_code_email(to_addr: str, code: str, account: str,
                     purpose: str = "reset") -> None:
    """SMTP 真发验证码邮件。失败抛 AuthError(EMAIL_SEND_FAILED)，文案带可读原因。"""
    import smtplib
    from email.header import Header
    from email.mime.text import MIMEText
    from email.utils import formataddr

    if purpose == "bind":
        subject = "AI 政策搜索智能体 · 绑定邮箱验证码"
        action = f"你正在给账号「{account}」绑定邮箱。"
    else:
        subject = "AI 政策搜索智能体 · 密码重置验证码"
        action = f"你正在重置「AI 政策搜索智能体」账号「{account}」的登录密码。"
    body = (
        f"你好（账号：{account}），\n\n"
        f"{action}\n"
        f"验证码：{code}（{_RESET_TTL // 60} 分钟内有效）\n\n"
        f"如果这不是你本人的操作，请忽略本邮件，账号不会被改动。\n"
    )
    msg = MIMEText(body, "plain", "utf-8")
    msg["Subject"] = Header(subject, "utf-8")
    msg["From"] = formataddr((str(Header("AI 政策搜索智能体", "utf-8")), config.SMTP_USER))
    msg["To"] = to_addr
    try:
        with smtplib.SMTP_SSL(config.SMTP_HOST, config.SMTP_PORT,
                              timeout=config.SMTP_TIMEOUT) as smtp:
            smtp.login(config.SMTP_USER, config.SMTP_PASS)
            smtp.sendmail(config.SMTP_USER, [to_addr], msg.as_string())
    except Exception as exc:  # noqa: BLE001 - 统一转成可读业务错误
        raise AuthError("EMAIL_SEND_FAILED", _smtp_error_text(exc)) from exc


def _smtp_error_text(exc: Exception) -> str:
    """把 SMTP 异常翻译成用户能读懂的一句话（附原始响应码便于排查）。"""
    code = str(getattr(exc, "smtp_code", "") or "")
    resp = getattr(exc, "smtp_error", "")
    if isinstance(resp, bytes):
        resp = resp.decode("utf-8", "ignore")
    resp = str(resp).strip()
    low = resp.lower()
    if code == "550" and ("non-existent" in low or "recipient" in low):
        return "收件邮箱不存在或地址有误，请检查邮箱拼写后重试"
    if code in ("551", "553"):
        return "收件方邮箱拒收，请检查邮箱地址后重试"
    if code == "554" and ("dt:spm" in low or "spam" in low):
        return "邮件被收件方判为垃圾邮件拦截，请稍后重试或换一个邮箱"
    if code:
        return f"邮件服务器拒绝发送（SMTP {code}：{resp[:120] or '无详情'}）"
    return f"验证码邮件发送失败：{type(exc).__name__}"


def forgot_password(payload: dict) -> dict:
    """生成 6 位验证码。echo 通道随响应回显；email 通道真发到绑定邮箱。"""
    account = _text(payload, "account")
    if not account:
        raise ValidationError("account", "请输入注册时的用户名或邮箱")

    row = repo.find_user_for_login(account)
    if not row or not int(row.get("status") or 0):
        raise AuthError("USER_NOT_FOUND", "该账号未注册或已禁用")

    key = account.lower()
    now = time.time()
    prev = _reset_entry(account)
    if prev and now - prev["issued"] < _RESET_RESEND:
        raise AuthError("CODE_COOLDOWN", "验证码已发送，请稍后再试")

    code = "".join(secrets.choice("0123456789") for _ in range(6))
    _RESET_CODES[key] = {
        "code": code, "expires": now + _RESET_TTL, "issued": now,
        "attempts": 0, "user_id": int(row["id"]),
    }

    if config.CODE_CHANNEL == "email" and config.SMTP_USER and config.SMTP_PASS:
        to_addr = (row.get("email") or "").strip()
        if not to_addr:
            raise AuthError("NO_EMAIL_BOUND", "该账号未绑定邮箱，无法发送验证码邮件，请改用邮箱作为账号名重新注册")
        _send_code_email(to_addr, code, account)
        return {
            "ok": True,
            "account": account,
            "channel": "email",
            "sentTo": _mask_email(to_addr),   # 只回脱敏地址，不回验证码
            "expiresIn": _RESET_TTL,
        }

    return {
        "ok": True,
        "account": account,
        "channel": "echo",
        "code": code,               # 原型演示：直接返回；email 通道不下发
        "expiresIn": _RESET_TTL,
        "note": "原型演示：验证码通道为 echo 回显（可经 CODE_CHANNEL=email 切换真发）",
    }


def reset_password(payload: dict) -> dict:
    """校验验证码 → 更新密码哈希 → 作废该用户全部会话（踢下线）。"""
    account = _text(payload, "account")
    code = _text(payload, "code")
    password = str(payload.get("password") or "")

    if not account:
        raise ValidationError("account", "请输入注册时的用户名或邮箱")
    if not code:
        raise ValidationError("code", "请输入验证码")
    error = security.validate_password(password)
    if error:
        raise ValidationError("password", error)

    entry = _reset_entry(account)
    if not entry:
        raise AuthError("CODE_EXPIRED", "验证码已过期，请重新获取")
    if entry["attempts"] >= _RESET_MAX_ATTEMPTS:
        _RESET_CODES.pop(account.lower(), None)
        raise AuthError("CODE_EXPIRED", "错误次数过多，请重新获取验证码")
    if not secrets.compare_digest(entry["code"], code):
        entry["attempts"] += 1
        raise AuthError("CODE_MISMATCH", "验证码不正确")

    repo.update_password(entry["user_id"], password)
    repo.delete_user_sessions(entry["user_id"])
    _RESET_CODES.pop(account.lower(), None)
    return {"ok": True, "reset": True}


def me_payload(user: dict) -> dict:
    """「我」的完整视图：用户 + 统计 + 最近一次检索（供前端首屏直接回放）。"""
    user_id = int(user["id"])
    return {
        "user": repo.public_user(repo.get_user(user_id)),
        "stats": repo.user_stats(user_id),
        "latest": repo.latest_search_record(user_id),
    }


# ============================================================
# FastAPI 依赖
# ============================================================
def bearer_token(authorization: str | None) -> str | None:
    """从 Authorization 头解析 Bearer Token。"""
    if not authorization:
        return None
    parts = authorization.split(None, 1)
    if len(parts) == 2 and parts[0].lower() == "bearer":
        return parts[1].strip() or None
    return None


def _resolve(authorization: str | None) -> dict | None:
    token = bearer_token(authorization)
    if not token:
        return None
    if not db.available():
        raise HTTPException(
            status_code=503,
            detail={"code": "DB_UNAVAILABLE", "message": "数据库不可用，无法校验登录状态"},
        )
    try:
        return repo.resolve_session(token)
    except db.DBUnavailable as exc:
        raise HTTPException(
            status_code=503, detail={"code": "DB_UNAVAILABLE", "message": str(exc)}
        ) from exc


def current_user(authorization: str | None = Header(default=None)) -> dict:
    """受保护接口：必须登录。"""
    user = _resolve(authorization)
    if not user:
        raise HTTPException(
            status_code=401,
            detail={"code": "UNAUTHORIZED", "message": "请先登录（缺少或失效的登录凭证）"},
        )
    if not int(user.get("status") or 0):
        raise HTTPException(
            status_code=403, detail={"code": "ACCOUNT_DISABLED", "message": "该账号已被禁用"}
        )
    return user


def optional_user(authorization: str | None = Header(default=None)) -> dict | None:
    """游客可用接口：登录时返回用户，未登录返回 None（不报错）。"""
    if not db.available():
        return None
    try:
        return _resolve(authorization)
    except HTTPException:
        return None


def user_of(user: Any) -> dict | None:
    return repo.public_user(user) if isinstance(user, dict) else None
