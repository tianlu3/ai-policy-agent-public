"""路径与运行配置（全部可用环境变量覆盖）。"""
from __future__ import annotations

import os
from pathlib import Path

# ── 目录定位 ─────────────────────────────────────────────
BASE_DIR = Path(__file__).resolve().parent.parent          # deliverables/backend
DELIVERABLES_DIR = BASE_DIR.parent                         # deliverables


def _env_path(key: str, default: Path) -> Path:
    raw = os.getenv(key)
    return (Path(raw).expanduser() if raw else default).resolve()


# 前端原型目录（含 dev.html / src/ / data/ / test_date.js）
GUI_DIR = _env_path("GUI_DIR", DELIVERABLES_DIR / "gui-prototype")
# 假数据源（后端数据来源）
TEST_DATA_JS = _env_path("TEST_DATA_JS", GUI_DIR / "test_date.js")
# 后端使用的 bootstrap 数据文件（由 test_date.js 转换而来）
BOOTSTRAP_JSON = _env_path("BOOTSTRAP_JSON", BASE_DIR / "app" / "data" / "bootstrap.json")

# ── .env 加载（零依赖，仅补空缺，不覆盖已有环境变量） ──
ENV_FILE = BASE_DIR / ".env"


def _load_dotenv(path: Path = ENV_FILE) -> int:
    """读取 KEY=VALUE 形式的 .env。已存在的环境变量优先，不会被覆盖。"""
    if not path.exists():
        return 0
    loaded = 0
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value
            loaded += 1
    return loaded


ENV_LOADED = _load_dotenv()


# ── 运行参数 ─────────────────────────────────────────────
HOST = os.getenv("HOST", "127.0.0.1")
PORT = int(os.getenv("PORT", "8000"))
# 启动时若 test_date.js 比 bootstrap.json 新且本机有 node，则自动重新转换
AUTO_REFRESH = os.getenv("BOOTSTRAP_AUTO_REFRESH", "1").strip().lower() not in ("0", "false", "no")


# ── LLM 抽取层 ───────────────────────────────────────────
# auto = 配了 Key 走远端，否则走本地免费规则引擎；也可强制 mock / openai / ollama …
LLM_PROVIDER = os.getenv("LLM_PROVIDER", "auto").strip()
LLM_API_KEY = os.getenv("LLM_API_KEY", "").strip()
# 默认指向智谱 GLM-4-Flash（免费额度、国内可直连、OpenAI 兼容）
LLM_BASE_URL = os.getenv("LLM_BASE_URL", "https://open.bigmodel.cn/api/paas/v4").strip()
LLM_MODEL = os.getenv("LLM_MODEL", "glm-4-flash").strip()
# 单次模型调用超时（秒）。默认 300 —— 免费档实测约 20 tokens/s，
# 一次完整抽取（~2300 tokens 输出）就要 ~120s，90s 会被硬掐断并误判为「网络不可达」。
LLM_TIMEOUT = float(os.getenv("LLM_TIMEOUT", "300"))
# 单次生成上限。约 230 tokens/条；放大到 8192 给「多产出几条」留足余量，
# 即便真实模型自身封顶更低，search.py 也会在解析失败时回退本地规则引擎（产出 30~70 条），不会变少。
LLM_MAX_TOKENS = int(os.getenv("LLM_MAX_TOKENS", "8192"))
# 代理策略：auto=直连优先、失败再走系统代理；0=强制直连；1=强制走系统代理。
# 默认 auto —— 本地应用直连公网 API，避免被本机失效/陈旧的 http_proxy 卡死。
LLM_USE_PROXY = os.getenv("LLM_USE_PROXY", "auto").strip().lower()
# 瞬时故障重试：免费档高峰期 429 / 5xx 常见，一次失败就降级太可惜。
# 默认只重试 1 次 —— 每次尝试本身就是一次完整生成（~180s），次数多了总时长压不住。
LLM_MAX_RETRIES = int(os.getenv("LLM_MAX_RETRIES", "1"))
LLM_RETRY_BACKOFF = float(os.getenv("LLM_RETRY_BACKOFF", "2.0"))  # 秒，指数退避

# ── LLM 随用途分模型（2026-10-14 用户选择「三用途分别配模型」）────────────
# 四个用途各自都可单独指定 模型 / 端点 / Key / 思考开关 / 超时 / 输出上限，
# **缺省一律继承上面那套全局值** —— 不配就是单一模型，行为与改造前完全一致。
#   query   查询理解（先解析、再检索）：输出只有几十 token，跑在 20s 硬等待窗里 → 最需要「快」
#   extract 结构化抽取（把候选政策吐成 JSON）：长输出，受 token 上限约束
#   chat    政策对话（详情页右栏问答）：要稳、要中文口语
#   brief   简报综述（导出时写 180–300 字）：短输出但要求文采
LLM_PURPOSES = ("query", "extract", "chat", "brief")

# 思考开关（thinking 参数）：GLM-4.5/4.7 这类**思考型模型**默认会把输出预算烧在
# reasoning_content 上 —— 实测 glm-4.5-flash 17~24s 仍交回空正文（finish_reason=length），
# 查询理解会直接超时、简报会退化成规则文案。默认 off（显式下发 thinking={"type":"disabled"}）；
# 想在某个用途上换文采就把它设成 on（见 LLM_THINKING_BRIEF）。
LLM_THINKING = os.getenv("LLM_THINKING", "off").strip().lower()


def _purpose_value(name: str, purpose: str, cast=str, fallback=None):
    """读 `<NAME>_<PURPOSE>` 覆盖值；空串/非法值一律回落到全局值。

    例：`LLM_MODEL_CHAT=glm-4.5-flash`、`LLM_API_KEY_BRIEF=xxx`、`LLM_THINKING_BRIEF=on`。
    """
    raw = os.getenv(f"{name}_{purpose.upper()}", "").strip()
    if not raw:
        return fallback
    try:
        return cast(raw)
    except (TypeError, ValueError):
        return fallback


def llm_settings(purpose: str = "extract") -> dict:
    """按用途解析出一份完整的模型调用设置（未单独配置的键继承全局值）。"""
    p = (purpose or "extract").strip().lower()
    if p not in LLM_PURPOSES:
        p = "extract"
    return {
        "purpose": p,
        "base_url": _purpose_value("LLM_BASE_URL", p, str, LLM_BASE_URL),
        "api_key": _purpose_value("LLM_API_KEY", p, str, LLM_API_KEY),
        "model": _purpose_value("LLM_MODEL", p, str, LLM_MODEL),
        "thinking": _purpose_value("LLM_THINKING", p, str, LLM_THINKING),
        "timeout": _purpose_value("LLM_TIMEOUT", p, float, LLM_TIMEOUT),
        "max_tokens": _purpose_value("LLM_MAX_TOKENS", p, int, LLM_MAX_TOKENS),
        "use_proxy": _purpose_value("LLM_USE_PROXY", p, str, LLM_USE_PROXY),
        "max_retries": _purpose_value("LLM_MAX_RETRIES", p, int, LLM_MAX_RETRIES),
        "retry_backoff": _purpose_value("LLM_RETRY_BACKOFF", p, float, LLM_RETRY_BACKOFF),
    }

# ── 检索服务 ─────────────────────────────────────────────
SEARCH_WORKERS = int(os.getenv("SEARCH_WORKERS", "4"))       # 并发检索任务数
# 单次产出政策条数（提示词层 + 层级分摊的唯一来源；prompts.py 据此把总量摊到国家/省/市/区县/园区）。
# 默认 15：约 15×230≈3450 tokens，落在免费模型 ~4096 输出上限内，真实模型能直接给、不必回退；
# 真回退时本地规则引擎会产出 30~70 条，同样满足「显示全部符合条件」而非固定 10 条。
SEARCH_MAX_ITEMS = int(os.getenv("SEARCH_MAX_ITEMS", "15"))  # 单次产出政策条数
# 结果集硬上限（**本地规则引擎**用）：本地引擎按「地域全层级 × 主题」铺开，
# 2 个省约 340 条，全部 34 个省会到数千条 —— 这里封顶，避免一次检索把页面与
# 历史记录的 result_json 撑爆。装填顺序为国家→省→市→区县，越界时区县先被截。
# 注意：它不约束远端模型的产出（那条链路由 SEARCH_MAX_ITEMS 控制 tokens 预算）。
SEARCH_RESULT_MAX = int(os.getenv("SEARCH_RESULT_MAX", "400"))
# 清单补全开关（默认开）：远端模型受**输出 token 上限**约束，给不出「全层级铺满」的清单
# （实测 2 个省 + 不限只出 14 条）。打开后由本地规则引擎把结果补齐到
# 「地域全层级 × 主题」的规模，模型抽取到的条目原样保留在前；两处合并按
# 「政策名 + 发文机关」去重，总量仍由 SEARCH_RESULT_MAX 封顶。
# 置 0 → 恢复「引擎给多少就是多少」。
SEARCH_CATALOG_EXPAND = os.getenv("SEARCH_CATALOG_EXPAND", "1").strip().lower() not in ("0", "false", "no")
SEARCH_KEEP_TASKS = int(os.getenv("SEARCH_KEEP_TASKS", "50"))  # 内存中保留的任务数

# ── 查询理解（先解析、再检索） ───────────────────────────
# 打开后，远端模型可用时会**先**读一遍用户问句，把行业 / 类型 / 时间读出来，
# 再拿这些条件去检索（`app/query_parse.py` + `search.py → _understand()`）。
# 本地词表解析不受这个开关影响 —— 它永远是兜底，保证了离线与 POST 首帧响应的确定性。
QUERY_PARSE_ENABLED = os.getenv("QUERY_PARSE_ENABLED", "1").strip().lower() not in ("0", "false", "no")
# 查询理解单次等待上限（秒）。它是「检索开始前」的一步，用户正盯着进度条；
# 模型卡住就沿用语词表结果，绝不为了它把整条流水线拖住。
# 注意这只是等待窗：超时后线程被放弃，不会中断底层请求。
QUERY_PARSE_TIMEOUT = float(os.getenv("QUERY_PARSE_TIMEOUT", "20"))
# 查询理解是超短输出（一个几十 token 的 JSON），单独给它一个输出上限，
# 免得沿用抽取的 max_tokens 让免费档白白等待。
QUERY_PARSE_MAX_TOKENS = int(os.getenv("QUERY_PARSE_MAX_TOKENS", "400"))

# ── 政策简报（导出 XLSX / DOCX / PDF） ───────────────────
# 生成的文件落在这里；`<briefId>__<友好文件名>` 的命名规则让它重启后仍可下载
# （不依赖内存索引）。只保留最近 BRIEF_KEEP 份，避免无限增长。
BRIEF_DIR = _env_path("BRIEF_DIR", BASE_DIR / "_briefs")
BRIEF_KEEP = int(os.getenv("BRIEF_KEEP", "40"))
# AI 综述的单次等待上限（秒）。与检索的 LLM_TIMEOUT 是两回事：
# 综述是**点了按钮当场等**的交互，输出短（几百字），60s 足够；
# 超时/失败一律降级为规则文案，保证「一定能导出」。
BRIEF_SUMMARY_TIMEOUT = float(os.getenv("BRIEF_SUMMARY_TIMEOUT", "60"))
BRIEF_SUMMARY_MAX_TOKENS = int(os.getenv("BRIEF_SUMMARY_MAX_TOKENS", "800"))

# ── 政策详情 · AI 对话（问政策） ──────────────────────────
# 详情页右栏的问答：把**当前这条政策**的结构化字段作为上下文，连同最近几轮对话
# 一起交给模型，让它回答「我能不能申 / 要交什么材料 / 怎么走流程」。
# 关掉后接口返回 503，前端给明确提示（不假装能问）。
CHAT_ENABLED = os.getenv("CHAT_ENABLED", "1").strip().lower() not in ("0", "false", "no")
# 单次等待上限（秒）。与简报综述同理：这是用户**敲完字当场等**的交互，
# 输出短（几百字），60s 足够；超时/失败一律降级为规则回答（见 app/chat.py）。
CHAT_TIMEOUT = float(os.getenv("CHAT_TIMEOUT", "60"))
CHAT_MAX_TOKENS = int(os.getenv("CHAT_MAX_TOKENS", "700"))
# 带进提示词的最近对话轮数（一轮 = 一问一答）。太多既拖长首字延迟、也挤占上下文。
CHAT_CONTEXT_TURNS = int(os.getenv("CHAT_CONTEXT_TURNS", "6"))
# 单条政策下每个用户保留的对话条数上限，超出按时间裁剪最旧的（防止无限增长）。
CHAT_KEEP_PER_POLICY = int(os.getenv("CHAT_KEEP_PER_POLICY", "200"))
# 单条提问的字符上限：超长输入直接拒绝，不打到模型上浪费额度。
CHAT_MAX_QUESTION_CHARS = int(os.getenv("CHAT_MAX_QUESTION_CHARS", "500"))

# 前端最短停留时长（毫秒）：模型太快时也保证检索动画可感知
SEARCH_MIN_DURATION_MS = int(os.getenv("SEARCH_MIN_DURATION_MS", "2600"))


# ── MySQL（账号体系 + 检索记录持久化） ────────────────────
# 关掉后账号/历史接口返回 503，检索主链路照常（游客模式）。
# DB_ENABLED 还接受 "sqlite"：账号/历史改用零依赖的 SQLite 文件库（评审/演示
# 场景免装 MySQL），此时 DB_HOST 等连接参数被忽略。
_raw_db_enabled = os.getenv("DB_ENABLED", "1").strip().lower()
DB_ENABLED = _raw_db_enabled not in ("0", "false", "no")
DB_ENGINE = "sqlite" if _raw_db_enabled in ("sqlite", "sqlite3") else "mysql"
# SQLite 模式的库文件位置（默认 backend/ai_policy.sqlite3；exe 打包时指向 exe 旁）
DB_SQLITE_PATH = _env_path("DB_SQLITE_PATH", BASE_DIR / "ai_policy.sqlite3")
DB_HOST = os.getenv("DB_HOST", "127.0.0.1").strip()
DB_PORT = int(os.getenv("DB_PORT", "3306"))
DB_USER = os.getenv("DB_USER", "root").strip()
DB_PASSWORD = os.getenv("DB_PASSWORD", "")
DB_NAME = os.getenv("DB_NAME", "ai_policy").strip()
DB_CHARSET = os.getenv("DB_CHARSET", "utf8mb4").strip()
DB_POOL_SIZE = int(os.getenv("DB_POOL_SIZE", "5"))
DB_CONNECT_TIMEOUT = int(os.getenv("DB_CONNECT_TIMEOUT", "5"))
# 启动时自动建库 + 建表（CREATE ... IF NOT EXISTS，可重复执行）
DB_AUTO_INIT = os.getenv("DB_AUTO_INIT", "1").strip().lower() not in ("0", "false", "no")

# 登录会话有效期（天）。Token 为随机串，库里只存 SHA-256 摘要。
# 与前端 AUTH.ttlDays（localStorage 里的凭证保留期）对齐：登录一次即记住，
# 超过该天数自动失效、需要重新登录。
AUTH_TOKEN_TTL_DAYS = int(os.getenv("AUTH_TOKEN_TTL_DAYS", "7"))
# 单用户历史记录保留条数上限（0 = 不限）
HISTORY_KEEP_PER_USER = int(os.getenv("HISTORY_KEEP_PER_USER", "200"))


# ── 忘记密码 · 验证码发送通道 ────────────────────────────
# echo  = 原型模式：验证码随接口响应直接回显（回归闸门用，不外发）
# email = 真发模式：SMTP 发送到账号绑定邮箱，响应只回脱敏地址
# 环境变量优先于 .env（回归时用 CODE_CHANNEL=echo 启动即可强制回显）
CODE_CHANNEL = os.getenv("CODE_CHANNEL", "email").strip().lower()
SMTP_HOST = os.getenv("SMTP_HOST", "smtp.qq.com").strip()
SMTP_PORT = int(os.getenv("SMTP_PORT", "465"))
SMTP_USER = os.getenv("SMTP_USER", "").strip()
SMTP_PASS = os.getenv("SMTP_PASS", "").strip()
SMTP_TIMEOUT = float(os.getenv("SMTP_TIMEOUT", "12"))
