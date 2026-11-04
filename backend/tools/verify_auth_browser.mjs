/* ============================================================
   真实浏览器端到端验证：账号体系 + 检索记录（MySQL）
   ------------------------------------------------------------
   走完整条 UI 链路（不直接调接口）：
     游客首页 → 点顶栏账号区 → 切注册 → 填表提交 → 自动登录
     → 检索记录空态 → 发起第一次检索 → 记录落库
     → 回放历史结果 → 以此条件再检索 → **刷新页面直接看到上次结果**
     → 删除记录 → 退出登录
   用系统 Edge（channel: msedge），不下载额外浏览器。
   用法：node tools/verify_auth_browser.mjs [baseUrl]
   ============================================================ */
import { mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(pathToFileURL(resolve(
  process.env.PW_WORKSPACE || 'C:/Users/22866/.workbuddy/binaries/node/workspace', 'noop.js')));
const pw = await import(pathToFileURL(require.resolve('playwright')).href);
const chromium = pw.chromium || (pw.default && pw.default.chromium);

const BASE = (process.argv[2] || 'http://127.0.0.1:8000').replace(/\/$/, '');
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '_shots');
mkdirSync(OUT, { recursive: true });

let fail = 0;
let pass = 0;
const ok = (c, label, extra) => {
  if (c) { pass++; console.log('  ✓ ' + label); } else {
    fail++;
    console.log('  ✗ ' + label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''));
  }
};
const shot = (page, name) => page.screenshot({ path: resolve(OUT, name + '.png'), fullPage: false });

/* 每次运行用独立用户名：这样才能断言「新账号 → 检索记录为空」 */
const stamp = Date.now().toString(36);
const USER = {
  username: 'bw' + stamp,
  displayName: '浏览器校验' + stamp.slice(-4),
  password: 'Browser2026',
};

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();

const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
const badResponses = [];
page.on('response', (r) => { if (r.status() >= 400) badResponses.push(r.status() + ' ' + r.url().replace(BASE, '')); });

let phase = 'boot';
const calls = [];
page.on('request', (r) => {
  if (r.url().includes('/api/v1/')) {
    calls.push({ phase, method: r.method(), url: r.url().replace(BASE, '') });
  }
});
const countSearchPosts = (p) => calls.filter((c) => c.phase === p && c.method === 'POST' && c.url === '/api/v1/searches').length;

console.log('目标服务：' + BASE + ' · 测试账号：' + USER.username + '\n');

/* ============================================================ */
console.log('【1】游客打开应用：未登录首屏 = 登录 / 注册页');
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });

/* 首屏规则：账号服务可用且未登录 → 直接落在「登录 / 注册」页 */
await page.waitForSelector('.auth-card', { timeout: 20000 });
ok(true, '未登录首屏直接落在「登录 / 注册」页');
const guestChip = (await page.locator('.tb-user').first().innerText()).replace(/\s+/g, ' ').trim();
ok(/登录 \/ 注册/.test(guestChip), '顶栏账号区为未登录态', guestChip);
const guestToken = await page.evaluate(() => localStorage.getItem('policy_agent_token'));
ok(guestToken === null, '本地无登录凭证');
const guestDb = await page.evaluate(() => fetch('/api/v1/db/status').then((r) => r.json()));
ok(guestDb.available === true, '后端 MySQL 已就绪（浏览器里直连确认）', guestDb.database);
await shot(page, '10-login');

/* 游客出口：不强制登录 */
await page.click('[data-auth-guest]');
await page.waitForSelector('#homeQ', { timeout: 10000 });
ok(true, '「以游客身份继续」→ 进入首页（不强制登录）');
ok((await page.locator('.auth-card').count()) === 0, '离开登录页后账号卡已移除');

/* ============================================================ */
console.log('\n【2】进入登录 / 注册屏');
await page.locator('.tb-user').first().click();
await page.waitForSelector('.auth-card', { timeout: 10000 });
ok(true, '已跳转账号屏（.auth-card 渲染）');
const tabs = await page.locator('.auth-tabs button').allInnerTexts();
ok(tabs.join('/') === '登录/注册', '登录 / 注册 双 Tab 存在', tabs);
const asideTitle = await page.locator('.auth-aside h2').innerText();
ok(asideTitle.length > 4, '左侧说明栏已渲染', asideTitle);
ok(await page.locator('#af_username').count() === 1, '登录表单含用户名输入框');
ok(await page.locator('#af_displayName').count() === 0, '登录态不显示注册专属字段');

console.log('\n【3】切到注册并填表提交');
await page.click('[data-auth-tab="register"]');
await page.waitForSelector('#af_displayName', { timeout: 5000 });
ok(await page.locator('#af_company').count() === 1, '注册表单含企业档案字段（填一次）');
const preIndustry = await page.inputValue('#af_industry');
/* 注册表单的「行业」按首页筛选栏里**已生效**的行业预填（企业档案填一次就够）。
   首页四个维度默认全不限 → 没有可预填的值，留空待填（以前默认预选智能硬件/软件信息，
   所以这里会自动带出「智能硬件 / 软件信息」）。契约的两端都钉住：空时为空、有值时带出来。 */
ok(preIndustry === '', '行业默认不限 → 注册表单的行业留空（不再预置演示值）', preIndustry || '（空）');
const prefillWhenSet = await page.evaluate(() => {
  const sep = ((DATA.home || {}).filter || {}).joinSep || ' / ';
  FILTER_STATE.applied.industry = new Set(['智能硬件']);
  const v = FILTER_STATE.values('industry').join(sep);
  FILTER_STATE.applied.industry = new Set();   // 还原，别影响后续用例
  FILTER_STATE.draft.industry = new Set();
  return v;
});
ok(prefillWhenSet === '智能硬件', '  且该字段的确跟着「筛选栏已生效的行业」走（有值就会预填）', prefillWhenSet);
const preRegion = await page.inputValue('#af_regionName');
/* 地域默认不预选任何地区 → 注册表单的「常用地域」应为空（占位提示未选择） */
ok(preRegion === '', '地域默认不预选 → 常用地域留空待填', preRegion);
await shot(page, '11-register');

/* 先故意填错：两次密码不一致 */
await page.fill('#af_username', USER.username);
await page.fill('#af_displayName', USER.displayName);
await page.fill('#af_password', USER.password);
await page.fill('#af_password2', 'Mismatch2026');
await page.fill('#af_company', '杭州智造科技有限公司');
await page.click('#authSubmit');
await page.waitForTimeout(300);
const errText = await page.locator('#authErr').innerText().catch(() => '');
ok(/不一致/.test(errText), '两次密码不一致被前端拦截并给出提示', errText.replace(/\s+/g, ' '));
/* 未登录有两种形态：未进入（登录 / 注册）与游客态（游客 · 未保存 + 退出）。
   这一段只关心「没登录」，两种都算通过。 */
ok(/登录 \/ 注册|游客/.test((await page.locator('.tb-user').first().innerText())),
  '校验失败时未登录');

/* 改正后提交 */
await page.fill('#af_password2', USER.password);
await page.click('#authSubmit');
await page.waitForSelector('.hist-list, .empty', { timeout: 20000 });
ok(true, '注册成功并自动登录 → 直接进入检索记录页');

const chipAfter = (await page.locator('.tb-user').first().innerText()).replace(/\s+/g, ' ').trim();
ok(chipAfter.indexOf(USER.displayName) >= 0, '顶栏显示昵称（登录态生效）', chipAfter);
ok(/已登录/.test(chipAfter), '顶栏显示「已登录」标记', chipAfter);
const tokenNow = await page.evaluate(() => localStorage.getItem('policy_agent_token'));
ok(typeof tokenNow === 'string' && tokenNow.length > 20, 'Token 已写入 localStorage', (tokenNow || '').slice(0, 8) + '…');

console.log('\n【4】新账号的检索记录应为空态');
const emptyTitle = await page.locator('.empty h4').innerText();
ok(/还没有检索记录/.test(emptyTitle), '展示「还没有检索记录」空态', emptyTitle);
ok(await page.locator('.hist-card').count() === 0, '当前无历史卡片');
await shot(page, '12-history-empty');

/* ============================================================ */
console.log('\n【5】发起登录状态下的检索 → 条件与结果落库');
phase = 'first-search';
await page.click('.empty [data-go="home"]');
await page.waitForSelector('#homeQ', { timeout: 10000 });
await page.fill('#homeQ', '我是杭州做智能硬件的，能申什么补贴');
await page.click('[data-go="search"]');
await page.waitForSelector('#pipeBar', { timeout: 10000 });
/* 上限 900s：mock 通道秒回，auto 通道免费档单次真实检索实测能拖到 389s（>300s 会假失败）。 */
await page.waitForSelector('.result-card', { timeout: 900000 });
await page.waitForTimeout(400);
const searched = await page.locator('.result-card').count();
ok(searched > 0, '检索完成并渲染结果列表', searched);
ok(countSearchPosts('first-search') === 1, '登录用户发起的检索走的是 POST /api/v1/searches');

console.log('\n【6】检索记录页已出现该条记录');
phase = 'history';
await page.click('.tb-nav button[data-nav="history"]');
await page.waitForSelector('.hist-card', { timeout: 15000 });
await page.waitForTimeout(300);
const cards = await page.locator('.hist-card').count();
ok(cards >= 1, '历史列表出现记录卡片', cards);
const firstQ = await page.locator('.hist-card .hc-q').first().innerText();
ok(/智能硬件/.test(firstQ), '记录卡片显示原始问句', firstQ);
const firstCond = await page.locator('.hist-card .hc-cond').first().innerText();
/* 记录卡片的地域段 = **该次检索实际生效的地域**，与结果列表页头同源：
   筛选栏优先 → 问句里识别到的地名 → 都没有才是「全国（不限）」。
   本次没动筛选栏、问句是「我是杭州做智能硬件的…」→ 实际跑的就是杭州市，
   所以卡片必须显示「杭州市」；显示「全国（不限）」才是 bug
   （历史上有过：落库存「筛选栏原样」（空），卡片与同一次检索的结果对不上）。 */
ok(/杭州市/.test(firstCond), '记录卡片的地域＝该次检索实际生效的地域（问句识别到杭州市）', firstCond.replace(/\s+/g, ' '));
ok(!/全国（不限）/.test(firstCond), '  问句里点了地名，就不再显示「全国（不限）」', firstCond.replace(/\s+/g, ' '));
const firstMeta = await page.locator('.hist-card .hc-meta').first().innerText();
ok(/%|条政策|平均置信度/.test(firstMeta), '记录卡片显示口径 / 条数 / 置信度', firstMeta.replace(/\s+/g, ' '));
const badges = await page.locator('.hist-card .badge').allInnerTexts();
ok(badges.length >= 2, '记录卡片带状态与引擎徽标', badges);
const userLine = await page.locator('.hist-user').first().innerText();
ok(userLine.indexOf(USER.displayName) >= 0, '列表头部显示当前账号', userLine);
await shot(page, '13-history');

/* ============================================================ */
console.log('\n【7】回放历史结果（不重新检索）');
phase = 'replay';
await page.click('[data-history-replay]');
await page.waitForSelector('.result-card', { timeout: 30000 });
await page.waitForTimeout(400);
const replayed = await page.locator('.result-card').count();
ok(replayed === searched, '回放后的结果条数与首次一致', [replayed, searched]);
ok(countSearchPosts('replay') === 0, '回放**没有**触发新的检索请求（直接读库）');
await shot(page, '14-replay');

console.log('\n【8】以此条件再检索（条件恢复 → 真实检索）');
phase = 'restore';
await page.click('.tb-nav button[data-nav="history"]');
await page.waitForSelector('.hist-card', { timeout: 15000 });
await page.click('[data-history-restore]');
await page.waitForSelector('#pipeBar', { timeout: 10000 });
const restoredQ = await page.inputValue('#homeQ').catch(() => '');
ok(countSearchPosts('restore') === 1, '「以此条件再检索」发起了一次真实检索');
await page.waitForSelector('.result-card', { timeout: 900000 });
await page.waitForTimeout(500);

await page.click('.tb-nav button[data-nav="history"]');
await page.waitForSelector('.hist-card', { timeout: 15000 });
await page.waitForTimeout(300);
const cards2 = await page.locator('.hist-card').count();
ok(cards2 >= 2, '第二次检索同样落库（记录累积）', cards2);

/* ============================================================ */
console.log('\n【9】核心：重新打开应用 → 直接看到上次结果，无需重新检索');
phase = 'reopen';
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.result-card', { timeout: 30000 });
await page.waitForTimeout(500);
ok(true, '刷新后自动落到结果列表（.result-card 已渲染）');
ok(countSearchPosts('reopen') === 0, '打开应用时**没有**发起任何检索（直接回放库里结果）', countSearchPosts('reopen'));
const chipReopen = (await page.locator('.tb-user').first().innerText()).replace(/\s+/g, ' ').trim();
ok(chipReopen.indexOf(USER.displayName) >= 0, '会话自动恢复（仍是登录态）', chipReopen);
const listHead = await page.locator('.list-head .meta').first().innerText().catch(() => '');
ok(listHead.length > 0, '结果列表口径来自历史回放数据', listHead.replace(/\s+/g, ' '));
await shot(page, '15-restored-list');

/* 账号屏应显示「已自动回放上次检索结果」与统计 */
phase = 'account';
await page.locator('.tb-user').first().click();
await page.waitForSelector('.ac-nm', { timeout: 10000 });
const acName = await page.locator('.ac-nm').innerText();
ok(acName.indexOf(USER.displayName) >= 0, '账号屏显示当前用户', acName.replace(/\s+/g, ' '));
const acStats = await page.locator('.ac-stat b').allInnerTexts();
ok(acStats.length === 4, '「我的数据」4 项统计已渲染', acStats);
ok(Number(acStats[0]) >= 2, '检索次数统计与落库一致', acStats);
const restoredBanner = await page.locator('.auth-card .banner.ok .bn-ttl').innerText().catch(() => '');
ok(/已自动回放上次检索结果/.test(restoredBanner), '账号屏提示已回放上次结果', restoredBanner);
const profileCompany = await page.inputValue('#pf_company');
ok(profileCompany.length > 0, '企业档案已随账号带出（填一次即长期生效）', profileCompany);
await shot(page, '16-account');

/* 改档案 → 保存 */
await page.fill('#pf_industry', '智能硬件 / 软件信息（已改）');
await page.click('[data-profile-save]');
await page.waitForTimeout(800);
const savedIndustry = await page.inputValue('#pf_industry');
ok(/已改/.test(savedIndustry), '企业档案修改后写回成功（重新渲染仍为新值）', savedIndustry);

/* ============================================================ */
console.log('\n【10】删除一条检索记录');
phase = 'delete';
await page.click('.tb-nav button[data-nav="history"]');
await page.waitForSelector('.hist-card', { timeout: 15000 });
await page.waitForTimeout(300);
const beforeDel = await page.locator('.hist-card').count();
await page.click('[data-history-delete]');
await page.waitForSelector('[data-history-confirm]', { timeout: 5000 });
ok(true, '删除需二次确认（先出现确认按钮）');
await shot(page, '17-delete-confirm');
await page.click('[data-history-confirm]');
await page.waitForTimeout(1200);
const afterDel = await page.locator('.hist-card').count();
ok(afterDel === beforeDel - 1, '确认后记录被删除', [beforeDel, afterDel]);

/* ============================================================ */
console.log('\n【11】退出登录');
phase = 'logout';
await page.locator('.tb-user').first().click();
await page.waitForSelector('[data-auth-logout]', { timeout: 10000 });
await page.click('[data-auth-logout]');
/* 闸门规则：退登同时撤销游客身份 → 回到「登录 / 注册」，不再直接放行到首页 */
await page.waitForSelector('.auth-card', { timeout: 10000 });
await page.waitForTimeout(600);
ok(true, '退出登录 → 回到「登录 / 注册」闸门（不再直接放行）');
const gateAfterLogout = await page.evaluate(() => (typeof AUTH !== 'undefined' ? AUTH.gateOpen() : 'no-AUTH'));
ok(gateAfterLogout === false, '退登同时撤销游客身份：闸门重新关闭', gateAfterLogout);
const chipOut = (await page.locator('.tb-user').first().innerText()).replace(/\s+/g, ' ').trim();
ok(/登录 \/ 注册/.test(chipOut), '顶栏回到未登录态', chipOut);
const tokenGone = await page.evaluate(() => localStorage.getItem('policy_agent_token'));
ok(tokenGone === null, '本地凭证已清除');
phase = 'after-logout';
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
/* 登出后重新打开：未登录 → 首屏应回到「登录 / 注册」页（新首屏规则） */
await page.waitForSelector('.auth-card', { timeout: 20000 });
ok(true, '登出后重新打开 → 回到未登录首屏（登录 / 注册）');
const chipFresh = (await page.locator('.tb-user').first().innerText()).replace(/\s+/g, ' ').trim();
ok(/登录 \/ 注册/.test(chipFresh), '登出后重新打开仍是游客态（会话已失效）', chipFresh);
await shot(page, '18-after-logout');

/* ============================================================ */
console.log('\n【12】接口调用与页面错误');
const uniq = [...new Set(calls.map((c) => c.method + ' ' + c.url))];
uniq.forEach((c) => console.log('    ' + c));
ok(uniq.some((c) => c.includes('/api/v1/auth/register')), '调用了注册接口');
ok(uniq.some((c) => c.includes('/api/v1/auth/me')), '调用了 /auth/me 恢复会话');
ok(uniq.some((c) => c.includes('/api/v1/history')), '调用了检索记录接口');
ok(uniq.some((c) => c.includes('/api/v1/searches')), '检索走的是检索链路');
ok(!uniq.some((c) => c.includes('/api/bootstrap')), '未回退到 /api/bootstrap');

ok(consoleErrors.length === 0, '无 JS 运行时错误', consoleErrors.slice(0, 3));
const realBad = badResponses.filter((u) => !/favicon\.ico/.test(u) && !/401/.test(u));
ok(realBad.length === 0, '无非预期失败请求（favicon / 未登录 401 除外）', realBad);
if (badResponses.length) console.log('    失败请求:', badResponses.join(' | '));

await browser.close();
console.log(`\n断言 ${pass} 项通过${fail ? `，${fail} 项未通过 ❌` : '，全部通过 ✅'}（截图见 backend/_shots/）`);
process.exit(fail === 0 ? 0 : 1);
