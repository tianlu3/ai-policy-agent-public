"""OpenAI 兼容 Provider。

一个实现覆盖所有兼容 `/chat/completions` 的免费/低价端点：

    · 智谱 GLM             https://open.bigmodel.cn/api/paas/v4   （免费额度，国内直连）
                          glm-4-flash / glm-4-flash-250414 / glm-4.5-flash（思考型，配 LLM_THINKING=off）
    · 硅基流动 SiliconFlow    https://api.siliconflow.cn/v1          （含免费模型）
    · OpenRouter             https://openrouter.ai/api/v1           （:free 模型）
    · 本地 Ollama            http://127.0.0.1:11434/v1              （零成本、完全离线）

仅依赖标准库 urllib，不引入额外依赖。

代理策略（LLM_USE_PROXY）：
    auto（默认）—— 直连优先；仅当直连出现**连通性**错误时才回退系统代理。
    0          —— 强制直连（忽略 http_proxy / https_proxy）。
    1          —— 强制走系统代理（企业内网场景）。
    ★ 为什么默认直连优先：本机环境里 http_proxy 常常指向一个已失效的本地端口，
      无条件复用会让所有外呼「读超时」，而实际上直连是通的。
"""
from __future__ import annotations

import json
import os
import re
import socket
import time
import urllib.error
import urllib.parse
import urllib.request

from .. import config
from .base import ExtractionRequest, ExtractionResult, LLMError
from .prompts import build_query_messages

_FENCE_RE = re.compile(r"^```[a-zA-Z0-9_-]*\s*|\s*```$", re.MULTILINE)

_PROXY_ENV_KEYS = ("https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY", "all_proxy", "ALL_PROXY")

# 瞬时故障状态码：限流与服务端故障值得退避重试；401/403/404 属语义错误，重试无用
_RETRIABLE_STATUS = {408, 409, 425, 429}


def _extract_json(text: str) -> dict:
    """从模型返回里稳健地取出 JSON 对象。

    容忍三种常见情况：纯 JSON、带 ```json 围栏、前后夹带解释性文字。
    若模型直接返回数组，则包装成 {"policies": [...]}。
    """
    if not text or not text.strip():
        raise LLMError("模型返回为空")

    raw = text.strip()
    cleaned = _FENCE_RE.sub("", raw).strip()

    for candidate in (cleaned, raw):
        try:
            obj = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict):
            return obj
        if isinstance(obj, list):
            return {"parsed": [], "policies": obj}

    start, end = cleaned.find("{"), cleaned.rfind("}")
    if start >= 0 and end > start:
        try:
            obj = json.loads(cleaned[start:end + 1])
            if isinstance(obj, dict):
                return obj
        except json.JSONDecodeError:
            pass

    raise LLMError(f"模型返回无法解析为 JSON（前 200 字）：{raw[:200]}")


class OpenAICompatProvider:
    """OpenAI 兼容端点客户端。"""

    name = "openai-compat"
    is_remote = True

    def __init__(
        self,
        base_url: str,
        api_key: str,
        model: str,
        timeout: float = 90.0,
        json_mode: bool = False,
        temperature: float = 0.2,
        max_tokens: int = 4096,
        use_proxy: str = "auto",
        max_retries: int = 2,
        retry_backoff: float = 2.0,
        thinking: str = "off",
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.timeout = timeout
        self.json_mode = json_mode
        self.temperature = temperature
        self.max_tokens = max_tokens
        self.use_proxy = (use_proxy or "auto").strip().lower()
        self.max_retries = max(0, int(max_retries))
        self.retry_backoff = max(0.0, float(retry_backoff))
        # 思考开关：off / disabled  → 显式关闭（默认，见 config.LLM_THINKING）
        #             on  / enabled  → 显式打开
        #             auto / 空      → 什么都不下发，由服务端默认行为决定
        self.thinking = (thinking or "auto").strip().lower()

    def thinking_payload(self) -> dict:
        """返回该实例该下发的 thinking 参数（不需要下发时返回空 dict）。

        ★ 只在**模型名看起来支持思考**（GLM 系列）时才下发：非 GLM 端点
        （SiliconFlow / Ollama / OpenRouter 上的开源模型）收到未知字段可能直接 400。
        显式要求打开（on）时不设这道门槛 —— 用户明确知道自己在做什么。
        """
        t = self.thinking
        if t in ("on", "enabled", "true", "1"):
            return {"thinking": {"type": "enabled"}}
        if t in ("off", "disabled", "false", "0"):
            if "glm" in (self.model or "").lower():
                return {"thinking": {"type": "disabled"}}
        return {}

    # ---------- 内部 ----------

    @property
    def _is_local(self) -> bool:
        return "127.0.0.1" in self.base_url or "localhost" in self.base_url

    def _has_proxy_env(self) -> bool:
        return any(os.environ.get(k) for k in _PROXY_ENV_KEYS)

    @staticmethod
    def _proxy_alive(timeout: float = 1.0) -> bool:
        """快速探测系统代理是否真的可达。

        环境里配了 http_proxy 不等于它可用 —— 很多桌面客户端会注入一个本地代理端口，
        客户端退出后端口就废了。若不预检，一次直连读超时后再白等一轮代理超时，
        会把总耗时翻倍。这里 1 秒 TCP 探测，连不上就不把代理列为候选通道。
        """
        for key in _PROXY_ENV_KEYS:
            raw = os.environ.get(key)
            if not raw:
                continue
            try:
                parts = urllib.parse.urlsplit(raw if "://" in raw else "http://" + raw)
                host = parts.hostname
                port = parts.port or 8080
                if not host:
                    continue
                with socket.create_connection((host, port), timeout=timeout):
                    return True
            except OSError:
                continue
        return False

    def _openers(self) -> list[tuple[urllib.request.OpenerDirector, str]]:
        """按顺序返回候选通道：(opener, 描述)。第一个成功即返回。"""
        direct = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        # 本地端点（Ollama 等）永远不该走代理
        if self._is_local or self.use_proxy == "0":
            return [(direct, "直连")]
        if self.use_proxy == "1":
            return [(urllib.request.build_opener(), "系统代理")]
        # auto：直连优先；仅当「确实配了代理 且 代理真的活着」才追加代理通道兜底
        if self._has_proxy_env() and self._proxy_alive():
            return [(direct, "直连"), (urllib.request.build_opener(), "系统代理")]
        return [(direct, "直连")]

    def _post(self, payload: dict, timeout: float | None = None) -> dict:
        url = f"{self.base_url}/chat/completions"
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        # 单次调用可覆盖超时：抽取要长（LLM_TIMEOUT），简报综述只要短（BRIEF_SUMMARY_TIMEOUT）
        budget = float(timeout if timeout else self.timeout)

        attempts: list[str] = []
        last_error: Exception | None = None

        for opener, label in self._openers():
            req = urllib.request.Request(url, data=body, method="POST")
            req.add_header("Content-Type", "application/json")
            req.add_header("Authorization", f"Bearer {self.api_key}")
            try:
                with opener.open(req, timeout=budget) as resp:
                    return json.loads(resp.read().decode("utf-8"))
            except urllib.error.HTTPError as exc:
                # 语义错误（鉴权/限流/路径）与通道无关，不再尝试其它通道
                detail = ""
                try:
                    detail = exc.read().decode("utf-8", "replace")[:300]
                except Exception:  # noqa: BLE001
                    pass
                hint = ""
                if exc.code in (401, 403):
                    hint = "（API Key 无效或未授权，请检查 LLM_API_KEY）"
                elif exc.code == 429:
                    hint = "（触发限流或额度用尽）"
                elif exc.code == 404:
                    hint = "（模型名或接口路径不存在，请检查 LLM_MODEL / LLM_BASE_URL）"
                elif exc.code >= 500:
                    hint = "（服务端瞬时故障）"
                retriable = exc.code in _RETRIABLE_STATUS or exc.code >= 500
                raise LLMError(
                    f"HTTP {exc.code} {exc.reason}{hint} {detail}",
                    retriable=retriable,
                    status=exc.code,
                ) from exc
            except json.JSONDecodeError as exc:
                raise LLMError("接口返回的不是合法 JSON") from exc
            except (socket.timeout, TimeoutError) as exc:
                # 读超时 = 连接已建立、只是服务端生成慢。换通道不会更快，直接终止重试。
                attempts.append(f"{label}超时（{budget:.0f}s 内未返回）")
                last_error = exc
                break
            except urllib.error.URLError as exc:
                reason = getattr(exc, "reason", exc)
                if isinstance(reason, (socket.timeout, TimeoutError)):
                    attempts.append(f"{label}超时（{budget:.0f}s 内未返回）")
                    last_error = exc
                    break
                # 连接级错误（拒绝连接 / DNS 失败）→ 换下一个通道再试
                attempts.append(f"{label}失败（{reason}）")
                last_error = exc
                continue
            except OSError as exc:
                attempts.append(f"{label}失败（{exc}）")
                last_error = exc
                continue

        detail = "；".join(attempts) or "无可用通道"
        raise LLMError(
            f"网络不可达：{detail}（base_url={self.base_url}，"
            f"可用 LLM_USE_PROXY=0 强制直连 / =1 强制走代理）",
            retriable=True,
        ) from last_error

    # ---------- 对外 ----------

    def _request(
        self, payload: dict, timeout: float | None = None, retries: int | None = None
    ) -> dict:
        """发请求，并对**瞬时故障**做退避重试。

        免费档高峰期 429（限流）与 5xx（服务端「操作失败」）都相当常见，
        一次失败就整单降级到本地引擎太可惜。这里最多重试 `max_retries` 次，
        指数退避（默认 2s → 4s）。
        语义性失败（401/403/404、返回体非法）不重试，直接抛出。
        """
        tried_without_format = False
        last: LLMError | None = None
        budget_retries = self.max_retries if retries is None else max(0, int(retries))

        for attempt in range(budget_retries + 1):
            try:
                return self._post(payload, timeout)
            except LLMError as exc:
                last = exc
                # 端点不支持 response_format → 去掉后立即重试一次（不占退避配额）
                if self.json_mode and not tried_without_format and "response_format" in payload:
                    payload.pop("response_format", None)
                    tried_without_format = True
                    continue
                if not exc.retriable or attempt >= budget_retries:
                    raise
                time.sleep(self.retry_backoff * (2 ** attempt))

        raise last  # pragma: no cover - 循环内必然 return 或 raise

    @staticmethod
    def _message_text(data: dict) -> tuple[str, bool]:
        """取出正文；返回 (正文, 是否只有推理没有正文)。"""
        try:
            msg = data["choices"][0]["message"]
        except (KeyError, IndexError, TypeError) as exc:
            raise LLMError(f"返回体结构不符合预期：{str(data)[:200]}") from exc
        content = (msg.get("content") or "")
        had_reasoning = bool((msg.get("reasoning_content") or "").strip())
        return content, had_reasoning and not content.strip()

    def _request_text(
        self, payload: dict, *, timeout: float | None = None, retries: int | None = None
    ) -> str:
        """发请求并取正文；**空正文自愈**：思考型模型把预算烧在推理上时自动关思考重试一次。

        实测（2026-10-14）：glm-4.5-flash 默认走思考，17~24s 后 content 为空、
        finish_reason=length（推理吃满 max_tokens）；glm-4.7-flashx 默认 11.4s 同样带 1103 字推理。
        以前这里直接抛「模型返回为空」，查询理解只能沿用语词表、简报只能降级规则文案 ——
        现在发现「只有推理没有正文」就**立刻关掉思考再要一次**，用户完全无感。
        """
        data = self._request(payload, timeout=timeout, retries=retries)
        text, reasoning_only = self._message_text(data)
        if text.strip():
            return text
        if reasoning_only and self.thinking_payload().get("thinking", {}).get("type") != "disabled":
            retry_payload = dict(payload)
            retry_payload["thinking"] = {"type": "disabled"}
            data = self._request(retry_payload, timeout=timeout, retries=0)
            text, reasoning_only = self._message_text(data)
        if not text.strip():
            raise LLMError(
                "模型返回为空（只有推理、没有正文）—— 建议设 LLM_THINKING=off"
                if reasoning_only else "模型返回为空"
            )
        return text

    def extract(
        self, req: ExtractionRequest, messages: list[dict[str, str]] | None = None
    ) -> ExtractionResult:
        messages = messages or []
        started = time.time()

        payload: dict = {
            "model": self.model,
            "messages": messages,
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
        }
        if self.json_mode:
            payload["response_format"] = {"type": "json_object"}
        payload.update(self.thinking_payload())

        content = self._request_text(payload)

        obj = _extract_json(content)
        policies = obj.get("policies") or obj.get("items") or []
        if not isinstance(policies, list):
            raise LLMError("policies 字段不是数组")

        return ExtractionResult(
            provider=f"{self.name}:{self.model}",
            # 条件标签（那四行）**不由抽取层拼**：唯一口径是 app/labels.py → resolve_conditions()，
            # 由 search.py 算一次并同时交给检索屏四行 / 页头标题 / 落库三处。
            # 让模型自己写「行业 = …」最危险：它写的是一个我们未必采纳的值。
            parsed=[],
            policies=[p for p in policies if isinstance(p, dict)],
            raw=content[:4000],
            elapsed_ms=int((time.time() - started) * 1000),
            degraded=False,
        )

    def parse_query(self, query: str) -> dict:
        """★ 查询理解（先解析、再检索）：一次**超短输出**的补全，只吐结构化条件。

        与 `extract` 的区别不只是输出短：
          · 输出只有几十个 token，快，且可以给一个很紧的等待上限（config.QUERY_PARSE_TIMEOUT）；
          · **不重试**（`retries=0`）—— 它在检索开始前跑，用户正盯着进度条，
            卡住就沿用语词表结果，绝不为了它把整条流水线拖住。
        """
        payload = {
            "model": self.model,
            "messages": build_query_messages(query),
            "temperature": 0.0,
            "max_tokens": config.QUERY_PARSE_MAX_TOKENS,
        }
        if self.json_mode:
            payload["response_format"] = {"type": "json_object"}
        payload.update(self.thinking_payload())

        content = self._request_text(
            payload, timeout=config.QUERY_PARSE_TIMEOUT, retries=0
        )
        return _extract_json(content or "")

    def complete(
        self,
        messages: list[dict[str, str]],
        *,
        max_tokens: int = 700,
        timeout: float | None = None,
        temperature: float = 0.3,
        retries: int = 0,
    ) -> str:
        """纯文本补全：只写一段短文案（简报综述 / 政策对话），不做 JSON 抽取。

        ★ 与 `extract` 的关键差别是**默认不重试**（`retries=0`）：
          抽取出错值得退避重试，而简报是用户点了按钮**当场等**的交互 ——
          一次 60s 超时后再退避重试 2 次，用户要干等三分钟。
          超时就直接降级到本地规则文案，把「一定能导出」放在第一位。
        """
        payload = {
            "model": self.model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        payload.update(self.thinking_payload())
        return self._request_text(payload, timeout=timeout, retries=retries).strip()
