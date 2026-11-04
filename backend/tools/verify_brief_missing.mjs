/* 简报文件丢失（TC-070）的常驻闸门
   ================================================================
   场景：服务端 `_briefs` 里那份生成源已被清理（手动删 / BRIEF_KEEP 自动 prune），
   用户手上还留着那次生成返回的 briefId，此时点「重新下载」或「打开所在文件夹」。

   后端契约（两条接口必须同码）：
     GET  /api/v1/briefs/{id}/download  → 404 {"error":{"code":"BRIEF_MISSING", ...}}
     POST /api/v1/briefs/{id}/reveal    → 404 {"error":{"code":"BRIEF_MISSING", ...}}

   验收标准（用户看得见的那一句）：
     「该简报文件已不存在（可能已被清理），请重新生成」

   本脚本用「自己造一份真文件 → 先验证它真能下 → 再删掉」的顺序做**正向对照**，
   否则无法排除「本来就没下下来」这种假绿。

   注意：reveal 成功路径会真的拉起资源管理器，所以正向对照只做 download，
        reveal 只跑失败路径（失败路径不 Popen，安全）。

   用法：node tools/verify_brief_missing.mjs [url]        默认 http://127.0.0.1:8000
         BRIEF_DIR=/abs/path 可覆盖简报目录推断
*/
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';

const require = createRequire(pathToFileURL(resolve(
  process.env.PW_WORKSPACE || 'C:/Users/22866/.workbuddy/binaries/node/workspace', 'noop.js'
)));
const pw = await import(pathToFileURL(require.resolve('playwright')).href);
const chromium = pw.chromium || (pw.default && pw.default.chromium);

const BASE = process.argv[2] || 'http://127.0.0.1:8000';
const BRIEF_DIR = process.env.BRIEF_DIR
  || join(dirname(fileURLToPath(import.meta.url)), '..', '_briefs');

/* 用户看得见的验收句，脚本只认这一句 */
const WANT = '该简报文件已不存在（可能已被清理），请重新生成';

let pass = 0;
let fail = 0;
const ok = (c, m, extra) => {
  if (c) { pass += 1; console.log('  ok   ' + m + (extra === undefined ? '' : '   → ' + extra)); }
  else { fail += 1; console.log('  FAIL ' + m + (extra === undefined ? '' : '   → ' + extra)); }
};
const note = (m) => console.log('  ·    ' + m);

/* ---------- 造一份「刚生成」的简报文件，拿到它的 briefId ---------- */
const ID = 'tc070' + Date.now().toString(16).slice(-6);
const FRIENDLY = '政策简报_' + new Date().toISOString().slice(0, 10) + '_闸门测试.pdf';
const FILE = join(BRIEF_DIR, ID + '__' + FRIENDLY);
const BODY = Buffer.concat([
  Buffer.from('%PDF-1.4\n% tc070 fixture\n'),
  Buffer.alloc(2048, 0x20),
  Buffer.from('\n%%EOF\n'),
]);
const api = (p) => BASE + p;

console.log('\n简报文件丢失闸门   base=' + BASE);
console.log('  简报目录 ' + BRIEF_DIR);
console.log('  夹具 id  ' + ID + '\n');

if (!existsSync(BRIEF_DIR)) {
  console.log('  FAIL 简报目录不存在，无法做正向对照：' + BRIEF_DIR);
  process.exit(1);
}
mkdirSync(BRIEF_DIR, { recursive: true });
writeFileSync(FILE, BODY);

/* ---------- ① · 后端契约（直连，不经前端） ---------- */
console.log('[1] 后端契约');
const r1 = await fetch(api('/api/v1/briefs/' + ID + '/download'));
const b1 = Buffer.from(await r1.arrayBuffer());
ok(r1.status === 200 && b1.length === BODY.length,
  '[1.1] 文件在场时 download 能拿到真内容（正向对照）',
  'HTTP ' + r1.status + ' · ' + b1.length + ' bytes');

rmSync(FILE, { force: true });
note('已删除 ' + FILE);

const r2 = await fetch(api('/api/v1/briefs/' + ID + '/download'));
const j2 = await r2.json().catch(() => null);
const m2 = (j2 && j2.error && j2.error.message) || '';
ok(r2.status === 404 && j2 && j2.error && j2.error.code === 'BRIEF_MISSING' && m2 === WANT,
  '[1.2] 文件被删后 download 返回 404 / BRIEF_MISSING / 标准文案',
  'HTTP ' + r2.status + ' · code=' + ((j2 && j2.error && j2.error.code) || '-') + ' · msg=' + m2);

const r3 = await fetch(api('/api/v1/briefs/' + ID + '/reveal'), { method: 'POST' });
const j3 = await r3.json().catch(() => null);
const m3 = (j3 && j3.error && j3.error.message) || '';
ok(r3.status === 404 && j3 && j3.error && j3.error.code === 'BRIEF_MISSING' && m3 === WANT,
  '[1.3] 文件被删后 reveal 返回 404 / BRIEF_MISSING / 标准文案',
  'HTTP ' + r3.status + ' · code=' + ((j3 && j3.error && j3.error.code) || '-') + ' · msg=' + m3);

const r4 = await fetch(api('/api/v1/briefs/neverever0000/download'));
const j4 = await r4.json().catch(() => null);
ok(r4.status === 404 && j4 && j4.error && j4.error.code === 'BRIEF_MISSING',
  '[1.4] 从未存在过的 id 与「被清理」同码（前端无法靠 code 区分两者）',
  'code=' + ((j4 && j4.error && j4.error.code) || '-'));

/* ---------- ② · 前端：点按钮后用户看见什么 ---------- */
console.log('\n[2] 前端提示文案');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, acceptDownloads: true });
const errs = [];
const NOISE = /api\/v1\/db\/status|net::ERR_FAILED|net::ERR_CONNECTION_REFUSED|Failed to fetch|Download is starting/;
page.on('pageerror', (e) => { if (!NOISE.test(String(e))) errs.push(String(e)); });

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof window.DATA !== 'undefined' && window.DATA.api, { timeout: 20000 });
await page.waitForFunction(() => typeof BRIEF_STATE !== 'undefined', { timeout: 20000 });
/* #toasts 由 buildShell() 在 boot() 里注入，必须等它真的出现在 DOM 里 */
await page.waitForSelector('#toasts', { state: 'attached', timeout: 20000 });

/* 截住 toast：它 2400ms 后自删，直接读 DOM 会抢不到 */
await page.evaluate(() => {
  window.__toasts = [];
  const host = document.getElementById('toasts');
  new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => {
    if (n.classList && n.classList.contains('toast')) {
      window.__toasts.push({ cls: n.className, text: n.textContent || '' });
    }
  }))).observe(host, { childList: true });
});

/* 走进简报屏，让按钮真的渲染出来。
   登录闸门会把一切跳转拦回 login，所以先把闸门放开（只作用于本次页内会话）。 */
await page.evaluate(() => {
  if (typeof AUTH !== 'undefined' && AUTH && AUTH.gateOpen) AUTH.gateOpen = () => true;
  if (typeof go === 'function') go('brief');
});
await page.waitForTimeout(400);

/* 冒充「刚才生成成功、briefId 还在手上」的状态，并重渲染让「重新下载」出现 */
const seeded = await page.evaluate(({ id, name }) => {
  if (typeof BRIEF_STATE === 'undefined' || typeof render !== 'function') return false;
  BRIEF_STATE.result = { briefId: id, fileName: name, downloadUrl: '/api/v1/briefs/' + id + '/download' };
  BRIEF_STATE.error = '';
  BRIEF_STATE.exported = true;
  render();
  return true;
}, { id: ID, name: FRIENDLY });
ok(seeded, '[2.0] 页面已持有 briefId 且「重新下载」按钮渲染出来',
  seeded ? 'ok' : 'BRIEF_STATE / render 不可达');

/* 「重新下载」 */
const hasDlBtn = await page.locator('[data-brief-download]').count();
ok(hasDlBtn > 0, '[2.1] 存在 [data-brief-download] 按钮', 'count=' + hasDlBtn);
if (hasDlBtn > 0) {
  await page.evaluate(() => { window.__toasts = []; });
  await page.locator('[data-brief-download]').first().click();
  await page.waitForTimeout(1200);
  const got = await page.evaluate(() => window.__toasts.map((t) => t.text).join(' | '));
  ok(got.includes(WANT), '[2.2] 点「重新下载」→ 提示「' + WANT + '」', got || '(无 toast)');
} else {
  fail += 1;
  console.log('  FAIL [2.2] 按钮缺失，无法验证');
}

/* 「打开所在文件夹」 */
const hasRvBtn = await page.locator('[data-brief-reveal]').count();
ok(hasRvBtn > 0, '[2.3] 存在 [data-brief-reveal] 按钮', 'count=' + hasRvBtn);
if (hasRvBtn > 0) {
  /* [2.2] 的修复会把失效的 result 清空（按钮回到 disabled）—— 这里重播种一次，
     模拟「手上还留着 briefId 就点定位」的场景本身 */
  await page.evaluate(({ id, name }) => {
    BRIEF_STATE.result = { briefId: id, fileName: name, downloadUrl: '/api/v1/briefs/' + id + '/download' };
    BRIEF_STATE.exported = true;
    render();
  }, { id: ID, name: FRIENDLY });
  await page.waitForTimeout(200);
  await page.evaluate(() => { window.__toasts = []; });
  await page.locator('[data-brief-reveal]').first().click();
  await page.waitForTimeout(1200);
  const got = await page.evaluate(() => window.__toasts.map((t) => t.text).join(' | '));
  ok(got.includes(WANT), '[2.4] 点「打开所在文件夹」→ 提示「' + WANT + '」', got || '(无 toast)');
} else {
  fail += 1;
  console.log('  FAIL [2.4] 按钮缺失，无法验证');
}

/* 文案表是否备了专用键（修复后回归用；缺键说明只能靠通用模板硬套） */
const hasKey = await page.evaluate(() => !!(DATA.brief && DATA.brief.errors && DATA.brief.errors.missing));
ok(hasKey, '[2.5] brief.json 备有专用键 errors.missing（供两条按钮统一引用）',
  hasKey ? 'ok' : '缺键，当前只能落到 downloadFailed / failed 两个通用模板');

ok(errs.length === 0, '[2.6] 全程无 JS 异常', errs.length ? errs.join(' ; ') : 'ok');

await browser.close();

/* ---------- 收尾：夹具必须清干净 ---------- */
rmSync(FILE, { force: true });
if (existsSync(FILE)) console.log('  FAIL 夹具未清干净：' + FILE);

console.log('\n结果  pass=' + pass + '  fail=' + fail + '\n');
process.exit(fail ? 1 : 0);
