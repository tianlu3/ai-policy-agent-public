#!/usr/bin/env python
"""把 gui-prototype/test_date.js 转换为 app/data/bootstrap.json（后端数据源）。

用法：
    python tools/convert_test_data.py
需要本机已安装 Node.js（用于在沙箱中求值 JS 对象字面量）。
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import config, jsconvert  # noqa: E402


def main() -> int:
    print(f"[i] 源文件     : {config.TEST_DATA_JS}")
    print(f"[i] 输出文件   : {config.BOOTSTRAP_JSON}")

    if not config.TEST_DATA_JS.exists():
        print("[x] 找不到 test_date.js")
        return 1
    if not jsconvert.node_available():
        print("[x] 未检测到 node，请先安装 Node.js 后重试")
        return 2

    data = jsconvert.test_data_js_to_json(config.TEST_DATA_JS, config.BOOTSTRAP_JSON)
    print(f"[ok] 已生成，共 {len(data)} 个命名空间：{', '.join(data.keys())}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
