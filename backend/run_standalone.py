#!/usr/bin/env python
"""PyInstaller 独立打包入口：双击 exe = 启动后端 + 自动开浏览器。

打包命令见 build_exe/build_exe.bat。要点：
- 冻结环境里 app 包被解到 sys._MEIPASS，config.py 的 BASE_DIR 指向那里，
  GUI_DIR / BRIEF_DIR 必须在 import app.config 之前用环境变量钉住。
- 用户可在 exe 旁边放一个 .env（可选）：这里先加载它，再补冻结默认值，
  顺序保证 .env 优先、默认值只兜底。
- exe 旁没有 .env 时默认 DB_ENABLED=0（目标机器多半没装 MySQL，账号/历史
  功能自动关闭，其余功能完整可用）。
"""
from __future__ import annotations

import os
import sys
from pathlib import Path


def _load_env_file(path: Path) -> int:
    """极简 .env 解析（与 app/config._load_dotenv 同规则）：KEY=VALUE，# 注释，不覆盖已有环境变量。"""
    n = 0
    if not path.is_file():
        return 0
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip("'\"")
        if key and key not in os.environ:
            os.environ[key] = value
            n += 1
    return n


def main() -> int:
    if getattr(sys, "frozen", False):
        import multiprocessing

        multiprocessing.freeze_support()

        exe_dir = Path(sys.executable).resolve().parent
        bundle = Path(getattr(sys, "_MEIPASS"))  # onefile 解包目录（含 app 与 gui-prototype）

        # ① exe 旁边的可选 .env：让使用者能开 MySQL / 换模型 / 换端口
        _load_env_file(exe_dir / ".env")

        # ② 冻结默认值（只兜底，不覆盖 ①）
        os.environ.setdefault("GUI_DIR", str(bundle / "gui-prototype"))
        os.environ.setdefault("BOOTSTRAP_AUTO_REFRESH", "0")  # 镜像/包内无 node，禁止重转 bootstrap
        os.environ.setdefault("BRIEF_DIR", str(exe_dir / "_briefs"))  # 简报落在 exe 旁，持久可见
        # SQLite 兜底库也放 exe 旁：临时解包目录会被清空，不能落那里
        os.environ.setdefault("DB_SQLITE_PATH", str(exe_dir / "ai_policy.sqlite3"))
        if not (exe_dir / ".env").is_file():
            os.environ.setdefault("DB_ENABLED", "sqlite")  # 未配置就默认零依赖可跑通账号功能

        sys.argv = [sys.executable, "--open"]  # 复用 run.py：端口顺延 + 自动开浏览器

        # 提前真实导入 app.main：导入错误直接抛栈（uvicorn 的 import-string 会把栈吞掉）
        import app.main  # noqa: F401

    import run

    return run.main()


if __name__ == "__main__":
    raise SystemExit(main())
