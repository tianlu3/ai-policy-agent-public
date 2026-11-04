"""账号安全原语：密码哈希与会话 Token。

为什么不用 bcrypt / passlib：
  · `hashlib.pbkdf2_hmac` 是标准库实现，免编译、免额外依赖；
  · 哈希串自带**算法 / 迭代次数 / 盐**，后续升级参数也能校验旧密码（向前兼容）；
  · 本地单机场景下 PBKDF2-HMAC-SHA256 @ 26 万次迭代 ≈ 百毫秒级，既拖慢爆破
    又不影响登录体验。

哈希串格式（与 Django 的 `pbkdf2_sha256` 同构，便于迁移）：

    pbkdf2_sha256$<iterations>$<salt_b64>$<hash_b64>

会话 Token 直接使用 `secrets.token_urlsafe(32)`（256 bit 熵），
数据库里**只存 SHA-256 摘要**：即使库被拖走也无法反推出可用的 Token。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import secrets

ALGORITHM = "pbkdf2_sha256"
ITERATIONS = 260_000
SALT_BYTES = 16
TOKEN_BYTES = 32

# 用户名 / 密码的基础校验规则（前端也会校验一遍，后端做兜底）
USERNAME_MIN, USERNAME_MAX = 3, 32
PASSWORD_MIN = 6
PASSWORD_MAX = 128


# ============================================================
# 密码
# ============================================================
def _b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii").strip()


def _unb64(text: str) -> bytes:
    return base64.b64decode(text.encode("ascii"))


def hash_password(password: str, *, iterations: int = ITERATIONS) -> str:
    salt = secrets.token_bytes(SALT_BYTES)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return f"{ALGORITHM}${iterations}${_b64(salt)}${_b64(digest)}"


def verify_password(password: str, stored: str) -> bool:
    """定时安全比较，任何格式异常都返回 False（不抛错，避免暴露实现细节）。"""
    if not password or not stored:
        return False
    try:
        algorithm, raw_iterations, salt_b64, hash_b64 = stored.split("$", 3)
        if algorithm != ALGORITHM:
            return False
        iterations = int(raw_iterations)
        expected = _unb64(hash_b64)
        actual = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), _unb64(salt_b64), iterations
        )
        return hmac.compare_digest(actual, expected)
    except Exception:  # noqa: BLE001 - 格式损坏 / base64 非法一律视为校验失败
        return False


def needs_rehash(stored: str) -> bool:
    """迭代次数落后于当前配置时需要重哈希（登录成功后透明升级）。"""
    try:
        algorithm, raw_iterations, _, _ = stored.split("$", 3)
        return algorithm != ALGORITHM or int(raw_iterations) < ITERATIONS
    except Exception:  # noqa: BLE001
        return True


# ============================================================
# 会话 Token
# ============================================================
def new_token() -> str:
    return secrets.token_urlsafe(TOKEN_BYTES)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


# ============================================================
# 表单校验
# ============================================================
def validate_username(username: str) -> str | None:
    """返回错误文案；None 表示通过。"""
    if not username:
        return "请输入用户名"
    if not (USERNAME_MIN <= len(username) <= USERNAME_MAX):
        return f"用户名长度需为 {USERNAME_MIN}–{USERNAME_MAX} 个字符"
    allowed = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-.@")
    if not set(username) <= allowed:
        return "用户名只能包含字母、数字与 _ - . @"
    if username[0].isdigit():
        return "用户名不能以数字开头"
    return None


def validate_password(password: str) -> str | None:
    if not password:
        return "请输入密码"
    if len(password) < PASSWORD_MIN:
        return f"密码至少 {PASSWORD_MIN} 位"
    if len(password) > PASSWORD_MAX:
        return f"密码最多 {PASSWORD_MAX} 位"
    if password.isdigit() or password.isalpha():
        return "密码需同时包含字母与数字，安全性更高"
    return None


def validate_display_name(name: str) -> str | None:
    if not name:
        return "请输入昵称"
    if len(name) > 32:
        return "昵称最多 32 个字符"
    return None


def normalize_email(email: str) -> str | None:
    email = (email or "").strip().lower()
    if not email:
        return None
    if "@" not in email or "." not in email.split("@")[-1] or len(email) > 160:
        raise ValueError("邮箱格式不正确")
    return email
