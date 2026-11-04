"""诊断：真实检索期间轮询接口的可用性（定位前端断连黄条来源）。

用法：python tools/diag_poll_gap.py
输出：每 500ms 一次的 (t, http_code, ms, err)，末尾汇总连续失败段。
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request

BASE = os.environ.get("DIAG_BASE", "http://127.0.0.1:8000")
USER = os.environ.get("DIAG_USER", "tester01")
PWD = os.environ.get("DIAG_PWD", "Test123456")
QUERY = os.environ.get("DIAG_Q", "杭州市 制造业 补贴政策")
DURATION = float(os.environ.get("DIAG_SEC", "120"))

# 沙箱回环必须绕过代理
os.environ["NO_PROXY"] = "127.0.0.1,localhost"
os.environ["no_proxy"] = "127.0.0.1,localhost"


def call(method: str, path: str, body=None, token=None, timeout=10.0):
    url = BASE + path
    data = None
    headers = {"Accept": "application/json"}
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json; charset=utf-8"
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            return resp.status, json.loads(raw.decode("utf-8")), (time.time() - t0) * 1000, None
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        try:
            payload = json.loads(raw.decode("utf-8"))
        except Exception:
            payload = {"raw": raw[:200].decode("utf-8", "replace")}
        return exc.code, payload, (time.time() - t0) * 1000, "HTTPError"
    except Exception as exc:  # 超时 / 连接被拒
        return 0, None, (time.time() - t0) * 1000, f"{type(exc).__name__}: {exc}"


def main() -> int:
    code, payload, ms, err = call("POST", "/api/v1/auth/login", {"username": USER, "password": PWD})
    print(f"[login] code={code} ms={ms:.0f} err={err} payload={str(payload)[:180]}")
    if code != 200:
        return 2
    token = payload.get("token") or payload.get("accessToken") or payload.get("access_token")
    if not token:
        print("[login] 未拿到 token，响应字段：", list((payload or {}).keys()))
        return 2

    code, payload, ms, err = call("POST", "/api/v1/searches", {"query": QUERY}, token=token)
    print(f"[create] code={code} ms={ms:.0f} err={err} payload={str(payload)[:220]}")
    if code not in (200, 201, 202):
        return 2
    task_id = (payload or {}).get("taskId") or (payload or {}).get("id")
    print(f"[create] taskId={task_id}")
    if not task_id:
        return 2

    t_start = time.time()
    print("\n  t(s)  code     ms   status/step      err")
    print("  " + "-" * 62)
    samples = []
    while time.time() - t_start < DURATION:
        code, payload, ms, err = call("GET", f"/api/v1/searches/{task_id}", token=token, timeout=8.0)
        t = time.time() - t_start
        status = (payload or {}).get("status", "")
        step = (payload or {}).get("step", "")
        errcode = (payload or {}).get("code", "") if code >= 400 else ""
        line = f"  {t:5.1f}  {code:4d}  {ms:6.0f}   {status}/{step}  {errcode or ''} {err or ''}"
        print(line, flush=True)
        samples.append((t, code, ms, err, status))
        if status in ("succeeded", "failed", "error"):
            print(f"\n[terminal] 任务在 t={t:.1f}s 结束，status={status}")
            break
        time.sleep(0.5)

    # 汇总：连续失败段（code==0 或 >=500 视为不可用）
    gaps = []
    cur = None
    for t, code, ms, err, status in samples:
        bad = code == 0 or code >= 500
        if bad:
            if cur is None:
                cur = [t, t, 1, code]
            else:
                cur[1] = t
                cur[2] += 1
        else:
            if cur is not None:
                gaps.append(cur)
                cur = None
    if cur is not None:
        gaps.append(cur)

    print("\n" + "=" * 62)
    print(f"[summary] 采样 {len(samples)} 次，跨度 {samples[-1][0]:.1f}s")
    if not gaps:
        print("[summary] 无失败采样 → 轮询全程可用，黄条不来自后端断连")
    else:
        for s, e, n, c in gaps:
            print(f"[summary] 连续失败 {n:3d} 次  {s:6.1f}s → {e:6.1f}s (持续 {e - s:.1f}s, 末次 code={c})")
        print(f"[summary] 最长失败段 = {max(e - s for s, e, n, c in gaps):.1f}s（前端宽限期 15s）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
