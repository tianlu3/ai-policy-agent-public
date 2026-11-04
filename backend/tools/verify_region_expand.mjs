/* 临时验证：用户截图场景 —— 选「内蒙古自治区 + 黑龙江省」，行业/类型都不限。
   断言：① 两个省都真的进了结果；② 结果按「地域全层级 × 主题」铺开（数百条）；
        ③ 页头/页脚/条件摘要口径一致；④ 无 JS 报错。
   用法：node tools/_verify_multiregion.mjs [baseUrl]                */
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

let fail = 0;
const ok = (c, label, extra) => {
  if (c) console.log('  ✓ ' + label);
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
};

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.auth-card', { timeout: 20000 });
await page.click('[data-auth-guest]');
await page.waitForSelector('#homeQ', { timeout: 20000 });

console.log('\n【0】清空行业 / 类型 / 截止 + 问句（复现用户截图：什么都不设）');
for (const g of ['industry', 'type', 'deadline']) {
  await page.click(`[data-opt-trigger="${g}"]`);
  await page.waitForSelector('#optPanel', { timeout: 5000 });
  await page.click('#optPanel [data-opt-clear]');
  await page.click('#optPanel [data-opt-ok]');
  await page.waitForTimeout(200);
}
const cleared = await page.evaluate(() => ['industry', 'type', 'deadline']
  .map((g) => (document.querySelector(`[data-opt-trigger="${g}"]`) || {}).innerText || '')
  .map((t) => t.replace(/\s+/g, ' ').trim()));
ok(cleared.every((t) => t.indexOf('不限') >= 0 || t.indexOf('近 12 个月') >= 0),
  '三个维度都已回到「不限 / 近 12 个月」', cleared);
console.log('\n【1】地域筛选：内蒙古自治区(15) + 黑龙江省(23)，行业/类型都不勾');
await page.click('#rgHome');
await page.waitForSelector('#cascPanel', { timeout: 5000 });
for (const code of ['15', '23']) {
  const row = page.locator(`#cascPanel .frow[data-casc-node="${code}"]`);
  if (!(await row.count())) { await page.fill('#cascPanel #cascQ', code === '15' ? '内蒙古' : '黑龙江'); await page.waitForTimeout(250); }
  await row.first().scrollIntoViewIfNeeded();
  await row.first().click();
  await page.waitForTimeout(150);
}
await page.click('#cascPanel [data-casc-ok]');
await page.waitForTimeout(300);
const picked = await page.evaluate(() => Array.from(document.querySelectorAll('#rgHome .tag'))
  .map((e) => e.textContent.trim()));
ok(picked.length === 2, '触发器上挂着 2 个地域标签', picked);

console.log('\n【2】开始检索并等结果落地');
/* 问句换成一句**不带行业 / 类型词**的泛问。本轮起行业 / 类型会从问句里解析出来
   （先解析、再检索）：留着默认问句「我是杭州做智能硬件的，能申什么补贴」就会解析出
   智能硬件 / 补贴 → 主题池收窄 → 只剩 271 条，「地域全层级铺满」的规模断言失去意义。
   两个细节：
     ① 前端刻意不允许空问句（`APP.query || DATA.search.defaultQuery`），所以要填一句真话；
     ② 必须在**所有面板交互之后**再填 —— 上面点「确定」会整屏 render()，
        输入框是按 APP.query 重建的，早填的会被冲掉。 */
await page.fill('#homeQ', '有什么政策');
await page.waitForTimeout(200);
ok((await page.inputValue('#homeQ')).indexOf('智能硬件') < 0,
  '问句换成泛问「有什么政策」（不含行业 / 类型词，避免查询理解收窄主题池）',
  await page.inputValue('#homeQ'));
await page.click('[data-go="search"]');
await page.waitForSelector('.list-head h2', { timeout: 60000 });
await page.waitForTimeout(600);

const s = await page.evaluate(() => {
  const items = (typeof DATA !== 'undefined' && DATA.policies && DATA.policies.items) || [];
  const issuers = items.map((p) => p.issuer || '');
  const levels = [...new Set(items.map((p) => p.level))];
  const tally = {};
  items.forEach((p) => { tally[p.level] = (tally[p.level] || 0) + 1; });
  return {
    n: items.length,
    levels, tally,
    regionsUsed: (DATA.list.regionsUsed || []).slice(),
    title: (document.querySelector('.list-head h2') || {}).innerText || '',
    pager: (document.querySelector('.pager span') || {}).innerText || '',
    condRow: (() => {
      const rows = Array.from(document.querySelectorAll('.filterbar .fb-row'));
      const last = rows[rows.length - 1];
      return last ? last.innerText.replace(/\s+/g, ' ').trim() : '';
    })(),
    inner: issuers.filter((x) => x.startsWith('内蒙古')).length,
    heilong: issuers.filter((x) => x.startsWith('黑龙江')).length,
    hz: issuers.filter((x) => x.startsWith('呼和浩特')).length,
    harbin: issuers.filter((x) => x.startsWith('哈尔滨')).length,
    perPage: typeof listPerPage !== 'undefined' ? listPerPage() : -1,
    pages: typeof listPageCount !== 'undefined' ? listPageCount() : -1,
  };
});

console.log('\n【3】结果集规模与覆盖');
ok(s.n > 300, '结果不再只有 21 条，而是「数百条」量级', s.n);
ok(s.regionsUsed.length === 2, '条件回显的地域数 = 2（内蒙古 / 黑龙江）', s.regionsUsed);
ok(s.title.indexOf('内蒙古自治区') >= 0 && s.title.indexOf('黑龙江省') >= 0,
  '页头标题同时含两个省', s.title);
ok(s.inner > 0 && s.heilong > 0, '内蒙古与黑龙江的省级政策都产出了',
  { 内蒙古: s.inner, 黑龙江: s.heilong });
ok(s.hz > 0 && s.harbin > 0, '两省下辖市也展开了（呼和浩特 / 哈尔滨）',
  { 呼和浩特: s.hz, 哈尔滨: s.harbin });
ok(['国家级', '省级', '市级', '区县级'].every((lv) => s.levels.includes(lv)),
  '四个层级齐全（国家级 / 省级 / 市级 / 区县级）', s.levels);
ok(s.pages === Math.max(1, Math.ceil(s.n / s.perPage)), '页数 = ceil(总数 / 每页)',
  `${s.pages} 页 / ${s.n} 条 / 每页 ${s.perPage}`);
ok(new RegExp('共\\s*' + s.n + '\\s*条').test(s.pager), '页脚「共 n 条」跟得上结果集', s.pager);
ok(s.condRow.indexOf('地域 2 个') >= 0, '条件摘要「地域 2 个」与回显一致', s.condRow);
ok(s.condRow.indexOf('行业') < 0 && s.condRow.indexOf('类型') < 0,
  '条件摘要不含行业 / 类型（筛选栏没设、问句里也没提 → 不无中生有）', s.condRow);
ok(s.condRow.indexOf('近 12 个月') >= 0, '截止未设 → 显示默认窗口「近 12 个月」', s.condRow);

console.log('\n  层级分布：', JSON.stringify(s.tally));
console.log('  页脚：', s.pager);
console.log('  条件摘要：', s.condRow);

console.log('\n【4】翻到最后一页仍有内容');
const last = await page.evaluate(() => {
  const bak = LIST_STATE.page;
  LIST_STATE.page = listPageCount();
  render();
  const n = document.querySelectorAll('.result-card').length;
  LIST_STATE.page = bak;
  render();
  return n;
});
ok(last > 0, '末页不是空页', last);

await page.screenshot({ path: resolve(OUT, 'multiregion-2prov.png'), fullPage: false });

/* ---------------------------------------------------------------
   【4.5】下钻到区县后**不再横向铺开兄弟区县**（2026-10-15 用户截图场景）

   用户实测：筛选栏里选了「上海市 + 杨浦区」，结果列表却出现松江 / 崇明 /
   徐汇 / 普陀 / 浦东新区 …… 15 个与他无关的区。根因是「下辖全层级展开」
   对选中节点无条件生效 —— 展开一个已被下钻的分支时，只该走被选中的那几支。
   --------------------------------------------------------------- */
console.log('\n【4.5】下钻到区县：只剩 上海市 + 杨浦区（不再铺开其余 15 个区）');
/* 重新装载一次再操作：一是别带上前面「内蒙古 + 黑龙江」的已选标签
   （#rgHome 上挂着标签时，点它的中心会落在标签的 × 上 → 变成「删掉一个地域」
   而不是打开面板），二是这条路径本就该从干净状态起步。 */
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
/* 游客态已经记住 → 直接进首页；只有没记住时才走一遍登录闸门 */
const gate2 = await page.waitForSelector('.auth-card', { timeout: 8000 })
  .then(() => true).catch(() => false);
if (gate2) await page.click('[data-auth-guest]');
await page.waitForSelector('#homeQ', { timeout: 20000 });
await page.click('[data-region-trigger]');
await page.waitForSelector('#cascPanel', { timeout: 5000 });
/* 级联态（不填搜索框）：第 0 列是省级行政区（含直辖市），点上海市才会展开它下辖那列 */
const col = (i) => page.locator('#cascPanel .casc-col').nth(i);
await col(0).locator('.frow:has-text("上海市")').first().click();
await page.waitForFunction(() => {
  const c = document.querySelectorAll('#cascPanel .casc-col')[1];
  return !!c && (c.textContent || '').indexOf('杨浦区') >= 0;
}, null, { timeout: 5000 }).catch(() => {});
await page.waitForTimeout(200);
await col(1).locator('.frow:has-text("杨浦区")').first().click();
const drafted2 = await page.waitForFunction(() => CASCADE.draft.size >= 2, null, { timeout: 4000 })
  .then(() => true).catch(() => false);
ok(drafted2, '（前置）上海市 + 杨浦区都进了地域草稿',
  await page.evaluate(() => CASCADE.draft.size));
await page.click('#cascPanel [data-casc-ok]');
await page.waitForTimeout(300);

await page.fill('#homeQ', '跨境电商补贴');
await page.waitForTimeout(200);
await page.click('[data-go="search"]');
await page.waitForSelector('.list-head h2', { timeout: 60000 });
await page.waitForTimeout(600);

const d2 = await page.evaluate(() => {
  const items = (typeof DATA !== 'undefined' && DATA.policies && DATA.policies.items) || [];
  return {
    n: items.length,
    names: items.map((p) => p.name || ''),
    issuers: items.map((p) => p.issuer || ''),
    regionsUsed: (DATA.list.regionsUsed || []).slice(),
    title: (document.querySelector('.list-head h2') || {}).innerText || '',
  };
});
const OTHER_D = ['黄浦区', '徐汇区', '长宁区', '静安区', '普陀区', '虹口区', '闵行区',
  '宝山区', '嘉定区', '浦东新区', '金山区', '松江区', '青浦区', '奉贤区', '崇明区'];
const strayNames = d2.names.filter((n) => OTHER_D.some((x) => n.indexOf(x) >= 0));
const strayIssuers = d2.issuers.filter((n) => OTHER_D.some((x) => n.indexOf(x) >= 0));
ok(d2.regionsUsed.join('/') === '上海市/杨浦区', '条件回显 = 上海市 / 杨浦区', d2.regionsUsed);
ok(strayNames.length === 0, '★ 结果里不出现别的区（松江 / 崇明 / 徐汇 …）', strayNames.slice(0, 4));
ok(strayIssuers.length === 0, '  发文机关也都是上海市 / 杨浦区的', strayIssuers.slice(0, 4));
ok(d2.names.some((n) => n.indexOf('杨浦区') >= 0), '杨浦区自己的政策确实出来了',
  d2.names.slice(0, 3));
ok(d2.title.indexOf('杨浦区') >= 0, '页头标题带上了杨浦区', d2.title);
ok(0 < d2.n < 60, '条数收到「一个市 + 一个区」的量级', d2.n);
await page.screenshot({ path: resolve(OUT, 'multiregion-drilldown.png'), fullPage: false });
console.log('  产出 %d 条：%s', d2.n, d2.names.slice(0, 4).join(' | '));

console.log('\n【5】页面错误');
ok(errs.length === 0, '无 JS 运行时错误', errs.slice(0, 3));

await browser.close();
console.log(fail === 0 ? '\n全部通过 ✅' : `\n${fail} 项未通过 ❌`);
process.exit(fail === 0 ? 0 : 1);
