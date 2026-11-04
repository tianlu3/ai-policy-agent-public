/* ============================================================
   真实浏览器端到端验证：首页填词 → 点「开始检索」→ 停在检索屏看进程
   → 服务端返回后自动跳结果列表。
   用系统 Edge（channel: msedge），不下载额外浏览器。
   用法：node tools/verify_search_browser.mjs [baseUrl]
   ============================================================ */
import { mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

/* playwright 装在 WorkBuddy 独立工作区，避免污染项目；用 require 解析其入口再动态 import */
const require = createRequire(pathToFileURL(resolve(process.env.PW_WORKSPACE || 'C:/Users/22866/.workbuddy/binaries/node/workspace', 'noop.js')));
const pw = await import(pathToFileURL(require.resolve('playwright')).href);
const chromium = pw.chromium || (pw.default && pw.default.chromium);

const BASE = process.argv[2] || 'http://127.0.0.1:8000';
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '_shots');
mkdirSync(OUT, { recursive: true });

let fail = 0;
const ok = (c, label, extra) => {
  if (c) console.log('  ✓ ' + label);
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
};

const shot = (page, name) => page.screenshot({ path: resolve(OUT, name + '.png'), fullPage: false });

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();

const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
/* 定位 404 等失败请求的具体 URL */
const badResponses = [];
page.on('response', (r) => { if (r.status() >= 400) badResponses.push(r.status() + ' ' + r.url()); });

/* ---------- 记录前端真实发出的检索接口调用 ---------- */
const calls = [];
page.on('request', (r) => { if (r.url().includes('/api/v1/')) calls.push(r.method() + ' ' + r.url().replace(BASE, '')); });

/* 产品顶栏导航项 */
const navLabels = () => page.evaluate(() => Array.from(
  document.querySelectorAll('.tb-nav button')).map((b) => b.textContent.trim()));

console.log('【1】打开应用并等待数据装载（收到后端数据后才渲染）');
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });

/* 首屏闸门：未登录必须先「登录」或「以游客身份继续」，点后者进首页 */
await page.waitForSelector('.auth-card', { timeout: 20000 });
ok(true, '未登录首屏落在「登录 / 注册」闸门（必须先登录或以游客身份进入）');
await page.click('[data-auth-guest]');
ok(true, '点「以游客身份继续」→ 进入首页');

await page.waitForSelector('#homeQ', { timeout: 15000 });
ok(await page.locator('#homeQ').count() === 1, '首页检索框已渲染（说明 bootstrap 装载成功）');
const bootText = await page.locator('.boot-pill').innerText().catch(() => '');
ok(/已自动加载\s*\d+\s*个内置政策源/.test(bootText), '首启文案由后端 stats 插值', bootText);

/* ---------- 顶部不再有原型索引条：入口全在产品导航里 ---------- */
ok(await page.locator('.proto-bar').count() === 0, '顶部原型索引条已移除');
const navs = await navLabels();
ok(navs.length === 5, '产品顶栏导航 5 项（v1.4 已删任务监控 / 订阅提醒 / 地域多选 / 异常降级）', navs);
ok(navs.indexOf('检索中') < 0, '「检索中」不作为导航项（过程态）', navs);
ok(await page.locator('.tb-run').count() === 0, '未检索时顶栏没有「检索中」胶囊');
await shot(page, '01-home');

console.log('\n【2】填入查询并点击「开始检索」');
await page.fill('#homeQ', '我是杭州做智能硬件的，能申什么补贴');
await page.click('[data-go="search"]');
/* ★ 等「挂载」而不是「可见」：进度条是 `width:0%` 的 <i>，第 0 步（查询理解）期间
   `total` 还没拿到，pct 恒为 0 → 宽度为 0 → Playwright 判它 hidden。
   旧模型解析 ~1s 时这个 10s 的「可见」等待碰巧总能过，换成 glm-4.5-flash 后解析
   实测 4.6~7.1s（免费档高峰期更久），竞态就暴露了。这里断言的本意是「已进入检索屏」，
   存在即可；进度真的在推进由下一节「进度条宽度在推进」单独盯。 */
await page.waitForSelector('#pipeBar', { state: 'attached', timeout: 10000 });
ok(true, '已进入检索屏（#pipeBar 挂载完成）');
ok(await page.locator('.tb-run').count() === 1, '检索开始后顶栏出现「检索中 n%」胶囊');

console.log('\n【3】验证「结果返回前一直停在检索屏」且进程在推进');
/* 先等进度真的开始推进（第 0 步解析结束、crawl 拿到 total），再采样：
   只确认「屏幕没跳走 + 进度在变」，随后马上切屏——后面的步骤专测「切屏不中断」。
   ★ 采样窗不能写死 800ms：真实模型在「AI 结构化」那一步可能几十秒才挪一格，
     固定短窗口会误报「进度条静止」（8000 实例上实测偶发 1 项红）。
     现在改成「采到两个不同宽度就立刻收工」，最多等 15s；这一小段里直接跑完了也算过。
     mock 仍是秒级返回 + 早退，不拖时间。 */
const advanced = await page.waitForFunction(
  // 顶层 const 不进 window，只能按名字取（与脚本里其它地方一致）
  () => (typeof SEARCH_STATE !== 'undefined' && SEARCH_STATE.pct > 0), null, { timeout: 90000 },
).then(() => true).catch(() => false);
ok(advanced, '解析阶段结束后进度开始真实推进（pct > 0）');
let sawRunning = 0; const widths = new Set(); const titleSeen = new Set();
const t0 = Date.now();
while (Date.now() - t0 < 15000) {
  if (await page.locator('#pipeBar').count()) {
    sawRunning++;
    widths.add(await page.locator('#pipeBar').evaluate((el) => el.style.width));
    const tt = await page.locator('#pipeTitle').innerText().catch(() => '');
    if (tt) titleSeen.add(tt.trim());
  }
  if (widths.size > 1) break;                                   // 已经在动，收工
  const runningNow = await page.evaluate(() => !!(SEARCH_STATE && SEARCH_STATE.running));
  if (!runningNow) break;                                       // 这一小段里直接跑完了
  await page.waitForTimeout(100);
}
ok(sawRunning >= 5, '检索屏持续存在（未被提前跳走）', sawRunning);
const stillRunning = await page.evaluate(() => !!(SEARCH_STATE && SEARCH_STATE.running));
ok(widths.size > 1 || !stillRunning, '进度条宽度在推进（真实进度，非静止）', [...widths]);
console.log('    进度条出现过的宽度:', [...widths].join(' , '));
console.log('    步骤标题:', [...titleSeen].join(' → '));
await shot(page, '02-searching');

/* ---------------------------------------------------------------
   【3b】检索屏：抓取日志一多也必须滑得动（2026-10-15 用户报「没法下滑查看」）

   .screen 是定高 1440×900 + overflow:hidden，所以内容超出必须由**内部容器**自己滚。
   以前 .search-body 与 .loglist 都没有 overflow，多源抓取的日志一多，
   下面的日志与「取消检索」按钮直接被裁在画布外 —— 滑不动、也够不着取消。
   --------------------------------------------------------------- */
console.log('\n【3b】检索屏可滚动（日志溢出时滑得动、取消键在屏内）');
const roll = await page.evaluate(() => {
  const el = (s) => document.querySelector(s);
  const body = el('.search-body');
  const list = el('#fetchLogs');
  const cs = (n, p) => (n ? getComputedStyle(n)[p] : null);
  return {
    bodyOverflow: cs(body, 'overflowY'),
    listOverflow: cs(list, 'overflowY'),
    listMaxH: cs(list, 'maxHeight'),
    listCount: list ? list.children.length : -1,
  };
});
ok(roll.bodyOverflow === 'auto' || roll.bodyOverflow === 'scroll',
  '★ .search-body 自己可滚（内容超出不再被画布裁掉）', roll.bodyOverflow);
ok(roll.listOverflow === 'auto' || roll.listOverflow === 'scroll',
  '★ 抓取日志区自己可滚', roll.listOverflow);
ok(roll.listMaxH !== 'none' && roll.listMaxH !== '0px',
  '  日志区限高（不随条数无限长高）', roll.listMaxH);

/* 把日志灌到明显溢出，验证「真的能滚」而不是只有 CSS 声明（灌完还原） */
const scrolled = await page.evaluate(() => {
  const list = document.getElementById('fetchLogs');
  if (!list) return null;
  const bak = list.innerHTML;
  list.innerHTML = Array.from({ length: 80 }, (_, i) =>
    `<li><span class="lt">${(i / 10).toFixed(1)}s</span><span class="ls">源 ${i} — 完成 · 新增 1 条</span><span class="lr"></span></li>`).join('');
  list.scrollTop = list.scrollHeight;
  const after = list.scrollTop;
  const out = { after, sh: list.scrollHeight, ch: list.clientHeight };
  list.scrollTop = 0;
  list.innerHTML = bak;
  return out;
});
ok(scrolled && scrolled.after > 0 && scrolled.sh > scrolled.ch,
  '  日志溢出时 scrollTop 真的能改变（不是只有声明）', scrolled);

/* 「取消检索」按钮必须落在画布可视区内 —— 否则用户滑不回去、也取消不了 */
const cancelIn = await page.evaluate(() => {
  const scr = document.querySelector('.screen');
  const btn = document.querySelector('[data-cancel]');
  if (!scr || !btn) return null;
  const s = scr.getBoundingClientRect();
  const b = btn.getBoundingClientRect();
  return { top: Math.round(b.top - s.top), bottom: Math.round(b.bottom - s.top), h: Math.round(s.height) };
});
ok(cancelIn && cancelIn.top >= 0 && cancelIn.bottom <= cancelIn.h + 1,
  '★ 「取消检索」留在画布可视区里（不会被日志顶出视野）', cancelIn);

console.log('\n【4】检索中途切到「简报中心」：后台继续跑，不再中断');
/* 关键诉求：点「开始检索」后去别的屏，检索不能断 */
await page.click('.tb-nav button[data-nav="brief"]');
await page.waitForTimeout(200);
const left = await page.evaluate(() => ({
  screen: APP.screen,
  running: SEARCH_STATE.running,
  pill: !!document.querySelector('.tb-run'),
  pipe: !!document.getElementById('pipeBar'),
}));
ok(left.screen === 'brief', '已切到「简报中心」（检索屏已被替换）', left.screen);
ok(left.pipe === false, '检索屏 DOM 已卸载（不是被隐藏）');
ok(left.running === true, '切屏后检索仍在后台运行（SEARCH_STATE.running 仍为 true）', left);
ok(left.pill === true, '顶栏出现「检索中 n%」胶囊，任意屏可见');

/* 顶栏此时元素最多（9 项导航 + 检索胶囊 + 账号），确认没有被挤成两行 */
const barFit = await page.evaluate(() => {
  const h = (sel) => {
    const el = document.querySelector(sel);
    return el ? Math.round(el.getBoundingClientRect().height) : -1;
  };
  return { name: h('.tb-name'), status: h('.tb-status'), run: h('.tb-run'),
    navScroll: document.querySelector('.tb-nav').scrollWidth,
    navClient: document.querySelector('.tb-nav').clientWidth };
});
ok(barFit.name <= 26, '检索中顶栏仍单行（品牌名未被挤成两行）', barFit);
ok(barFit.run > 0 && barFit.status === 0,
  '检索期间「检索中」胶囊顶替状态胶囊（不新增一个元素把顶栏挤爆）', barFit);
ok(barFit.navScroll <= barFit.navClient + 1, '检索中导航仍不溢出', barFit);

/* 后台继续跑的直接证据：离开检索屏后，进度轮询请求仍在持续发出
   （calls 里存的是 "GET /api/v1/searches/<id>" 这样的字符串） */
const pollCount = () => calls.filter((c) => c.indexOf('GET /api/v1/searches/') === 0
  && c.indexOf('/result') < 0).length;
const pollsBefore = pollCount();
await page.waitForTimeout(1600);
const pollsAfter = pollCount();
ok(pollsAfter > pollsBefore, '不在检索屏时仍按 pollMs 持续轮询进度（后台任务没断）',
  { pollsBefore, pollsAfter });

/* 顺带确认进度视图模型在推进：百分比 / 步骤 / 已抓条数 / 日志至少有一项在变。
   注意：抓取阶段跑完后进度条会停在 100%，此时长耗时在 AI 结构化那一步，
   所以只要「有变化」或「这一小段里直接跑完了」都算通过。
   ★ 采样间隔给到 2.5s：真实模型一格可能就要几秒（同【3】，别用 1.2s 逼出假红）。 */
const snap = () => page.evaluate(() => ({
  pct: SEARCH_STATE.pct, step: SEARCH_STATE.step,
  from: SEARCH_STATE.countFrom, logs: SEARCH_STATE.logs.length, running: SEARCH_STATE.running,
}));
const s1 = await snap();
await page.waitForTimeout(2500);
const s2 = await snap();
ok(!s2.running || s2.pct !== s1.pct || s2.step !== s1.step || s2.from !== s1.from || s2.logs !== s1.logs,
  '切屏期间进度视图模型仍在推进（或已跑完）', { s1, s2 });
await shot(page, '02b-background');

console.log('\n【5】后台跑完 → 右下角弹通知，不强行跳屏');
/* 上限 900s：mock 通道秒回，这条只在 auto 通道才有意义 —— 免费档单次真实检索实测能拖到 389s。 */
await page.waitForSelector('.toast.notice', { timeout: 900000 });
await page.waitForTimeout(300);
const noticeText = (await page.locator('.toast.notice').innerText()).replace(/\s+/g, ' ').trim();
ok(/检索完成/.test(noticeText), '右下角弹出「检索完成」通知卡片', noticeText.slice(0, 60));
ok(noticeText.length > 10, '通知里有结果摘要（问句 + 条数）', noticeText.slice(0, 80));
ok(await page.locator('.toast.notice [data-notice-act]').count() === 1, '通知带「查看结果」操作按钮');
const screenStill = await page.evaluate(() => APP.screen);
ok(screenStill === 'brief', '没有把用户从「简报中心」强行拽走', screenStill);
const noticeBox = await page.locator('.toast.notice').boundingBox();
ok(noticeBox && noticeBox.x > 1600 / 2 && noticeBox.y > 1000 / 2,
  '通知弹在右下角', noticeBox && { x: Math.round(noticeBox.x), y: Math.round(noticeBox.y) });
await shot(page, '02c-notice');

console.log('\n【6】点通知里的「查看结果」→ 落到结果列表');
await page.click('.toast.notice [data-notice-act]');
await page.waitForSelector('.result-card', { timeout: 30000 });
await page.waitForTimeout(400);
const screenAfter = await page.evaluate(() => APP.screen);
ok(screenAfter === 'list', '点「查看结果」→ 结果列表屏', screenAfter);
ok(await page.locator('.tb-run').count() === 0, '完成后顶栏「检索中」胶囊已消失');
await shot(page, '03-list');

const cards = await page.locator('.result-card').count();
ok(cards >= 3 && cards <= 20, '列表渲染出政策卡（= 后端返回条数）', cards);
const firstName = await page.locator('.result-card .rc-name').first().innerText();
ok(firstName && firstName.length > 4, '卡片标题非空（p.name 已正确渲染）', firstName);
const firstMeta = await page.locator('.result-card .rc-meta').first().innerText();
ok(firstMeta.length > 10 && !/undefined/.test(firstMeta), '卡片机构/层级/类型字段已渲染', firstMeta.replace(/\s+/g, ' '));
const headMeta = await page.locator('.list-head .meta').innerText();
ok(/条有效/.test(headMeta), '列表口径 meta 来自后端', headMeta);
const banned = await page.locator('text=undefined').count();
ok(banned === 0, '页面无 "undefined" 文案（字段无缺失）', banned);

/* ---------------------------------------------------------------
   6a-2) 第二条筛选行（条件摘要）也必须由**结果集**推导
   ---------------------------------------------------------------
   用户报过的 bug 同款：这一行曾写死「已选 3 项：地域 {n} 个 · 有效 · 近 90 天截止」，
   而 {n} 填的是首页筛选栏的勾选数 —— 用户问「我是杭州做智能硬件的」时地域是问句带出来的，
   筛选栏本来就没勾，于是同一屏上出现「地域 0 个」和上方回显的「杭州市」当场打架。 */
const condRow = await page.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('.filterbar .fb-row'));
  const last = rows[rows.length - 1];
  return {
    label: last && last.querySelector('.fb-label') ? last.querySelector('.fb-label').innerText.trim() : '',
    hint: last && last.querySelector('.hint') ? last.querySelector('.hint').innerText.trim() : '',
    regionsUsed: (DATA.list.regionsUsed || []).length,
    cascadeN: CASCADE.count(false),
    echo: (document.querySelector('#rgListSlot') || {}).innerText || '',
  };
});
ok(condRow.label === '本次条件', '第二条筛选行的标签是「本次条件」', condRow.label);
ok(condRow.hint.indexOf('地域 ' + condRow.regionsUsed + ' 个') === 0
  || (condRow.regionsUsed === 0 && condRow.hint.indexOf('地域不限') === 0),
  '  地域个数 = 结果集的地域数（' + condRow.regionsUsed + ' 个），与上方回显同源', condRow.hint);
ok(condRow.echo.indexOf('杭州市') >= 0 && condRow.hint.indexOf('杭州市') < 0,
  '  （对照）地域名由上面那行回显负责，摘要只报个数，两处不重复也不打架',
  { echo: condRow.echo.replace(/\s+/g, ' ').slice(0, 20) });
if (condRow.regionsUsed > 0 && condRow.cascadeN === 0) {
  ok(true, '  （关键）筛选栏地域勾选数为 0，摘要仍写「地域 '
    + condRow.regionsUsed + ' 个」—— 证明跟的是结果集而不是筛选栏',
  { regionsUsed: condRow.regionsUsed, cascade: condRow.cascadeN });
}
ok(!/已选 \d+ 项/.test(condRow.hint), '  不再有写死的「已选 n 项」前缀', condRow.hint);
ok(condRow.hint.indexOf('近 90 天截止') < 0,
  '  不再有与本次条件无关的写死尾巴「有效 · 近 90 天截止」', condRow.hint);
console.log('    条件摘要:', condRow.label, '|', condRow.hint);

/* ---------------------------------------------------------------
   6b) 分页口径必须跟着**本次结果集**走
   ---------------------------------------------------------------
   用户报过的 bug：页脚写着「共 96 条 · 第 2 / 5 页」（那是内置样例集的规模），
   可这次检索只产出 10 条 → 第 2 页起全是「本页暂无内容」。
   根因是分页总数沿用了静态 bootstrap 里的声明值，没跟本次结果集对齐。 */
console.log('\n【6b】分页口径跟着本次结果集（翻页不能翻出空页）');
const total = await page.evaluate(() => (typeof DATA !== 'undefined' ? DATA.policies.items.length : -1));
const pagerTxt = (await page.locator('.pager span').first().innerText()).trim();
const declared = Number((pagerTxt.match(/共\s*(\d+)\s*条/) || [])[1]);
ok(declared === total, '页脚的「共 n 条」= 本次结果集实际条数', `${declared} vs ${total}`);
ok(!/共 96 条/.test(pagerTxt), '  不是静态样例的口径（96 条）', pagerTxt);
const perPage = await page.evaluate(() => (typeof listPerPage !== 'undefined' ? listPerPage() : -1));
const shownPages = Number((pagerTxt.match(/第\s*\d+\s*\/\s*(\d+)\s*页/) || [])[1]);
ok(shownPages === Math.max(1, Math.ceil(total / perPage)),
  '页数 = ceil(总数 / 每页)', `${shownPages} 页 / ${total} 条 / 每页 ${perPage}`);
ok(total <= perPage || (await page.locator('.result-card').count()) === perPage,
  '第 1 页渲染出每页条数（不是被声明值带偏）',
  `${await page.locator('.result-card').count()} 张`);

/* 把 perPage 临时改小，逼出多页，再**逐页翻到底**：每一页都必须有内容。
   1 页时下一页应当是禁用态 —— 「翻过去是空页」在两条路径上都不能出现。 */
const sweep = await page.evaluate(() => {
  const bakPer = DATA.list.pager.perPage;
  const bakPage = LIST_STATE.page;
  DATA.list.pager.perPage = 3;
  const pages = listPageCount();
  const empty = []; const counts = [];
  for (let k = 1; k <= pages; k++) {
    LIST_STATE.page = k;
    render();
    const n = document.querySelectorAll('.result-card').length;
    counts.push(n);
    if (!n) empty.push(k);
  }
  LIST_STATE.page = pages + 5;            // 越界：必须夹回最后一页，而不是空白
  render();
  const clampedEmpty = document.querySelectorAll('.result-card').length === 0;
  DATA.list.pager.perPage = bakPer;
  LIST_STATE.page = bakPage;
  render();
  return { pages, empty, counts, clampedEmpty };
});
ok(sweep.pages >= 2, '临时把每页调小后真的出现多页（分页是活的）', sweep.pages + ' 页');
ok(sweep.empty.length === 0, '逐页翻到底：每一页都有内容（没有空页）',
  '每页条数 ' + sweep.counts.join('/'));
ok(!sweep.clampedEmpty, '页码越界夹回最后一页后仍有内容');
const nextDisabled = await page.evaluate(() => {
  const bakPer = DATA.list.pager.perPage;
  DATA.list.pager.perPage = 3;
  LIST_STATE.page = listPageCount();
  render();
  const btn = document.querySelector('.pg-nav[data-page="' + (listPageCount() + 1) + '"]');
  const out = !!btn && btn.disabled;
  DATA.list.pager.perPage = bakPer;
  LIST_STATE.page = 1;
  render();
  return out;
});
ok(nextDisabled, '末页时「下一页」是禁用态（点不动，也就不会翻到空页）');
/* 留一张「真的翻到第 2 页」的截图：perPage 临时调小到 3，停在有内容的第 2 页 */
await page.evaluate(() => {
  DATA.list.pager.perPage = 3;
  LIST_STATE.page = 2;
  render();
});
await page.waitForTimeout(250);
const page2Cards = await page.locator('.result-card').count();
const page2Text = (await page.locator('.pager span').first().innerText()).trim();
ok(page2Cards === 3 && /第 2 \/ \d+ 页/.test(page2Text), '第 2 页真的有内容（截图留档）',
  { cards: page2Cards, pager: page2Text });
await shot(page, '03b-list-page2');
await page.evaluate(() => {
  DATA.list.pager.perPage = 20;
  LIST_STATE.page = 1;
  render();
});
await page.waitForTimeout(200);

console.log('\n【7】详情页与简报页可正常消费新数据');
await page.locator('.result-card .rc-name').first().click();
await page.waitForSelector('.clause', { timeout: 10000 });
const clauses = await page.locator('.clause').count();
ok(clauses >= 2, '详情页条款 ≥2 条（conditionsFull[1] 可读）', clauses);
const qa = await page.locator('.qa .qv').allInnerTexts();
ok(qa.length >= 3, '三问答案条 3 条（matched.split 正常）', qa.length);
await shot(page, '04-detail');
await page.click('[data-nav="brief"]').catch(() => {});
await page.waitForTimeout(600);
await shot(page, '05-brief');

console.log('\n【8】前端真实发出的检索接口调用');
calls.forEach((c) => console.log('    ' + c));
ok(calls.some((c) => c.startsWith('POST /api/v1/searches')), '发起了 POST /api/v1/searches');
ok(calls.some((c) => /GET \/api\/v1\/searches\/[^/]+$/.test(c)), '按 pollMs 轮询了进度');
ok(calls.some((c) => c.endsWith('/result')), '取回了 /result');
ok(!calls.some((c) => c.includes('/api/bootstrap')), '未回退到 /api/bootstrap（走的是检索链路）');

console.log('\n【9】模型接入状态');
const llmStatus = await page.evaluate(() => fetch('/api/v1/llm/status').then((r) => r.json()));
console.log('    ' + JSON.stringify(llmStatus));
ok(llmStatus.configured === 'auto' || llmStatus.configured === 'openai', 'LLM_PROVIDER 已配置', llmStatus.configured);
ok(llmStatus.hasApiKey === true, 'API Key 已被后端读到', llmStatus.hasApiKey);
ok(llmStatus.isRemote === true, '实际使用远端真实模型（未降级到本地引擎）', llmStatus.model);
ok(llmStatus.model === 'glm-4-flash' || /^glm-/.test(String(llmStatus.model)),
  '模型已接上智谱 GLM 系（改造前写死 glm-4-flash，现允许按用途升级到 glm-4.5-flash 等）',
  llmStatus.model);
/* 按用途分模型（2026-10-14）：四个用途都要报出解析后的模型，且顶层 model = extract 那份 */
ok(Array.isArray(llmStatus.purposes) && llmStatus.purposes.length === 4,
  '四用途（query/extract/chat/brief）各自报出模型',
  (llmStatus.purposes || []).map((p) => p.purpose + '=' + p.model).join(' · '));
const extractP = (llmStatus.purposes || []).find((p) => p.purpose === 'extract');
ok(extractP && extractP.model === llmStatus.model,
  '顶层 model 与 extract 用途一致（旧契约不破）', llmStatus.model);
ok((llmStatus.purposes || []).every((p) => p.model && p.model !== 'undefined'),
  '每个用途都解析出非空模型名');

console.log('\n【10】页面错误');
ok(consoleErrors.length === 0, '无 JS 运行时错误', consoleErrors.slice(0, 3));
const realBad = badResponses.filter((u) => !/favicon\.ico/.test(u));
ok(realBad.length === 0, '无失败资源请求（favicon 除外）', realBad);
if (badResponses.length) console.log('    失败请求:', badResponses.join(' | '));

/* ===============================================================
   11) 用户实报的场景：筛选栏选「福建省」+ 问句里写「杭州」
   ---------------------------------------------------------------
   原话：「正在检索过程中还是「我是杭州做智能硬件的，能申什么补贴」」——
   检索屏标题印的是**用户原话**，下面的条件行印的是**生效条件**（福建省/福州市），
   同一屏自相矛盾，用户根本看不出这次到底按什么地域在查。
   现在检索屏标题 = 与结果屏同一枚「条件指纹」，问句只进 tooltip。
   这一节把整条路径在真实 DOM 上跑一遍。 */
console.log('\n【11】筛选栏 福建省 + 问句 杭州：两屏标题必须都说「福建省」');
{
  const Q = '我是杭州做智能硬件的，能申什么补贴';
  await page.click('.tb-nav button[data-nav="home"]');
  await page.waitForSelector('#homeQ', { timeout: 10000 });
  /* ① 在「地域」筛选里勾上福建省（勾省 = 全省一个条件） */
  await page.click('[data-region-trigger]');
  await page.waitForSelector('#cascPanel', { timeout: 5000 });
  await page.fill('#cascQ', '福建');
  /* 等过滤后的行真的出现，别在重绘窗口里点（点早会被一次重绘吞掉） */
  await page.waitForFunction(() => {
    const rows = Array.from(document.querySelectorAll('#cascPanel .casc-col')[0]
      ? document.querySelectorAll('#cascPanel .casc-col')[0].querySelectorAll('.frow') : []);
    return rows.some((r) => (r.textContent || '').indexOf('福建省') >= 0);
  }, null, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(200);
  await page.locator('#cascPanel .casc-col').nth(0)
    .locator('.frow:has-text("福建省")').first().click();
  /* ★ 点完行要等「草稿真的进了 CASCADE.draft」再点确定 —— 这两条前置断言把
     「面板根本没生效」和「地域被查询理解推翻」两种故障分开报：
     以前面板没生效时，下游会连报四条「地域应该是福建省、却是杭州市」，看着像产品 bug。 */
  const drafted = await page.waitForFunction(() => CASCADE.draft.size > 0, null, { timeout: 4000 })
    .then(() => true).catch(() => false);
  ok(drafted, '（前置）勾选进了地域草稿（CASCADE.draft 非空）',
    await page.evaluate(() => CASCADE.draft.size));
  await page.click('#cascPanel [data-casc-ok]');   // 地域面板的确定键是 data-casc-ok（选项面板才是 data-opt-ok）
  const committed = await page.waitForFunction(() => CASCADE.applied.size > 0, null, { timeout: 4000 })
    .then(() => true).catch(() => false);
  ok(committed, '（前置）点「确定」后地域已生效（检索只发 CASCADE.applied，草稿不算数）',
    await page.evaluate(() => CASCADE.applied.size));
  await page.waitForTimeout(200);
  const trig = await page.locator('#rgHome').innerText().catch(() => '');
  ok(trig.includes('福建省'), '（前置）筛选栏已选福建省', trig.replace(/\s+/g, ' '));

  /* ② 输入一个提「杭州」的问句并检索 */
  await page.fill('#homeQ', Q);
  await page.click('[data-go="search"]');
  await page.waitForSelector('#pipeEcho', { timeout: 10000 });
  /* ★ 等的是**后端条件指纹真的到货并已画上屏**，而不是「文本看起来像标题了」。
     指纹未到之前屏上是问句回显（或挂载时的样例指纹），它同样以「正在检索」开头、
     同样含「」，按文本形状 break 会当场读到那一份 —— 真实模型下这段空窗有十几秒
     （免费档实测更久），mock 首帧即到，所以这个坑只在真模型实例上暴露：
     上一次 8000 回归就是这么报了四条「地域应该是福建省、却是杭州市」的假红。 */
  const titled = await page.waitForFunction(() => {
    if (typeof SEARCH_STATE === 'undefined' || !SEARCH_STATE.condTitle) return false;
    const el = document.getElementById('pipeEcho');
    return !!el && el.innerText.trim() === SEARCH_STATE.condTitle.trim();
  }, null, { timeout: 180000 }).then(() => true).catch(() => false);
  ok(titled, '检索条件指纹已到货且已画上屏（真模型下查询理解耗时较长，等它而不是等文本形状）',
    await page.evaluate(() => (typeof SEARCH_STATE !== 'undefined' && SEARCH_STATE.condTitle) || ''));
  const echo = (await page.locator('#pipeEcho').innerText()).trim();
  ok(echo.indexOf('福建省') >= 0,
    '检索屏标题按**生效条件**渲染地域（不再印问句）', echo);
  ok(echo.indexOf('杭州') < 0,
    '  标题里不出现问句里的「杭州」（与条件行不再打架）', echo);
  const echoTip = await page.locator('#pipeEcho').getAttribute('title');
  ok(echoTip === Q, '  问句没有丢，收进标题的 tooltip', echoTip);
  const parsedRow = (await page.locator('#pipeParsed').innerText()).replace(/\s+/g, ' ');
  ok(parsedRow.indexOf('福建省') >= 0, '  下面「已解析出条件」同样是福建省（两处一致）', parsedRow.slice(0, 90));
  /* 本轮起行业 / 类型也会**从问句里读出来**（先解析、再检索）：筛选栏只设了地域，
     所以行业/类型这两行会标「· 来自查询」——这正是要盯着的地方，
     以前它们一律写「不限」，用户交代的事系统一个字没接住。 */
  ok(/行业 = \S+ · 来自查询/.test(parsedRow),
    '  行业那行来自问句解析（筛选栏没设行业，也不再写「不限」）', parsedRow.slice(0, 120));
  /* 同屏一致性：标题与条件行由**同一个 poll 载荷**渲染，不该各说一套。
     放在一次 evaluate 里读，避免两次读之间夹进一次轮询。 */
  const live = await page.evaluate(() => ({
    state: (typeof SEARCH_STATE !== 'undefined' && SEARCH_STATE.condTitle) || '',
    echo: (document.getElementById('pipeEcho') || {}).innerText || '',
  }));
  ok(live.echo.trim() === live.state.trim() && live.state.indexOf('福建省') >= 0,
    '  检索屏标题逐字等于 SEARCH_STATE.condTitle（前端不自己拼，直接印后端那枚指纹）',
    live.state);
  await shot(page, '02d-search-cond-fujian');

  /* ③ 等结果落地，核对两屏标题是同一枚指纹
     ★ 等的是**本次**检索跑完：真实模型一次检索 2~6 分钟（免费档实测到 389s），
       原来只给 36s（120×300ms），窗口一耗尽就往下比 —— 那比的是**上一次检索**留在
       列表屏的旧页头（旧问句里的「杭州」），看着像「筛选栏地域被查询推翻」，
       实际是闸门自己等太短（mock 秒回，所以只在真模型实例上暴露）。
       现在按前端 `search.json→timeoutMs` 同口径等 420s，并且**要求真的等到
       running=false** —— 等不到就直接判失败，绝不拿旧画面糊弄过去。 */
  let searchDone = false;
  for (let i = 0; i < 1400; i++) {
    const st = await page.evaluate(() => (SEARCH_STATE && SEARCH_STATE.running) ? 1 : 0);
    if (!st) { searchDone = true; break; }
    await page.waitForTimeout(300);
  }
  ok(searchDone, '本次检索真的跑完（不是等超时后拿上一次的旧画面比对）');
  /* 检索屏上**最后显示的那一句**：解析查询那一步可能补进新条件（大模型先读一遍问句），
     标题会跟着刷新，所以要在轮询停下之后、离开这一屏之前取。 */
  const echoFinal = await page.evaluate(
    () => (document.getElementById('pipeEcho') || {}).innerText || '');
  /* running=false 到「新结果 hydrate 进 DATA」之间还有一次异步落地，等它一下
     （否则会读到上一次检索的页头 —— 断言本身不放松，只是不等在竞态窗口里） */
  await page.waitForFunction(() => {
    const t = (typeof DATA !== 'undefined' && DATA.list && DATA.list.head
      && DATA.list.head.title) || '';
    return t.indexOf('福建省') >= 0;
  }, null, { timeout: 60000 }).catch(() => {});
  await page.evaluate(() => go('list'));
  await page.waitForSelector('.list-head h2', { timeout: 20000 });
  await page.waitForTimeout(300);
  const listTitle = (await page.locator('.list-head h2').innerText()).trim();
  const slot = (t) => t.slice(t.indexOf('「'));
  ok(listTitle.indexOf('福建省') >= 0 && listTitle.indexOf('杭州') < 0,
    '结果列表页头标题也是福建省（同一枚生效条件）', listTitle);
  ok(slot(listTitle) === slot(echoFinal.trim()),
    '  检索屏（离开前那一帧）与结果屏标题逐字同指纹（只有前缀不同）',
    { 检索屏: echoFinal.trim(), 结果屏: listTitle });
  await shot(page, '03c-list-fujian');

  /* ④ 顺带复核「勾选随结果集归零」：这份新结果必须有 0 条勾选 */
  const pickState = await page.evaluate(() => {
    const el = document.getElementById('pickCount');
    return { text: el ? el.innerText.trim() : '', size: LIST_STATE.picked.size, page: LIST_STATE.page };
  });
  ok(pickState.size === 0 && pickState.text === '已勾选 0 条',
    '新一份结果落地后勾选归零（不再显示与列表对不上的条数）', pickState);
  ok(pickState.page === 1, '  页码回到第 1 页', pickState.page);
  /* 把筛选栏恢复干净，免得影响下次手工打开应用 */
  await page.evaluate(() => {
    CASCADE.clear();
    CASCADE.commit();
    SEARCH_STATE.running = false;
    render();
  });
}

await browser.close();
console.log(fail === 0 ? '\n浏览器端到端验证全部通过 ✅（截图见 backend/_shots/）' : `\n${fail} 项未通过 ❌`);
process.exit(fail === 0 ? 0 : 1);
