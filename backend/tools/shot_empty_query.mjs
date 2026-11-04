/* 空问句检索的视觉留档（2026-10-15「不要默认检索」）：
   ① 不填问句、只选 黑龙江省 + 大庆市 → 检索屏标题必须是「… · 不限 · 不限」，
      条件行不得出现「来自查询」的行业/类型；
   ② 结果列表页头与检索屏同一枚指纹。 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(pathToFileURL(resolve(
  process.env.PW_WORKSPACE || 'C:/Users/22866/.workbuddy/binaries/node/workspace', 'noop.js')));
const pw = await import(pathToFileURL(require.resolve('playwright')).href);
const chromium = pw.chromium || (pw.default && pw.default.chromium);

const BASE = process.argv[2] || 'http://127.0.0.1:8010';
const OUT = resolve(process.cwd(), '_shots');

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.auth-card', { timeout: 20000 });
await page.click('[data-auth-guest]');
await page.waitForSelector('#homeQ', { timeout: 20000 });

/* 只选地域，问句框留空 */
await page.click('#rgHome');
await page.waitForSelector('#cascPanel', { timeout: 5000 });
const col = (i) => page.locator('#cascPanel .casc-col').nth(i);
await col(0).locator('.frow:has-text("黑龙江省")').first().click();
await page.waitForTimeout(250);
await col(1).locator('.frow:has-text("大庆市")').first().click();
await page.waitForTimeout(250);
await page.click('#cascPanel [data-casc-ok]');
await page.waitForTimeout(300);

/* 问句框确认是空的 */
const q = await page.inputValue('#homeQ');
console.log('问句框内容:', JSON.stringify(q), q === '' ? '✓ 空' : '✗ 非空');

await page.click('[data-go="search"]');

/* 等待指纹到货且画上屏（与 verify_search_browser 同一口径，mock 下秒到）。
   注意 SEARCH_STATE 是页面里的顶层 const —— 不挂 window，要用裸标识符访问。 */
await page.waitForFunction(() => {
  const st = (typeof SEARCH_STATE !== 'undefined') ? SEARCH_STATE : null;
  const el = document.getElementById('pipeEcho');
  return !!el && !!st && !!st.condTitle && el.innerText.indexOf(st.condTitle) >= 0;
}, null, { timeout: 60000 });

const title = await page.locator('#pipeEcho').innerText();
const parsed = (await page.locator('#pipeParsed').innerText()).replace(/\s+/g, ' ');
console.log('检索屏标题:', title.trim());
console.log('条件行    :', parsed.trim());

const okTitle = title.includes('不限 · 不限') && !title.includes('智能硬件');
const okParsed = parsed.includes('行业 = 不限') && parsed.includes('类型 = 不限')
  && !parsed.includes('智能硬件 · 来自查询');
console.log(okTitle ? '✓ 标题没有捏造行业/类型' : '✗ 标题异常');
console.log(okParsed ? '✓ 条件行没有捏造行业/类型' : '✗ 条件行异常');

await page.screenshot({ path: resolve(OUT, '60-emptyq-search.png') });

/* 等结果列表 */
await page.waitForSelector('.result-card .rc-name', { timeout: 60000 });
await page.waitForTimeout(500);
const head = (await page.locator('.list-head h2').innerText()).replace(/\s+/g, ' ');
const n = await page.locator('.result-card').count();
console.log('列表页头  :', head.trim(), '| 卡片数:', n);
await page.screenshot({ path: resolve(OUT, '61-emptyq-list.png') });

console.log((okTitle && okParsed) ? '\nALL OK' : '\nFAILED');
await browser.close();
process.exit((okTitle && okParsed) ? 0 : 1);
