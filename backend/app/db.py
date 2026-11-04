"""MySQL 接入层：连接池 · 建库建表 · 轻量查询封装。

设计原则（与《后端架构设计方案》保持一致）：

  · **数据库不可用不影响主链路**。检索、bootstrap、静态托管等照常工作；
    只有「账号 / 历史」相关接口返回 503，前端自动退回游客模式。
  · 连接参数全部来自 `config`（可用 `.env` 覆盖），代码里不出现任何凭据。
  · 只依赖 **PyMySQL**（纯 Python，免编译），不引入 ORM —— 表结构与 SQL
    显式可读，便于课程答辩时逐条讲解。
  · 连接 **autocommit + 池化**：本地单机场景下最简单可靠；需要事务时
    用 `with db.transaction() as conn:` 显式开启。

对外主要接口：

    db.init()                    # 建库 + 建表 + 建连池（服务启动时调用一次）
    db.available()               # 当前是否可用（未配置 / 连不上 → False）
    db.status()                  # 诊断信息，供 /api/v1/db/status 展示
    db.query_all(sql, params)    # → list[dict]
    db.query_one(sql, params)    # → dict | None
    db.execute(sql, params)      # → 影响行数
    db.insert(sql, params)       # → 自增主键
"""
from __future__ import annotations

import logging
import queue
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from . import config

log = logging.getLogger("backend.db")

SCHEMA_FILE = Path(__file__).resolve().parent / "schema.sql"
SCHEMA_SQLITE_FILE = Path(__file__).resolve().parent / "schema.sqlite.sql"

# ── 驱动懒加载：没装 PyMySQL 时后端仍可启动（账号功能降级） ──
try:  # pragma: no cover - 取决于运行环境
    import pymysql
    from pymysql.cursors import DictCursor

    try:
        from importlib.metadata import version as _pkg_version

        DRIVER = f"pymysql {_pkg_version('pymysql')}"
    except Exception:  # noqa: BLE001
        DRIVER = "pymysql"
    DRIVER_ERROR: str | None = None
except Exception as exc:  # noqa: BLE001
    pymysql = None  # type: ignore[assignment]
    DictCursor = None  # type: ignore[assignment]
    DRIVER = "pymysql（未安装）"
    DRIVER_ERROR = f"未安装 PyMySQL：{exc}（执行 pip install pymysql 后重启服务）"


class DBUnavailable(RuntimeError):
    """数据库未配置 / 未安装驱动 / 连接失败。上层据此返回 503 而非 500。"""


class DuplicateKeyError(RuntimeError):
    """唯一键冲突（MySQL 1062 / SQLite IntegrityError 的统一译名）。

    message 里带得到冲突列的信息（MySQL 是索引名，SQLite 是列名），
    上层据此区分「用户名占用」还是「邮箱占用」。
    """


# ============================================================
# 连接池
# ============================================================
def _connect_kwargs(with_db: bool = True) -> dict[str, Any]:
    kw: dict[str, Any] = {
        "host": config.DB_HOST,
        "port": config.DB_PORT,
        "user": config.DB_USER,
        "password": config.DB_PASSWORD,
        "charset": config.DB_CHARSET,
        "autocommit": True,
        "connect_timeout": max(2, config.DB_CONNECT_TIMEOUT),
        "read_timeout": max(5, config.DB_CONNECT_TIMEOUT * 4),
        "write_timeout": max(5, config.DB_CONNECT_TIMEOUT * 4),
        "cursorclass": DictCursor,
    }
    if with_db:
        kw["database"] = config.DB_NAME
    return kw


class ConnectionPool:
    """极简连接池：空闲连接用 LIFO 复用，取用前 ping 探活，坏连接直接丢弃。

    规模很小（本地单机、单进程），因此不做复杂的回收线程 ——
    空闲连接长期不用会自然被 MySQL 的 wait_timeout 断开，
    而每次取用前的 `ping()` 正好把这种情况兜住。
    """

    def __init__(self, size: int, connect_kwargs: dict[str, Any]) -> None:
        self._size = max(1, int(size))
        self._kw = dict(connect_kwargs)
        self._idle: "queue.LifoQueue[Any]" = queue.LifoQueue()
        self._sem = threading.BoundedSemaphore(self._size)
        self._created = 0
        self._lock = threading.Lock()

    # ---------- 内部 ----------
    def _open(self):
        if pymysql is None:
            raise DBUnavailable(DRIVER_ERROR or "PyMySQL 不可用")
        conn = pymysql.connect(**self._kw)
        with self._lock:
            self._created += 1
        return conn

    @staticmethod
    def _alive(conn) -> bool:
        try:
            conn.ping(reconnect=False)
            return True
        except Exception:  # noqa: BLE001 - 探活失败即视为坏连接
            return False

    @staticmethod
    def _close(conn) -> None:
        try:
            conn.close()
        except Exception:  # noqa: BLE001
            pass

    # ---------- 对外 ----------
    @contextmanager
    def acquire(self) -> Iterator[Any]:
        if not self._sem.acquire(timeout=max(3, config.DB_CONNECT_TIMEOUT + 3)):
            raise DBUnavailable("连接池已耗尽，等待超时")
        conn = None
        try:
            try:
                candidate = self._idle.get_nowait()
                conn = candidate if self._alive(candidate) else None
                if conn is None:
                    self._close(candidate)
            except queue.Empty:
                conn = None
            if conn is None:
                conn = self._open()
            yield conn
        except DBUnavailable:
            raise
        except Exception:
            # 任何异常都可能是连接层面的，保守起见丢弃当前连接
            if conn is not None:
                self._close(conn)
                with self._lock:
                    self._created = max(0, self._created - 1)
                conn = None
            raise
        finally:
            if conn is not None:
                self._idle.put(conn)
            self._sem.release()

    @property
    def created(self) -> int:
        with self._lock:
            return self._created


# ============================================================
# 模块级状态
# ============================================================
_pool: ConnectionPool | None = None
_pool_lock = threading.Lock()
_ready = False
_last_error: str | None = None
_tables: list[str] = []

# ── SQLite 兜底引擎（DB_ENABLED=sqlite 时启用） ──
# 单连接 + 互斥锁：本地演示场景并发极低，串行化最简单可靠；
# WAL 模式让「写历史 / 读历史」互不阻塞，busy_timeout 兜住偶发争用。
_sqlite_conn: sqlite3.Connection | None = None
_sqlite_lock = threading.RLock()


def _engine() -> str:
    return config.DB_ENGINE


def engine() -> str:
    """当前数据库引擎：'mysql' 或 'sqlite'（repo 层据此选 upsert 方言）。"""
    return config.DB_ENGINE


def _to_sqlite(sql: str) -> str:
    """MySQL 方言 → SQLite：占位符与取当前时间。其余 SQL 两边语法兼容。"""
    return sql.replace("%s", "?").replace("NOW()", "datetime('now','localtime')")


def _sqlite_open() -> sqlite3.Connection:
    path = config.DB_SQLITE_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def _sqlite_ensure() -> sqlite3.Connection:
    """懒加载：首次访问时建连 + 建表（schema 全部 IF NOT EXISTS，可重复执行）。"""
    global _sqlite_conn, _ready, _last_error, _tables
    if _sqlite_conn is None:
        if not SCHEMA_SQLITE_FILE.exists():
            raise DBUnavailable(f"未找到 SQLite 建表脚本：{SCHEMA_SQLITE_FILE}")
        path = config.DB_SQLITE_PATH
        conn = _sqlite_open()
        conn.executescript(SCHEMA_SQLITE_FILE.read_text(encoding="utf-8"))
        rows = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        ).fetchall()
        _tables = [str(r["name"]) for r in rows]
        _sqlite_conn = conn
        _ready = True
        _last_error = None
        log.info("SQLite 就绪：%s · 数据表 %s", path, "/".join(_tables))
    return _sqlite_conn


def _read_schema_statements() -> list[str]:
    """把 schema.sql 拆成可逐条执行的语句（去掉 `--` 注释与空行）。"""
    if not SCHEMA_FILE.exists():
        raise DBUnavailable(f"未找到建表脚本：{SCHEMA_FILE}")
    lines = []
    for raw in SCHEMA_FILE.read_text(encoding="utf-8").splitlines():
        stripped = raw.strip()
        if not stripped or stripped.startswith("--"):
            continue
        lines.append(raw)
    blob = "\n".join(lines)
    return [stmt.strip() for stmt in blob.split(";") if stmt.strip()]


def _ensure_database() -> None:
    """连到服务器（不指定库）创建数据库。"""
    if pymysql is None:
        raise DBUnavailable(DRIVER_ERROR or "PyMySQL 不可用")
    conn = pymysql.connect(**_connect_kwargs(with_db=False))
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"CREATE DATABASE IF NOT EXISTS `{config.DB_NAME}` "
                f"DEFAULT CHARACTER SET {config.DB_CHARSET} "
                f"COLLATE {config.DB_CHARSET}_0900_ai_ci"
            )
    finally:
        conn.close()


# ------------------------------------------------------------
# 轻量迁移：建表语句全是 IF NOT EXISTS，**改列结构时老库不会自动跟上**，
# 这里按 information_schema 逐个补列（MySQL 的 ALTER TABLE 不支持 IF NOT EXISTS）。
# 每项 = (表名, 列名, 补列 DDL)；列已存在就跳过，可重复执行。
# ------------------------------------------------------------
_MIGRATIONS: tuple[tuple[str, str, str], ...] = (
    (
        "chat_messages",
        "policy_name",
        "ALTER TABLE `chat_messages` ADD COLUMN `policy_name` VARCHAR(255) NULL "
        "DEFAULT '' COMMENT '政策名快照（对话记录页直接展示，免回查 bootstrap）' AFTER `policy_id`",
    ),
)


def _migrate(cur) -> None:
    for table, column, ddl in _MIGRATIONS:
        cur.execute(
            "SELECT COUNT(*) AS n FROM information_schema.COLUMNS "
            "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s AND COLUMN_NAME = %s",
            (table, column),
        )
        row = cur.fetchone() or {}
        if not row.get("n"):
            log.info("迁移：补列 %s.%s", table, column)
            cur.execute(ddl)


def init() -> bool:
    """初始化：建库 → 建表 → 轻量迁移 → 建连池。失败只记录，不抛给调用方（主链路要继续跑）。"""
    global _pool, _ready, _last_error, _tables

    if not config.DB_ENABLED:
        _ready = False
        _last_error = "DB_ENABLED=0，账号与历史功能已关闭"
        log.info("数据库：%s", _last_error)
        return False
    if DRIVER_ERROR and _engine() == "mysql":
        _ready = False
        _last_error = DRIVER_ERROR
        log.warning("MySQL：%s", _last_error)
        return False

    if _engine() == "sqlite":
        try:
            with _sqlite_lock:
                _sqlite_ensure()
            return True
        except Exception as exc:  # noqa: BLE001
            _ready = False
            _last_error = f"{type(exc).__name__}: {exc}"
            log.warning("SQLite 不可用：%s", _last_error)
            log.warning("账号与检索历史将不可用；检索主链路不受影响（游客模式）")
            return False

    try:
        if config.DB_AUTO_INIT:
            _ensure_database()
        with _pool_lock:
            if _pool is None:
                _pool = ConnectionPool(config.DB_POOL_SIZE, _connect_kwargs())
        if config.DB_AUTO_INIT:
            with _pool.acquire() as conn, conn.cursor() as cur:
                for stmt in _read_schema_statements():
                    cur.execute(stmt)
                _migrate(cur)
                cur.execute("SHOW TABLES")
                _tables = sorted(row[list(row.keys())[0]] for row in cur.fetchall())
        _ready = True
        _last_error = None
        log.info(
            "MySQL 就绪：%s:%s/%s · 数据表 %s · 连池 %d",
            config.DB_HOST, config.DB_PORT, config.DB_NAME,
            "/".join(_tables) or "（未检查）", config.DB_POOL_SIZE,
        )
        return True
    except Exception as exc:  # noqa: BLE001 - 连不上不应该让服务起不来
        _ready = False
        _last_error = f"{type(exc).__name__}: {exc}"
        log.warning("MySQL 不可用：%s", _last_error)
        log.warning("账号与检索历史将不可用；检索主链路不受影响（游客模式）")
        return False


def reset() -> None:
    """丢弃连池状态（配置变更或测试用）。"""
    global _pool, _ready, _tables, _sqlite_conn
    with _pool_lock:
        pool, _pool = _pool, None
    if pool is not None:
        while True:
            try:
                pool._close(pool._idle.get_nowait())
            except queue.Empty:
                break
    with _sqlite_lock:
        if _sqlite_conn is not None:
            try:
                _sqlite_conn.close()
            except Exception:  # noqa: BLE001
                pass
            _sqlite_conn = None
    _ready = False
    _tables = []


def available() -> bool:
    return _ready


def require() -> None:
    """供接口层调用：不可用直接抛 DBUnavailable，由路由转成 503。"""
    if not _ready:
        raise DBUnavailable(_last_error or "数据库未就绪")


def status() -> dict[str, Any]:
    if _engine() == "sqlite":
        return {
            "enabled": config.DB_ENABLED,
            "available": _ready,
            "engine": "sqlite",
            "driver": f"sqlite3 {sqlite3.sqlite_version}（兜底模式，免装 MySQL）",
            "database": str(config.DB_SQLITE_PATH),
            "host": "",
            "user": "",
            "poolSize": 1,
            "tables": list(_tables),
            "autoInit": True,
            "error": _last_error,
        }
    return {
        "enabled": config.DB_ENABLED,
        "available": _ready,
        "engine": "mysql",
        "driver": DRIVER,
        "host": f"{config.DB_HOST}:{config.DB_PORT}",
        "database": config.DB_NAME,
        "user": config.DB_USER,
        "poolSize": config.DB_POOL_SIZE,
        "tables": list(_tables),
        "autoInit": config.DB_AUTO_INIT,
        "error": _last_error,
    }


# ============================================================
# 查询封装
# ============================================================
def _pool_or_raise() -> ConnectionPool:
    if pymysql is None:
        raise DBUnavailable(DRIVER_ERROR or "PyMySQL 不可用")
    if _pool is None:
        raise DBUnavailable(_last_error or "数据库未就绪")
    return _pool


def _wrap_dup(exc: Exception) -> Exception:
    """把两个引擎的「唯一键冲突」统一译成 DuplicateKeyError。"""
    if _engine() == "mysql":
        if exc.args and isinstance(exc.args[0], int) and exc.args[0] == 1062:
            return DuplicateKeyError(str(exc))
        return exc
    if isinstance(exc, sqlite3.IntegrityError) and "UNIQUE constraint failed" in str(exc):
        return DuplicateKeyError(str(exc))
    return exc


def query_all(sql: str, params: Any = None) -> list[dict]:
    if _engine() == "sqlite":
        with _sqlite_lock:
            try:
                cur = _sqlite_ensure().execute(_to_sqlite(sql), tuple(params or ()))
                return [dict(r) for r in cur.fetchall()]
            except sqlite3.Error as exc:
                raise _wrap_dup(exc) from exc
    with _pool_or_raise().acquire() as conn, conn.cursor() as cur:
        try:
            cur.execute(sql, params or ())
            return list(cur.fetchall() or [])
        except Exception as exc:  # noqa: BLE001
            raise _wrap_dup(exc) from exc


def query_one(sql: str, params: Any = None) -> dict | None:
    rows = query_all(sql, params)
    return rows[0] if rows else None


def execute(sql: str, params: Any = None) -> int:
    if _engine() == "sqlite":
        with _sqlite_lock:
            try:
                cur = _sqlite_ensure().execute(_to_sqlite(sql), tuple(params or ()))
                _sqlite_conn.commit()
                return int(cur.rowcount if cur.rowcount is not None else 0)
            except sqlite3.Error as exc:
                raise _wrap_dup(exc) from exc
    with _pool_or_raise().acquire() as conn, conn.cursor() as cur:
        try:
            cur.execute(sql, params or ())
            return int(cur.rowcount if cur.rowcount is not None else 0)
        except Exception as exc:  # noqa: BLE001
            raise _wrap_dup(exc) from exc


def insert(sql: str, params: Any = None) -> int:
    if _engine() == "sqlite":
        with _sqlite_lock:
            try:
                cur = _sqlite_ensure().execute(_to_sqlite(sql), tuple(params or ()))
                _sqlite_conn.commit()
                return int(cur.lastrowid or 0)
            except sqlite3.Error as exc:
                raise _wrap_dup(exc) from exc
    with _pool_or_raise().acquire() as conn, conn.cursor() as cur:
        try:
            cur.execute(sql, params or ())
            return int(cur.lastrowid or 0)
        except Exception as exc:  # noqa: BLE001
            raise _wrap_dup(exc) from exc


@contextmanager
def transaction() -> Iterator[Any]:
    """显式事务（需要多语句原子性时使用）。"""
    if _engine() == "sqlite":
        with _sqlite_lock:
            conn = _sqlite_ensure()
            conn.execute("BEGIN")
            try:
                yield conn
            except Exception:
                conn.rollback()
                raise
            else:
                conn.commit()
            return
    with _pool_or_raise().acquire() as conn:
        conn.begin()
        try:
            yield conn
        except Exception:
            conn.rollback()
            raise
        else:
            conn.commit()


def ping() -> bool:
    """真实探活：拿一条连接执行 SELECT 1。"""
    try:
        row = query_one("SELECT 1 AS ok")
        return bool(row and int(row.get("ok") or 0) == 1)
    except Exception as exc:  # noqa: BLE001
        global _last_error
        _last_error = f"{type(exc).__name__}: {exc}"
        return False
