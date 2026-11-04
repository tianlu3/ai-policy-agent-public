/* ============================================================
   详情页三处新交互的快速验收（对 8010 mock 跑）：
     【A】左上角「返回」按钮存在且能回结果列表
     【B】详情页「加入对比」：真把当前政策加进清单；
         凑够 2 条 → 回结果列表并直接打开对比浮层
     【C】检索第 6 步文案 = 「结果打包」（不再宣称自动生成简报）
   用法：node tools/verify_detail_ui.mjs [url]   默认 http://127.0.0.1:8010
   ============================================================ */
import { pathToFileURL } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(pathToFileURL(resolve(
  process.env.PW_WORKSPACE || 'C:/Users/22866/.workbuddy/binaries/node/workspace', 'noop.js'
)));
const pw = await import(pathToFileURL(require.resolve('playwright')).href);
const chromium = pw.chromium || (pw.default && pw.default.chromium);

const BASE = process.argv[2] || 'http://127.0.0.1:8010';
const SHOTS = join(dirname(fileURLToPath(import.meta.url)), '..', '_shots');

let pass = 0, fail = 0;
const ok = (c, m, extra) => {
  if (c) { pass += 1; console.log('  ok   ' + m + (extra === undefined ? '' : '   → ' + extra)); }
  else { fail += 1; console.log('  FAIL ' + m + (extra === undefined ? '' : '   → ' + extra)); }
};

const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const wait = (ms) => page.waitForTimeout(ms);

await page.goto(BASE + '/', { waitUntil: 'load' });
await wait(1100);
const guest = page.locator('.auth-card [data-auth-guest]');
if (await guest.count()) { await guest.first().click(); await wait(700); }

/* ---------- 【A】返回按钮 ---------- */
console.log('【A】详情页左上角「返回」');
await page.evaluate(() => {
  go('detail', { policyId: DATA.policies.items[0].id, target: DATA.detail.defaultTarget });
});
await wait(500);
ok(await page.locator('.detail-back').count() === 1, '返回按钮存在且只有 1 个');
ok((await page.locator('.detail-back').innerText()).includes('返回'), '按钮文案含「返回」');
const backBox = await page.locator('.detail-back').boundingBox();
ok(!!backBox && backBox.x < 220, '按钮位于详情区左上角', backBox && Math.round(backBox.x));
await page.screenshot({ path: join(SHOTS, '_detail_back.png') });
await page.locator('.detail-back').click();
await wait(600);
ok(await page.evaluate(() => APP.screen) === 'list', '点返回 → 回到结果列表');

/* ---------- 【B】详情页加入对比 ---------- */
console.log('【B】详情页「加入对比」优化');
await page.evaluate(() => {
  LIST_STATE.picked.clear();
  go('detail', { policyId: DATA.policies.items[1].id, target: DATA.detail.defaultTarget });
});
await wait(500);
await page.locator('.detail-tags [data-compare]').click();
await wait(700);
ok(await page.evaluate(() => APP.screen) === 'list', '不足 2 条 → 回结果列表继续勾');
ok(await page.evaluate(() => LIST_STATE.compareOpen) === false, '不足 2 条 → 不弹对比浮层');
ok(await page.evaluate((id) => LIST_STATE.picked.has(id), await page.evaluate(() => DATA.policies.items[1].id)),
  '当前政策真的进了对比清单（picked.size=' + (await page.evaluate(() => LIST_STATE.picked.size)) + '）');
const toastB = await page.locator('.toast').last().innerText().catch(() => '');
ok(/还差|加入对比/.test(toastB), '提示说清还差几条', toastB.replace(/\n/g, ' '));

// 在结果列表勾第二条 → 点工具条「对比」→ 浮层打开（原路径不受影响）
await page.evaluate(() => {
  const second = DATA.policies.items[2].id;
  LIST_STATE.picked.add(second);
  render();
});
await wait(400);
await page.locator('.list-tools [data-compare], .result-list [data-compare], [data-compare]').first().click();
await wait(600);
ok(await page.evaluate(() => LIST_STATE.compareOpen) === true, '勾够 2 条 → 对比浮层打开');
await page.locator('[data-cmp-close]').first().click().catch(() => {});
await wait(400);

// 详情页凑够 2 条的直接路径：在详情页点加入对比 → 回列表并自动打开对比
await page.evaluate(() => {
  LIST_STATE.picked.clear();
  go('detail', { policyId: DATA.policies.items[1].id, target: DATA.detail.defaultTarget });
});
await wait(500);
await page.evaluate(() => { LIST_STATE.picked.add(DATA.policies.items[3].id); });
await page.locator('.detail-tags [data-compare]').click();
await wait(700);
ok(await page.evaluate(() => APP.screen) === 'list' && await page.evaluate(() => LIST_STATE.compareOpen) === true,
  '详情页凑够 2 条 → 回列表且对比浮层直接打开');
await page.screenshot({ path: join(SHOTS, '_detail_compare.png') });

/* ---------- 【C】检索第 6 步文案 ---------- */
console.log('【C】检索第 6 步 = 「结果打包」');
const steps = await page.evaluate(() => DATA.search.steps);
ok(steps[5] === '结果打包', '第 6 步文案 = 结果打包', steps[5]);
ok(!steps.join().includes('简报生成'), '步骤里不再出现「简报生成」');
const titles = await page.evaluate(() => DATA.search.runningTitles);
ok(titles[5] === '结果打包中', '运行标题 = 结果打包中', titles[5]);

console.log(`\n结果：通过 ${pass} 项${fail ? `，失败 ${fail} 项` : '，全部通过'}`);
await browser.close();
process.exit(fail ? 1 : 0);
