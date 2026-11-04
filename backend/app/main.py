"""FastAPI 应用：本地托管前端 + bootstrap 数据 + 账号体系 + 检索链路。"""
from __future__ import annotations

import logging
import re
from contextlib import asynccontextmanager
from datetime import date

from fastapi import Body, Depends, FastAPI, Header, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import accounts, bootstrap, config, db, llm, netutil, repo
from . import brief as brief_service
from . import chat as chat_service
from . import search as search_service
from .llm.base import ExtractionRequest

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s · %(message)s",
)
log = logging.getLogger("backend")


@asynccontextmanager
async def lifespan(_: FastAPI):
    try:
        data = bootstrap.load()
        log.info("bootstrap 就绪：%d 个命名空间", len(data))
        log.info("前端目录：%s", config.GUI_DIR)
    except Exception as exc:  # noqa: BLE001
        log.error("bootstrap 装载失败：%s", exc)
        log.error("前端将自动降级到 test_date.js（若可访问）")

    # MySQL：账号体系与检索记录持久化。失败不影响主链路（游客模式）。
    if db.init():
        try:
            purged = repo.purge_expired_sessions()
            if purged:
                log.info("MySQL：清理过期登录会话 %d 条", purged)
        except Exception as exc:  # noqa: BLE001
            log.warning("MySQL：清理过期会话失败：%s", exc)
    else:
        log.warning("MySQL 未就绪 —— 登录/注册与检索历史不可用，检索主链路照常")

    status = llm.provider_status()
    if config.ENV_FILE.exists():
        log.info("已加载 .env：%s", config.ENV_FILE)
    log.info("LLM 抽取层：%s · %s", status["model"], status["note"])
    yield
    search_service.service.shutdown()


app = FastAPI(
    title="AI 政策搜索智能体 · 本地后端",
    version="0.3.0",
    description=(
        "本地后端：GET /api/bootstrap 提供前端数据；"
        "POST /api/v1/searches 走「提示词 → 大模型 → 十命名空间」检索链路；"
        "MySQL 承载账号体系（注册/登录）与检索记录（登录后自动回放）。"
    ),
    lifespan=lifespan,
)

# 本地开发：允许跨端口/跨源访问（file:// 打开前端时也能请求）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_NO_STORE = {"Cache-Control": "no-store"}


# ============================================================
# 统一错误体：{"error": {"code","message"}}
# 前端 src/data.js → request() 依赖这个形状取错误文案。
# ============================================================
@app.exception_handler(StarletteHTTPException)
async def _http_error(_: object, exc: StarletteHTTPException) -> JSONResponse:
    detail = exc.detail
    if isinstance(detail, dict) and "code" in detail:
        payload = {"error": detail}
    else:
        payload = {"error": {"code": f"HTTP_{exc.status_code}", "message": str(detail)}}
    return JSONResponse(payload, status_code=exc.status_code, headers=_NO_STORE)


@app.get("/healthz", include_in_schema=False)
def healthz() -> dict[str, str]:
    # service 字段是本服务的身份标识：netutil.find_running 靠它区分
    # 「本服务在运行」与「别的程序恰好对 /healthz 回 200」
    # （实例：VMware vmnat 转发占用 8002 且转发目标对 /healthz 回 200，
    #   导致 start_server.bat 误判「已在运行」并把浏览器带到 8002）。
    return {"status": "ok", "service": netutil.SERVICE_MARK}


@app.get("/readyz", include_in_schema=False)
def readyz() -> JSONResponse:
    ok = bootstrap.is_ready()
    return JSONResponse(
        {"status": "ready" if ok else "degraded", "bootstrap": ok},
        status_code=200 if ok else 503,
    )


@app.get("/api/bootstrap", tags=["bootstrap"], summary="前端唯一入口：装配全部后端数据")
def api_bootstrap() -> JSONResponse:
    """返回与 test_date.js 的 window.TEST_DATA 同构的十个命名空间。

    前端 src/data.js → loadBackend() 直接消费该响应。
    """
    try:
        data = bootstrap.load()
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(
            {"error": {"code": "BOOTSTRAP_UNAVAILABLE", "message": str(exc)}},
            status_code=503,
            headers=_NO_STORE,
        )
    return JSONResponse(content=data, headers=_NO_STORE)


@app.get("/api/bootstrap/namespaces", include_in_schema=False)
def api_bootstrap_namespaces() -> dict[str, list[str]]:
    return {"namespaces": bootstrap.NAMESPACES}


# ============================================================
# 检索链路：「开始检索」→ 建任务 → 轮询进度 → 取结果
#   POST   /api/v1/searches                 发起（立即返回 taskId，不阻塞前端）
#   GET    /api/v1/searches/{id}            轮询进度（步骤/源进度/抓取日志/解析条件）
#   GET    /api/v1/searches/{id}/result     取包装好的十命名空间数据
#   DELETE /api/v1/searches/{id}            取消
# ============================================================


def _fail(code: str, message: str, status: int) -> JSONResponse:
    return JSONResponse(
        {"error": {"code": code, "message": message}}, status_code=status, headers=_NO_STORE
    )


# ============================================================
# 账号体系：注册 / 登录 / 登出 / 当前用户 / 企业档案
#   鉴权：Authorization: Bearer <token>（Token 由登录/注册下发）
# ============================================================
def _account_error(exc: Exception) -> JSONResponse:
    """域异常 → HTTP 响应（前端统一读 {"error":{"code","message"}}）。"""
    if isinstance(exc, accounts.ValidationError):
        return _fail("VALIDATION_ERROR", exc.message, 400)
    if isinstance(exc, repo.ConflictError):
        return _fail("CONFLICT", str(exc), 409)
    if isinstance(exc, accounts.AuthError):
        if exc.code == "BAD_CREDENTIALS":
            return _fail(exc.code, exc.message, 401)
        if exc.code in ("USER_NOT_FOUND", "NO_EMAIL_BOUND", "EMAIL_CODE_REQUIRED",
                        "EMAIL_CODE_MISMATCH", "EMAIL_CODE_COOLDOWN",
                        "CODE_EXPIRED", "CODE_MISMATCH", "CODE_COOLDOWN"):
            return _fail(exc.code, exc.message, 400)
        if exc.code == "EMAIL_SEND_FAILED":
            return _fail(exc.code, exc.message, 502)
        return _fail(exc.code, exc.message, 403)
    if isinstance(exc, db.DBUnavailable):
        return _fail("DB_UNAVAILABLE", f"数据库不可用：{exc}", 503)
    raise exc


@app.post(
    "/api/v1/auth/register",
    tags=["auth"],
    summary="注册用户（写入 MySQL，成功即自动登录）",
    status_code=201,
)
def api_register(
    payload: dict | None = Body(default=None),
    user_agent: str = Header(default=""),
) -> JSONResponse:
    try:
        result = accounts.register(payload if isinstance(payload, dict) else {},
                                   user_agent=user_agent)
    except Exception as exc:  # noqa: BLE001
        return _account_error(exc)
    log.info("新用户注册：%s（id=%s）", result["user"]["username"], result["user"]["id"])
    return JSONResponse(result, status_code=201, headers=_NO_STORE)


@app.post("/api/v1/auth/login", tags=["auth"], summary="登录（签发 Bearer Token）")
def api_login(
    payload: dict | None = Body(default=None),
    user_agent: str = Header(default=""),
) -> JSONResponse:
    try:
        result = accounts.login(payload if isinstance(payload, dict) else {},
                                user_agent=user_agent)
    except Exception as exc:  # noqa: BLE001
        return _account_error(exc)
    log.info("用户登录：%s", result["user"]["username"])
    return JSONResponse(result, headers=_NO_STORE)


@app.post(
    "/api/v1/auth/forgot",
    tags=["auth"],
    summary="忘记密码：下发验证码（原型直接返回验证码）",
)
def api_auth_forgot(payload: dict | None = Body(default=None)) -> JSONResponse:
    try:
        result = accounts.forgot_password(payload if isinstance(payload, dict) else {})
    except Exception as exc:  # noqa: BLE001
        return _account_error(exc)
    log.info("忘记密码验证码已生成：%s", result["account"])
    return JSONResponse(result, headers=_NO_STORE)


@app.post("/api/v1/auth/reset", tags=["auth"], summary="验证码重置密码（作废全部会话）")
def api_auth_reset(payload: dict | None = Body(default=None)) -> JSONResponse:
    try:
        result = accounts.reset_password(payload if isinstance(payload, dict) else {})
    except Exception as exc:  # noqa: BLE001
        return _account_error(exc)
    log.info("密码已通过验证码重置，相关会话全部作废")
    return JSONResponse(result, headers=_NO_STORE)


@app.post("/api/v1/auth/logout", tags=["auth"], summary="登出（会话立即失效）")
def api_logout(authorization: str | None = Header(default=None)) -> JSONResponse:
    token = accounts.bearer_token(authorization)
    if not db.available():
        return _fail("DB_UNAVAILABLE", "数据库不可用", 503)
    try:
        removed = accounts.logout(token)
    except Exception as exc:  # noqa: BLE001
        return _account_error(exc)
    return JSONResponse({"ok": True, "removed": removed}, headers=_NO_STORE)


@app.get("/api/v1/auth/me", tags=["auth"], summary="当前用户 + 统计 + 最近一次检索")
def api_me(user: dict = Depends(accounts.current_user)) -> JSONResponse:
    try:
        return JSONResponse(accounts.me_payload(user), headers=_NO_STORE)
    except db.DBUnavailable as exc:
        return _account_error(exc)


@app.patch("/api/v1/auth/profile", tags=["auth"], summary="更新个人与企业档案（含邮箱/手机号）")
def api_update_profile(
    payload: dict | None = Body(default=None),
    user: dict = Depends(accounts.current_user),
) -> JSONResponse:
    try:
        updated = accounts.update_profile(int(user["id"]), payload or {})
    except Exception as exc:  # noqa: BLE001
        return _account_error(exc)
    return JSONResponse({"user": updated}, headers=_NO_STORE)


@app.post("/api/v1/auth/profile/email-code",
          tags=["auth"], summary="发送更换绑定邮箱的验证码（发往新邮箱）")
def api_profile_email_code(
    payload: dict | None = Body(default=None),
    user: dict = Depends(accounts.current_user),
) -> JSONResponse:
    try:
        result = accounts.send_email_bind_code(int(user["id"]), payload or {})
    except Exception as exc:  # noqa: BLE001
        return _account_error(exc)
    return JSONResponse(result, headers=_NO_STORE)


@app.post("/api/v1/auth/password", tags=["auth"], summary="修改密码（旧密码 → 新密码）")
def api_change_password(
    payload: dict | None = Body(default=None),
    user: dict = Depends(accounts.current_user),
    authorization: str = Header(default=""),
) -> JSONResponse:
    token = authorization[7:].strip() if authorization.lower().startswith("bearer ") else ""
    try:
        result = accounts.change_password(int(user["id"]), payload or {}, token)
    except Exception as exc:  # noqa: BLE001
        return _account_error(exc)
    log.info("用户修改密码：%s（踢掉 %s 个其他会话）",
             user.get("username"), result.get("sessionsRevoked"))
    return JSONResponse(result, headers=_NO_STORE)


@app.get("/api/v1/db/status", tags=["auth"], summary="数据库接入状态（诊断用）")
def api_db_status() -> JSONResponse:
    info = db.status()
    info["ping"] = db.ping() if db.available() else False
    # 供回归闸门识别验证码通道（echo 可回显全链路断言；email 只做冒烟）
    info["codeChannel"] = config.CODE_CHANNEL
    return JSONResponse(info, headers=_NO_STORE)


# ============================================================
# 检索记录：登录用户的「填一次就够了」——条件与结果都存 MySQL
#   GET    /api/v1/history                  列表（轻量，不含结果体）
#   GET    /api/v1/history/{id}             单条 + 结果回放（bootstrap）
#   DELETE /api/v1/history/{id}             删除单条
#   DELETE /api/v1/history                  清空
# ============================================================
@app.get("/api/v1/history", tags=["history"], summary="我的检索记录（列表）")
def api_history_list(
    user: dict = Depends(accounts.current_user),
    limit: int = 20,
    offset: int = 0,
    keyword: str = "",
) -> JSONResponse:
    try:
        data = repo.list_search_records(
            int(user["id"]), limit=limit, offset=offset, keyword=keyword.strip()
        )
    except Exception as exc:  # noqa: BLE001
        return _account_error(exc)
    return JSONResponse(data, headers=_NO_STORE)


@app.get("/api/v1/history/{record_id}", tags=["history"], summary="取历史记录并回放结果")
def api_history_detail(record_id: int, user: dict = Depends(accounts.current_user)) -> JSONResponse:
    try:
        record = repo.get_search_record(int(user["id"]), record_id)
    except Exception as exc:  # noqa: BLE001
        return _account_error(exc)
    if record is None:
        return _fail("RECORD_NOT_FOUND", f"检索记录不存在或不属于当前账号：{record_id}", 404)
    return JSONResponse({"record": record, "bootstrap": record.get("bootstrap")}, headers=_NO_STORE)


@app.delete("/api/v1/history/{record_id}", tags=["history"], summary="删除单条检索记录")
def api_history_delete(record_id: int, user: dict = Depends(accounts.current_user)) -> JSONResponse:
    try:
        removed = repo.delete_search_record(int(user["id"]), record_id)
    except Exception as exc:  # noqa: BLE001
        return _account_error(exc)
    if not removed:
        return _fail("RECORD_NOT_FOUND", f"检索记录不存在或不属于当前账号：{record_id}", 404)
    return JSONResponse({"ok": True, "id": record_id}, headers=_NO_STORE)


@app.delete("/api/v1/history", tags=["history"], summary="清空我的检索记录")
def api_history_clear(user: dict = Depends(accounts.current_user)) -> JSONResponse:
    try:
        removed = repo.clear_search_records(int(user["id"]))
    except Exception as exc:  # noqa: BLE001
        return _account_error(exc)
    return JSONResponse({"ok": True, "removed": removed}, headers=_NO_STORE)


@app.post(
    "/api/v1/searches",
    tags=["search"],
    summary="发起检索（异步任务，立即返回 taskId；登录用户结果自动落库）",
    status_code=202,
)
def api_start_search(
    payload: dict | None = Body(default=None),
    user: dict | None = Depends(accounts.optional_user),
) -> JSONResponse:
    """把用户条件交给检索服务：服务端组装提示词 → 调大模型 → 包装成十命名空间。

    带登录凭证时，任务完成后会把条件与结果写入 `search_records`，
    该用户下次登录可直接回放，无需重新检索。游客模式（无凭证）一切照旧，只是不落库。
    """
    user_id = int(user["id"]) if isinstance(user, dict) else None
    task = search_service.service.start(
        search_service.SearchRequest.from_payload(payload), user_id=user_id
    )
    log.info(
        "检索任务已创建：%s · 条件「%s」· %s",
        task.id, task.request.query[:40], "登录用户" if user_id else "游客",
    )
    return JSONResponse(task.status_payload(), status_code=202, headers=_NO_STORE)


@app.get("/api/v1/searches", include_in_schema=False)
def api_search_stats() -> dict:
    return search_service.service.stats()


@app.get("/api/v1/searches/{task_id}", tags=["search"], summary="查询检索进度（前端轮询）")
def api_search_status(task_id: str) -> JSONResponse:
    task = search_service.service.get(task_id)
    if task is None:
        return _fail("TASK_NOT_FOUND", f"检索任务不存在或已过期：{task_id}", 404)
    return JSONResponse(task.status_payload(), headers=_NO_STORE)


@app.get(
    "/api/v1/searches/{task_id}/result",
    tags=["search"],
    summary="取检索结果（与 test_date.js 同构的十命名空间）",
)
def api_search_result(task_id: str) -> JSONResponse:
    task = search_service.service.get(task_id)
    if task is None:
        return _fail("TASK_NOT_FOUND", f"检索任务不存在或已过期：{task_id}", 404)
    if task.status == "running":
        return _fail("TASK_RUNNING", "任务仍在进行中，请继续轮询进度", 409)
    if task.status == "canceled":
        return _fail("TASK_CANCELED", "任务已取消，无结果", 409)
    if task.status == "failed":
        return _fail("TASK_FAILED", task.error or "任务执行失败", 500)
    return JSONResponse(task.result_payload(), headers=_NO_STORE)


@app.delete("/api/v1/searches/{task_id}", tags=["search"], summary="取消检索")
def api_cancel_search(task_id: str) -> JSONResponse:
    task = search_service.service.get(task_id)
    if task is None:
        return _fail("TASK_NOT_FOUND", f"检索任务不存在或已过期：{task_id}", 404)
    canceled = task.cancel()
    return JSONResponse(
        {"taskId": task_id, "canceled": canceled, "status": task.status},
        headers=_NO_STORE,
    )


@app.get("/api/v1/llm/status", tags=["search"], summary="当前大模型接入状态（免费/本地）")
def api_llm_status() -> dict:
    return llm.provider_status()


@app.get(
    "/api/v1/prompts/preview",
    tags=["search"],
    summary="查看服务端整合出的提示词（含行政区划上下文）",
)
def api_prompt_preview(
    query: str = "",
    regions: str = "",
    industries: str = "",
    types: str = "",
    deadline: str = "",
) -> JSONResponse:
    req = ExtractionRequest(
        query=query,
        regions=[p for p in re.split(r"[,，;；\s]+", regions) if p],
        industries=industries,
        types=types,
        deadline=deadline,
        today=date.today().isoformat(),
        max_items=config.SEARCH_MAX_ITEMS,
    )
    return JSONResponse(llm.render_preview(req), headers=_NO_STORE)


# ============================================================
# 政策简报：把结果列表里选中的政策导出成**真实文件**
#   POST /api/v1/briefs                     生成（XLSX / DOCX / PDF，返回下载地址）
#   GET  /api/v1/briefs/{id}/download       下载刚生成的文件
#   POST /api/v1/briefs/{id}/reveal         在系统文件管理器里定位该文件
#   GET  /api/v1/briefs/status              能力探测（PDF 是否可用 / 输出目录）
#
# 清单由结构化数据直接拼装（不经模型改写，不会漏条目）；
# 综述走大模型（与检索同一套 provider），超时/失败自动降级为规则文案。
# ============================================================
@app.get("/api/v1/briefs/status", tags=["brief"], summary="简报能力探测（PDF 可用性 / 输出目录）")
def api_brief_status() -> JSONResponse:
    return JSONResponse(
        {
            "ok": True,
            "pdf": brief_service.pdf_available(),
            "formats": sorted(brief_service._FORMATS),
            "templates": list(brief_service._TEMPLATES),
            "scopes": list(brief_service._SCOPES),
            "outputDir": str(config.BRIEF_DIR),
            "summaryTimeout": config.BRIEF_SUMMARY_TIMEOUT,
        },
        headers=_NO_STORE,
    )


@app.post("/api/v1/briefs", tags=["brief"], summary="生成政策简报（XLSX / DOCX / PDF）")
def api_brief_create(payload: dict | None = Body(default=None)) -> JSONResponse:
    """请求体：`{format, template, scope, scopeLabel, conditions[], policies[]}`。

    同步生成（前端按钮转圈等待）：清单是本地拼装、近乎瞬时，只有综述要等模型，
    上限 `BRIEF_SUMMARY_TIMEOUT`（默认 60s），超时即用规则文案，绝不会把用户挂住。
    """
    try:
        result = brief_service.create_brief(payload if isinstance(payload, dict) else {})
    except brief_service.BriefError as exc:
        return _fail(exc.code, str(exc), 400)
    except Exception as exc:  # noqa: BLE001
        log.exception("简报生成失败")
        return _fail("BRIEF_FAILED", f"简报生成失败：{exc}", 500)
    log.info(
        "简报已生成：%s · %s · %s · %d 条 · %d KB · 综述来源=%s（%dms）",
        result["briefId"], result["format"], result["template"], result["count"],
        max(1, result["bytes"] // 1024), result["summarySource"], result["elapsedMs"],
    )
    return JSONResponse(result, headers=_NO_STORE)


@app.get("/api/v1/briefs/{brief_id}/download", tags=["brief"], summary="下载简报文件")
def api_brief_download(brief_id: str) -> Response:
    path = brief_service.brief_path(brief_id)
    if path is None:
        return _fail("BRIEF_MISSING", "该简报文件已不存在（可能已被清理），请重新生成", 404)
    ext = path.suffix.lstrip(".").lower()
    media = brief_service._FORMATS.get(ext, ("", "application/octet-stream"))[1]
    return FileResponse(
        path,
        media_type=media,
        filename=brief_service.friendly_of(path),
        headers=_NO_STORE,
    )


@app.post("/api/v1/briefs/{brief_id}/reveal", tags=["brief"], summary="在文件管理器中定位简报")
def api_brief_reveal(brief_id: str) -> JSONResponse:
    try:
        info = brief_service.reveal(brief_id)
    except brief_service.BriefError as exc:
        return _fail(exc.code, str(exc), 404)
    except Exception as exc:  # noqa: BLE001
        return _fail("REVEAL_FAILED", f"打开所在文件夹失败：{exc}", 500)
    # located=false 表示下载文件夹里没找到同名文件、只打开了文件夹本身
    return JSONResponse({"ok": True, **info}, headers=_NO_STORE)


# ============================================================
# 政策详情 · AI 对话（「问政策」）
# ------------------------------------------------------------
# 用户坐在某一条政策的详情页上，直接问「我这种情况能不能申 / 要交什么材料 /
# 怎么走流程」。答案的事实底座就是**这条政策**（见 app/chat.py）。
#
#   · 登录用户：一问一答都写 MySQL chat_messages，下次打开这条政策接着聊
#   · 游客：照样能问（response.saved=false），但后端不落库 ——
#     前端会明确提示「登录后可保存对话」，绝不假装存过
#   · 模型不可用 / 超时 / 输出过短：改用规则回答，并如实带 degraded=true 与原因
# ============================================================
@app.get("/api/v1/chat/status", tags=["chat"], summary="政策对话能力探测")
def api_chat_status() -> JSONResponse:
    return JSONResponse(
        {"ok": True, **chat_service.public_status()}, headers=_NO_STORE
    )


@app.get("/api/v1/chat/messages", tags=["chat"], summary="历史对话（带 policyId=某条政策 · 不带=按政策聚合的会话列表）")
def api_chat_history(
    user: dict | None = Depends(accounts.optional_user),
    policyId: str = "",
    limit: int = 200,
) -> JSONResponse:
    """两种用法：
    · `?policyId=xxx` → 该条政策下的完整一问一答（详情页对话面板用）
    · 不带 policyId   → 按政策聚合的会话列表（检索记录屏「对话记录」页用），
      每条含政策名快照 / 问答条数 / 最后一句预览，点卡片跳回那条政策的详情页。
    """
    uid = int(user["id"]) if user else None
    if not str(policyId or "").strip():
        return JSONResponse(
            {
                "ok": True,
                "signedIn": uid is not None,
                "threads": chat_service.threads_of(uid, limit=50),
            },
            headers=_NO_STORE,
        )
    return JSONResponse(
        {
            "ok": True,
            "signedIn": uid is not None,
            "policyId": str(policyId or ""),
            "messages": chat_service.history_of(uid, policyId, limit=max(1, min(limit, 500))),
        },
        headers=_NO_STORE,
    )


@app.post("/api/v1/chat/messages", tags=["chat"], summary="向当前政策提问（登录后自动落库）")
def api_chat_send(
    payload: dict | None = Body(default=None),
    user: dict | None = Depends(accounts.optional_user),
) -> JSONResponse:
    """请求体：`{policyId, question, policy?}`。

    `policy` 是可选的紧凑上下文（与屏上看到的一致）；没带时服务端按 policyId
    从 bootstrap 找一次。响应里的 `saved` 说明这一次到底有没有写进 MySQL。
    """
    body = payload if isinstance(payload, dict) else {}
    policy_id = str(body.get("policyId") or "")
    question = str(body.get("question") or "")
    policy = chat_service.resolve_policy(policy_id, body.get("policy"))

    if not policy:
        return _fail(
            "POLICY_NOT_FOUND",
            "没有拿到政策上下文：请先打开一条政策的详情页再提问",
            400,
        )

    uid = int(user["id"]) if user else None
    try:
        result = chat_service.respond(uid, policy, policy_id, question)
    except chat_service.ChatDisabled as exc:
        return _fail("CHAT_DISABLED", str(exc), 503)
    except chat_service.ChatBadRequest as exc:
        return _fail("CHAT_BAD_REQUEST", str(exc), 400)
    except Exception as exc:  # noqa: BLE001
        log.exception("政策对话失败")
        return _fail("CHAT_FAILED", f"对话失败：{exc}", 500)

    log.info(
        "政策对话：用户=%s 政策=%s 来源=%s%s 耗时=%dms %s",
        uid or "游客", policy_id or "-", result["source"],
        "（已落库）" if result["saved"] else "（未落库）",
        result["elapsedMs"], result["reason"],
    )
    return JSONResponse({"ok": True, "signedIn": uid is not None, **result}, headers=_NO_STORE)


@app.delete("/api/v1/chat/messages", tags=["chat"], summary="清空某条政策的对话")
def api_chat_clear(
    user: dict = Depends(accounts.current_user),
    policyId: str | None = None,
) -> JSONResponse:
    try:
        removed = chat_service.clear(int(user["id"]), policyId)
    except chat_service.ChatDisabled as exc:
        return _fail("CHAT_DISABLED", str(exc), 503)
    except Exception as exc:  # noqa: BLE001
        return _account_error(exc)
    return JSONResponse(
        {"ok": True, "removed": removed, "policyId": policyId or ""}, headers=_NO_STORE
    )


# 内联 favicon：避免浏览器默认请求 /favicon.ico 打出 404 噪声
_FAVICON = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
    '<rect width="64" height="64" rx="14" fill="#1f6feb"/>'
    '<circle cx="27" cy="29" r="12" fill="none" stroke="#fff" stroke-width="5"/>'
    '<path d="M36 38l12 12" stroke="#fff" stroke-width="6" stroke-linecap="round"/>'
    '</svg>'
)


@app.get("/favicon.ico", include_in_schema=False)
def favicon() -> Response:
    return Response(
        content=_FAVICON,
        media_type="image/svg+xml",
        headers={"Cache-Control": "public, max-age=86400"},
    )


@app.get("/", include_in_schema=False)
def index() -> Response:
    page = config.GUI_DIR / "dev.html"
    if not page.exists():
        return JSONResponse(
            {"error": {"code": "GUI_NOT_FOUND", "message": f"未找到前端页面：{page}"}},
            status_code=500,
        )
    return FileResponse(page)


# ⚠️ 静态挂载必须放在所有 API 路由之后："/" 会兜底匹配全部路径
app.mount("/", StaticFiles(directory=str(config.GUI_DIR)), name="gui")
