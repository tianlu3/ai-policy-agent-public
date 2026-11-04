/**
 * 前端契约联调验证（无需浏览器）
 * ------------------------------------------------------------------
 * 用 Node 直接加载真实的 gui-prototype/src/data.js，指向运行中的本地后端，
 * 执行 DATA.load()，断言「前端拿到后端数据 → 派生视图可用」，
 * 即证明前端能正常消费 GET /api/bootstrap 并进入渲染。
 *
 * 用法（后端需已启动）：
 *   node tools/verify_contract.mjs [baseUrl]
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(HERE, '..');
const GUI = process.env.GUI_DIR || path.resolve(BACKEND, '..', 'gui-prototype');
const BASE = process.argv[2] || 'http://127.0.0.1:8000';

const pass = [];
const fail = [];
const check = (name, cond, detail = '') => (cond ? pass : fail).push(`${name}${detail ? ' · ' + detail : ''}`);

/* ---------- 最小 DOM / 环境桩 ---------- */
const documentStub = {
  createElement: () => ({ set src(_) {}, onload: null, onerror: null }),
  head: { appendChild() {} },
  addEventListener: () => {},
  querySelectorAll: () => [],
  getElementById: () => null,
};
const windowStub = { addEventListener: () => {}, console };

const ctx = vm.createContext({
  window: windowStub,
  document: documentStub,
  console,
  // 相对路径按后端地址解析，等价于浏览器同源行为
  fetch: (u, o) => fetch(new URL(u, BASE), o),
  Promise, Set, Map, Object, Array, JSON, Math, Date, Error, RegExp,
  String, Number, Boolean, Symbol, parseInt, parseFloat, isNaN, undefined,
  setTimeout, clearTimeout,
});

/* ---------- 加载真实前端模块 ---------- */
const dataJs = fs.readFileSync(path.join(GUI, 'src', 'data.js'), 'utf8');
vm.runInContext(dataJs, ctx, { filename: 'src/data.js' });
const DATA = windowStub.DATA;
check('src/data.js 已暴露 window.DATA', !!DATA);

/* ---------- 执行装载（这一步等价于前端启动） ---------- */
let loaded = null;
try {
  loaded = await DATA.load();
  check('DATA.load() 成功（前端已收到后端数据）', true);
} catch (e) {
  check('DATA.load() 成功（前端已收到后端数据）', false, e.message);
}

if (loaded) {
  const items = (DATA.policies && DATA.policies.items) || [];
  check('policies.items 非空', items.length > 0, `${items.length} 条`);
  check('后端未走降级（window.TEST_DATA 未注入）', !windowStub.TEST_DATA);

  // 关键：app.js boot() 里的崩溃点
  check('policies.items[0].id 可用（boot 崩溃点）', !!(items[0] && items[0].id), items[0] && items[0].id);
  check('DATA.app.screens 非空（boot 崩溃点）', !!(DATA.app && DATA.app.screens && DATA.app.screens.length), `${(DATA.app?.screens || []).length} 屏`);

  // 派生视图（data.js hydrate 内构建）
  const p0 = DATA.policyById(items[0].id);
  check('policyById() 命中', !!p0, p0 && p0.name);
  /* 简报不再有「演示政策」兜底：previewPolicies 已删，改用 pickedPolicies（按 id 取政策） */
  check('pickedPolicies() 可用', (DATA.pickedPolicies([items[0].id]) || []).length > 0);
  check('regions.tree 非空', !!(DATA.regions && DATA.regions.tree && DATA.regions.tree.length), `${(DATA.regions?.tree || []).length} 个一级`);
  check('regions.coverageCodes 已由 policies 派生', DATA.regions.coverageCodes instanceof Set && DATA.regions.coverageCodes.size > 0, `${DATA.regions?.coverageCodes?.size} 个码`);
  check('明细七命名空间齐备', ['stats','policies','regions','search','list','detail','brief'].every((k) => k in DATA));

  // 抽查后端数据确实出现在前端命名空间里
  check('stats.policySources 透传', DATA.stats.policySources === 312, String(DATA.stats.policySources));
}

/* ---------- 输出 ---------- */
console.log(`\n目标后端：${BASE}\n前端目录：${GUI}\n`);
for (const p of pass) console.log('  [PASS] ' + p);
for (const f of fail) console.log('  [FAIL] ' + f);
console.log(`\n结果：${pass.length} 通过 / ${fail.length} 失败\n`);
process.exit(fail.length ? 1 : 0);
