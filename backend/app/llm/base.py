"""LLM 抽取层 · Provider 端口定义。

对应《后端架构设计方案》中的 LLMProvider 端口：上层（检索流水线）只依赖这里的
Protocol，换实现（本地 Mock / 云端免费 API / 本地 Ollama）不改上层代码。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable


class LLMError(RuntimeError):
    """LLM 调用失败：未配置 / 网络错误 / 鉴权失败 / 超时 / 返回体非法。

    retriable=True 表示这是**瞬时故障**（限流 429、服务端 5xx、连接中断等），
    调用方值得退避后重试；False 表示语义性失败（Key 无效、模型名错、返回体非法），
    重试多少次都一样，应直接降级。
    """

    def __init__(self, message: str, *, retriable: bool = False, status: int | None = None) -> None:
        super().__init__(message)
        self.retriable = retriable
        self.status = status


@dataclass
class ExtractionRequest:
    """一次抽取请求：用户原始条件 + 服务端补全的上下文。"""

    query: str = ""                                    # 用户自然语言输入
    regions: list[str] = field(default_factory=list)   # 已解析的区划名（含全称）
    region_codes: list[str] = field(default_factory=list)
    industries: str = ""
    types: str = ""
    deadline: str = ""
    today: str = ""                                    # 服务端当前日期
    max_items: int = 10


@dataclass
class ExtractionResult:
    """抽取结果。

    这里只承载「准原始」字段；id / daysLeft / corner / matched / offset 等
    由 wrap 层统一补齐，保证与前端契约一致。
    """

    provider: str
    parsed: list[str] = field(default_factory=list)
    policies: list[dict[str, Any]] = field(default_factory=list)
    raw: str = ""                 # 原始返回内容（排查用）
    elapsed_ms: int = 0
    degraded: bool = False        # 是否走了兜底（真实 LLM 失败后退回规则抽取）


@runtime_checkable
class LLMProvider(Protocol):
    """所有 Provider 的统一入口。"""

    name: str
    is_remote: bool

    def extract(
        self, req: ExtractionRequest, messages: list[dict[str, str]]
    ) -> ExtractionResult:
        """按提示词抽取政策。

        失败应抛 LLMError，由上层决定是否降级（而不是让主流程崩掉）。
        """
        ...

    def complete(
        self, messages: list[dict[str, str]], **options: Any
    ) -> str:
        """纯文本补全（**不做** JSON 抽取）。

        与 `extract` 是两条用途：抽取要吐结构化清单（长输出、受 token 上限约束），
        补全只写一段短文案（简报综述之类），输出短、等待可控。
        失败同样应抛 LLMError，由上层决定是否降级到本地规则文案。
        """
        ...

    def parse_query(self, query: str) -> dict:
        """**查询理解**（先解析、再检索）：从用户的一句话里读出结构化条件。

        输出形如：:

            {"industries": ["农业"], "types": ["场地减免"],
             "deadline": "近 90 天", "keywords": ["冬枣"]}

        只填**能从描述里明确看出**的项，看不出来就留空（空数组 / 空串）——
        宁可不填，也不要为了凑满而编一个用户没说过的行业。
        取值尽量落在首页筛选栏的枚举里（服务端会把枚举作为提示词的一部分给它）；
        枚举外的行业照实写（如「农业」）。

        失败应抛 LLMError，由上层沿用语词表（`app/query_parse.py`）的结果。
        """
        ...
