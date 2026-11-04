"""test_date.js → JSON 转换器。

test_date.js 是 JS 对象字面量（键无引号），不是合法 JSON，
因此借本机 node 在沙箱里求值 window.TEST_DATA 再序列化为 JSON。
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

# 通过环境变量传参，避免不同 node 版本下 -e 的 argv 偏移差异
_NODE_SNIPPET = r"""
const fs = require('fs'), vm = require('vm');
const src = process.env.NODE_SRC, out = process.env.NODE_OUT;
const code = fs.readFileSync(src, 'utf8');
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: src });
const data = sandbox.window.TEST_DATA;
if (!data || typeof data !== 'object') {
  throw new Error('test_date.js 未定义 window.TEST_DATA');
}
fs.writeFileSync(out, JSON.stringify(data));
"""


def node_available() -> bool:
    return shutil.which("node") is not None


def test_data_js_to_json(js_path: Path, json_path: Path, timeout: int = 60) -> dict[str, Any]:
    """把 test_date.js 转成 JSON 落盘并返回该字典。"""
    node = shutil.which("node")
    if not node:
        raise RuntimeError("未找到 node，无法从 test_date.js 转换（请安装 Node.js 或改用已有 bootstrap.json）")
    if not js_path.exists():
        raise FileNotFoundError(f"找不到 test_date.js：{js_path}")

    json_path.parent.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, "NODE_SRC": str(js_path), "NODE_OUT": str(json_path)}
    proc = subprocess.run(
        [node, "-e", _NODE_SNIPPET],
        capture_output=True, text=True, env=env, timeout=timeout,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"node 转换失败：{proc.stderr.strip() or proc.stdout.strip()}")

    data = json.loads(json_path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise RuntimeError("转换结果不是对象")
    return data
