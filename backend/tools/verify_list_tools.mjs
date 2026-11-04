/* 结果列表工具条验收 —— 「排序能换、视图能切、重置已消失」的常驻闸门
   ================================================================
   这三件事以前都只是 `toast(...)` 占位：点了弹个提示、界面纹丝不动，
   用户看到的就是「没法切换」。本脚本用真浏览器把每一条都点一遍。

   用法：node tools/verify_list_tools.mjs [url]      默认 http://127.0.0.1:8000
*/
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(pathToFileURL(resolve(
  process.env.PW_WORKSPACE || 'C:/Users/22866/.workbuddy/binaries/node/workspace', 'noop.js'
)));
const pw = await import(pathToFileURL(require.resolve('playwright')).href);
const chromium = pw.chromium || (pw.default && pw.default.chromium);

const BASE = process.argv[2] || 'http://127.0.0.1:8000';
const SHOTS = join(dirname(fileURLToPath(import.meta.url)), '..', '_shots');

let pass = 0;
let fail = 0;
const ok = (c, m, extra) => {
  if (c) { pass += 1; console.log('  ok   ' + m + (extra === undefined ? '' : '   → ' + extra)); }
  else { fail += 1; console.log('  FAIL ' + m + (extra === undefined ? '' : '   → ' + extra)); }
};
const note = (m) => console.log('  ·    ' + m);

const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
const NOISE = /api\/v1\/db\/status|blocked by CORS policy|net::ERR_FAILED|net::ERR_CONNECTION_REFUSED|Failed to fetch/;
page.on('pageerror', (e) => { if (!NOISE.test(String(e))) errs.push(String(e)); });
page.on('console', (m) => { if (m.type() === 'error' && !NOISE.test(m.text())) errs.push(m.text()); });

const wait = (ms) => page.waitForTimeout(ms);
const cards = () => page.locator('.result-card');
const rows = () => page.locator('.result-table tbody tr');
const sortBtn = () => page.locator('[data-sort]');
const menuOpen = () => page.evaluate(() => {
  const w = document.querySelector('.sortwrap');
  const m = document.getElementById('sortMenu');
  if (!m) return null;
  return { open: !!(w && w.classList.contains('open')), display: getComputedStyle(m).display };
});

await page.goto(BASE + '/', { waitUntil: 'load' });
await wait(1000);
const guest = page.locator('.auth-card [data-auth-guest]');
if (await guest.count()) { await guest.first().click(); await wait(600); }

await page.click('[data-nav="list"]');
await wait(600);
console.log('被测地址：' + BASE);
ok(await page.locator('.list-body').count() === 1, '已进入结果列表屏');

/* 分页口径从页面里取（后端给的 total / perPage），断言不写死数字 */
const PER = await page.evaluate(() => (typeof DATA !== 'undefined' ? DATA.list.pager.perPage : 20));
const TOTAL = await page.evaluate(() => (typeof DATA !== 'undefined' ? DATA.list.pager.total : 96));
const PAGES = Math.ceil(TOTAL / PER);
const pgNum = (n) => page.locator('.pager .pg:not(.pg-nav)[data-page="' + n + '"]');
const pgNav = (n) => page.locator('.pager .pg-nav[data-page="' + n + '"]');
const pagerTxt = () => page.locator('.pager span').first().innerText();
const curPage = () => page.locator('.pager .pg.on').innerText();

/* ============================================================
   ① 排序下拉：能展开、能选、真的换序
   ============================================================ */
console.log('\n【① 排序】');
ok(await cards().count() === PER, '默认是卡片视图，本页 ' + PER + ' 条结果', String(await cards().count()));
let label = (await sortBtn().innerText()).replace(/\s+/g, ' ').trim();
ok(label === '排序：权威度 + 发布时间', '按钮显示当前排序方案', label);

let m = await menuOpen();
ok(m && !m.open && m.display === 'none', '菜单默认收起（DOM 里在，但不显示）', JSON.stringify(m));

let names = () => page.$$eval('.result-card .rc-name', (els) => els.map((e) => e.innerText.trim()));
const orderAuthority = await names();
note('权威度序：' + orderAuthority.join(' / '));

await sortBtn().click();
await wait(250);
m = await menuOpen();
ok(m && m.open && m.display !== 'none', '点按钮后菜单展开', JSON.stringify(m));
ok(await page.locator('.sortmenu .sortopt').count() === 4, '菜单里 4 个排序方案',
  String(await page.locator('.sortmenu .sortopt').count()));
ok(await page.locator('.sortmenu input, .sortmenu .so-search').count() === 0, '排序菜单里没有搜索框（不是筛选面板）');
const onCount = await page.locator('.sortopt.on').count();
ok(onCount === 1 && (await page.locator('.sortopt.on').innerText()).indexOf('权威度') >= 0,
  '当前方案在菜单里被标出', String(onCount));
await page.screenshot({ path: join(SHOTS, '36-list-sort-menu.png') });

/* 选「截止日期」—— 在这份样例数据上它与「权威度」同序，所以另选一个能看出差别的方案 */
await page.click('[data-sort-opt="publish"]');
await wait(450);
label = (await sortBtn().innerText()).replace(/\s+/g, ' ').trim();
ok(label === '排序：发布时间（最新优先）', '选完按钮文案跟着换', label);
m = await menuOpen();
ok(m && !m.open, '选完自动收起', JSON.stringify(m));
const orderPublish = await names();
ok(orderPublish.join('|') !== orderAuthority.join('|'), '列表顺序真的变了（不是只改了个标签）',
  orderPublish.join(' / '));
ok(orderPublish[0] === '《滨江区产业园房租减免实施细则》', '最新发布的那条排到了第一位', orderPublish[0]);
const pagerTxtPublish = await pagerTxt();
ok(pagerTxtPublish.indexOf('按「发布时间（最新优先）」排序') >= 0, '底部分页说明也跟着当前方案走', pagerTxtPublish.trim());

/* 再切一个方案，确认不是「只生效一次」 */
await sortBtn().click();
await wait(250);
await page.click('[data-sort-opt="confidence"]');
await wait(450);
ok((await names())[0] === '《滨江区产业园房租减免实施细则》'
  && (await sortBtn().innerText()).indexOf('字段置信度') >= 0, '换第二个方案同样生效');
await sortBtn().click();
await wait(250);
await page.click('[data-sort-opt="authority"]');
await wait(450);
ok((await names()).join('|') === orderAuthority.join('|'), '切回「权威度」能复现原顺序');

/* Esc / 点别处 收起 */
await sortBtn().click();
await wait(250);
ok((await menuOpen()).open, '再次展开');
await page.keyboard.press('Escape');
await wait(250);
ok(!(await menuOpen()).open, 'Esc 收起菜单');
await sortBtn().click();
await wait(250);
await page.click('.list-head h2');
await wait(250);
ok(!(await menuOpen()).open, '点菜单以外的地方收起菜单');

/* ============================================================
   ② 卡片 / 表格视图切换
   ============================================================ */
console.log('\n【② 卡片 / 表格】');
ok(await cards().count() === PER && await rows().count() === 0, '起点：卡片视图（没有表格）');
let btnCls = await page.evaluate(() => ({
  grid: document.querySelector('[data-view="grid"]').className,
  rows: document.querySelector('[data-view="rows"]').className,
}));
ok(/btn-outline on/.test(btnCls.grid) && !/on/.test(btnCls.rows), '「卡片」按钮是选中态', btnCls.grid.trim());

await page.click('[data-view="rows"]');
await wait(500);
ok(await rows().count() === PER && await cards().count() === 0, '点「表格」后渲染出本页行数、卡片消失',
  '行=' + (await rows().count()) + ' 卡片=' + (await cards().count()));
const ths = await page.$$eval('.result-table thead th', (els) => els.map((e) => e.innerText.trim()));
ok(ths.length === 8, '表头 8 列（勾选列无标题 + 7 个列头）', ths.join('|'));
ok(ths[1] === '政策名称' && ths.includes('截止') && ths.includes('剩余') && ths.includes('补贴标准'),
  '列头文案来自 list.json → table.cols', ths.slice(1).join(' / '));
btnCls = await page.evaluate(() => ({
  grid: document.querySelector('[data-view="grid"]').className,
  rows: document.querySelector('[data-view="rows"]').className,
}));
ok(/btn-outline on/.test(btnCls.rows) && !/on/.test(btnCls.grid), '选中态切到「表格」', btnCls.rows.trim());
await page.screenshot({ path: join(SHOTS, '37-list-table-view.png') });

/* 表格里勾选 / 打开详情 仍可用（复用卡片同一套 data 属性） */
const before = await page.locator('#pickCount').innerText();
await page.click('.result-table tbody tr:first-child .checkbox');
await wait(400);
const after = await page.locator('#pickCount').innerText();
ok(before !== after, '表格里能勾选（勾选数变了）', before.trim() + ' → ' + after.trim());
ok(await page.locator('.result-table tbody tr:first-child.picked').count() === 1, '该行标出 picked 态');
await page.click('.result-table tbody tr.picked .rt-n');
await wait(500);
ok(await page.locator('.detail-title').count() === 1, '点表格里的政策名能进详情页');
/* 顶栏高亮必须跟着当前屏走 —— 详情页曾错挂 topBar('list')，
   表现是「人在政策详情页、导航却高亮结果列表」，这里钉死。 */
const navOn = await page.evaluate(() =>
  [...document.querySelectorAll('.tb-nav button.on')].map((b) => b.dataset.nav));
ok(navOn.length === 1 && navOn[0] === 'detail',
  '  顶栏高亮跟到「政策详情」（不再停在「结果列表」）', navOn.join(',') || '(无高亮)');
ok(await page.locator('.tb-nav button[data-nav="list"].on').count() === 0,
  '  「结果列表」已取消高亮');
await page.click('[data-nav="list"]');
await wait(600);
ok(await page.locator('.tb-nav button[data-nav="list"].on').count() === 1,
  '  回列表后高亮回到「结果列表」');
ok(await rows().count() === PER, '回到列表仍保持表格视图（视图状态没丢）');

await page.click('[data-view="grid"]');
await wait(500);
ok(await cards().count() === PER && await rows().count() === 0, '切回卡片视图正常');
const pickedN = Number((await page.locator('#pickCount').innerText()).replace(/\D/g, ''));
ok(await page.locator('.result-card.picked').count() === pickedN,
  '切视图不丢已勾选', (await page.locator('.result-card.picked').count()) + ' / ' + pickedN);

/* ============================================================
   ③ 「重置」已移除
   ============================================================ */
console.log('\n【③ 重置入口】');
ok(await page.locator('[data-reset-filter]').count() === 0, '结果列表里没有「重置」按钮');
const fbTxt = await page.locator('.filterbar').innerText();
ok(fbTxt.indexOf('重置') < 0, '筛选栏里也没有「重置」字样', fbTxt.replace(/\s+/g, ' ').trim().slice(0, 60));
ok(fbTxt.indexOf('本次检索使用的地域条件') >= 0, '  只读地域回显与说明还在');

/* ============================================================
   ④ 分页：页码真的换内容（不是只有个高亮的第 1 页）
   ============================================================ */
console.log('\n【④ 分页】');
ok((await pagerTxt()).indexOf('共 ' + TOTAL + ' 条 · 每页 ' + PER + ' 条 · 第 1 / ' + PAGES + ' 页') >= 0,
  '分页说明按后端口径渲染（不写死数字）', (await pagerTxt()).trim());
ok(await page.locator('.pager .pg[data-page]').count() === PAGES + 2,
  '页码 + 上/下一页按钮都在', PAGES + ' 个页码 + 2 个翻页按钮');

const page1Names = await names();
await pgNum(2).click();
await wait(500);
ok((await pagerTxt()).indexOf('第 2 / ' + PAGES + ' 页') >= 0, '点第 2 页后说明跟着变', (await pagerTxt()).trim());
const page2Names = await names();
ok(page2Names.length === PER && page2Names.every((n) => page1Names.indexOf(n) < 0),
  '第 2 页真的换了内容（与第 1 页零重叠）', '第 2 页首条 ' + page2Names[0]);
ok((await curPage()).trim() === '2', '当前页高亮跟着走', (await curPage()).trim());
await page.screenshot({ path: join(SHOTS, '38-list-page2.png') });

await pgNav(1).click();
await wait(500);
ok((await curPage()).trim() === '1', '「上一页」能回到第 1 页');
ok(await (await names()).join('|') === page1Names.join('|'), '回到第 1 页内容与原来一致（可复现）');
ok(await pgNav(0).isDisabled(), '第 1 页时「上一页」是禁用态');

await pgNum(PAGES).click();
await wait(500);
ok(await page.locator('.pg-nav[data-page="' + (PAGES + 1) + '"]').isDisabled(), '末页时「下一页」禁用');
ok((await names()).length === TOTAL - (PAGES - 1) * PER, '末页是剩下的那些条（不满一页也正常）',
  (await names()).length + ' 条');
await page.screenshot({ path: join(SHOTS, '39-list-last-page.png') });
await pgNum(1).click();
await wait(500);

const selAllTxt = await page.locator('.listhead-row span').nth(1).innerText();
ok(selAllTxt.indexOf('本页 ' + PER + ' 条') >= 0, '「全选」作用的是本页（文案带本页条数）', selAllTxt.trim());

/* ============================================================
   ⑤ 对比：勾选 2–5 条后并排比对核心字段
   ============================================================ */
console.log('\n【⑤ 对比】');

/** 重新进列表（刷新页面，勾选归零 —— 启动不替用户预选任何政策） */
async function enterList() {
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await wait(900);
  const g = page.locator('.auth-card [data-auth-guest]');
  if (await g.count()) { await g.first().click(); await wait(500); }
  await page.click('[data-nav="list"]');
  await wait(600);
}
const cardBox = (i) => page.locator('.result-card .checkbox').nth(i);
const pickTxt = () => page.locator('#pickCount').innerText();
const lastToast = async () => {
  const list = page.locator('#toasts .toast');
  const n = await list.count();
  return n ? await list.nth(n - 1).innerText() : '';
};

await enterList();
ok(await page.locator('.cmp-mask').count() === 0, '默认不显示对比浮层');
ok((await pickTxt()).indexOf('0') >= 0, '启动不预勾选任何政策（不再是后端 top2 演示预选）', (await pickTxt()).trim());
/* 这一节要验「对比 2 条」：由用例自己勾上本页第 1、2 张卡片，不依赖任何预选 */
await cardBox(0).click(); await wait(200);
await cardBox(1).click(); await wait(300);
ok((await pickTxt()).indexOf('2') >= 0, '手工勾选 2 条', (await pickTxt()).trim());

await page.click('[data-compare]');
await wait(500);
ok(await page.locator('.cmp-mask').count() === 1, '点「对比」后浮层出现');
const cols = await page.locator('.cmp-table thead th').count();
ok(cols === 3, '表头 = 对比项列 + 2 条政策', cols + ' 列');
const cmpHdr = await page.locator('.cmp-table thead').innerText();
ok(cmpHdr.indexOf('对比项') >= 0, '对比项列头来自 list.compare.fieldHead');
const cmpRows = await page.$$eval('.cmp-table tbody tr', (els) => els.length);
ok(cmpRows === 12, '12 项核心字段逐行比对', cmpRows + ' 行');
const cmpTxt = await page.locator('.cmp-panel').innerText();
ok(cmpTxt.indexOf('有差异') >= 0, '字段值不同的行标出「有差异」');
ok(await page.locator('.cmp-table tbody tr.diff').count() > 0, '  且确实有 diff 行',
  String(await page.locator('.cmp-table tbody tr.diff').count()) + ' 行有差异');
await page.screenshot({ path: join(SHOTS, '40-list-compare.png') });

await page.keyboard.press('Escape');
await wait(400);
ok(await page.locator('.cmp-mask').count() === 0, 'Esc 关闭对比浮层');

await page.click('[data-compare]');
await wait(400);
ok(await page.locator('.cmp-mask').count() === 1, '再次打开正常');
await page.click('.cmp-panel .cmp-body');
await wait(300);
ok(await page.locator('.cmp-mask').count() === 1, '点面板内部不会误关（只有遮罩空白处才关）');
await page.click('.cmp-head [data-cmp-close]');
await wait(400);
ok(await page.locator('.cmp-mask').count() === 0, '「关闭对比」按钮能关');

await page.click('[data-compare]');
await wait(400);
/* 注：原型画布带 transform，遮罩的定位上下文是画布而不是视口 ——
   所以要按遮罩自身的相对坐标点左边空白处（面板居中、两侧留白 ≥ 40px）。 */
await page.locator('.cmp-mask').click({ position: { x: 14, y: 320 } });
await wait(400);
ok(await page.locator('.cmp-mask').count() === 0, '点遮罩空白处也能关');

/* 条数不够：取消到只剩 1 条 */
await page.locator('.result-card.picked .checkbox').first().click();
await wait(400);
ok((await pickTxt()).indexOf('1') >= 0, '取消一条 → 只剩 1 条', (await pickTxt()).trim());
await page.click('[data-compare]');
await wait(400);
ok(await page.locator('.cmp-mask').count() === 0, '条数不足时不打开浮层');
ok((await lastToast()).indexOf('至少勾选 2 条') >= 0, '  并给出明确原因（不是点了没反应）',
  (await lastToast()).replace(/\s+/g, ' ').trim());
await wait(2400);

/* 条数超限：补到 6 条（从 0 起勾 6 张 —— 启动没有预选） */
await enterList();
for (const i of [0, 1, 2, 3, 4, 5]) { await cardBox(i).click(); await wait(150); }
ok((await pickTxt()).indexOf('6') >= 0, '补到 6 条', (await pickTxt()).trim());
await page.click('[data-compare]');
await wait(400);
ok(await page.locator('.cmp-mask').count() === 0, '超过上限时不打开浮层');
ok((await lastToast()).indexOf('最多同时对比 5 条') >= 0, '  并说明上限是多少',
  (await lastToast()).replace(/\s+/g, ' ').trim());
await wait(2400);

/* 取消到 5 条（上限内）→ 能开，且列数 = 5 */
await cardBox(0).click();
await wait(400);
await page.click('[data-compare]');
await wait(500);
ok(await page.locator('.cmp-mask').count() === 1, '回到上限内后能打开');
ok(await page.locator('.cmp-table thead th').count() === 6, '5 条政策 = 5 列 + 对比项列',
  String(await page.locator('.cmp-table thead th').count()) + ' 列');
await page.screenshot({ path: join(SHOTS, '41-list-compare-5.png') });
await page.click('.cmp-head [data-cmp-close]');
await wait(400);

/* ============================================================ */
console.log('\nJS 错误：' + (errs.length ? errs.join(' | ') : '无'));
if (errs.length) fail += 1;
console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
await browser.close();
process.exit(fail ? 1 : 0);
