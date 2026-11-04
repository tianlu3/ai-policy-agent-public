/* 针对性截图（2026-10-15 两条用户反馈）：
     ① 搜「上海市 / 杨浦区 · 跨境电商 · 补贴」→ 结果列表只该有上海 + 杨浦；
     ② 检索屏抓取日志一多，必须滑得动（且「取消检索」留在视野内）。
   用法：node tools/shot_scope_scroll.mjs [baseUrl]                        */
import { mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(pathToFileURL(resolve(
  process.env.PW_WORKSPACE || 'C:/Users/22866/.workbuddy/binaries/node/workspace', 'noop.js')));
const pw = await import(pathToFileURL(require.resolve('playwright')).href);
const chromium = pw.chromium || (pw.default && pw.default.chromium);

const BASE = process.argv[2] || 'http://127.0.0.1:8010';
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '_shots');
mkdirSync(OUT, { recursive: true });
const shot = (page, name) => page.screenshot({ path: resolve(OUT, name) });

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 940 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));

await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
const gate = await page.waitForSelector('.auth-card', { timeout: 10000 }).then(() => true).catch(() => false);
if (gate) await page.click('[data-auth-guest]');
await page.waitForSelector('#homeQ', { timeout: 20000 });

/* ---------- ① 地域：上海市 + 杨浦区 ---------- */
await page.click('[data-region-trigger]');
await page.waitForSelector('#cascPanel', { timeout: 5000 });
const col = (i) => page.locator('#cascPanel .casc-col').nth(i);
await col(0).locator('.frow:has-text("上海市")').first().click();
await page.waitForFunction(() => {
  const c = document.querySelectorAll('#cascPanel .casc-col')[1];
  return !!c && (c.textContent || '').indexOf('杨浦区') >= 0;
}, null, { timeout: 5000 }).catch(() => {});
await page.waitForTimeout(200);
await col(1).locator('.frow:has-text("杨浦区")').first().click();
await page.waitForTimeout(200);
await shot(page, '50-scope-cascade-spl-shyp.png');
await page.click('#cascPanel [data-casc-ok]');
await page.waitForTimeout(300);
await page.fill('#homeQ', '跨境电商补贴');
await page.waitForTimeout(200);
await shot(page, '51-scope-home-filters.png');

/* 点检索 → 立刻抓一张检索屏（日志灌满，看滚动与取消键） */
await page.click('[data-go="search"]');
await page.waitForSelector('#fetchLogs', { timeout: 15000 });
await page.waitForTimeout(900);
const placed = await page.evaluate(() => {
  const list = document.getElementById('fetchLogs');
  if (!list) return null;
  list.innerHTML = Array.from({ length: 26 }, (_, i) =>
    `<li><span class="lt">${(1.1 + i * 0.1).toFixed(1)}s</span>`
    + `<span class="ls">${i < 4 ? '中国政府网' : '第 ' + (i - 3) + ' 个政策源'} — 完成 · 新增 ${(i * 3) % 7} 条</span>`
    + `<span class="lr"></span></li>`).join('');
  list.scrollTop = Math.round(list.scrollHeight * 0.45);   // 停在中间，看得到上下都被裁
  const body = document.querySelector('.search-body');
  const btn = document.querySelector('[data-cancel]');
  const s = document.querySelector('.screen').getBoundingClientRect();
  const b = btn ? btn.getBoundingClientRect() : null;
  return {
    logScrollH: list.scrollHeight, logClientH: list.clientHeight,
    bodyScrollH: body.scrollHeight, bodyClientH: body.clientHeight,
    cancelBottom: b ? Math.round(b.bottom - s.top) : null, screenH: Math.round(s.height),
  };
});
await page.waitForTimeout(200);
await shot(page, '52-search-logs-scrollable.png');

/* 等结果落地 */
await page.waitForSelector('.list-head h2', { timeout: 60000 });
await page.waitForTimeout(800);
await shot(page, '53-scope-list-spl-shyp.png');
const list = await page.evaluate(() => {
  const items = (DATA.policies && DATA.policies.items) || [];
  return {
    n: items.length,
    regionsUsed: (DATA.list.regionsUsed || []).slice(),
    name: items.map((p) => p.name),
    issuer: items.map((p) => p.issuer),
    title: (document.querySelector('.list-head h2') || {}).innerText || '',
  };
});
await page.evaluate(() => { const c = document.querySelector('.result-card'); if (c) c.click(); });
await page.waitForSelector('.clause', { timeout: 10000 }).catch(() => {});
await page.waitForTimeout(500);
await shot(page, '54-scope-detail-spl-shyp.png');

console.log('\n=== 视觉留档 ===');
console.log('检索屏：日志 scrollHeight/clientHeight =', placed && `${placed.logScrollH}/${placed.logClientH}`,
  '| search-body', placed && `${placed.bodyScrollH}/${placed.bodyClientH}`,
  '| 取消键底边', placed && placed.cancelBottom, '/ 画布高', placed && placed.screenH);
console.log('结果集：', list.n, '条 · regionsUsed =', list.regionsUsed.join('/'));
console.log('页头：', list.title);
list.name.slice(0, 6).forEach((n, i) => console.log('   ', n, '|', list.issuer[i]));
console.log('页面错误：', errs.length ? errs.slice(0, 2) : '无');
await browser.close();
