"""LLM 随用途分模型 · 配置闸门（纯本地、毫秒级、不联网）。

钉住的约定（2026-10-14 用户选择「三用途分别配模型」+「简报关思考」）：

【1】缺省继承：不配任何 `LLM_*_<用途>` 时，四个用途都解析成全局那一套 —— 改造前后行为一致；
【2】按用途覆盖：`LLM_MODEL_CHAT` / `LLM_BASE_URL_BRIEF` / `LLM_API_KEY_QUERY` /
     `LLM_TIMEOUT_EXTRACT` / `LLM_MAX_TOKENS_BRIEF` 只影响自己那一项，其余继续继承；
【3】非法值与空白一律回落全局（不能因为写错一个数就让服务起不来）；
【4】未知用途名退化成 extract（绝不 KeyError）；
【5】思考开关：`thinking=off` 只对 GLM 系模型下发 `{"type":"disabled"}`
     （其它端点不认识这个字段，宁可不下发）；`on` 无条件下发；
【6】空正文自愈：正文为空但带 reasoning_content 时，客户端会**自动关思考重试一次**
     （GLM-4.5/4.7 是思考型模型，会把输出预算烧在推理上）；
【7】`provider_status()`：顶层 `model` = extract 那份（旧契约不破），
     `purposes` 四个用途齐全且各自带 model/baseUrl/thinking。
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import config  # noqa: E402
from app.llm import provider_status  # noqa: E402
from app.llm.openai_compat import OpenAICompatProvider  # noqa: E402

pass_n = 0
fail_n = 0


def ok(cond: bool, msg: str, extra: object = None) -> None:
    global pass_n, fail_n
    if cond:
        pass_n += 1
        print(f"  ok   {msg}" + ("" if extra is None else f"   → {extra}"))
    else:
        fail_n += 1
        print(f"  FAIL {msg}" + ("" if extra is None else f"   → {extra}"))


class env_patch:
    """临时注入环境变量（用途覆盖是每次调用现读 os.environ，所以改了立刻生效）。"""

    def __init__(self, **kv: str) -> None:
        self.kv = kv

    def __enter__(self):
        import os
        self.old = {k: os.environ.get(k) for k in self.kv}
        os.environ.update(self.kv)
        return self

    def __exit__(self, *exc):
        import os
        for k, v in self.old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        return False


print("【1】缺省继承：不配按用途变量时，四个用途 = 全局那一套")
base = config.llm_settings("extract")
ok(set(config.LLM_PURPOSES) == {"query", "extract", "chat", "brief"},
   "四用途定义齐全", config.LLM_PURPOSES)
for p in config.LLM_PURPOSES:
    s = config.llm_settings(p)
    same = (s["model"] == config.LLM_MODEL and s["base_url"] == config.LLM_BASE_URL
            and s["api_key"] == config.LLM_API_KEY and s["thinking"] == config.LLM_THINKING)
    ok(same, f"{p} 用途完全继承全局（模型/端点/Key/思考开关）", s["model"])

print("\n【2】按用途覆盖：只影响自己那一项")
with env_patch(LLM_MODEL_CHAT="glm-4.5-flash", LLM_MAX_TOKENS_BRIEF="900",
               LLM_BASE_URL_QUERY="https://example.invalid/v1", LLM_API_KEY_QUERY="k-query",
               LLM_TIMEOUT_EXTRACT="120"):
    chat = config.llm_settings("chat")
    brief = config.llm_settings("brief")
    query = config.llm_settings("query")
    extract = config.llm_settings("extract")
    ok(chat["model"] == "glm-4.5-flash", "LLM_MODEL_CHAT 只改 chat 的模型", chat["model"])
    ok(brief["model"] == config.LLM_MODEL, "brief 的模型不受影响（继续继承）", brief["model"])
    ok(brief["max_tokens"] == 900 and chat["max_tokens"] == config.LLM_MAX_TOKENS,
       "LLM_MAX_TOKENS_BRIEF 只改 brief 的输出上限", f"brief={brief['max_tokens']} chat={chat['max_tokens']}")
    ok(query["base_url"] == "https://example.invalid/v1" and query["api_key"] == "k-query",
       "端点与 Key 也能按用途换（跨厂商预留）", query["base_url"])
    ok(extract["timeout"] == 120.0 and chat["timeout"] == config.LLM_TIMEOUT,
       "LLM_TIMEOUT_EXTRACT 只改 extract 的超时", f"extract={extract['timeout']} chat={chat['timeout']}")

print("\n【3】非法值 / 空白一律回落全局")
with env_patch(LLM_TIMEOUT_CHAT="not-a-number", LLM_MAX_TOKENS_QUERY="", LLM_MODEL_BRIEF="  "):
    ok(config.llm_settings("chat")["timeout"] == config.LLM_TIMEOUT,
       "非数字超时不生效、回落全局（不会让服务起不来）", config.llm_settings("chat")["timeout"])
    ok(config.llm_settings("query")["max_tokens"] == config.LLM_MAX_TOKENS, "空串回落全局")
    ok(config.llm_settings("brief")["model"] == config.LLM_MODEL, "纯空白回落全局")

print("\n【4】未知用途名退化成 extract")
ok(config.llm_settings("nope")["purpose"] == "extract" and config.llm_settings("")["purpose"] == "extract",
   "未知/空用途名一律走 extract（绝不 KeyError）")

print("\n【5】思考开关：只对 GLM 系下发 disabled")
glm_off = OpenAICompatProvider(base_url="https://open.bigmodel.cn/api/paas/v4",
                               api_key="x", model="glm-4.5-flash", thinking="off")
other_off = OpenAICompatProvider(base_url="http://127.0.0.1:11434/v1",
                                 api_key="x", model="qwen2.5:7b", thinking="off")
forced_on = OpenAICompatProvider(base_url="http://127.0.0.1:11434/v1",
                                 api_key="x", model="qwen2.5:7b", thinking="on")
auto = OpenAICompatProvider(base_url="https://open.bigmodel.cn/api/paas/v4",
                            api_key="x", model="glm-4.5-flash", thinking="auto")
ok(glm_off.thinking_payload() == {"thinking": {"type": "disabled"}},
   "GLM 模型 + off → 下发 disabled（关掉推理，保住正文）", glm_off.thinking_payload())
ok(other_off.thinking_payload() == {},
   "非 GLM 端点 + off → 不下发（未知字段可能直接 400）", other_off.thinking_payload())
ok(forced_on.thinking_payload() == {"thinking": {"type": "enabled"}},
   "显式 on → 无条件下发 enabled")
ok(auto.thinking_payload() == {}, "auto → 什么都不下发，交给服务端默认")

print("\n【6】空正文自愈：只有推理没有正文 → 自动关思考重试")
probe = OpenAICompatProvider(base_url="https://open.bigmodel.cn/api/paas/v4",
                             api_key="x", model="glm-4.5-flash", thinking="on")
t1, r1 = probe._message_text({"choices": [{"message": {"content": "", "reasoning_content": "想了很久"}}]})
t2, r2 = probe._message_text({"choices": [{"message": {"content": "正文", "reasoning_content": "想了很久"}}]})
ok(t1 == "" and r1 is True, "识别出「只有推理、正文为空」")
ok(t2 == "正文" and r2 is False, "有正文时不误判为推理空转")

print("\n【7】provider_status：顶层 model = extract，purposes 四用途齐全")
st = provider_status()
ok([p["purpose"] for p in st["purposes"]] == list(config.LLM_PURPOSES),
   "purposes 按 query/extract/chat/brief 顺序列出", [p["purpose"] for p in st["purposes"]])
ok(st["purposes"][1]["model"] == st["model"],
   "顶层 model 与 extract 用途同一份（旧契约不破）", st["model"])
ok(all("thinking" in p and "baseUrl" in p and "inherited" in p for p in st["purposes"]),
   "每个用途都带 thinking / baseUrl / inherited")
ok(isinstance(st.get("thinking"), str) and st["thinking"] != "",
   "顶层报出全局思考开关", st.get("thinking"))

print(f"\n断言 {pass_n} 项通过，{fail_n} 项未通过" + (" ✅" if fail_n == 0 else " ❌"))
raise SystemExit(0 if fail_n == 0 else 1)
