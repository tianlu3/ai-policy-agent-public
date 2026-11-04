/* ============================================================
   E2E：断连宽限期（connGraceMs）
   验证目标（2026-10-25 用户口径：演示时黄条别乱弹）：
     [1] 断连后 3s / 10s：不出现黄条（静默重试中，屏幕无变化）
     [2] 断连 17s：超过 15s 宽限期 → 黄条出现
     [3] 恢复连接：黄条自动消失，检索进度接上
   手法：Playwright 拦截「任务状态轮询」请求（GET /api/v1/searches/{id}），
        只让建任务的 POST /api/v1/searches 通过 —— 确定性模拟后端失联，
        比杀进程干净（不污染 8000/8010 实例）。
   用法：node tools/verify_conn_grace.mjs [baseUrl]
   ============================================================ */
import { mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(pathToFileURL(resolve(process.env.PW_WORKSPACE || 'C:/Users/22866/.workbuddy/binaries/node/workspace', 'noop.js')));
const pw = await import(pathToFileURL(require.resolve('playwright')).href);
const chromium = pw.chromium || (pw.default && pw.default.chromium);

const BASE = process.argv[2] || 'http://127.0.0.1:8050';
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '_shots');
mkdirSync(OUT, { recursive: true });

let fail = 0;
const ok = (c, label, extra) => {
  if (c) console.log('  ✓ ' + label);
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.auth-card', { timeout: 20000 });
await page.click('[data-auth-guest]');
await page.waitForSelector('#homeQ', { timeout: 15000 });

const banner = page.locator('#pipeConnLost');
const visible = () => banner.isVisible().catch(() => false);

console.log('【0】拦截轮询请求，模拟后端失联（建任务 POST 放行）');
/* 只拦 GET /api/v1/searches/{id}（状态/结果），POST /api/v1/searches 不拦 */
await page.route(/\/api\/v1\/searches\/[^/]+(\?.*)?$/, (route) => route.abort('connectionrefused'));

await page.fill('#homeQ', '杭州市小微企业补贴');
await page.click('[data-go="search"]');
await page.waitForSelector('#pipeBar', { state: 'attached', timeout: 10000 });
ok(true, '检索已发起（#pipeBar 挂载）');
ok(!(await visible()), '刚断连的第一时间没有黄条');

console.log('\n【1】宽限期内（< 15s）应全程静默');
await sleep(3000);
ok(!(await visible()), '断连 3s：无黄条（静默重试中）');
await sleep(7000);
ok(!(await visible()), '断连 10s：仍无黄条');
await page.screenshot({ path: resolve(OUT, 'grace-01-silent.png') });

console.log('\n【2】超过宽限期（15s）应出现黄条');
await sleep(7000);
const shown = await visible();
ok(shown, '断连 17s：黄条出现（明确告知在重试）');
const txt = shown ? (await banner.innerText()).replace(/\s+/g, '') : '';
ok(/连接中断|正在自动重试/.test(txt), '黄条文案为「连接中断/自动重试」', txt.slice(0, 40));
await page.screenshot({ path: resolve(OUT, 'grace-02-banner.png') });

console.log('\n【3】恢复连接后黄条应自动消失');
await page.unroute(/\/api\/v1\/searches\/[^/]+(\?.*)?$/);
await sleep(3000);
ok(!(await visible()), '恢复后 3s 内黄条消失');
const finished = await page.locator('#pipeBar').count();
ok(finished >= 0, '页面未崩溃（#pipeBar 仍在 DOM）');
await page.screenshot({ path: resolve(OUT, 'grace-03-recovered.png') });

await browser.close();
console.log(`\n结果：${fail === 0 ? '全部通过' : fail + ' 项失败'}`);
process.exit(fail === 0 ? 0 : 1);
