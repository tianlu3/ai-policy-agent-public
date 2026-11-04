/* 针对性截图：后端 grounding 落地后的「申报条件 · 逐条自查」与「原文快照」。
   用法：node tools/shot_grounding.mjs [baseUrl]
   —— 走真实检索链路（后端给 conditionsDetail / snapshotMarks），不是离线样例集。 */
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
const shot = (page, n) => page.screenshot({ path: resolve(OUT, n + '.png'), fullPage: false });

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });

/* 游客进入（首屏是「登录 / 注册」闸门） */
await page.waitForSelector('.auth-card', { timeout: 20000 });
await page.click('[data-auth-guest]');
await page.waitForSelector('#homeQ', { timeout: 20000 });

await page.fill('#homeQ', '我是杭州做智能硬件的，能申什么补贴');
await page.click('[data-go="search"]');
/* ★ 不能等右下角通知：那条通知是「用户不在检索屏时才弹」的。
   本脚本搜完仍停在检索屏 → 应用会直接跳结果列表，通知根本不出现（等它会死等）。
   直接等结果卡片落地即可。 */
await page.waitForSelector('.result-card .rc-name', { timeout: 900000 });
await page.locator('.result-card .rc-name').first().click();
await page.waitForSelector('.clause', { timeout: 15000 });
await page.waitForTimeout(400);
await shot(page, '40-ground-detail');

const dump = await page.evaluate(() => {
  const items = (DATA.list.items || []);
  const p = DATA.policyById(APP.policyId) || items[0];
  return {
    name: p.name,
    confidence: p.confidence,
    matched: p.matched,
    unverified: p.unverified,
    offset: p.offset,
    snapshot: (p.snapshot || '').slice(0, 200),
    marks: p.snapshotMarks,
    details: (p.conditionsDetail || []).map((d) => ({
      full: d.full.slice(0, 28), status: d.status, conf: d.confidence, offset: d.offset,
    })),
    clauseMetaText: Array.from(document.querySelectorAll('.clause .cmeta')).map((e) => e.innerText.replace(/\s+/g, ' ')),
  };
});
console.log(JSON.stringify(dump, null, 1));

await page.click('[data-snap-open]').catch(() => {});
await page.waitForTimeout(400);
await shot(page, '41-ground-snapshot');
await browser.close();
