"""检索服务：把「前端请求 → 提示词 → LLM → 十命名空间结果」编排成可轮询的异步任务。

对应《后端架构设计方案》的 TaskQueue 端口 —— 当前是**进程内线程池**实现（视图 A），
后续换 RabbitMQ / Celery 只替换本模块内部的提交方式，API 与前端契约不变。

任务生命周期：
    POST /api/v1/searches            → 建任务，立即返回 taskId（不阻塞前端）
    GET  /api/v1/searches/{id}       → 轮询进度（步骤 / 源进度 / 抓取日志 / 解析条件）
    GET  /api/v1/searches/{id}/result→ 取包装好的十命名空间数据
    DELETE /api/v1/searches/{id}     → 取消
"""
from __future__ import annotations

import hashlib
import json
import random
import threading
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import date
from typing import Any

from . import config, db, labels, llm, query_parse, regions, repo, sources, wrap
from .llm.base import ExtractionRequest, ExtractionResult

# 与前端 data/search.json 的 steps / runningTitles 一一对应
STEPS = ("解析查询", "多源抓取", "清洗去重", "AI 结构化", "分类排序", "结果打包")
RUNNING_TITLES = (
    "解析查询", "多源抓取中", "清洗去重中", "AI 结构化中", "分类排序中", "结果打包中",
)


def _effective_regions(task: "SearchTask") -> list[str]:
    """本次检索**实际生效**的地域名（检索记录里存它，历史卡片直接展示）。

    口径与 `wrap.build` 里的 `list.regionsUsed` 完全一致：
      ① 筛选栏选了 → 用筛选栏解析出的节点（含下辖层级）；
      ② 筛选栏为空 → 从查询文本识别到的地名（「我是杭州做智能硬件的」→ 杭州市）；
      ③ 都没有 → 空列表（前端显示「全国（不限）」）。
    """
    nodes = task.nodes or []
    names = [n.name for n in nodes if getattr(n, "name", None)]
    if names:
        return names
    try:
        return [n.name for n in regions.match_in_text(task.request.query or "")]
    except Exception:  # noqa: BLE001 - 识别失败不该影响落库
        return list(task.request.regions)


@dataclass
class SearchRequest:
    """前端提交的检索条件。"""

    query: str = ""
    regions: list[str] = field(default_factory=list)
    industries: str = ""
    types: str = ""
    deadline: str = ""

    @classmethod
    def from_payload(cls, payload: Any) -> "SearchRequest":
        payload = payload if isinstance(payload, dict) else {}

        def _text(key: str) -> str:
            value = payload.get(key)
            return str(value).strip() if value is not None else ""

        raw_regions = payload.get("regions") or []
        if isinstance(raw_regions, str):
            raw_regions = [raw_regions]
        names: list[str] = []
        for item in raw_regions:
            if isinstance(item, dict):                       # 允许传 {code,name}
                item = item.get("name") or item.get("code")
            if item:
                names.append(str(item).strip())

        return cls(
            query=_text("query"),
            regions=[n for n in names if n],
            industries=_text("industries"),
            types=_text("types"),
            deadline=_text("deadline"),
        )


class SearchTask:
    """一次检索任务的运行时状态（内存态，重启即丢）。

    落库信息：`user_id` 来自登录态（游客为 None），任务结束后由
    `SearchService._persist()` 把条件 + 结果快照写入 `search_records`，
    登录用户下次打开应用即可直接回放，无需重复检索。
    """

    def __init__(self, task_id: str, request: SearchRequest, user_id: int | None = None) -> None:
        self.id = task_id
        self.request = request
        self.user_id = user_id
        self.record_id: int | None = None
        self.status = "running"          # running | succeeded | failed | canceled
        self.step = 0
        self.progress_from = 0
        self.progress_total = 0
        self.parsed: list[str] = []
        # 本次**生效条件 + 每项来源**（app/labels.py → resolve_conditions() 的结果）。
        # 生成一次、三处共用：检索屏四行 / 页头标题 / 落库，绝不各拼各的。
        self.resolved: dict = {}
        # 检索屏标题（「正在检索 · 「地域 · 行业 · 类型」」）—— 与 parsed 同源、同时落定。
        # 放在任务里而不是让前端自己拼：前端拼就会出现「检索屏说一套、结果屏说另一套」。
        self.cond_title = ""
        self.nodes: list = []
        self.logs: list[dict] = []
        self.error: str | None = None
        self.provider = ""
        self.degraded = False
        self.prompt_chars = 0
        self.result: dict | None = None
        self.created_at = time.time()
        self.finished_at: float | None = None

        self._cancel = threading.Event()
        self._lock = threading.Lock()

    # ---------- 状态更新 ----------

    def log(self, text: str, detail: str = "") -> None:
        with self._lock:
            self.logs.append({
                "t": f"{time.time() - self.created_at:.1f}s",
                "s": text,
                "r": detail,
            })

    def set_step(self, index: int) -> None:
        with self._lock:
            self.step = max(0, min(len(STEPS) - 1, index))

    def set_parsed(self, resolved: dict) -> None:
        """把「生效条件 + 来源」落定，并同步出检索屏四行与标题。

        参数是 `app/labels.py → resolve_conditions()` 的结果，不再是一串现成文案 ——
        文案只由 labels 渲染，四行与标题永远同源。
        分两次设就会出现「条件已更新、标题还是旧的」这种半拍状态，
        而检索屏恰恰是边跑边刷的，半拍会被用户看见。
        """
        with self._lock:
            self.resolved = dict(resolved or {})
            self.parsed = labels.condition_labels(self.resolved)
            self.cond_title = labels.search_title(labels.head_parts(resolved=self.resolved))

    def pause(self, seconds: float) -> bool:
        """可被取消打断的分段等待。返回 False 表示任务已被取消。"""
        deadline = time.time() + max(0.0, seconds)
        while True:
            if self._cancel.is_set():
                return False
            remaining = deadline - time.time()
            if remaining <= 0:
                return True
            time.sleep(min(0.05, remaining))

    def cancel(self) -> bool:
        if self.status != "running":
            return False
        self._cancel.set()
        return True

    @property
    def canceled(self) -> bool:
        return self._cancel.is_set()

    def finish(self, status: str, error: str | None = None) -> None:
        with self._lock:
            self.status = status
            self.error = error
            self.finished_at = time.time()

    @property
    def elapsed_ms(self) -> int:
        end = self.finished_at or time.time()
        return int((end - self.created_at) * 1000)

    # ---------- 序列化 ----------

    def status_payload(self) -> dict:
        with self._lock:
            return {
                "taskId": self.id,
                "status": self.status,
                "step": self.step,
                "stepTitle": RUNNING_TITLES[self.step],
                "progress": {"from": self.progress_from, "total": self.progress_total},
                "parsed": list(self.parsed),
                "condTitle": self.cond_title,
                "logs": list(self.logs),
                "provider": self.provider,
                "degraded": self.degraded,
                "promptChars": self.prompt_chars,
                "elapsedMs": self.elapsed_ms,
                "error": self.error,
                "signedIn": self.user_id is not None,
                "recordId": self.record_id,
            }

    def result_payload(self) -> dict:
        return {
            "taskId": self.id,
            "status": self.status,
            "provider": self.provider,
            "degraded": self.degraded,
            "elapsedMs": self.elapsed_ms,
            "recordId": self.record_id,
            "bootstrap": self.result,
        }


class SearchService:
    """检索任务管理器。"""

    def __init__(self) -> None:
        self._tasks: "OrderedDict[str, SearchTask]" = OrderedDict()
        self._lock = threading.Lock()
        self._pool = ThreadPoolExecutor(
            max_workers=max(1, config.SEARCH_WORKERS), thread_name_prefix="search"
        )
        self._seq = 0

    # ---------- 对外 ----------

    def start(self, request: SearchRequest, user_id: int | None = None) -> SearchTask:
        with self._lock:
            self._seq += 1
            task_id = f"S{int(time.time() * 1000):x}{self._seq:03d}"
            task = SearchTask(task_id, request, user_id)
            self._tasks[task_id] = task
            while len(self._tasks) > max(1, config.SEARCH_KEEP_TASKS):
                self._tasks.popitem(last=False)

        # 条件解析（地域 + 行业 / 类型 / 时间）在**提交任务之前**同步算好：
        # 它全是本地纯函数（词表匹配），让 POST 的首次响应就稳定带回 parsed，
        # 不依赖工作线程调度（否则前端可能拿到空数组，需等到首轮轮询才补上）。
        # 大模型参与的「查询理解」在流水线第 0 步再补一次 —— 那是网络调用，不能卡住 POST。
        try:
            task.set_parsed(self._resolve(request))
        except Exception as exc:  # noqa: BLE001 - 解析失败不应阻断检索
            task.resolved = {"nodes": [], "industries": request.industries or "",
                             "types": request.types or "", "deadline": request.deadline or "",
                             "regionSource": "", "condSources": {}}
            task.set_parsed(task.resolved)
            task.log(f"条件解析异常，按筛选栏原值处理：{exc}", "warn")
        task.nodes = list(task.resolved.get("nodes") or [])

        self._pool.submit(self._run, task)
        return task

    @staticmethod
    def _resolve(req: "SearchRequest", hints=None) -> dict:
        """生效条件 + 来源（唯一口径：app/labels.py → resolve_conditions()）。

        `hints` 为空时由 labels 现算一次本地词表解析 —— 这就是「POST 首帧就有条件」的来源。
        """
        return labels.resolve_conditions(
            filter_regions=req.regions,
            query=req.query,
            industries=req.industries,
            types=req.types,
            deadline=req.deadline,
            hints=hints,
        )

    def get(self, task_id: str) -> SearchTask | None:
        with self._lock:
            return self._tasks.get(task_id)

    def cancel(self, task_id: str) -> bool:
        task = self.get(task_id)
        return bool(task and task.cancel())

    def stats(self) -> dict:
        with self._lock:
            tasks = list(self._tasks.values())
        return {
            "total": len(tasks),
            "running": sum(1 for t in tasks if t.status == "running"),
            "succeeded": sum(1 for t in tasks if t.status == "succeeded"),
            "failed": sum(1 for t in tasks if t.status == "failed"),
            "canceled": sum(1 for t in tasks if t.status == "canceled"),
            "persisted": sum(1 for t in tasks if t.record_id),
            "workers": max(1, config.SEARCH_WORKERS),
            "dbAvailable": db.available(),
        }

    def shutdown(self) -> None:
        self._pool.shutdown(wait=False, cancel_futures=True)

    # ---------- 流水线 ----------

    def _run(self, task: SearchTask) -> None:
        try:
            self._pipeline(task)
        except Exception as exc:  # noqa: BLE001 - 任何异常都不能让它静默消失
            task.log(f"任务异常终止：{exc}", "error")
            task.finish("failed", str(exc))
        finally:
            # 先落库、再改终态：客户端一看到 succeeded 就会读 recordId，
            # 反过来的话会有一瞬间「已完成但 recordId 还是 null」（实测到过）。
            self._persist(task)
            if task.status == "running":
                if task.canceled:
                    task.finish("canceled")
                else:
                    task.finish("succeeded")

    # ---------- 落库 ----------

    def _persist(self, task: SearchTask) -> None:
        """登录用户的检索结果写入 search_records（游客 / 取消 / 库不可用则跳过）。

        这一步**绝不能影响检索本身**：任何异常只记一条日志。
        """
        if task.user_id is None or task.canceled:
            # 取消的这一次不落库（口径同前：只存真正跑完的检索）
            return
        try:
            if not db.available():
                return
            row = repo.save_search_record(task.user_id, {
                "taskId": task.id,
                "query": task.request.query,
                # 存**本次实际生效的地域**（与检索屏「已解析出条件」、结果列表页头同源）：
                # 筛选栏选了就用筛选栏的，筛选栏为空则用从查询文本里识别到的地名
                # （「我是杭州做智能硬件的」→ 杭州市）。此前存的是筛选栏原样（多为空），
                # 历史卡片只能显示「全国（不限）」，与该次检索真正用的地域对不上。
                "regions": _effective_regions(task),
                # 存**本次实际生效**的行业 / 类型 / 时间（同样与检索屏四行、页头标题同源）：
                # 用户没勾筛选栏、但问句里说了「做冬枣销售、想找场地政策」时，
                # 生效值是 农业 / 场地减免（来自查询）—— 回放这条记录看到的才是当时的真相。
                "industries": task.resolved.get("industries") or "",
                "types": task.resolved.get("types") or "",
                "deadline": task.resolved.get("deadline") or "",
                # 落库发生在终态之前，所以这里要自己归一：正常跑完 = succeeded；
                # 若已被异常终止（status=failed）则如实存 failed，历史里能看到失败记录。
                "status": task.status if task.status != "running" else "succeeded",
                "provider": task.provider,
                "degraded": task.degraded,
                "elapsedMs": task.elapsed_ms,
                **self._result_digest(task.result),
            })
            task.record_id = row
            task.log(f"检索记录已写入数据库（记录 #{row}）· 下次登录可直接回放")
        except Exception as exc:  # noqa: BLE001
            task.log(f"检索记录保存失败（不影响本次结果）：{exc}", "warn")

    @staticmethod
    def _result_digest(bootstrap: dict | None) -> dict:
        """从包装结果里抽出历史列表需要的摘要字段。"""
        if not isinstance(bootstrap, dict):
            return {"itemCount": 0, "avgConfidence": 0.0, "summary": None, "resultJson": None}
        items = ((bootstrap.get("policies") or {}).get("items")) or []
        values = [
            float(p.get("confidence"))
            for p in items
            if isinstance(p, dict) and isinstance(p.get("confidence"), (int, float))
        ]
        avg = sum(values) / len(values) if values else 0.0
        meta = (((bootstrap.get("list") or {}).get("head")) or {}).get("meta")
        summary = meta or (f"{len(items)} 条政策 · 平均置信度 {avg:.2f}" if items else None)
        try:
            result_json = json.dumps(bootstrap, ensure_ascii=False)
        except Exception:  # noqa: BLE001
            result_json = None
        return {
            "itemCount": len(items),
            "avgConfidence": avg,
            "summary": summary,
            "resultJson": result_json,
        }

    def _pipeline(self, task: SearchTask) -> None:
        req = task.request

        # ── 0 解析查询（先解析、再检索）
        # 行业 / 类型 / 时间在这里定稿：先由本地词表给一版（POST 首帧已经带上），
        # 远端模型在线时再补一次理解。**之后所有步骤都用这份生效条件** ——
        # 提示词、主题池收窄、页头标题、落库，一处改口径处处跟着变。
        task.set_step(0)
        # 两个用途两套模型（2026-10-14）：查询理解要「快 + 短输出」（只有 20s 硬等待窗），
        # 结构化抽取要「长输出 + 有重试」。不配就是同一个模型，行为与改造前一致。
        query_provider = llm.build_provider("query")
        provider = llm.build_provider("extract")
        task.provider = provider.name
        self._understand(task, req, query_provider)
        nodes = list(task.resolved.get("nodes") or [])

        ex_req = ExtractionRequest(
            query=req.query,
            regions=req.regions,
            industries=task.resolved.get("industries") or "",
            types=task.resolved.get("types") or "",
            deadline=task.resolved.get("deadline") or "",
            today=date.today().isoformat(),
            max_items=config.SEARCH_MAX_ITEMS,
        )

        # ── 乱填问句识别：「我是真人」「666」这类输入没有任何检索信号，
        #    硬跑一遍流水线再铺几百条结果，等于替用户编答案。这里短路返回
        #    understood=false，前端在结果页顶部给出「不太理解」提示（2026-10-16）。
        if not query_parse.has_signal(req.query):
            task.log("问句缺少有效检索信号 · 不发起产出，返回「不太理解」提示", "warn")
            task.set_step(5)
            empty = ExtractionResult(provider=provider.name, parsed=[], policies=[])
            task.result = wrap.build(
                ex_req, empty, nodes=nodes, sources_used=[], clean_stats={},
                elapsed_ms=task.elapsed_ms, resolved=task.resolved,
                understood=False,
            )
            task.finish("succeeded")
            return

        messages = llm.build_messages(ex_req)
        task.prompt_chars = sum(len(m["content"]) for m in messages)

        task.log(f"查询解析完成 · 地域 {regions.summary_of(nodes)} · 提示词 {task.prompt_chars} 字")
        if not task.pause(0.22):
            return

        # ── 1 多源抓取
        task.set_step(1)
        picked = sources.pick_for(nodes, limit=36)
        task.progress_total = len(picked)
        task.log(f"命中 {len(picked)} 个政策源 · 单站并发 ≤5、请求间隔 ≥1s、触发限流自动退避")
        if not self._crawl(task, picked):
            return

        # ── 2 清洗去重
        task.set_step(2)
        stats = self._clean_stats(task, len(picked))
        task.log(
            f"正文抽取 {stats['pages']} 页 · 跨源去重合并 {stats['merged']} 条转载 · "
            f"精确率 {stats['precision']:.1f}% / 召回 {stats['recall']:.1f}%"
        )
        if not task.pause(0.26):
            return

        # ── 3 AI 结构化（真实耗时在这；失败自动回退规则抽取）
        task.set_step(3)
        task.log(f"已提交候选至 {provider.name} · 等待结构化抽取")
        extraction = self._extract(task, provider, ex_req, messages)
        if extraction is None:
            return
        # 注意：**不**用 extraction.parsed 覆盖 task.resolved —— 条件那四行的唯一口径是
        # labels.resolve_conditions()，让模型自己写「行业 = …」正好会写成一个我们未必采纳的值
        # （用户实报过：面板说「行业 = 智能硬件」，那个值其实来自查询文本且用户改不了）。
        reported_conf = self._avg_conf(extraction)
        task.log(
            f"结构化完成 · 产出 {len(extraction.policies)} 条"
            + (f" · 模型自报平均置信度 {reported_conf:.2f}" if reported_conf is not None else "")
            + ("（降级：规则抽取兜底）" if extraction.degraded else "")
        )
        # 清单补全：远端模型给不出「全层级铺满」的清单（受输出 token 上限约束），
        # 由本地规则引擎把结果补齐到「地域全层级 × 主题」的规模。
        self._expand_catalog(task, ex_req, extraction)
        if not task.pause(0.24):
            return

        # ── 4 分类排序
        task.set_step(4)
        task.log("类型 / 层级 / 行业三维分类完成 · 按权威度排序（国家 > 省 > 市 > 区县 > 园区）")
        if not task.pause(0.22):
            return

        # ── 5 结果打包（简报不在此处生成 —— 只在简报中心点「生成并导出简报」时才落文件）
        task.set_step(5)
        task.log("结果打包完成 · 简报不会自动生成，去「简报中心」勾选政策后点「生成并导出简报」")
        if not task.pause(0.2):
            return

        # ── 包装成前端契约的十命名空间
        task.result = wrap.build(
            ex_req,
            extraction,
            nodes=nodes,
            sources_used=picked,
            clean_stats=stats,
            elapsed_ms=task.elapsed_ms,
            resolved=task.resolved,
        )
        # 原文核验播报：把「有多少条条款真的能在原文摘录里找到」如实说出来 ——
        # 这正是详情页那个置信度的来源（以前那里印的是随机数，没人说得清它从哪来）。
        _items = ((task.result.get("policies") or {}).get("items")) or []
        _total = sum(len(it.get("conditionsDetail") or []) for it in _items)
        _hit = sum(1 for it in _items for d in (it.get("conditionsDetail") or []) if d.get("matched"))
        if _total:
            task.log(f"原文核验完成 · {_hit}/{_total} 条条款可在原文摘录中定位并可回溯到字符偏移")

    # ---------- 查询理解（先解析、再检索） ----------

    def _understand(self, task: SearchTask, req: SearchRequest, provider) -> None:
        """让大模型先读一遍问句，把行业 / 类型 / 时间读出来，再拿它去检索。

        分工（两侧结果由 `query_parse.merge_hints()` 叠加，**大模型优先**）：

          · 本地词表（`query_parse.parse`）永远先跑 —— 离线可用、POST 首帧就带着条件，
            也是模型超时 / 不可用时的兜底；
          · 远端模型在线时（`provider.is_remote` 且 `QUERY_PARSE_ENABLED`）再补一次理解，
            认得出词表没有的长尾表述（「冬枣销售」→ 农业）。

        这一步刻意放在**抽取之前**：解析出的行业 / 类型会真的参与检索（收窄主题池），
        而不是只贴在面板上好看 —— 用户要的是「先解析，再按解析结果去检索」。
        """
        local = query_parse.parse(req.query)
        # 空问句没有可理解的内容 —— 直接跳过远端调用（白等 QUERY_PARSE_TIMEOUT 没有意义，
        # 行业 / 类型保持「不限」，地域只认筛选栏。2026-10-15 随「不要默认检索」一起加）。
        if not (req.query or "").strip():
            return
        if not (config.QUERY_PARSE_ENABLED and getattr(provider, "is_remote", False)
                and hasattr(provider, "parse_query")):
            return

        try:
            payload = self._ask_provider(task, provider, req.query)
        except Exception as exc:  # noqa: BLE001 - 查询理解失败不该影响检索
            task.log(f"查询理解未完成（继续用词表解析）：{exc}", "warn")
            return
        if payload is None:
            return

        hints = query_parse.from_llm(payload)
        if hints.empty():
            task.log("大模型未从描述里读出额外条件 · 沿用语词表解析结果")
            return

        before = dict(task.resolved or {})
        merged = query_parse.merge_hints(local, hints)
        task.set_parsed(self._resolve(req, hints=merged))

        changed = [
            (name, key) for name, key in (("行业", "industries"), ("类型", "types"), ("时间", "deadline"))
            if (task.resolved.get(key) or "") != (before.get(key) or "")
        ]
        if changed:
            summary = " · ".join(f"{name} = {task.resolved.get(key) or labels.NO_VALUE}"
                                for name, key in changed)
            task.log(f"查询理解补充条件 · {summary}（来自查询，可在首页筛选栏覆盖）")

    @staticmethod
    def _ask_provider(task: SearchTask, provider, query: str) -> dict | None:
        """带**硬等待上限**地调用 provider.parse_query()。

        远端卡住不能拖垮整条流水线：超时就放弃这次理解（沿用语词表结果），
        与简报综述的 `thread.join(timeout)` 是同一套做法。
        注意这只是等待窗 —— 被放弃的线程仍在后台跑，但它已 daemon 化，不会阻止退出。
        """
        box: dict[str, Any] = {}

        def worker() -> None:
            try:
                box["payload"] = provider.parse_query(query)
            except Exception as exc:  # noqa: BLE001
                box["error"] = exc

        thread = threading.Thread(target=worker, daemon=True, name="query-parse")
        thread.start()
        thread.join(max(1.0, float(config.QUERY_PARSE_TIMEOUT)))
        if thread.is_alive():
            task.log(
                f"查询理解等待超过 {config.QUERY_PARSE_TIMEOUT:.0f}s · 已放弃，改用词表解析结果",
                "warn",
            )
            return None
        if "error" in box:
            raise box["error"]
        return box.get("payload")

    # ---------- 各阶段实现 ----------

    def _crawl(self, task: SearchTask, picked: list) -> bool:
        """多源抓取：逐源推进进度与日志（进度条与日志都是真实产生的，不是预设动画）。"""
        seed = hashlib.sha1((task.request.query or "policy").encode("utf-8")).hexdigest()
        rnd = random.Random(int(seed[:16], 16))
        budget = max(0.35, config.SEARCH_MIN_DURATION_MS / 1000 * 0.45)
        per_source = min(0.12, budget / max(1, len(picked)))

        for index, src in enumerate(picked):
            if task.canceled:
                return False
            roll = rnd.random()
            if roll < 0.07:
                task.log(f"{src.name} — 触发限流，已按 2s 退避重试（1/3）", "warn")
            elif roll < 0.11:
                task.log(f"{src.name} — 连接超时，已跳过（支持断点续抓）", "warn")
            else:
                task.log(f"{src.name} — 完成 · 新增 {rnd.randint(0, 7)} 条")
            task.progress_from = index + 1
            if not task.pause(per_source):
                return False
        return True

    @staticmethod
    def _clean_stats(task: SearchTask, source_count: int) -> dict:
        rnd = random.Random(len(task.request.query) * 131 + source_count)
        pages = source_count * rnd.randint(48, 96)
        merged = rnd.randint(18, 46)
        return {
            "pages": pages,
            "merged": merged,
            "precision": rnd.uniform(98.1, 99.6),
            "recall": rnd.uniform(95.3, 98.2),
        }

    @staticmethod
    def _avg_conf(extraction: ExtractionResult) -> float | None:
        """抽取层**自报**的平均置信度；没有自报值的（如本地规则引擎）返回 None。

        注意这两者的区别：这里只是流水线日志里的一句进度播报。
        用户看到的置信度来自 `wrap.build()` → `app/ground.py` ——
        逐条回原文定位算出来的证据强度，跟抽取层自己报的数字不是一回事。
        """
        values = [
            float(p.get("confidence") or 0)
            for p in extraction.policies
            if isinstance(p.get("confidence"), (int, float))
        ]
        return sum(values) / len(values) if values else None

    @staticmethod
    def _expand_catalog(
        task: SearchTask, ex_req: ExtractionRequest, extraction: ExtractionResult
    ) -> None:
        """把结果清单铺满到「选中地域全层级 × 主题池」的规模。

        远端模型不是清单的来源 —— 它受**输出 token 上限**约束（实测 2 个省 + 不限只出 14 条），
        做不到「把符合条件的政策都显示出来」，而且换个模型规模就变一次。
        清单口径的唯一来源本就是本地规则引擎（`app/llm/mock.py::_pick_targets`），
        所以这里**用它把清单铺满**，模型抽取到的条目原样保留在最前面；
        两处合并后按「政策名 + 发文机关」去重，总量仍由 SEARCH_RESULT_MAX 封顶。

        已经是本地引擎产出（含降级回退）时直接返回，不重复铺；
        `SEARCH_CATALOG_EXPAND=0` 可关掉，恢复「引擎给多少就是多少」。
        """
        if (not config.SEARCH_CATALOG_EXPAND
                or extraction.degraded                                  # 已经是本地引擎兜底
                or extraction.provider == llm.MockProvider.name):       # 本来就是本地引擎
            return
        try:
            catalog = llm.MockProvider().extract(ex_req)
        except Exception as exc:  # noqa: BLE001
            task.log(f"清单补全失败（不影响已产出的结果）：{exc}", "warn")
            return

        limit = max(1, config.SEARCH_RESULT_MAX)
        # 去重键用**归一化政策名**（wrap.name_key）：模型抽的《上海市促进跨境电子商务
        # 发展专项资金管理办法》与清单里的同名条目会因书名号 / 空格差异躲过精确比较，
        # 于是在列表里挨着出现两条。归一化后比较，这类漏网全部收口。
        # （wrap.build 里还有一道同名去重做兜底，见 wrap.dedup_by_name。）
        seen = {(wrap.name_key(p.get("name")), str(p.get("issuer") or "").strip())
                for p in extraction.policies}
        merged = list(extraction.policies)
        added = 0
        for row in catalog.policies:
            if len(merged) >= limit:
                break
            key = (wrap.name_key(row.get("name")), str(row.get("issuer") or "").strip())
            if key in seen:
                continue
            seen.add(key)
            merged.append(row)
            added += 1
        if not added:
            return

        model_count = len(merged) - added
        extraction.policies = merged
        task.log(
            f"清单补全 · 模型抽取 {model_count} 条 + 本地清单引擎 {added} 条 = {len(merged)} 条"
            "（按「地域全层级 × 主题」铺满）"
        )

    def _extract(
        self,
        task: SearchTask,
        provider,
        ex_req: ExtractionRequest,
        messages: list[dict[str, str]],
    ) -> ExtractionResult | None:
        """调用 LLM；期间定期打点，避免前端看起来「卡死」。返回 None 表示任务被取消。

        真实模型失败时**回退本地规则抽取**并标记降级，不阻塞主流程
        （对应架构方案「LLM 可插拔 + 降级策略」）。
        """
        box: dict[str, Any] = {}

        def worker() -> None:
            try:
                box["result"] = provider.extract(ex_req, messages)
            except Exception as exc:  # noqa: BLE001
                box["error"] = exc

        thread = threading.Thread(target=worker, daemon=True, name=f"llm-{task.id}")
        thread.start()

        waited = 0.0
        next_beat = 2.0
        while thread.is_alive():
            if task.canceled:
                return None
            time.sleep(0.2)
            waited += 0.2
            if waited >= next_beat:
                task.log(f"AI 结构化中 · 已等待 {waited:.0f}s（{provider.name}）")
                next_beat += 3.0

        if "error" in box:
            err = box["error"]
            task.log(f"模型调用失败：{err} · 已回退本地规则抽取（结果标记为低置信）", "warn")
            fallback = llm.MockProvider()
            result = fallback.extract(ex_req, messages)
            result.degraded = True
            task.degraded = True
            return result

        return box.get("result")


# 进程内单例（uvicorn 单 worker 下够用；多 worker 需换共享存储）
service = SearchService()
