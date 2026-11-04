"""行政区划字典查询。

索引构建自 bootstrap 的 regions.tree（紧凑结构）：
    [code, name, py 首字母, children | null]
    code 规则：省级 2 位 / 地级 4 位 / 县级 6 位（逐级递增）
    「全国（不限）」的 code 为 "00"

用途：
  · 把用户查询里的地名（含简称，如「杭州」→「杭州市」）解析成区划码，
    写进提示词交给大模型，避免大模型编造区划码；
  · 包装层据此填 policies.items[].regionCodes。
"""
from __future__ import annotations

from dataclasses import dataclass

from . import bootstrap

# 行政通名：匹配时剥掉，支持「杭州」命中「杭州市」
_SUFFIXES = (
    "特别行政区", "自治区", "自治州", "自治县", "地区", "盟",
    "省", "市", "县", "区",
)
NATION_CODE = "00"
NATION_NAME = "全国（不限）"

_LEVEL_LABEL = {0: "全国", 1: "省级", 2: "市级", 3: "县级"}
_LEVEL_KEY = {0: "nation", 1: "province", 2: "city", 3: "county"}


@dataclass(frozen=True)
class RegionNode:
    code: str
    name: str
    level: int                       # 0 全国 / 1 省 / 2 市 / 3 县
    path: tuple[str, ...]            # 名称路径，如 ("浙江省", "杭州市")
    py: str = ""

    @property
    def level_label(self) -> str:
        return _LEVEL_LABEL.get(self.level, "县级")

    @property
    def level_key(self) -> str:
        return _LEVEL_KEY.get(self.level, "county")

    @property
    def short(self) -> str:
        """剥离行政通名后的简称。"""
        return strip_suffix(self.name)

    def codes_with_ancestors(self) -> list[str]:
        """含祖先的区划码链，如 杭州市 → ["33", "3301"]。

        与 test_date.js 中 policies[].regionCodes 的口径一致
        （省 2 位 + 市 4 位 + 县 6 位，逐级递增）。
        港澳台为 6 位省级码的特例，直接用它自身。
        """
        if self.level == 0:
            return [NATION_CODE]
        widths = {1: 2, 2: 4, 3: 6}
        width = widths.get(self.level, 6)
        # 码长与层级不符（如中国香港 810000 处于省级）→ 直接用自身码
        if len(self.code) > width:
            return [self.code]
        return [self.code[: widths[depth]] for depth in range(1, self.level + 1)]


def strip_suffix(name: str) -> str:
    for suf in _SUFFIXES:
        if len(name) > len(suf) and name.endswith(suf):
            return name[: -len(suf)]
    return name


_index: dict[str, RegionNode] = {}
_short_index: dict[str, list[RegionNode]] = {}
_ordered: list[RegionNode] = []
_built = False


_children_map: dict[str, list[RegionNode]] = {}


def _walk_node(
    raw, level: int, path: tuple[str, ...], out: list[RegionNode]
) -> list[RegionNode]:
    """递归建树，返回 [node] 供父级收集直接子节点。"""
    code, name = raw[0], raw[1]
    py = raw[2] if len(raw) > 2 and raw[2] else ""
    node = RegionNode(code=code, name=name, level=level, path=path + (name,), py=py)
    out.append(node)

    kids: list[RegionNode] = []
    for child in (raw[3] if len(raw) > 3 and raw[3] else []):
        kids.extend(_walk_node(child, level + 1, node.path, out))
    _children_map[node.code] = kids
    return [node]


def _build() -> None:
    global _built
    if _built:
        return
    data = bootstrap.load()
    out: list[RegionNode] = []
    # 顶层 = 「全国（不限）」+ 34 个省级行政区；
    # 不能一律按 level 0 处理，否则会把省份误判成全国、地级市误判成省级。
    for raw in data.get("regions", {}).get("tree") or []:
        level = 0 if raw[0] == NATION_CODE else 1
        _walk_node(raw, level, (), out)
    for node in out:
        _index.setdefault(node.name, node)
        _short_index.setdefault(node.short, []).append(node)
    _ordered.extend(out)
    _built = True


def children(node: RegionNode | None) -> list[RegionNode]:
    """直接下级节点。"""
    _build()
    return list(_children_map.get(node.code, [])) if node else []


def first_child(node: RegionNode | None, level: int | None = None) -> RegionNode | None:
    """第一个下级（可按层级过滤），用于「只说了市、需要补一个区县」这类场景。"""
    for child in children(node):
        if level is None or child.level == level:
            return child
    return None


def all_nodes() -> list[RegionNode]:
    _build()
    return _ordered


def lookup(name: str) -> RegionNode | None:
    """按全名或简称查一个节点（精确）。"""
    _build()
    name = (name or "").strip()
    if not name:
        return None
    if name in _index:
        return _index[name]
    hits = _short_index.get(strip_suffix(name)) or []
    return hits[0] if hits else None


def resolve(names: list[str]) -> list[RegionNode]:
    """把一组地名解析成节点（去重、保持层级顺序，全国排最前）。"""
    _build()
    seen: dict[str, RegionNode] = {}
    for raw in names or []:
        node = lookup(raw)
        if node:
            seen[node.code] = node
    return sorted(seen.values(), key=lambda n: (n.level, n.code))


def match_in_text(text: str, limit: int = 6) -> list[RegionNode]:
    """从自然语言里抽取地名，如「我是杭州做智能硬件的」→ 杭州市。

    同时匹配全名与去通名简称；命中的节点按层级排序返回。
    """
    _build()
    if not text:
        return []
    hits: dict[str, RegionNode] = {}
    for node in _ordered:
        if node.level == 0:
            continue
        if node.name in text:
            hits[node.code] = node
            continue
        short = node.short
        if len(short) >= 2 and short in text:
            hits.setdefault(node.code, node)
    ordered = sorted(hits.values(), key=lambda n: (n.level, n.code))
    return ordered[:limit]


def to_dict(node: RegionNode) -> dict:
    return {
        "code": node.code,
        "name": node.name,
        "level": node.level,
        "levelLabel": node.level_label,
        "levelKey": node.level_key,
        "path": list(node.path),
        "codes": node.codes_with_ancestors(),
    }


def codes_of(nodes: list[RegionNode]) -> list[str]:
    """节点集合 → 去重后的区划码（含祖先）。"""
    out: list[str] = []
    for node in nodes:
        for code in node.codes_with_ancestors():
            if code not in out:
                out.append(code)
    return out


def names_of(nodes: list[RegionNode]) -> str:
    """节点集合 → 「浙江省 · 杭州市」这样的展示串（用于日志与统计口径）。"""
    return " · ".join(n.name for n in nodes) if nodes else NATION_NAME


def summary_of(nodes: list[RegionNode]) -> str:
    """节点集合 → 简洁口径，如「浙江省 / 杭州市」。"""
    if not nodes:
        return NATION_NAME
    parts = [n.name for n in nodes if n.level >= 1]
    return " / ".join(parts) if parts else NATION_NAME
