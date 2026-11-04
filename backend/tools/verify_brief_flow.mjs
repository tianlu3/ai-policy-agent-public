/**
 * 政策简报接口契约（对本地实例跑，默认 http://127.0.0.1:8010）
 *
 *   node tools/verify_brief_flow.mjs                       # 默认 8010 mock
 *   node tools/verify_brief_flow.mjs http://127.0.0.1:8000
 *   BRIEF_TEST_REVEAL=1 node tools/verify_brief_flow.mjs   # 额外验证 reveal（会弹文件管理器窗口）
 *
 * 断言覆盖：能力探测 → 三格式生成 → 真下载（大小/魔数/文件名） → 参数透传
 *          → 非法格式 / 空清单 / 不存在的 id 三类错误体。
 */
const BASE = (process.argv[2] || "http://127.0.0.1:8010").replace(/\/$/, "");

let passed = 0;
const failures = [];

function ok(name, cond, extra = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}${extra ? "  " + extra : ""}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name}${extra ? "  " + extra : ""}`);
  }
}

async function jget(path) {
  const res = await fetch(BASE + path);
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { res, body };
}

const POLICIES = [
  {
    name: "关于支持智能硬件产业高质量发展的若干措施",
    level: "市级",
    issuer: "杭州市经济和信息化局",
    types: "资金补助 / 税收优惠",
    industries: "智能硬件",
    publish: "2026-08-12",
    deadline: "2026-11-30",
    daysLeft: 48,
    subsidy: "最高 500 万元",
    conditions: ["规上工业企业", "研发投入占比≥3%"],
    conditionsFull: ["在杭州市注册满两年"],
    materials: ["营业执照", "审计报告"],
    confidence: "高",
    matched: "智能硬件 · 资金补助",
    sources: [{ name: "杭州市经信局" }, { name: "浙江政务服务网" }],
  },
  {
    name: "浙江省首台（套）装备认定与奖励办法",
    level: "省级",
    issuer: "浙江省经济和信息化厅",
    types: "资质认定",
    industries: "智能硬件 / 高端装备",
    publish: "2026-06-01",
    deadline: "2026-10-20",
    daysLeft: 7,
    subsidy: "奖励 100 万元",
    confidence: "中",
  },
  {
    name: "小微企业研发费用加计扣除操作指引",
    level: "国家级",
    issuer: "国家税务总局",
    types: "税收优惠",
    publish: "2026-03-15",
    deadline: "长期有效",
    confidence: "高",
  },
];

const MAGIC = {
  xlsx: [0x50, 0x4b, 0x03, 0x04],
  docx: [0x50, 0x4b, 0x03, 0x04],
  pdf: [0x25, 0x50, 0x44, 0x46], // %PDF
};
const MIME = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
};

async function main() {
  console.log(`\n政策简报接口契约 · ${BASE}\n`);

  // ---------- 1. 能力探测 ----------
  console.log("[1] GET /api/v1/briefs/status");
  const st = await jget("/api/v1/briefs/status");
  ok("200", st.res.status === 200, `status=${st.res.status}`);
  ok("ok=true", st.body && st.body.ok === true);
  ok("formats 含三格式", st.body && ["xlsx", "docx", "pdf"].every((f) => st.body.formats.includes(f)),
    JSON.stringify(st.body && st.body.formats));
  ok("templates 含 onepage/detail", st.body && ["onepage", "detail"].every((t) => st.body.templates.includes(t)));
  ok("scopes 含 picked/filtered", st.body && ["picked", "filtered"].every((s) => st.body.scopes.includes(s)));
  ok("pdf 可用", st.body && st.body.pdf === true, `pdf=${st.body && st.body.pdf}`);
  ok("给出输出目录", !!(st.body && st.body.outputDir));

  // ---------- 2. 三格式生成 + 下载 ----------
  console.log("\n[2] POST /api/v1/briefs × 3 格式 → GET download");
  /* 综述的硬上限 = 服务端 BRIEF_SUMMARY_TIMEOUT（status 里给）+ 8s 余量 + 渲染；
     这里留 30s 冗余。超过即说明「超时降级」这道闸门失效了（详见 app/brief.py 的注释）。 */
  const SUMMARY_T = (st.body && Number(st.body.summaryTimeout)) || 60;
  const MAX_ELAPSED = (SUMMARY_T + 30) * 1000;
  const made = {};
  for (const fmt of ["xlsx", "docx", "pdf"]) {
    const res = await fetch(`${BASE}/api/v1/briefs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        format: fmt,
        template: fmt === "pdf" ? "onepage" : "detail",
        scope: "picked",
        scopeLabel: "杭州市 · 智能硬件 · 3 条政策",
        conditions: ["地域：杭州市（· 来自筛选栏）", "行业：智能硬件（· 来自筛选栏）", "类型：不限", "时间：不限"],
        policies: POLICIES,
      }),
    });
    const body = await res.json().catch(() => null);
    ok(`${fmt}: 200`, res.status === 200, `status=${res.status} ${body && body.error ? body.error.message : ""}`);
    if (res.status !== 200) continue;

    ok(`${fmt}: 有 briefId`, /^[0-9a-f]{8,}$/.test(body.briefId || ""), body.briefId);
    ok(`${fmt}: bytes>2000`, body.bytes > 2000, `${body.bytes} B`);
    ok(`${fmt}: count=3`, body.count === 3);
    ok(`${fmt}: mediaType 正确`, body.mediaType === MIME[fmt], body.mediaType);
    ok(`${fmt}: fileName 带扩展名`, (body.fileName || "").endsWith("." + fmt), body.fileName);
    ok(`${fmt}: fileName 含范围`, (body.fileName || "").includes("3 条政策"), body.fileName);
    ok(`${fmt}: summarySource 合法`, ["llm", "rule"].includes(body.summarySource), body.summarySource);
    ok(`${fmt}: summary 非空且够长`, (body.summary || "").length >= 40, `${(body.summary || "").length} 字`);
    ok(`${fmt}: downloadUrl 指向自身`, body.downloadUrl === `/api/v1/briefs/${body.briefId}/download`);
    ok(`${fmt}: elapsedMs 在超时硬上限内`, body.elapsedMs >= 0 && body.elapsedMs < MAX_ELAPSED,
      `${body.elapsedMs}ms（上限 ${MAX_ELAPSED}ms = 综述超时 ${SUMMARY_T}s + 30s 冗余）`);
    made[fmt] = body;
  }

  for (const fmt of Object.keys(made)) {
    const b = made[fmt];
    const dl = await fetch(BASE + b.downloadUrl);
    const buf = new Uint8Array(await dl.arrayBuffer());
    ok(`${fmt}: download 200`, dl.status === 200, `status=${dl.status}`);
    ok(`${fmt}: 下载字节数 == bytes`, buf.length === b.bytes, `${buf.length} vs ${b.bytes}`);
    ok(`${fmt}: 魔数正确`, MAGIC[fmt].every((v, i) => buf[i] === v),
      [...buf.slice(0, 4)].map((n) => n.toString(16)).join(" "));
    ok(`${fmt}: Content-Type 正确`, (dl.headers.get("content-type") || "").includes(MIME[fmt]),
      dl.headers.get("content-type"));
    const cd = dl.headers.get("content-disposition") || "";
    ok(`${fmt}: 附件下载 + 中文文件名`, /attachment/.test(cd) && /filename\*=utf-8''/i.test(cd), cd.slice(0, 90));
    // 二次下载应逐字节一致（文件落盘，不依赖内存态）
    const again = new Uint8Array(await (await fetch(BASE + b.downloadUrl)).arrayBuffer());
    ok(`${fmt}: 二次下载一致`, again.length === buf.length && again.every((v, i) => v === buf[i]));
  }

  // ---------- 3. 参数透传 ----------
  console.log("\n[3] 参数透传（范围 / 模板 / 别名）");
  const r1 = await fetch(`${BASE}/api/v1/briefs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      format: "doc", // 前端 Doc 选项的别名
      template: "onepage",
      scope: "filtered",
      scopeLabel: "当前筛选结果",
      policies: POLICIES,
    }),
  });
  const b1 = await r1.json();
  ok("format=doc 归一化为 docx", b1.format === "docx", b1.format);
  ok("scope=filtered 透传", b1.scope === "filtered", b1.scope);
  ok("文件名带「当前筛选结果」", (b1.fileName || "").includes("当前筛选结果"), b1.fileName);

  const r2 = await fetch(`${BASE}/api/v1/briefs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ format: "xlsx", template: "不存在的模板", scope: "乱填", policies: POLICIES }),
  });
  const b2 = await r2.json();
  ok("非法 template 回退 onepage", b2.template === "onepage", b2.template);
  ok("非法 scope 回退 picked", b2.scope === "picked", b2.scope);

  // ---------- 4. 错误体 ----------
  console.log("\n[4] 错误体（统一 {\"error\":{\"code\",\"message\"}}）");
  const e1 = await fetch(`${BASE}/api/v1/briefs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ format: "pptx", policies: POLICIES }),
  });
  const eb1 = await e1.json();
  ok("非法格式 400", e1.status === 400, `status=${e1.status}`);
  ok("非法格式 code=BAD_FORMAT", eb1.error && eb1.error.code === "BAD_FORMAT", JSON.stringify(eb1.error));

  const e2 = await fetch(`${BASE}/api/v1/briefs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ format: "xlsx", policies: [] }),
  });
  const eb2 = await e2.json();
  ok("空清单 400", e2.status === 400, `status=${e2.status}`);
  ok("空清单 code=EMPTY_POLICIES", eb2.error && eb2.error.code === "EMPTY_POLICIES", JSON.stringify(eb2.error));
  ok("空清单文案可读", eb2.error && /勾选/.test(eb2.error.message), eb2.error && eb2.error.message);

  const e3 = await fetch(`${BASE}/api/v1/briefs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ format: "xlsx" }),
  });
  const eb3 = await e3.json();
  ok("缺 policies 400 code=NO_POLICIES", e3.status === 400 && eb3.error && eb3.error.code === "NO_POLICIES",
    JSON.stringify(eb3.error));

  const e4 = await jget("/api/v1/briefs/deadbeef0000/download");
  ok("不存在的 id 404", e4.res.status === 404, `status=${e4.res.status}`);
  ok("不存在 id code=BRIEF_MISSING", e4.body && e4.body.error && e4.body.error.code === "BRIEF_MISSING",
    JSON.stringify(e4.body && e4.body.error));

  // ---------- 5. reveal（可选，会弹文件管理器） ----------
  if (process.env.BRIEF_TEST_REVEAL === "1") {
    console.log("\n[5] POST /api/v1/briefs/{id}/reveal");
    const id = made.xlsx && made.xlsx.briefId;
    const rv = await fetch(`${BASE}/api/v1/briefs/${id}/reveal`, { method: "POST" });
    const bv = await rv.json();
    ok("reveal 200", rv.status === 200, `status=${rv.status}`);
    // reveal 优先去用户「下载」文件夹定位浏览器存的那份；没找到就打开文件夹（located=false）
    ok("reveal 返回磁盘路径", !!(bv.path && /政策简报_|[Dd]ownload/.test(bv.path)), bv.path);
    ok("reveal 带 located 标记", typeof bv.located === "boolean", `located=${bv.located}`);
    const rv2 = await fetch(`${BASE}/api/v1/briefs/deadbeef0000/reveal`, { method: "POST" });
    ok("reveal 不存在 id → 404", rv2.status === 404, `status=${rv2.status}`);
  } else {
    console.log("\n[5] reveal 已跳过（需要时用 BRIEF_TEST_REVEAL=1 打开）");
  }

  // ---------- 汇总 ----------
  console.log(`\n结果：通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : "，全部通过"}`);
  if (failures.length) {
    console.log("失败项：\n  - " + failures.join("\n  - "));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("脚本异常：", err);
  process.exit(1);
});
