/* 输入框行为回归验收 —— 「按一下 y 出来三个 y」「中文打不进去」的常驻闸门
   ================================================================
   这一类 bug 的根因只有一个：**输入过程中把 <input> 节点整个换掉**。
   后果有两级：
     ① 轻的 —— 同一个按键的默认动作被追加到新节点上，一次输入变两三个字符；
     ② 重的 —— 输入法正在组词时节点被替换，组词直接中断，中文永远打不进去。
   所以本脚本对每个输入框都断言三件事：
     A. 一次按键 = 一个字符（含连续输入、退格、按住连发）
     B. 过滤 / 重绘后，输入框仍是**同一个 DOM 节点**（用 dataset 标记来验证）
     C. 输入法组词（CDP 模拟）期间不被重绘打断，候选词能上屏

   另含「结果列表的地域只读回显」验收：它回答「这份结果是按什么地域检索出来的」，
   不该再是一个能点开的选择器。

   用法
   ----
   node tools/verify_input_ime.mjs                                  # 默认 http://127.0.0.1:8000
   node tools/verify_input_ime.mjs http://127.0.0.1:8000
   node tools/verify_input_ime.mjs "file:///D:/.../ai-policy-agent-prototype.html"
   （file:// 测的是单文件版；需 NO_PROXY=127.0.0.1,localhost）
*/
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(pathToFileURL(resolve(
  process.env.PW_WORKSPACE || 'C:/Users/22866/.workbuddy/binaries/node/workspace', 'noop.js'
)));
const pw = await import(pathToFileURL(require.resolve('playwright')).href);
const chromium = pw.chromium || (pw.default && pw.default.chromium);

const SHOTS = join(dirname(fileURLToPath(import.meta.url)), '..', '_shots');
const SHOT = /^https?:/.test(process.argv[2] || 'http://127.0.0.1:8000');   /* 只在真后端那轮留图 */

const ARG = process.argv[2] || 'http://127.0.0.1:8000';
const URL_ = /^file:|^https?:/.test(ARG)
  ? ARG
  : pathToFileURL(resolve(ARG)).href;

let pass = 0;
let fail = 0;
const ok = (cond, msg, extra) => {
  /* extra 常是对象（{点选前, 点选后}）—— 直接拼字符串会印成 [object Object]，
     失败时正是最需要看清数字的时候，所以统一 JSON 化。 */
  const tail = extra === undefined
    ? ''
    : '   → ' + (extra && typeof extra === 'object' ? JSON.stringify(extra) : extra);
  if (cond) { pass += 1; console.log('  ok   ' + msg + tail); }
  else { fail += 1; console.log('  FAIL ' + msg + tail); }
};
const note = (msg) => console.log('  ·    ' + msg);
const shot = (page, name) => (SHOT ? page.screenshot({ path: join(SHOTS, name + '.png') }) : Promise.resolve());

const browser = await chromium.launch({ channel: 'msedge' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errs = [];
/* 网络噪音不算：file:// 打开时前端探测 /api/v1/db/status 必然被 CORS 拦，
   那是「没有后端」的正常表现，不是本脚本要管的 JS 异常。 */
const NET_NOISE = /api\/v1\/db\/status|blocked by CORS policy|net::ERR_FAILED|net::ERR_CONNECTION_REFUSED|Failed to fetch/;
page.on('pageerror', (e) => { if (!NET_NOISE.test(String(e))) errs.push(String(e)); });
page.on('console', (m) => { if (m.type() === 'error' && !NET_NOISE.test(m.text())) errs.push(m.text()); });

await page.goto(URL_, { waitUntil: 'load' });
await page.waitForTimeout(1100);

console.log('被测地址：' + URL_);
const stamp = await page.evaluate(() => ({
  build: window.__BUILD__ || '(无构建戳：这是旧副本)',
  kind: window.__BUILD_KIND__ || '-',
}));
console.log('构建戳　：' + stamp.build + '  [' + stamp.kind + ']');

/* 过闸门 */
const guest = page.locator('.auth-card [data-auth-guest]');
if (await guest.count()) { await guest.first().click(); await page.waitForTimeout(600); }
ok(await page.locator('.auth-card').count() === 0, '已越过登录闸门（游客身份）');

/* 外壳不再有任何浮层控件（左下角画布缩放胶囊已按需求移除；屏索引条更早就删了）。
   这条是防回流：外壳一旦又长出东西，它必然压在页面内容上 ——
   之前那枚胶囊就吃过页面底部的点击（verify_home_filters 报
   `#protoTools intercepts pointer events`，点了没反应）。 */
const shell = await page.evaluate(() => ({
  tools: document.querySelectorAll('#protoTools, .proto-tools').length,
  scene: document.querySelectorAll('.proto-rail, .proto-index').length,
  /* 视口左下角（最容易被浮层占据的位置）必须能拿到页面自己的元素 */
  bottomLeft: (() => {
    const el = document.elementFromPoint(14, innerHeight - 14);
    return el ? (el.className || el.tagName) + '' : '(null)';
  })(),
  viewportBg: getComputedStyle(document.getElementById('viewport')).backgroundColor,
  canvasRadius: getComputedStyle(document.getElementById('canvas')).borderTopLeftRadius,
  canvasShadow: getComputedStyle(document.getElementById('canvas')).boxShadow,
}));
ok(shell.tools === 0, '外壳不再有画布缩放胶囊（左下角浮层已删）', shell.tools);
ok(shell.scene === 0, '  屏索引条也保持移除状态', shell.scene);
ok(!/proto-tools|proto-viewport/.test(shell.bottomLeft),
  '  视口左下角拿到的是页面元素，不是外壳浮层', shell.bottomLeft);
ok(shell.viewportBg === 'rgb(249, 249, 249)' && shell.canvasRadius === '0px' && shell.canvasShadow === 'none',
  '  视口与画布同色、无圆角无投影（页面即整页，四周不留框）',
  [shell.viewportBg, shell.canvasRadius, shell.canvasShadow].join(' / '));

/* 构建戳仍在 window.__BUILD__（左下角那枚胶囊撤掉了，需要时开控制台读） */
ok(typeof stamp.build === 'string' && stamp.build.indexOf('(') < 0 && !/未知/.test(stamp.build),
  '构建戳仍写入产物（window.__BUILD__）', stamp.build);

const cdp = await ctx.newCDPSession(page);

/** 给输入框打标记：重绘时节点被换掉，标记就会丢 */
const mark = (sel, key) => page.evaluate(
  ([s, k]) => { const el = document.querySelector(s); if (el) el.dataset[k] = 'kept'; }, [sel, key]);
const marked = (sel, key) => page.evaluate(
  ([s, k]) => { const el = document.querySelector(s); return el ? (el.dataset[k] || '(标记丢失=节点被替换)') : '(输入框不存在)'; },
  [sel, key]);
const val = (sel) => page.inputValue(sel);
const wait = (ms) => page.waitForTimeout(ms);

/** 走一串单键输入，逐字符返回 */
async function typeChars(sel, chars, gap = 130) {
  await page.click(sel);
  await wait(120);
  const seen = [];
  for (const ch of chars) {
    await page.keyboard.type(ch);
    await wait(gap);
    seen.push(await val(sel));
  }
  return seen;
}

/** 用 CDP 模拟输入法：先组词，再上屏候选词 */
async function ime(sel, pinyin, hanzi) {
  await page.evaluate((s) => {
    const el = document.querySelector(s);
    if (el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
  }, sel);
  await page.click(sel);
  await wait(120);
  await cdp.send('Input.imeSetComposition', { text: pinyin, selectionStart: pinyin.length, selectionEnd: pinyin.length });
  await wait(180);
  const during = await val(sel);
  await cdp.send('Input.insertText', { text: hanzi });
  await wait(220);
  return { during, after: await val(sel) };
}

/* ============================================================
   ① 地域级联面板的搜索框 #cascQ
   ============================================================ */
console.log('\n【① 地域级联面板搜索框 #cascQ】');
await page.click('#rgHome');
await wait(400);
ok(await page.locator('#cascPanel').count() === 1, '级联面板已打开');

await mark('#cascQ', 'pm');
let seq = await typeChars('#cascQ', ['y', 'o']);
ok(seq[0] === 'y', '按一下 y 只出 1 个 y', JSON.stringify(seq[0]));
ok(seq[1] === 'yo', '连续输入 y→o 得到 yo（不是 yyo / yoyo）', JSON.stringify(seq[1]));
ok(await marked('#cascQ', 'pm') === 'kept', '过滤刷新后输入框仍是同一个 DOM 节点', await marked('#cascQ', 'pm'));
await page.keyboard.press('Backspace');
await wait(130);
ok(await val('#cascQ') === 'y', 'Backspace 正常退格（不吞字、不多删）', JSON.stringify(await val('#cascQ')));
const bodyTxt = await page.evaluate(() => {
  const b = document.querySelector('#cascPanel .fpanel-body');
  return b ? b.innerText.replace(/\s+/g, ' ').trim().slice(0, 48) : '';
});
ok(bodyTxt.length > 0, '列表已按搜索词过滤重绘', bodyTxt);

let r = await ime('#cascQ', 'zhong', '中');
ok(r.during === 'zhong', '组词中的拼音已上屏（组词态没有被重绘打断）', JSON.stringify(r.during));
ok(r.after.indexOf('中') >= 0, '候选词「中」成功上屏', JSON.stringify(r.after));
ok(await marked('#cascQ', 'pm') === 'kept', '组词结束后输入框节点未被替换', await marked('#cascQ', 'pm'));
r = await ime('#cascQ', 'zhengce', '政策');
ok(r.after.indexOf('政策') >= 0, '连续两次中文上屏正常', JSON.stringify(r.after));

/* 中文热搜词打进去，直接看渲染结果 */
r = await ime('#cascQ', 'hangzhou', '杭州');
ok(r.after.indexOf('杭州') >= 0, '中文「杭州」成功上屏', JSON.stringify(r.after));
ok(await page.locator('#cascPanel .casc-list .frow').count() >= 1,
  '中文「杭州」真的参与过滤（列表里出现了匹配项）',
  String(await page.locator('#cascPanel .casc-list .frow').count()) + ' 行');
await shot(page, '34-input-cascade-cn');
note('已存图 _shots/34-input-cascade-cn.png');

/* ============================================================
   ② 行业 / 类型 选项面板的搜索框 #optQ
   ============================================================ */
console.log('\n【② 选项面板搜索框 #optQ（行业 / 类型）】');
await page.keyboard.press('Escape');
await wait(300);
const optCases = [
  { group: 'industry', pinyin: 'ruanjian', hanzi: '软件' },
  { group: 'type', pinyin: 'butie', hanzi: '补贴' },
];
for (const c of optCases) {
  const sel = `[data-opt-trigger="${c.group}"]`;
  await page.click(sel);
  await wait(400);
  ok(await page.locator('#optPanel').count() === 1, `[${c.group}] 面板已打开`);
  await mark('#optQ', 'pm');
  seq = await typeChars('#optQ', ['y', 'o']);
  ok(seq[0] === 'y', `[${c.group}] 按一下 y 只出 1 个 y`, JSON.stringify(seq[0]));
  ok(seq[1] === 'yo', `[${c.group}] 连续输入得到 yo`, JSON.stringify(seq[1]));
  ok(await marked('#optQ', 'pm') === 'kept', `[${c.group}] 过滤刷新后输入框节点未变`, await marked('#optQ', 'pm'));
  r = await ime('#optQ', c.pinyin, c.hanzi);
  ok(r.after.indexOf(c.hanzi) >= 0, `[${c.group}] 中文「${c.hanzi}」成功上屏`, JSON.stringify(r.after));
  await page.keyboard.press('Escape');
  await wait(300);
}
/* 单选维度（截止时间）不该有搜索框 */
await page.click('[data-opt-trigger="deadline"]');
await wait(350);
ok(await page.locator('#optQ').count() === 0, '[deadline] 单选维度没有搜索框（符合设计）');
await page.keyboard.press('Escape');
await wait(300);

/* ============================================================
   ③ 首页自然语言查询框 #homeQ
   ============================================================ */
console.log('\n【③ 首页查询框 #homeQ】');
await mark('#homeQ', 'pm');
seq = await typeChars('#homeQ', ['y', 'o']);
ok(seq[0] === 'y', '按一下 y 只出 1 个 y', JSON.stringify(seq[0]));
ok(seq[1] === 'yo', '连续输入得到 yo', JSON.stringify(seq[1]));
ok(await marked('#homeQ', 'pm') === 'kept', '输入后输入框节点未被替换', await marked('#homeQ', 'pm'));
r = await ime('#homeQ', 'gaoxin', '高新');
ok(r.after.indexOf('高新') >= 0, '中文「高新」成功上屏', JSON.stringify(r.after));
ok(await marked('#homeQ', 'pm') === 'kept', '中文上屏后节点仍未被替换', await marked('#homeQ', 'pm'));

/* ============================================================
   ④ （原「地域多选」屏的内嵌面板一节已删 —— 该屏与首页级联面板
      是同一套组件，属重复入口，已整体移除。浮层面板路径由【①】覆盖。）
   ============================================================ */

/* ============================================================
   ⑤ 检索记录搜索框 #histQ（有 350ms 防抖 + 整屏重绘，最容易吞字）
     该屏的搜索框只对已登录用户展示，所以先真登录一次。
   ============================================================ */
console.log('\n【⑤ 检索记录搜索框 #histQ】');
const IS_HTTP = /^https?:/.test(URL_);
let loggedIn = false;
if (IS_HTTP) {
  const uname = 'ime' + String(Date.now()).slice(-9);
  await page.evaluate(async ({ base, uname }) => {
    const r = await fetch(base + '/api/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: uname, password: 'Abc123456', displayName: '输入自检' }),
    });
    return r.status;
  }, { base: URL_.replace(/\/$/, ''), uname }).catch(() => 0);
  const chip = page.locator('.tb-guest .tb-user, .tb-user').first();
  if (await chip.count()) {
    await chip.click();
    await wait(600);
    if (await page.locator('#af_username').count()) {
      await page.fill('#af_username', uname);
      await page.fill('#af_password', 'Abc123456');
      await page.click('#authSubmit');
      await wait(1600);
      loggedIn = await page.evaluate(() => typeof AUTH !== 'undefined' && !!AUTH.authed && AUTH.authed());
    }
  }
  ok(loggedIn, '已用一个临时账号登录（才能看到检索记录的搜索框）', uname);
} else {
  note('file:// 单文件版没有后端，跳过「检索记录搜索框」一节');
}

if (loggedIn) {
  await page.click('[data-nav="history"]');
  await wait(900);
}
if (await page.locator('#histQ').count()) {
  await mark('#histQ', 'pm');
  await page.click('#histQ');
  await page.keyboard.type('y');
  await wait(130);
  ok(await val('#histQ') === 'y', '按一下 y 只出 1 个 y', JSON.stringify(await val('#histQ')));
  await wait(900);                       /* 越过 350ms 防抖 + 一次整屏重绘 */
  ok(await val('#histQ') === 'y', '防抖重绘后搜索词仍在（不被清空）', JSON.stringify(await val('#histQ')));
  await page.keyboard.type('o');          /* 关键：重绘后紧接着再输入 */
  await wait(150);
  const two = await val('#histQ');
  ok(two === 'yo', '防抖重绘后继续输入，字没丢', JSON.stringify(two));
  note('节点身份：' + await marked('#histQ', 'pm') + '（该屏是整屏 render()，节点会被换，靠恢复焦点与光标兜住）');
  await page.evaluate(() => {
    const el = document.getElementById('histQ');
    if (el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
  });
  await wait(600);
} else {
  note('#histQ 不在场（该屏需要登录态），跳过');
}

/* ============================================================
   ⑥ 结果列表：地域只读回显
   ============================================================ */
console.log('\n【⑥ 结果列表的地域回显（只读，不可再选）】');
/* 先回首页，在级联面板里勾选并确定一个省 —— 注意这里**只改了筛选条件，没有发起新检索**：
   回显回答的是「**当前这份结果**是按什么地域检索出来的」（后端给的结果集元数据
   list.regionsUsed），所以它不该跟着刚改的筛选栏走。 */
await page.click('[data-nav="home"]');
await wait(600);
await page.click('#rgHome');
await wait(450);
/* 搜索词是 CASC_STATE 共享的，【①】里输入过，先清干净再点选 */
await page.evaluate(() => {
  if (typeof CASC_STATE !== 'undefined') CASC_STATE.query = '';
  const el = document.getElementById('cascQ');
  if (el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
});
await wait(300);
const provRow = page.locator('#cascPanel [data-casc-node="33"]').first();
if (await provRow.count()) {
  await provRow.click();
  await wait(300);
  await page.click('[data-casc-ok]');
  await wait(450);
  note('已在级联面板里勾选并确定一个省（33 浙江省）');
}
await page.click('[data-nav="list"]');
await wait(500);
const rg = await page.evaluate(() => {
  const e = document.getElementById('rgList');
  if (!e) return null;
  return {
    cls: e.className,
    caret: !!e.querySelector('.caret'),
    drop: !!e.querySelector('[data-fdrop]'),
    write: e.getAttribute('data-region-trigger'),
    text: e.innerText.replace(/\s+/g, ' ').trim(),
    hint: (document.querySelector('.fb-hint') || {}).innerText || '',
  };
});
ok(!!rg, '结果列表里能找到地域回显 #rgList');
if (rg) {
  ok(/readonly/.test(rg.cls), '地域是只读触发器（带 readonly 类）', rg.cls.trim());
  ok(!rg.caret, '只读回显没有展开箭头 caret');
  ok(!rg.drop, '只读回显没有单个删除 ×');
  ok(rg.write === null, '不挂 data-region-trigger（点了不会弹面板）');
  const used = await page.evaluate(
    () => (typeof DATA !== 'undefined' && DATA.list && DATA.list.regionsUsed) || []);
  ok(used.length > 0 && rg.text.indexOf(used[0]) >= 0,
    '回显的是「当前这份结果集的地域」（后端给的 list.regionsUsed）', { text: rg.text, used });
  ok(rg.text.indexOf('浙江省') < 0,
    '  只改筛选栏、没发起新检索时不会改写回显（它描述结果集，不是筛选条件）', rg.text);
  ok(!/请选择/.test(rg.text), '回显里不含「请选择」这类可交互占位文案');
  note('辅助说明：' + rg.hint);
}
await page.click('#rgList', { force: true }).catch(() => {});
await wait(400);
ok(await page.locator('#cascPanel').count() === 0
  && await page.locator('#optPanel').count() === 0,
  '点击地域回显不会弹出任何选择面板');
await shot(page, '35-input-list-region-readonly');
note('已存图 _shots/35-input-list-region-readonly.png');

/* ============================================================
   ⑦ 回归：首页四个维度仍然可以打开面板
   ============================================================ */
console.log('\n【⑦ 回归：首页四维筛选仍可交互】');
await page.click('[data-nav="home"]');
await wait(450);
for (const sel of ['#rgHome', '[data-opt-trigger="industry"]', '[data-opt-trigger="type"]', '[data-opt-trigger="deadline"]']) {
  await page.click(sel);
  await wait(350);
  const open = await page.locator('#cascPanel, #optPanel').count();
  ok(open === 1, '可打开：' + sel, 'panel=' + open);
  await page.keyboard.press('Escape');
  await wait(300);
}

/* ============================================================
   ⑧ 筛选面板的滚动位置保持
   ------------------------------------------------------------
   用户原话：「用户选择地区之后，选择框会自动回到最上面，我希望用户选择之后
   可以保持再原地，其他的选择框也是这样修改」。

   根因：面板列表是整块 innerHTML 换掉的（不换 <input>，理由见【①】），
   换掉就把滚动条弹回顶部 —— 把「省级行政区」翻到广东勾一下，又得从头往下翻。
   现在的做法（app.js → swapPanelBody）是按**内容身份**记住位置：
   身份没变（只是勾了一行）就放回原处；身份变了（换了展开的省 / 市、改了搜索词）
   就回顶部 —— 换了人的名单停在旧位置没有意义。

   本节把两个面板都盯上：级联三列 + 选项面板（行业 / 类型 / 截止时间）。
   ============================================================ */
console.log('\n【⑧ 筛选面板：勾选后滚动位置不弹回顶部】');
await page.click('[data-nav="home"]');
await wait(500);
await page.click('#rgHome');
await wait(450);
/* 搜索词是 CASC_STATE 共享的，前面几节可能留了字，先清干净 */
await page.evaluate(() => {
  if (typeof CASC_STATE !== 'undefined') CASC_STATE.query = '';
  const el = document.getElementById('cascQ');
  if (el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
});
await wait(350);

/** 三列的位置与可滚性 */
const cascTops = () => page.evaluate(() => Array.from(document.querySelectorAll('#cascPanel .casc-list'))
  .map((el) => ({ top: Math.round(el.scrollTop), h: el.clientHeight, sh: el.scrollHeight })));

/** 把某列滚到让「名字里含 name 的那一行」落入视野，然后点它（真实 click，走委托处理器）。
 *  name 传空串则取**最后一行**（保证是往下翻，位置一定非 0）。
 *  返回 { label, target }：target = 点击前的滚动位置，正是「用户当前停在哪」。 */
const scrollToAndClick = (col, name) => page.evaluate(([c, n]) => {
  const lists = Array.from(document.querySelectorAll('#cascPanel .casc-list'));
  const list = lists[c];
  if (!list) return null;
  const rows = Array.from(list.querySelectorAll('.frow[data-casc-node]'));
  const row = n ? rows.find((r) => r.innerText.indexOf(n) >= 0) : rows[rows.length - 1];
  if (!row) return null;
  const lr = list.getBoundingClientRect();
  const rr = row.getBoundingClientRect();
  list.scrollTop += (rr.top - lr.top) - 60;          /* 像人一样「翻到它」 */
  const target = Math.round(list.scrollTop);
  row.click();
  return { label: row.innerText.replace(/\s+/g, ' ').trim(), target };
}, [col, name]);

const c0 = await cascTops();
ok(c0[0].sh > c0[0].h + 8, '省级列可滚动（34 个省级行政区，一屏放不下）', JSON.stringify(c0[0]));

/* ── A 省级列：翻到广东、勾一下，滚回来的还是这个位置 ── */
const a = await scrollToAndClick(0, '广东');
await wait(300);
const cA = await cascTops();
ok(!!a && a.target > 40, '（前置）点选前已经把省级列翻下去了', a);
ok(!!a && cA[0].top === a.target,
  '勾选「' + (a ? a.label : '') + '」后省级列**停在原地**（不再弹回顶部）',
  { 点选前: a && a.target, 点选后: cA[0].top });
ok(cA[1].sh > cA[1].h + 8 && cA[1].top === 0,
  '  同时市列换成新省的名单，从**顶部**开始看（换了人的名单不该沿用旧位置）',
  JSON.stringify(cA[1]));

/* ── B 市列：翻下去再勾一个市 → 市列不跳；区县列换名单 → 回顶 ── */
const b = await scrollToAndClick(1, '');
await wait(300);
const cB = await cascTops();
if (b && b.target > 0) {
  ok(cB[1].top === b.target,
    '在市列里翻到「' + b.label + '」并勾选后，市列同样停在原地',
    { 点选前: b.target, 点选后: cB[1].top });
  ok(cB[2].top === 0,
    '  区县列换成了这个市的下级名单 → 回到顶部', cB[2].top);
} else {
  const cityScrollable = cB[1].sh > cB[1].h + 8;
  ok(cityScrollable, '（本省地级市较多，市列可滚动）', JSON.stringify(cB[1]));
  ok(cB[0].top === (a ? a.target : -1),
    '  勾选市之后省级列也不受影响（三列各自独立）', cB[0].top);
}

/* ── C 换了搜索词 = 换了名单 → 一律回顶部 ── */
await page.evaluate(() => {
  const lists = Array.from(document.querySelectorAll('#cascPanel .casc-list'));
  if (lists[0]) lists[0].scrollTop = 280;
});
await wait(120);
const beforeQ = await cascTops();
await page.fill('#cascQ', '省');
await wait(400);
const afterQ = await cascTops();
ok(beforeQ[0].top > 0, '（前置）输入前省级列已翻到下半屏', beforeQ[0].top);
ok(afterQ[0].sh > afterQ[0].h + 8 && afterQ[0].top === 0,
  '改了搜索词 → 名单整体换人，省级列回到顶部（位置不再沿用）',
  JSON.stringify(afterQ[0]));
await page.evaluate(() => {
  const el = document.getElementById('cascQ');
  if (el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
});
await wait(300);
await page.keyboard.press('Escape');
await wait(300);

/* ── D 选项面板（行业 / 类型 / 截止时间）走的是同一条 swapPanelBody ──
   注意：默认布局下 8 个行业一屏就放得下（实测 254 ≤ 254），根本滚不动 ——
   所以这里**临时把面板压矮**，把「滚动位置保持」这条路径真正跑起来。
   压矮只改布局高度，不改任何逻辑；测完把注入的样式摘掉。 */
const optBody = () => page.evaluate(() => {
  const el = document.querySelector('#optPanel .fpanel-body');
  return el ? { top: Math.round(el.scrollTop), h: el.clientHeight, sh: el.scrollHeight } : null;
});
await page.click('[data-opt-trigger="industry"]');
await wait(400);
const d0 = await optBody();
ok(!!d0 && d0.sh <= d0.h + 2,
  '选项面板在默认布局下一屏放得完整份选项（本来就不需要滚动）', JSON.stringify(d0));

const forced = await page.addStyleTag({
  content: '.opt-panel .fpanel-body{max-height:104px !important;min-height:104px !important}',
});
await wait(200);
const d1 = await optBody();
ok(!!d1 && d1.sh > d1.h + 8, '（把面板压矮后）选项列表变成可滚动，测试条件成立', JSON.stringify(d1));

const dClick = await page.evaluate(() => {
  const body = document.querySelector('#optPanel .fpanel-body');
  if (!body) return null;
  body.scrollTop = 70;
  const br = body.getBoundingClientRect();
  const row = Array.from(body.querySelectorAll('.frow[data-opt-val]'))
    .find((r) => { const b = r.getBoundingClientRect(); return b.top > br.top + 2 && b.bottom < br.bottom - 2; });
  if (!row) return null;
  const info = { label: row.innerText.replace(/\s+/g, ' ').trim(), target: Math.round(body.scrollTop) };
  row.click();
  info.after = Math.round(body.scrollTop);
  return info;
});
await wait(200);
ok(!!dClick && dClick.target > 0,
  '（前置）选项面板已翻到下半屏，并点了当前可见的「' + (dClick ? dClick.label : '') + '」', dClick);
ok(!!dClick && dClick.after === dClick.target,
  '勾选行业后，选项面板同样**停在原地**（与级联面板共用同一条保持逻辑）',
  dClick && { 点选前: dClick.target, 点选后: dClick.after });
const d2 = await optBody();
ok(!!d2 && d2.top === (dClick ? dClick.target : -1),
  '  重绘之后位置仍在（不是只保住了一次）', d2 && d2.top);
await forced.evaluate((el) => el.remove());
await page.keyboard.press('Escape');
await wait(300);

/* ============================================================ */
console.log('\nJS 错误：' + (errs.length ? errs.join(' | ') : '无'));
if (errs.length) fail += 1;
console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
await browser.close();
process.exit(fail ? 1 : 0);
