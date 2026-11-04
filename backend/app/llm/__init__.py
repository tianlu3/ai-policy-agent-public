"""LLM 抽取层：Provider 端口 + 免费本地引擎 + OpenAI 兼容客户端。

用法：
    from app import llm
    provider = llm.build_provider()          # 按配置自动选择
    result = provider.extract(req, llm.build_messages(req))
"""
from __future__ import annotations

from .. import config
from .base import ExtractionRequest, ExtractionResult, LLMError, LLMProvider
from .mock import MockProvider
from .openai_compat import OpenAICompatProvider
from .prompts import (
    BRIEF_SYSTEM_PROMPT,
    CHAT_SYSTEM_PROMPT,
    QUERY_PARSE_SYSTEM_PROMPT,
    SYSTEM_PROMPT,
    build_brief_messages,
    build_chat_messages,
    build_messages,
    build_query_messages,
    build_user_prompt,
    render_preview,
)

__all__ = [
    "ExtractionRequest",
    "ExtractionResult",
    "LLMError",
    "LLMProvider",
    "MockProvider",
    "OpenAICompatProvider",
    "SYSTEM_PROMPT",
    "BRIEF_SYSTEM_PROMPT",
    "CHAT_SYSTEM_PROMPT",
    "QUERY_PARSE_SYSTEM_PROMPT",
    "build_messages",
    "build_brief_messages",
    "build_chat_messages",
    "build_query_messages",
    "build_user_prompt",
    "render_preview",
    "build_provider",
    "provider_status",
    "complete",
]

_REMOTE_KINDS = {
    "openai", "openai-compat", "openai_compat",
    "zhipu", "glm", "siliconflow", "openrouter", "ollama", "deepseek",
}


def _remote_provider(purpose: str = "extract") -> OpenAICompatProvider:
    """按**用途**构建远端 Provider（模型/端点/Key/思考开关/超时全部来自 config）。

    四个用途（`config.LLM_PURPOSES`）：query 查询理解 / extract 结构化抽取 /
    chat 政策对话 / brief 简报综述。未单独配置的键继承全局 `LLM_*`。
    """
    s = config.llm_settings(purpose)
    return OpenAICompatProvider(
        base_url=s["base_url"],
        api_key=s["api_key"],
        model=s["model"],
        timeout=s["timeout"],
        max_tokens=s["max_tokens"],
        use_proxy=s["use_proxy"],
        max_retries=s["max_retries"],
        retry_backoff=s["retry_backoff"],
        thinking=s["thinking"],
    )


def build_provider(purpose: str = "extract") -> LLMProvider:
    """按配置 + 用途选 Provider。

    LLM_PROVIDER 取值：
      auto   —— 配了 API Key 就用远端，否则用本地规则引擎（默认）
      mock   —— 强制本地规则引擎（离线演示）
      openai / zhipu / siliconflow / openrouter / ollama —— 强制远端

    purpose 只影响**远端**走哪套模型设置（见 `config.llm_settings()`）；
    mock 是同一个本地规则引擎，与用途无关。
    """
    kind = (config.LLM_PROVIDER or "auto").strip().lower()
    settings = config.llm_settings(purpose)

    if kind == "mock":
        return MockProvider()

    if kind in _REMOTE_KINDS:
        if not settings["api_key"]:
            raise LLMError(
                f"LLM_PROVIDER={kind} 需要 API Key：请在 backend/.env 里设置 LLM_API_KEY"
                f"（或 {settings['purpose']} 用途专用的 LLM_API_KEY_{settings['purpose'].upper()}），"
                "也可改用 LLM_PROVIDER=mock 走本地免费引擎"
            )
        return _remote_provider(settings["purpose"])

    # auto
    if settings["api_key"]:
        return _remote_provider(settings["purpose"])
    return MockProvider()


def complete(
    messages: list[dict[str, str]],
    *,
    max_tokens: int = 700,
    timeout: float | None = None,
    temperature: float = 0.3,
    purpose: str = "brief",
) -> str:
    """纯文本补全（简报综述这类短文案）。不走抽取解析。

    调用方（`app/brief.py`）负责兜底：本函数失败/超时一律抛 LLMError，
    由它决定退化为本地规则文案 —— 因此这里不吞异常。
    """
    provider = build_provider(purpose)
    return provider.complete(  # type: ignore[attr-defined]
        messages, max_tokens=max_tokens, timeout=timeout, temperature=temperature
    )


def provider_status() -> dict:
    """当前 LLM 配置状态（给 /api/v1/llm/status 与启动日志用）。

    顶层键沿用改造前的形状（= extract 那份设置），另加 `purposes` 列出四个用途
    各自解析出的模型 —— 前端与闸门据此确认「解析/抽取/对话/简报」用的是不是同一套。
    """
    has_key = bool(config.LLM_API_KEY)
    kind = (config.LLM_PROVIDER or "auto").strip().lower()
    effective = "mock" if (kind == "mock" or (kind == "auto" and not has_key)) else kind
    settings = config.llm_settings("extract")

    purposes = []
    for p in config.LLM_PURPOSES:
        s = config.llm_settings(p)
        purposes.append({
            # 口径必须与顶层一致：mock 实例（LLM_PROVIDER=mock）下全部报「本地规则引擎」，
            # 否则会出现「顶层说 mock、purposes 说 glm-4.5-flash」的自相矛盾状态。
            "model": s["model"] if effective != "mock" else "本地规则引擎",
            "baseUrl": s["base_url"] if effective != "mock" else "",
            "purpose": p,
            "thinking": s["thinking"],
            "inherited": s["model"] == config.LLM_MODEL,
        })

    if effective != "mock":
        note = f"已接入真实模型（{effective}:{settings['model']}）"
        models = {p["model"] for p in purposes}
        if len(models) > 1:
            note += f" · 按用途分模型 {len(models)} 个"
    elif kind == "mock":
        note = "已按 LLM_PROVIDER=mock 强制使用本地免费规则引擎（离线、确定性）"
    else:
        note = "未配置 API Key，使用本地免费规则引擎（无需联网，可完整跑通链路）"
    return {
        "configured": config.LLM_PROVIDER,
        "effective": effective,
        "isRemote": effective != "mock",
        "hasApiKey": has_key,
        "baseUrl": settings["base_url"] if effective != "mock" else "",
        "model": settings["model"] if effective != "mock" else "本地规则引擎",
        "thinking": config.LLM_THINKING,
        "purposes": purposes,
        "timeout": settings["timeout"],
        "maxTokens": settings["max_tokens"],
        "useProxy": settings["use_proxy"],
        "note": note,
    }
