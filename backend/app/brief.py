"""政策简报：把选定的政策清单生成**可下载的真实文件**（XLSX / DOCX / PDF）。

为什么放在后端
--------------
  · 「三格式真文件」要在服务端打包 OOXML（zip + xml）与排版 PDF，浏览器端做不了；
  · 「AI 综述」直接复用后端已配置好的大模型通道（与检索抽取同一套 provider）。

分工（对应 UI 上那两个设置）
--------------------------
  清单  ← 结构化数据直接拼装。条目、金额、日期**不经模型改写**，不会失真、不会漏条目。
  综述  ← 大模型写一段 180~300 字的短文案。它只「看趋势」，不复述全部条目，所以输出短、
          等待可控（`BRIEF_SUMMARY_TIMEOUT`，默认 60s）。超时/失败 → 规则文案兜底。
  模板  ← onepage（精简列）/ detail（含申请条件与材料）。
  范围  ← picked（用户勾选的）/ filtered（当前结果集）。

文件命名：`政策简报_YYYY-MM-DD_<范围>.<ext>`，落盘为 `<briefId>__<友好名>`，
所以**重启后仍能按 id 下载**，不必依赖内存索引。
"""
from __future__ import annotations

import re
import sys
import threading
import time
import uuid
import zipfile
from datetime import date
from html import escape as _esc
from pathlib import Path
from typing import Any

from . import config, llm

# ---------- 格式登记 ----------

_XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
_DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
_PDF_MIME = "application/pdf"

_FORMATS: dict[str, tuple[str, str]] = {
    "xlsx": ("xlsx", _XLSX_MIME),
    "docx": ("docx", _DOCX_MIME),
    "pdf": ("pdf", _PDF_MIME),
}
# 前端把 Doc 选项的值写成 doc，这里一并接受
_FORMAT_ALIAS = {"doc": "docx", "word": "docx", "excel": "xlsx"}

_TEMPLATES = ("onepage", "detail")
_SCOPES = ("picked", "filtered")

_ILLEGAL = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


class BriefError(RuntimeError):
    """简报生成失败（消息直接给用户看）。"""

    def __init__(self, message: str, code: str = "BRIEF_FAILED") -> None:
        super().__init__(message)
        self.code = code


# ---------- 字段归一化（前端契约 → 渲染用） ----------

def _txt(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (list, tuple)):
        return " / ".join(_txt(v) for v in value if _txt(v))
    return str(value).strip()


def _items(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [p.strip() for p in re.split(r"[；;、,，\n]", value) if p.strip()]
    if isinstance(value, (list, tuple)):
        return [_txt(v) for v in value if _txt(v)]
    return [_txt(value)]


def _norm_policy(raw: Any) -> dict[str, str] | None:
    """一条政策 → 渲染用的平面字段。缺字段退化成空串，绝不抛。"""
    if not isinstance(raw, dict):
        return None
    name = _txt(raw.get("name"))
    if not name:
        return None

    sources = raw.get("sources") or []
    source_name = ""
    if isinstance(sources, list) and sources:
        first = sources[0]
        source_name = _txt(first.get("name")) if isinstance(first, dict) else _txt(first)
    extra = len(sources) - 1 if isinstance(sources, list) else 0

    days = raw.get("daysLeft")
    if not isinstance(days, (int, float)):
        days = None

    return {
        "name": name,
        "level": _txt(raw.get("level")),
        "issuer": _txt(raw.get("issuer")),
        "types": _txt(raw.get("types")),
        "industries": _txt(raw.get("industries")),
        "publish": _txt(raw.get("publish")),
        "deadline": _txt(raw.get("deadline")),
        "daysLeft": "" if days is None else str(int(days)),
        "subsidy": _txt(raw.get("subsidy")),
        "conditions": "、".join(_items(raw.get("conditions"))),
        "conditionsFull": "\n".join(_items(raw.get("conditionsFull"))),
        "materials": "、".join(_items(raw.get("materials"))),
        "source": source_name + (f"（多源合并 {extra + 1} 条）" if extra > 0 else ""),
        "confidence": _txt(raw.get("confidence")),
        "matched": _txt(raw.get("matched")),
    }


def _norm_payload(payload: Any) -> dict:
    """校验并归一化请求体。"""
    payload = payload if isinstance(payload, dict) else {}

    fmt = _txt(payload.get("format")).lower() or "xlsx"
    fmt = _FORMAT_ALIAS.get(fmt, fmt)
    if fmt not in _FORMATS:
        raise BriefError(f"不支持的导出格式：{fmt}（可选 {' / '.join(_FORMATS)}）", "BAD_FORMAT")

    template = _txt(payload.get("template")).lower() or "onepage"
    if template not in _TEMPLATES:
        template = "onepage"

    scope = _txt(payload.get("scope")).lower() or "picked"
    if scope not in _SCOPES:
        scope = "picked"

    raw_list = payload.get("policies")
    if not isinstance(raw_list, list):
        raise BriefError("请求体缺少 policies 数组", "NO_POLICIES")

    policies = [p for p in (_norm_policy(x) for x in raw_list) if p]
    if not policies:
        raise BriefError(
            "没有可导出的政策：请先在结果列表勾选政策（或把导出范围切到「当前筛选结果」）",
            "EMPTY_POLICIES",
        )

    return {
        "format": fmt,
        "template": template,
        "scope": scope,
        "scopeLabel": _txt(payload.get("scopeLabel")) or f"{len(policies)} 条政策",
        "conditions": [_txt(c) for c in (payload.get("conditions") or []) if _txt(c)],
        "policies": policies,
    }


# ---------- 综述：大模型优先，规则兜底 ----------

def rule_summary(policies: list[dict[str, str]], conditions: list[str]) -> str:
    """规则文案：不调模型也能给出一段有用的综述，保证「一定能导出」。"""
    total = len(policies)
    tally: dict[str, int] = {}
    for p in policies:
        tally[p["level"] or "未标注"] = tally.get(p["level"] or "未标注", 0) + 1
    order = ["国家级", "省级", "市级", "区县级", "园区级", "未标注"]
    mix = "、".join(f"{lv} {tally[lv]} 条" for lv in order if lv in tally)

    soon: list[dict[str, str]] = []
    for p in policies:
        try:
            left = int(p["daysLeft"])
        except (TypeError, ValueError):
            continue
        if 0 <= left <= 30:
            soon.append(p)
    soon.sort(key=lambda x: int(x["daysLeft"]))

    level_line = f"本次共收录 {total} 条政策，层级构成为：{mix}。" if mix else f"本次共收录 {total} 条政策。"

    parts = [level_line]
    if soon:
        head = "；".join(f"{p['name']}（{p['daysLeft']} 天后截止）" for p in soon[:3])
        parts.append(f"其中 {len(soon)} 条将在 30 天内截止，建议优先核验：{head}。")
    else:
        parts.append("所选政策均未在 30 天内截止，可按重要程度安排申报顺序。")

    cond_line = "、".join(conditions) if conditions else "未指定额外条件"
    parts.append(
        f"本次检索条件为：{cond_line}。共性材料通常包括营业执照、财务报表与相关发票凭证，"
        "建议按各条政策的材料清单逐项核对后再提交。"
    )
    return "".join(parts)


_MD_LINE = re.compile(r"^\s{0,3}(?:[#>*\-+]|\d+[.)])\s*")
_MD_BOLD = re.compile(r"\*{1,3}|`{1,3}|_{1,2}")


def _clean_summary(text: str) -> str:
    """清掉模型爱加的 markdown 记号与空行，保留段落。"""
    lines = []
    for raw in (text or "").splitlines():
        line = _MD_BOLD.sub("", _MD_LINE.sub("", raw)).strip()
        if line:
            lines.append(line)
    joined = "\n".join(lines).strip()
    return joined.strip("「」\"'")


def ai_summary(payload: dict) -> tuple[str, str, str]:
    """生成综述。返回 (文案, 来源, 说明)；来源 ∈ {"llm", "rule"}。"""
    policies = payload["policies"]
    conditions = payload["conditions"]

    try:
        provider = llm.build_provider("brief")   # 简报用途：可单独配模型；默认关思考保出稿速度
    except Exception as exc:  # noqa: BLE001 - 没配 Key 等，直接规则兜底
        return rule_summary(policies, conditions), "rule", f"模型不可用（{exc}）"

    if not getattr(provider, "is_remote", False):
        # 本地规则引擎写不出像样的综述，直接用规则文案，不必绕一圈
        return rule_summary(policies, conditions), "rule", "当前为本地规则引擎（未调用远端模型）"

    messages = llm.build_brief_messages(payload)
    box: dict[str, Any] = {}

    def worker() -> None:
        try:
            # 复用上面那份 provider：不再走 llm.complete() 里的第二次 build_provider()，
            # 少一个「跑到线程池外面去」的可能。
            box["text"] = provider.complete(
                messages,
                max_tokens=config.BRIEF_SUMMARY_MAX_TOKENS,
                timeout=config.BRIEF_SUMMARY_TIMEOUT,
                temperature=0.3,
                retries=0,
            )
        except Exception as exc:  # noqa: BLE001
            box["error"] = exc

    thread = threading.Thread(target=worker, daemon=True, name="brief-summary")
    thread.start()
    # **硬上限**：`provider.complete` 的 socket 超时是「每次读操作」的，服务端只要持续吐字节
    # （实测确有网关注入空白保活）就永远不会触发；所以真正的兜底是这道 join 截止。
    # 用量：`tools/_stall_llm.py` + BRIEF_SUMMARY_TIMEOUT=3 → 实测 11.0s 返回（= 3 + 8 余量），
    # 而不是等满桩的 20s。改这里务必重跑该实验。
    thread.join(config.BRIEF_SUMMARY_TIMEOUT + 8)

    if thread.is_alive():
        return rule_summary(policies, conditions), "rule", \
            f"模型 {config.BRIEF_SUMMARY_TIMEOUT:.0f}s 内未返回，已改用规则文案"
    if "error" in box:
        return rule_summary(policies, conditions), "rule", f"模型调用失败（{box['error']}）"

    text = _clean_summary(box.get("text") or "")
    if len(text) < 40:                      # 太短基本是无效输出
        return rule_summary(policies, conditions), "rule", "模型返回内容过短，已改用规则文案"
    return text, "llm", "由大模型生成"


# ---------- 渲染：三格式 ----------

_ROWS_FULL = (
    ("序号", "name", "level", "issuer", "types", "industries",
     "publish", "deadline", "daysLeft", "subsidy", "conditions", "materials", "source", "confidence"),
)
_COLS_FULL = [
    ("序号", 6), ("政策名称", 46), ("层级", 8), ("发文机关", 26), ("政策类型", 16),
    ("适用行业", 18), ("发布时间", 12), ("截止日期", 12), ("剩余天数", 9),
    ("补贴标准", 40), ("申请条件（要点）", 30), ("申报材料", 30), ("数据来源", 24), ("置信度", 8),
]
_COLS_LITE = [
    ("序号", 6), ("政策名称", 52), ("层级", 8), ("发文机关", 28),
    ("截止日期", 12), ("剩余天数", 9), ("补贴标准", 46), ("数据来源", 24),
]


def _table(payload: dict) -> tuple[list[str], list[list[str]]]:
    """表头 + 数据行（按模板决定列）。"""
    full = payload["template"] == "detail"
    cols = _COLS_FULL if full else _COLS_LITE
    header = [c[0] for c in cols]

    rows: list[list[str]] = []
    for i, p in enumerate(payload["policies"], 1):
        if full:
            rows.append([
                str(i), p["name"], p["level"], p["issuer"], p["types"], p["industries"],
                p["publish"], p["deadline"], p["daysLeft"], p["subsidy"],
                p["conditions"], p["materials"], p["source"], p["confidence"],
            ])
        else:
            rows.append([
                str(i), p["name"], p["level"], p["issuer"],
                p["deadline"], p["daysLeft"], p["subsidy"], p["source"],
            ])
    return header, rows


def _head_meta(payload: dict, summary_source: str) -> list[str]:
    lines = [
        f"导出时间：{date.today().isoformat()}",
        f"导出范围：{payload['scopeLabel']}",
        f"政策条数：{len(payload['policies'])} 条",
        f"简报模板：{'详版（含全部字段与来源）' if payload['template'] == 'detail' else '一页纸（精简字段）'}",
        "综述来源：" + ("大模型生成" if summary_source == "llm" else "本地规则生成"),
    ]
    if payload["conditions"]:
        lines.append("检索条件：" + "；".join(payload["conditions"]))
    return lines


_DISCLAIMER = (
    "免责声明：本简报由 AI 自动聚合公开政策生成，仅供内部参考，不构成申报建议。"
    "本工具仅聚合与结构化公开政策原文，请以官方发布文本为准。"
)


# ---- XLSX（零依赖：手写 OOXML） ----

_STYLES_XML = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="4">
<font><sz val="11"/><name val="\u5b8b\u4f53"/></font>
<font><b/><sz val="11"/><color rgb="FF1F2937"/><name val="\u5b8b\u4f53"/></font>
<font><sz val="10"/><color rgb="FF6B7280"/><name val="\u5b8b\u4f53"/></font>
<font><b/><sz val="14"/><color rgb="FF111827"/><name val="\u5b8b\u4f53"/></font>
</fonts>
<fills count="3">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFEFF6FF"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color rgb="FFD1D5DB"/></left><right style="thin"><color rgb="FFD1D5DB"/></right><top style="thin"><color rgb="FFD1D5DB"/></top><bottom style="thin"><color rgb="FFD1D5DB"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="5">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>"""


def _col_name(index: int) -> str:
    """1 → A, 27 → AA。"""
    out = ""
    while index > 0:
        index, rem = divmod(index - 1, 26)
        out = chr(65 + rem) + out
    return out


def _cell(ref: str, text: str, style: int) -> str:
    if text == "":
        return f'<c r="{ref}" s="{style}"/>'
    return (f'<c r="{ref}" s="{style}" t="inlineStr">'
            f'<is><t xml:space="preserve">{_esc(text)}</t></is></c>')


def _sheet_xml(rows: list[list[tuple[str, int]]], widths: list[int], freeze: int = 0) -> str:
    cols = "".join(
        f'<col min="{i + 1}" max="{i + 1}" width="{w}" customWidth="1"/>'
        for i, w in enumerate(widths)
    )
    body = []
    for r, row in enumerate(rows, 1):
        cells = "".join(_cell(_col_name(c + 1) + str(r), text, style)
                        for c, (text, style) in enumerate(row))
        body.append(f'<row r="{r}">{cells}</row>')
    pane = ""
    if freeze:
        pane = (f'<sheetViews><sheetView workbookViewId="0">'
                f'<pane ySplit="{freeze}" topLeftCell="A{freeze + 1}" activePane="bottomLeft" state="frozen"/>'
                f'</sheetView></sheetViews>')
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            f'{pane}<cols>{cols}</cols><sheetData>{"".join(body)}</sheetData></worksheet>')


def render_xlsx(payload: dict, summary: str) -> bytes:
    header, rows = _table(payload)
    cols = _COLS_FULL if payload["template"] == "detail" else _COLS_LITE

    # Sheet1：政策清单（标题 + 表头 + 数据 + 免责声明；元信息统一放 Sheet2）
    s1: list[list[tuple[str, int]]] = [
        [(f"企业扶持政策简报 · 政策清单（{payload['scopeLabel']}）", 3)]
    ]
    s1.append([(h, 1) for h in header])
    for row in rows:
        s1.append([(cell, 2) for cell in row])
    s1.append([(_DISCLAIMER, 4)])
    sheet1 = _sheet_xml(s1, [w for _, w in cols], freeze=2)

    # Sheet2：简报综述
    s2: list[list[tuple[str, int]]] = [[("企业扶持政策简报 · 综述", 3)]]
    for line in _head_meta(payload, payload["_summarySource"]):
        s2.append([(line, 4)])
    s2.append([("", 0)])
    for para in summary.splitlines():
        s2.append([(para, 2)])
    s2.append([("", 0)])
    s2.append([(_DISCLAIMER, 4)])
    sheet2 = _sheet_xml(s2, [110], freeze=0)

    content_types = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
        '</Types>')
    rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
        '</Relationships>')
    workbook = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        '<sheets>'
        '<sheet name="\u653f\u7b56\u6e05\u5355" sheetId="1" r:id="rId1"/>'
        '<sheet name="\u7b80\u62a5\u7efc\u8ff0" sheetId="2" r:id="rId2"/>'
        '</sheets></workbook>')
    wb_rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>'
        '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
        '</Relationships>')

    import io
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", content_types)
        z.writestr("_rels/.rels", rels)
        z.writestr("xl/workbook.xml", workbook)
        z.writestr("xl/_rels/workbook.xml.rels", wb_rels)
        z.writestr("xl/styles.xml", _STYLES_XML)
        z.writestr("xl/worksheets/sheet1.xml", sheet1)
        z.writestr("xl/worksheets/sheet2.xml", sheet2)
    return buf.getvalue()


# ---- DOCX（零依赖：手写 OOXML） ----

_DOCX_STYLES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr>
<w:rFonts w:ascii="\u7b49\u7ebf" w:eastAsia="\u7b49\u7ebf" w:hAnsi="\u7b49\u7ebf"/>
<w:sz w:val="21"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault>
</w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
</w:styles>"""


def _para(text: str = "", *, size: int = 21, bold: bool = False, color: str = "",
          align: str = "", indent: int = 0, space_after: int = 120) -> str:
    """一个 Word 段落。size 用半磅（21 = 10.5pt）。"""
    props = [f'<w:spacing w:after="{space_after}" w:line="300" w:lineRule="auto"/>']
    if align:
        props.append(f'<w:jc w:val="{align}"/>')
    if indent:
        props.append(f'<w:ind w:left="{indent}"/>')
    run = ["<w:rPr>"]
    if bold:
        run.append("<w:b/>")
    if color:
        run.append(f'<w:color w:val="{color}"/>')
    run.append(f'<w:sz w:val="{size}"/>')
    run.append('<w:rFonts w:ascii="\u7b49\u7ebf" w:eastAsia="\u7b49\u7ebf" w:hAnsi="\u7b49\u7ebf"/>')
    run.append("</w:rPr>")
    body = f'<w:t xml:space="preserve">{_esc(text)}</w:t>' if text else ""
    return f'<w:p><w:pPr>{"".join(props)}</w:pPr><w:r>{"".join(run)}{body}</w:r></w:p>'


def render_docx(payload: dict, summary: str) -> bytes:
    full = payload["template"] == "detail"
    parts: list[str] = [
        _para("企业扶持政策简报", size=36, bold=True, align="center", space_after=60),
        _para(payload["scopeLabel"], size=20, color="6B7280", align="center", space_after=200),
    ]
    for line in _head_meta(payload, payload["_summarySource"]):
        parts.append(_para(line, size=18, color="6B7280", space_after=40))

    parts.append(_para("一、简报综述", size=26, bold=True, space_after=100))
    for para in (summary or "").splitlines():
        parts.append(_para(para, size=21, indent=200, space_after=100))

    parts.append(_para("二、政策清单", size=26, bold=True, space_after=100))
    for i, p in enumerate(payload["policies"], 1):
        parts.append(_para(f"{i}. {p['name']}", size=22, bold=True, space_after=60))
        line2 = f"层级：{p['level']}　发文机关：{p['issuer']}"
        if full and p["types"]:
            line2 += f"　类型：{p['types']}"
        parts.append(_para(line2, size=20, color="374151", indent=200, space_after=40))
        line3 = f"截止：{p['deadline']}"
        if p["daysLeft"]:
            line3 += f"（剩 {p['daysLeft']} 天）"
        if p["subsidy"]:
            line3 += f"　补贴：{p['subsidy']}"
        parts.append(_para(line3, size=20, color="374151", indent=200, space_after=40))
        if full:
            if p["conditionsFull"]:
                for idx, cond in enumerate(p["conditionsFull"].splitlines(), 1):
                    parts.append(_para(f"申请条件 {idx}：{cond}", size=19, color="4B5563",
                                       indent=360, space_after=30))
            if p["materials"]:
                parts.append(_para(f"申报材料：{p['materials']}", size=19, color="4B5563",
                                   indent=360, space_after=30))
        else:
            if p["conditions"]:
                parts.append(_para(f"申请条件：{p['conditions']}", size=19, color="4B5563",
                                   indent=200, space_after=30))
        if p["source"]:
            parts.append(_para(f"来源：{p['source']}", size=19, color="9CA3AF",
                               indent=200, space_after=160))

    parts.append(_para(_DISCLAIMER, size=18, color="9CA3AF", space_after=0))

    document = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        f'<w:body>{"".join(parts)}'
        '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
        '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr>'
        '</w:body></w:document>')
    content_types = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
        '</Types>')
    rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
        '</Relationships>')
    doc_rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
        '</Relationships>')

    import io
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", content_types)
        z.writestr("_rels/.rels", rels)
        z.writestr("word/document.xml", document)
        z.writestr("word/_rels/document.xml.rels", doc_rels)
        z.writestr("word/styles.xml", _DOCX_STYLES)
    return buf.getvalue()


# ---- PDF（reportlab：内置中文 CID 字体，无需字体文件） ----

_CJK_FONT = "STSong-Light"
_cjk_ready = False


def pdf_available() -> bool:
    try:
        import reportlab  # noqa: F401
    except Exception:  # noqa: BLE001
        return False
    return True


def _ensure_cjk() -> None:
    """注册内置中文 CID 字体（只需一次）。"""
    global _cjk_ready
    if _cjk_ready:
        return
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont

    if _CJK_FONT not in pdfmetrics.getRegisteredFontNames():
        pdfmetrics.registerFont(UnicodeCIDFont(_CJK_FONT))
    _cjk_ready = True


def render_pdf(payload: dict, summary: str) -> bytes:
    if not pdf_available():
        raise BriefError(
            "PDF 需要 reportlab：请在 backend 目录执行 "
            "`.venv/Scripts/python -m pip install reportlab`（或改导出 XLSX / DOCX）",
            "PDF_UNAVAILABLE",
        )
    import io

    from reportlab.lib import colors
    from reportlab.lib.enums import TA_CENTER
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer

    _ensure_cjk()
    full = payload["template"] == "detail"

    def style(name: str, size: float, *, bold: bool = False, color: str = "1F2937",
              indent: float = 0, space: float = 4, align: int = 0) -> ParagraphStyle:
        return ParagraphStyle(
            name, fontName=_CJK_FONT, fontSize=size, leading=size * 1.6,
            textColor=colors.HexColor("#" + color), alignment=align,
            leftIndent=indent, spaceAfter=space, wordWrap="CJK",
        )

    title = style("t", 16, bold=True, color="111827", align=TA_CENTER, space=2)
    sub = style("s", 9, color="6B7280", align=TA_CENTER, space=10)
    meta = style("m", 8, color="6B7280", space=1)
    h2 = style("h2", 12, bold=True, color="111827", space=6)
    body = style("b", 9.5, color="374151", indent=10, space=4)
    pname = style("pn", 10, bold=True, color="1F2937", space=1)
    pline = style("pl", 8.8, color="4B5563", indent=10, space=1)
    foot = style("f", 7.5, color="9CA3AF", space=0)

    flow: list[Any] = [
        Paragraph(_esc("企业扶持政策简报"), title),
        Paragraph(_esc(payload["scopeLabel"]), sub),
    ]
    for line in _head_meta(payload, payload["_summarySource"]):
        flow.append(Paragraph(_esc(line), meta))
    flow.append(Spacer(1, 6))

    flow.append(Paragraph("一、简报综述", h2))
    for para in (summary or "").splitlines():
        flow.append(Paragraph(_esc(para), body))

    flow.append(Spacer(1, 8))
    flow.append(Paragraph("二、政策清单", h2))
    for i, p in enumerate(payload["policies"], 1):
        flow.append(Paragraph(_esc(f"{i}. {p['name']}"), pname))
        line2 = f"层级：{p['level']}｜发文机关：{p['issuer']}"
        if full and p["types"]:
            line2 += f"｜类型：{p['types']}"
        flow.append(Paragraph(_esc(line2), pline))
        line3 = f"截止：{p['deadline']}"
        if p["daysLeft"]:
            line3 += f"（剩 {p['daysLeft']} 天）"
        if p["subsidy"]:
            line3 += f"｜补贴：{p['subsidy']}"
        flow.append(Paragraph(_esc(line3), pline))
        if full:
            for idx, cond in enumerate(p["conditionsFull"].splitlines(), 1):
                flow.append(Paragraph(_esc(f"申请条件 {idx}：{cond}"), pline))
            if p["materials"]:
                flow.append(Paragraph(_esc(f"申报材料：{p['materials']}"), pline))
        elif p["conditions"]:
            flow.append(Paragraph(_esc(f"申请条件：{p['conditions']}"), pline))
        if p["source"]:
            flow.append(Paragraph(_esc(f"来源：{p['source']}"), pline))
        flow.append(Spacer(1, 5))

    flow.append(Spacer(1, 6))
    flow.append(Paragraph(_esc(_DISCLAIMER), foot))

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        leftMargin=16 * mm, rightMargin=16 * mm, topMargin=16 * mm, bottomMargin=16 * mm,
        title="企业扶持政策简报", author="AI 政策搜索智能体",
    )
    doc.build(flow)
    return buf.getvalue()


_RENDERERS = {"xlsx": render_xlsx, "docx": render_docx, "pdf": render_pdf}


# ---------- 落盘与下载 ----------

def _friendly_name(payload: dict) -> str:
    ext = _FORMATS[payload["format"]][0]
    scope = _ILLEGAL.sub("", payload["scopeLabel"]).strip() or "政策"
    return f"政策简报_{date.today().isoformat()}_{scope}.{ext}"


def _prune() -> None:
    """只保留最近 BRIEF_KEEP 份，避免无限增长。"""
    try:
        files = sorted(config.BRIEF_DIR.glob("*"), key=lambda p: p.stat().st_mtime, reverse=True)
        for old in files[max(1, config.BRIEF_KEEP):]:
            try:
                old.unlink()
            except OSError:
                pass
    except OSError:
        pass


def create_brief(payload: Any) -> dict:
    """生成简报文件。返回给前端的元数据（含下载地址）。"""
    started = time.monotonic()
    norm = _norm_payload(payload)

    summary, source, note = ai_summary(norm)
    norm["_summarySource"] = source
    blob = _RENDERERS[norm["format"]](norm, summary)

    config.BRIEF_DIR.mkdir(parents=True, exist_ok=True)
    brief_id = uuid.uuid4().hex[:12]
    friendly = _friendly_name(norm)
    path: Path = config.BRIEF_DIR / f"{brief_id}__{friendly}"
    path.write_bytes(blob)
    _prune()

    return {
        "briefId": brief_id,
        "fileName": friendly,
        "downloadUrl": f"/api/v1/briefs/{brief_id}/download",
        "mediaType": _FORMATS[norm["format"]][1],
        "bytes": len(blob),
        "count": len(norm["policies"]),
        "format": norm["format"],
        "template": norm["template"],
        "scope": norm["scope"],
        "summary": summary,
        "summarySource": source,
        "summaryNote": note,
        # 单调时钟：墙钟可能被 NTP 校正/进程挂起拉偏，耗时口径必须单调
        "elapsedMs": int((time.monotonic() - started) * 1000),
    }


def _locate(brief_id: str) -> Path | None:
    """按 id 找文件：`<id>__<友好名>`，重启后依旧可命中（不依赖内存索引）。"""
    safe = re.sub(r"[^0-9a-zA-Z]", "", brief_id or "")
    if not safe:
        return None
    try:
        matches = sorted(config.BRIEF_DIR.glob(f"{safe}__*"))
    except OSError:
        return None
    return matches[0] if matches else None


def brief_path(brief_id: str) -> Path | None:
    return _locate(brief_id)


def friendly_of(path: Path) -> str:
    name = path.name
    return name.split("__", 1)[1] if "__" in name else name


def _downloads_dir() -> Path | None:
    """用户的「下载」文件夹（浏览器另存的默认去处）。

    Windows 优先读注册表里资源管理器的真实已知文件夹（被挪过盘符也能跟到），
    读不到再退 `~/Downloads`；非 Windows 一律 `~/Downloads`。
    """
    import os
    from pathlib import Path as _P

    home = _P(os.path.expanduser("~"))
    if sys.platform.startswith("win"):
        try:
            import winreg

            key_path = (
                r"Software\Microsoft\Windows\CurrentVersion"
                r"\Explorer\User Shell Folders"
            )
            # {374DE290-…} 是资源管理器「下载」目录的官方 Known Folder GUID
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path) as k:
                raw, _ = winreg.QueryValueEx(k, "{374DE290-123F-4565-9164-39C4925E467B}")
                raw = os.path.expandvars(raw) if isinstance(raw, str) else ""
                if raw:
                    p = _P(raw)
                    if p.is_dir():
                        return p
        except Exception:
            pass  # 注册表读不到就退默认位置
    fallback = home / "Downloads"
    return fallback if fallback.is_dir() else None


def _find_downloaded(friendly: str, downloads: Path) -> Path | None:
    """在下载文件夹里找浏览器刚存下来的那份：先精确同名，再按「同名 + (1)」重名规则。"""
    try:
        exact = downloads / friendly
        if exact.is_file():
            return exact
        stem = friendly.rsplit(".", 1)[0]
        ext = friendly.rsplit(".", 1)[-1]
        # 浏览器对重名文件会存成「xxx (1).pdf」——按前缀匹配，取最新一份
        cands = [p for p in downloads.glob(f"{stem}*") if p.suffix.lower() == f".{ext.lower()}"]
        return max(cands, key=lambda p: p.stat().st_mtime) if cands else None
    except OSError:
        return None


def reveal(brief_id: str) -> dict:
    """打开「文件所在文件夹」。

    用户真正拿到手的文件是**浏览器下载**的那份（默认在「下载」文件夹），
    服务端 `_briefs` 里那份只是生成源 —— 所以这里优先去下载文件夹定位：
      · 找到同名文件 → 资源管理器选中它；
      · 没找到（被改名 / 挪走）→ 打开下载文件夹让用户自己看最新下载。
    下载文件夹不可用（非 Windows / 路径不存在）才退回定位服务端文件。
    """
    path = _locate(brief_id)
    if path is None:
        raise BriefError("该简报文件已不存在（可能已被清理），请重新生成", "BRIEF_MISSING")
    import subprocess

    friendly = friendly_of(path)
    downloads = _downloads_dir()
    if downloads is not None:
        hit = _find_downloaded(friendly, downloads)
        if hit is not None:
            if sys.platform.startswith("win"):
                subprocess.Popen(["explorer", "/select,", str(hit)])
            elif sys.platform == "darwin":
                subprocess.Popen(["open", "-R", str(hit)])
            else:
                subprocess.Popen(["xdg-open", str(hit.parent)])
            return {"path": str(hit), "located": True, "downloads": str(downloads)}
        # 没找到同名文件：直接打开下载文件夹（Windows 用 explorer 打开目录）
        if sys.platform.startswith("win"):
            subprocess.Popen(["explorer", str(downloads)])
        else:
            subprocess.Popen(["xdg-open" if sys.platform != "darwin" else "open", str(downloads)])
        return {"path": str(downloads), "located": False, "downloads": str(downloads)}

    # 兜底：定位不到下载文件夹，退回服务端文件位置
    if sys.platform.startswith("win"):
        subprocess.Popen(["explorer", "/select,", str(path)])
    elif sys.platform == "darwin":
        subprocess.Popen(["open", "-R", str(path)])
    else:
        subprocess.Popen(["xdg-open", str(path.parent)])
    return {"path": str(path), "located": True, "downloads": ""}
