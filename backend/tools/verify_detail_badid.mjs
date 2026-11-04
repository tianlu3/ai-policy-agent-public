/* 非法政策 id 进详情屏（TC-071）的常驻闸门
   ================================================================
   场景：手上拿着一个当前结果集里不存在的 policyId 去开详情。
   真实来源有两条：
     · 对话记录 / 检索记录里点开一条早已不在当前结果集的政策（screens-d.js → go('detail', {policyId})）；
     · URL 深链（用例里写的「直链」）。

   验收标准：
     兜底到当前结果集第一条，或给空态占位，绝不能白屏。

   本脚本同时把「深链到底能不能带 id」这件事查清楚 —— 用例把深链当入口写，
   但 boot() 只拿 hash 去比屏名（app.js:828-841），带 id 的 hash 比不中任何屏名。

   用法：node tools/verify_detail_badid.mjs [url]     默认 http://127.0.0.1:8010（mock）
*/
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(pathToFileURL(resolve(
  process.env.PW_WORKSPACE || 'C:/Users/22866/.workbuddy/binaries/node/workspace', 'noop.js'
)));
const pw = await import(pathToFileURL(require.resolve('playwright')).href);
const chromium = pw.chromium || (pw.default && pw.default.chromium);

const BASE = process.argv[2] || 'http://127.0.0.1:8010';
const BAD = 'P-NOT-EXIST-9999';

let pass = 0;
let fail = 0;
const ok = (c, m, extra) => {
  if (c) { pass += 1; console.log('  ok   ' + m + (extra === undefined ? '' : '   → ' + extra)); }
  else { fail += 1; console.log('  FAIL ' + m + (extra === undefined ? '' : '   → ' + extra)); }
};
const note = (m) => console.log('  ·    ' + m);

console.log('\n非法 id 进详情屏闸门   base=' + BASE);

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const errs = [];
const NOISE = /api\/v1\/db\/status|net::ERR_FAILED|net::ERR_CONNECTION_REFUSED|Failed to fetch/;
page.on('pageerror', (e) => { if (!NOISE.test(String(e))) errs.push(String(e)); });

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(
  () => typeof window.DATA !== 'undefined' && window.DATA.api && typeof go === 'function',
  { timeout: 20000 },
);
await page.waitForSelector('#stage', { state: 'attached', timeout: 20000 });

/* ---------- ① 前置：当前结果集 ---------- */
console.log('\n[1] 前置');
const pre = await page.evaluate(() => {
  const it = (DATA.policies && DATA.policies.items) || [];
  return { n: it.length, firstId: it[0] && it[0].id, firstName: it[0] && it[0].name };
});
ok(pre.n > 0 && !!pre.firstId, '[1.1] 结果集非空，且首条可作兜底基准',
  'n=' + pre.n + ' · first=' + pre.firstId + ' · ' + pre.firstName);

/* ---------- ② 非法 id 进详情：能不能兜住 ---------- */
console.log('\n[2] 非法 id 进详情（等价于从对话记录 / 检索记录点开一条已不在结果集的政策）');
const r = await page.evaluate((bad) => {
  /* 登录闸门会把一切跳转拦回 login，测试期先放开 */
  if (typeof AUTH !== 'undefined' && AUTH && AUTH.gateOpen) AUTH.gateOpen = () => true;
  const before = APP.policyId;
  let threw = '';
  try { go('detail', { policyId: bad }); } catch (e) { threw = String(e); }
  const stage = document.getElementById('stage');
  const main = document.querySelector('.detail-main');
  return {
    threw,
    before,
    screen: APP.screen,
    policyId: APP.policyId,
    hasDetail: !!main,
    stageLen: stage ? stage.innerHTML.length : 0,
    text: stage ? stage.textContent.replace(/\s+/g, ' ').trim().slice(0, 300) : '',
  };
}, BAD);

ok(!r.threw, '[2.1] 进入详情屏不抛异常', r.threw || 'ok');
ok(r.screen === 'detail' && r.hasDetail && r.stageLen > 200,
  '[2.2] 详情屏真渲染出来，不白屏',
  'screen=' + r.screen + ' · .detail-main=' + r.hasDetail + ' · stageLen=' + r.stageLen);
ok(r.policyId === pre.firstId,
  '[2.3] APP.policyId 被归一化为当前结果集第一条（app.js:110-113）',
  'APP.policyId=' + r.policyId + '  期望=' + pre.firstId);
ok(pre.firstName && r.text.includes(pre.firstName),
  '[2.4] 页面上看到的就是第一条的名字',
  pre.firstName ? ('看到 ' + (r.text.includes(pre.firstName) ? '是' : '否')) : '(无名字可比)');
if (r.before && r.before !== pre.firstId) note('进入前 APP.policyId=' + r.before);

/* ---------- ③ 深链到底能不能带 id ---------- */
console.log('\n[3] URL 深链（用例写的「直链」入口）');
const deep = await page.evaluate(() => {
  const hash = 'detail/P-NOT-EXIST-9999';
  /* 复刻 boot() 的判定：只拿 hash 比屏名 */
  return {
    hash,
    recognized: SCREENS.some((s) => s.key === hash),
    screenKeys: SCREENS.map((s) => s.key),
  };
});
ok(deep.recognized === false,
  '[3.1] boot() 只认屏名，带 id 的 hash 比不中任何屏（app.js:828-841）',
  '#' + deep.hash + ' 命中=' + deep.recognized + ' · 已知屏=' + deep.screenKeys.join(','));
note('所以「用不存在的政策 id 打开详情（直链）」在当前实现里进不去详情屏，会落到默认首屏；');
note('真正能带着 id 进详情的是 go(\'detail\', {policyId})，即 [2] 那条路径。');

/* ---------- ④ 结果集为空时的空态 ---------- */
console.log('\n[4] 结果集为空（后端返回 0 条）时的空态');
const empty = await page.evaluate((bad) => {
  const backup = DATA.policies.items.slice();
  DATA.policies.items.length = 0;
  let threw = '';
  let hasDetail = false;
  let stageLen = 0;
  let text = '';
  /* 先清空 stage：render() 是 `stage.innerHTML = def.render()`，render 抛错时 innerHTML
     根本不会被赋值，上一屏内容会原样留在那里 —— 不清空就会把「旧屏残留」误判成「不白屏」。 */
  const stage0 = document.getElementById('stage');
  if (stage0) stage0.innerHTML = '';
  try {
    go('detail', { policyId: bad });
  } catch (e) { threw = String(e); }
  const main = document.querySelector('.detail-main');
  const stage = document.getElementById('stage');
  hasDetail = !!main;
  stageLen = stage ? stage.innerHTML.length : 0;
  text = stage ? stage.textContent.replace(/\s+/g, ' ').trim().slice(0, 160) : '';
  DATA.policies.items.push(...backup);
  return { threw, hasDetail, stageLen, text, restored: DATA.policies.items.length };
}, BAD);

ok(!empty.threw, '[4.1] 结果集为空时进详情不抛异常', empty.threw || 'ok');
ok(empty.hasDetail && empty.stageLen > 120,
  '[4.2] 空集时给空态占位，不白屏',
  '.detail-main=' + empty.hasDetail + ' · stageLen=' + empty.stageLen + (empty.text ? ' · 「' + empty.text.slice(0, 60) + '…」' : ''));
note('恢复后结果集 ' + empty.restored + ' 条');

/* ---------- ⑤ 无异常 ---------- */
console.log('\n[5] 健壮性');
ok(errs.length === 0, '[5.1] 全程无 JS 异常', errs.length ? errs.join(' ; ') : 'ok');

await browser.close();
console.log('\n结果  pass=' + pass + '  fail=' + fail + '\n');
process.exit(fail ? 1 : 0);
