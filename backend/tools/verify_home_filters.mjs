/* ============================================================
   真实浏览器验证 · 首页「条件精确筛选」统一控件 + 游客出口（第四轮）
   ------------------------------------------------------------
   A. 四个维度（地域 / 行业 / 类型 / 截止时间）是**同一个控件**：
      触发器（维度标签 + 已选标签块 + 单个 × 删除 + 「+N」折叠 + 清空）
      与面板骨架（头部标题/快捷操作/搜索/提示 + 列表 + 底部摘要/清空/确定(n)）
      共用一份实现，地域与选项维度只在列表区排布上不同。
   B. 面板内的搜索、全选、行勾选、清空、确定生效、触发器与摘要同步。
   C. 地域「选中全省」快捷操作：一键勾上当前省全部地级市，再点取消，
      纯增量（不动省名自身、不影响其他省份）；搜索态不出现。
   D. 游客身份的快捷出口：顶栏「游客 · 未保存」+ 一步「退出」回到闸门。
   E. 生效值随 POST /api/v1/searches 提交（后端契约不变）。
   F. 登录「记住一次、超期失效」（沿用上一轮）。

   用系统 Edge（channel: msedge），不下载额外浏览器。
   用法：node tools/verify_home_filters.mjs [baseUrl]
   ============================================================ */
import { mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(pathToFileURL(resolve(
  process.env.PW_WORKSPACE || 'C:/Users/22866/.workbuddy/binaries/node/workspace', 'noop.js')));
const pw = await import(pathToFileURL(require.resolve('playwright')).href);
const chromium = pw.chromium || (pw.default && pw.default.chromium);

const BASE = process.argv[2] || 'http://127.0.0.1:8000';
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '_shots');
mkdirSync(OUT, { recursive: true });

let pass = 0;
let fail = 0;
const ok = (c, label, extra) => {
  if (c) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
};
const shot = (page, name) => page.screenshot({ path: resolve(OUT, name + '.png'), fullPage: false });

/* 把页面拉回首页：跑完账号那一段后可能停在登录闸门（凭证超期），也可能已经回到首页 */
async function ensureHome(p) {
  if (await p.locator('#homeQ').count()) return;
  const guest = p.locator('.auth-card [data-auth-guest]');
  if (await guest.count()) await guest.first().click();
  await p.waitForSelector('#homeQ', { timeout: 15000 });
}

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();

const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

const searchBodies = [];
page.on('request', (r) => {
  if (r.method() === 'POST' && r.url().includes('/api/v1/searches')) {
    try { searchBodies.push(JSON.parse(r.postData() || '{}')); } catch (e) { searchBodies.push({}); }
  }
});

/* ---------- 首页筛选相关的可见状态 ---------- */
const snap = () => page.evaluate(() => {
  const T = (sel) => {
    const e = document.querySelector(sel);
    return e ? e.textContent.replace(/\s+/g, ' ').trim() : null;
  };
  /* 触发器的「值区」= 维度标签 + 标签块，不含右侧的「清空」（那是操作，不是值） */
  const trig = (g) => {
    const e = document.querySelector(`[data-opt-trigger="${g}"]`);
    if (!e) return null;
    const tv = e.querySelector('.tv');
    const tags = e.querySelector('.tags');
    const parts = [tv ? tv.textContent.replace(/\s+/g, ' ').trim() : ''];
    if (tags) {
      parts.push(Array.from(tags.children)
        .map((c) => c.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' '));
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  };
  const chips = (sel) => Array.from(document.querySelectorAll(sel + ' .tag .x[data-fdrop]'))
    .map((e) => e.dataset.fdrop);
  const more = (sel) => {
    const e = document.querySelector(sel + ' .tag.more');
    return e ? e.textContent.trim() : null;
  };
  const OPT = (g) => `[data-opt-trigger="${g}"]`;
  return {
    offlineBar: document.querySelectorAll('.offline-bar').length,
    triggers: ['industry', 'type', 'deadline'].map(trig),
    chIndustry: chips(OPT('industry')),
    chRegion: chips('#rgHome'),
    moreIndustry: more(OPT('industry')),
    moreRegion: more('#rgHome'),
    region: T('#rgHome'),
    summary: T('#homeSummary'),
    /* 选项面板 */
    panelOpen: !!document.querySelector('#optPanel'),
    panelClass: document.querySelector('#optPanel') ? document.querySelector('#optPanel').className : null,
    panelTitle: T('#optPanel .fp-ttl'),
    panelHint: T('#optPanel .fp-hint'),
    panelSearch: !!document.querySelector('#optPanel #optQ'),
    allBtn: T('#optPanel [data-opt-all]'),
    rows: Array.from(document.querySelectorAll('#optPanel .frow'))
      .map((r) => ({ v: r.dataset.optVal, on: r.classList.contains('on') })),
    emptyText: T('#optPanel .fpanel-empty'),
    okBtn: T('#optPanel [data-opt-ok]'),
    sum: T('#optPanel .fpanel-foot .sum'),
    /* 地域级联面板 */
    cascOpen: !!document.querySelector('#cascPanel'),
    cascTitle: T('#cascPanel .fp-ttl'),
    cascHint: T('#cascPanel .fp-hint'),
    cascProvAll: T('[data-casc-prov-all]'),
    cascProvAllHint: (() => {
      const b = document.querySelector('[data-casc-prov-all]');
      return b ? b.getAttribute('title') : null;
    })(),
    cascOpenCount: document.querySelectorAll('#cascPanel .frow.on').length,
    cascSum: T('#cascPanel .fpanel-foot .sum'),
    cascSearch: !!document.querySelector('#cascPanel #cascQ'),
    /* 顶栏 */
    guestChip: T('.tb-guest .tb-user'),
    /* 顶栏有没有被挤成两行：必须看**布局高度**（clientHeight），
       不能用 getBoundingClientRect().height —— 那个会被画布 scale() 放大
       （视口 1600×1000 时 scale≈1.111，63px 的行高会被量成 70，直接踩到阈值上）。
       单行时实测 63px，两行会到 110 左右，70 是安全分界。 */
    topbarWrapped: (() => {
      const t = document.querySelector('.topbar');
      return t ? t.clientHeight > 70 : null;
    })(),
  };
});

const OPEN_GUEST_EXIT = '[data-auth-drop-guest]';

console.log('【0】进入应用（闸门 → 游客身份 → 首页）+ 游客出口已在顶栏');
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.auth-card', { timeout: 20000 });
await shot(page, '27-login-remember');
const rememberNote = await page.locator('.auth-remember').innerText().catch(() => '');
ok(/本机保留\s*7\s*天/.test(rememberNote), '登录页给出「保留多久」的说明', rememberNote);
ok(await page.locator('.auth-card [data-auth-guest]').count() >= 1,
  '未进入时登录页给出「以游客身份继续」入口');
await page.click('.auth-card [data-auth-guest]');
await page.waitForSelector('#homeQ', { timeout: 15000 });

let s = await snap();
ok(/游客/.test(s.guestChip), '进入后顶栏明确标出游客身份', s.guestChip);
ok(await page.locator(OPEN_GUEST_EXIT).count() === 1, '顶栏直接给出「退出」出口（不必先进登录页）');
ok(s.topbarWrapped === false, '顶栏没有被挤成两行');

console.log('\n【1】首页：四个维度默认全不预选（都不限）');
/* 面板操作助手：开面板 → 清空 → 勾上指定项 → 确定 */
const setGroup = async (g, values) => {
  await page.click(`[data-opt-trigger="${g}"]`);
  await page.waitForSelector('#optPanel', { timeout: 5000 });
  await page.click('#optPanel [data-opt-clear]');
  for (const v of values) await page.click(`#optPanel [data-opt-val="${v}"]`);
  await page.click('#optPanel [data-opt-ok]');
  await page.waitForTimeout(200);
};
s = await snap();
ok(s.offlineBar === 0, '首页底部蓝色降级横幅仍是移除状态', s.offlineBar);
/* ★ 四个维度默认全「不限」（地域不预选、行业/类型 value 为空、截止时间单选默认不限）。
   曾经预选过一套演示值（行业=智能硬件/软件信息、类型=补贴/场地减免/稳岗、截止=近 90 天），
   用户新开一次检索时旧值会静默生效 —— 问句写「我是东莞做人工智能的」，
   页头却写着「东莞市 · 智能硬件 / 软件信息 · 补贴 / 场地减免 等 3 项」，
   搜索的行业与检索用的行业对不上。 */
ok(/行业：\s*不限/.test(s.triggers[0] || ''), '行业默认不限（不预选任何值）', s.triggers[0]);
ok(/类型：\s*不限/.test(s.triggers[1] || ''), '类型默认不限（不预选任何值）', s.triggers[1]);
ok(/截止时间：\s*不限/.test(s.triggers[2] || ''), '截止时间默认不限', s.triggers[2]);
ok(/已选 0 项：地域不限/.test(s.summary || ''), '四项摘要：默认一个条件都没加', s.summary);
ok(await page.locator('[data-opt-trigger] .tag').count() === 0,
  '三个选项触发器上都没有预置的标签块');
await shot(page, '25a-home-all-unlimited');

console.log('\n【1b】走真实 UI 选上样例条件（后面各小节沿用这套交互）');
await setGroup('industry', ['智能硬件', '软件信息']);
await setGroup('type', ['补贴', '场地减免', '稳岗']);
await setGroup('deadline', ['近 90 天']);
s = await snap();
ok(s.triggers[0] === '行业： 智能硬件 +1', '行业触发器 = 维度标签 + 标签块 + 折叠计数', s.triggers[0]);
ok(s.triggers[1] === '类型： 补贴 +2', '类型触发器同构', s.triggers[1]);
ok(s.triggers[2] === '截止时间： 近 90 天', '截止时间触发器同构', s.triggers[2]);
ok(s.chIndustry.join('/') === '智能硬件', '一行四列时只展示 1 个标签块（tagMax）', s.chIndustry);
ok(s.moreIndustry === '+1', '其余折叠为「+N」', s.moreIndustry);
/* 点触发器中段（标签所在处）必须展开面板，而不是把条件删掉 —— 标签本体不是删除热区 */
const keepCh = (await snap()).chIndustry.join('/');
await page.click('[data-opt-trigger="industry"] .tags');
await page.waitForTimeout(250);
ok((await snap()).panelOpen && (await snap()).chIndustry.join('/') === keepCh,
  '点触发器值区是「展开面板」，不会误删已选条件', [keepCh, (await snap()).chIndustry]);
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
await page.click('[data-opt-trigger="industry"] .tag.more');
await page.waitForTimeout(250);
s = await snap();
ok(s.panelOpen && s.rows.filter((r) => r.on).map((r) => r.v).join('/') === '智能硬件/软件信息',
  '点「+N」折叠标签 → 打开面板，被折叠的项也在其中');
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
ok(/地域：/.test(s.region || ''), '地域触发器也始终显示维度标签（与三项一致）', s.region);
ok(/已选 3 项：地域不限 · 行业 2 个 · 类型 3 个 · 截止：近 90 天/.test(s.summary || ''),
  '摘要按维度计数（地域空 → 3 项）', s.summary);
ok(await page.locator('.capcard').count() === 3, '能力卡（原蓝条位置上方）照常渲染');
await shot(page, '25-home-filters');

console.log('\n【2】行业面板：与地域面板同一套骨架 + 搜索 + 全选');
await page.click('[data-opt-trigger="industry"]');
await page.waitForSelector('#optPanel', { timeout: 5000 });
s = await snap();
ok(s.panelOpen, '点「行业」触发器 → 面板展开');
ok(s.panelClass === 'fpanel opt-panel', '面板挂的是共用骨架类 .fpanel', s.panelClass);
ok(s.panelTitle === '行业 · 可多选', '面板标题正确', s.panelTitle);
ok(/勾选即改草稿，点「确定」才生效/.test(s.panelHint || ''), '面板给出生效时机说明（与地域同一句）', s.panelHint);
ok(s.panelSearch, '面板内有搜索框（与地域面板同款）');
ok(s.allBtn === '全选', '多选维度给出「全选」快捷操作', s.allBtn);
ok(s.rows.length === 8, '选项行数 = 配置项数（8）', s.rows.length);
ok(s.rows.filter((r) => r.on).map((r) => r.v).join('/') === '智能硬件/软件信息',
  '默认已勾选项与触发器回显一致', s.rows.filter((r) => r.on).map((r) => r.v));
ok(s.okBtn === '确定（2）', '确定按钮带草稿计数', s.okBtn);
await shot(page, '26-opt-industry');

/* 搜索：过滤可见项，且「全选」只作用于可见项 */
await page.click('#optPanel [data-opt-clear]');
await page.waitForTimeout(150);
await page.fill('#optPanel #optQ', '智能');
await page.waitForTimeout(200);
s = await snap();
ok(s.rows.length === 1 && s.rows[0].v === '智能硬件', '搜索框按名称过滤可选项', s.rows.map((r) => r.v));
ok(s.allBtn === '全选', '可见项尚未勾选时按钮为「全选」', s.allBtn);
await page.click('#optPanel [data-opt-all]');
await page.waitForTimeout(150);
s = await snap();
ok(s.rows.filter((r) => r.on).length === 1 && s.allBtn === '取消全选',
  '「全选」只勾当前可见项，按钮随即变为「取消全选」', [s.rows.filter((r) => r.on).length, s.allBtn]);
ok(s.sum === '已选 1 项：智能硬件', '面板底部摘要跟随草稿（不含被过滤掉的项）', s.sum);
await page.click('#optPanel [data-opt-all]');
await page.waitForTimeout(150);
s = await snap();
ok(s.rows.filter((r) => r.on).length === 0 && s.allBtn === '全选', '再点「取消全选」撤销可见项');
await page.fill('#optPanel #optQ', 'zzz');
await page.waitForTimeout(200);
s = await snap();
ok(s.rows.length === 0 && /没有匹配的选项/.test(s.emptyText || ''),
  '无匹配时给出空态兜底，而不是白板', s.emptyText);
await page.fill('#optPanel #optQ', '智能');
await page.waitForTimeout(200);
s = await snap();
ok(s.rows.length === 1, '改回关键词后重新过滤');
await page.click('#optPanel [data-opt-val="智能硬件"]');
await page.waitForTimeout(150);
s = await snap();
ok(s.sum === '已选 1 项：智能硬件', '勾选即改草稿，底部摘要同步', s.sum);
ok((s.triggers[0] || '').indexOf('智能硬件') >= 0, '未点「确定」前，触发器保持已生效值（草稿不外泄）', s.triggers[0]);
await page.click('#optPanel [data-opt-ok]');
await page.waitForTimeout(250);
s = await snap();
ok(!s.panelOpen, '点「确定」→ 面板收起');
ok(s.triggers[0] === '行业： 智能硬件', '确定后触发器只剩 1 个标签块', s.triggers[0]);
ok(/已选 3 项：地域不限 · 行业 1 个 · 类型 3 个 · 截止：近 90 天/.test(s.summary || ''),
  '确定后摘要同步（行业 1 个）', s.summary);

/* 再打开：搜索词应已复位（草稿/搜索都不跨次残留） */
await page.click('[data-opt-trigger="industry"]');
await page.waitForSelector('#optPanel', { timeout: 5000 });
s = await snap();
ok(s.rows.length === 8 && await page.inputValue('#optPanel #optQ') === '',
  '重新打开时搜索词复位、列表回到全量');
await page.keyboard.press('Escape');
await page.waitForTimeout(200);

console.log('\n【3】触发器上的 × 单个删除 + 触发器内「清空」（地域与选项维度同一套）');
await page.click('[data-opt-trigger="type"]');
await page.waitForSelector('#optPanel', { timeout: 5000 });
await page.click('#optPanel [data-opt-clear]');
await page.waitForTimeout(150);
s = await snap();
ok(s.rows.every((r) => !r.on), '面板内「清空」取消所有勾选');
ok(s.sum === '未选择 → 检索不限该维度', '空草稿给出明确的兜底说明', s.sum);
await page.click('#optPanel [data-opt-ok]');
await page.waitForTimeout(250);
s = await snap();
ok(/类型：\s*不限/.test(s.triggers[1] || ''), '确定后触发器回到「不限」占位', s.triggers[1]);
ok(/已选 2 项：地域不限 · 行业 1 个 · 截止：近 90 天/.test(s.summary || ''),
  '清空后类型不再计入「已选」项数', s.summary);

/* 重新勾两项，再从触发器上逐个 × 掉（setGroup 助手定义在【1】开头） */
await setGroup('type', ['稳岗', '补贴']);
s = await snap();
ok(s.triggers[1] === '类型： 稳岗 +1', '两个已选项 → 展示 1 个 + 折叠 +1', s.triggers[1]);
ok(await page.locator('[data-opt-trigger="type"] .tag.more').count() === 1, '折叠标签「+1」在触发器内');
await page.click('[data-opt-trigger="type"] .tag .x');
await page.waitForTimeout(250);
s = await snap();
ok(s.triggers[1] === '类型： 补贴' && /类型 1 个/.test(s.summary || ''),
  '点标签上的 × → 单独删掉「稳岗」，摘要同步', s.triggers[1]);
await page.click('[data-opt-trigger="type"] .clear-slot');
await page.waitForTimeout(250);
s = await snap();
ok(/类型：\s*不限/.test(s.triggers[1] || ''), '触发器上的「清空」一步清掉该维度', s.triggers[1]);

console.log('\n【4】截止时间：单选（不受「全选」影响）');
await page.click('[data-opt-trigger="deadline"]');
await page.waitForSelector('#optPanel', { timeout: 5000 });
s = await snap();
ok(s.panelTitle === '截止时间 · 单选', '面板标题标明为单选', s.panelTitle);
ok(s.allBtn === null, '单选维度不出现「全选」（全选对单选无意义）', s.allBtn);
ok(!s.panelSearch, '选项少且单选的维度不摆搜索框', s.panelSearch);
ok(s.rows.filter((r) => r.on).map((r) => r.v).join('') === '近 90 天', '单选面板回显当前已生效的「近 90 天」');
await page.click('#optPanel [data-opt-val="近 30 天"]');
await page.waitForTimeout(150);
s = await snap();
ok(s.rows.filter((r) => r.on).map((r) => r.v).join('') === '近 30 天', '单选：点新值自动替换旧值（不会同时选中两项）');
await page.click('#optPanel [data-opt-ok]');
await page.waitForTimeout(250);
s = await snap();
ok(s.triggers[2] === '截止时间： 近 30 天', '确定后触发器更新', s.triggers[2]);
ok(/截止：近 30 天/.test(s.summary || ''), '摘要跟着换', s.summary);
await page.click('[data-opt-trigger="deadline"]');
await page.waitForSelector('#optPanel', { timeout: 5000 });
await page.click('#optPanel [data-opt-val="不限"]');
await page.click('#optPanel [data-opt-ok]');
await page.waitForTimeout(250);
s = await snap();
ok(/截止时间：\s*不限/.test(s.triggers[2] || ''), '选「不限」后触发器显示不限', s.triggers[2]);
ok(/已选 1 项：地域不限 · 行业 1 个/.test(s.summary || ''), '「不限」不计入已选项数', s.summary);

console.log('\n【5】地页面板同构 + 「选中全省」快捷操作');
await page.click('[data-opt-trigger="industry"]');
await page.waitForSelector('#optPanel', { timeout: 5000 });
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
ok(!(await snap()).panelOpen, 'Esc 关闭面板');
await page.click('[data-opt-trigger="industry"]');
await page.waitForSelector('#optPanel', { timeout: 5000 });
await page.click('#optBackdrop', { position: { x: 40, y: 860 } });
await page.waitForTimeout(200);
ok(!(await snap()).panelOpen, '点遮罩关闭面板');
await page.click('[data-opt-trigger="industry"]');
await page.waitForSelector('#optPanel', { timeout: 5000 });
await page.click('[data-opt-trigger="industry"]');
await page.waitForTimeout(200);
s = await snap();
ok(!s.panelOpen, '再点同一个触发器可收起（触发器浮在遮罩之上）');
ok(await page.locator('#optLayer').count() === 0, '关闭后浮层节点被移除，无残留');

await page.click('#rgHome');
await page.waitForSelector('#cascPanel', { timeout: 5000 });
s = await snap();
ok(s.cascOpen, '点地域触发器 → 级联面板展开');
ok(s.cascTitle === '地域 · 可多选', '级联面板也有标题（与选项面板同构）', s.cascTitle);
ok(s.cascSearch, '级联面板保留搜索框');
ok(s.cascProvAll === '选中全省', '市级列标题旁给出「选中全省」快捷操作', s.cascProvAll);
ok(s.cascProvAllHint && /一键勾上 \/ 取消/.test(s.cascProvAllHint), '快捷操作有明确的悬浮说明', s.cascProvAllHint);
ok(/勾选即改草稿，点「确定」才生效/.test(s.cascHint || ''),
  '级联面板的提示语与选项面板同源（同一份 filterLabels）', s.cascHint);
await shot(page, '29-region-province-all');

/* 城市列的行数 = 该省下辖地级市数量（不写死，避免换省就红） */
const cityCount = await page.locator('#cascPanel .casc-col').nth(1).locator('.frow').count();
const before = (await snap()).cascOpenCount;
await page.click('[data-casc-prov-all]');
await page.waitForTimeout(300);
s = await snap();
ok(cityCount > 0 && s.cascOpenCount === before + cityCount,
  '「选中全省」一次勾上该省下全部地级市', [before, cityCount, s.cascOpenCount]);
ok(s.cascProvAll === '取消全省', '全部勾上后按钮变为「取消全省」', s.cascProvAll);
ok(new RegExp(cityCount + ' 个下级区划').test(await page.locator('#toasts .toast').last().innerText().catch(() => '')),
  '给出操作反馈（勾了几个）');
await page.click('[data-casc-prov-all]');
await page.waitForTimeout(300);
s = await snap();
ok(s.cascOpenCount === before, '再点一次整体取消，回到原状', [before, s.cascOpenCount]);
ok(s.cascProvAll === '选中全省', '按钮文案随之复位', s.cascProvAll);

/* 搜索态不给「选中全省」（此时列里不是「某省的下辖市」） */
await page.fill('#cascPanel #cascQ', '杭州');
await page.waitForTimeout(300);
ok(await page.locator('[data-casc-prov-all]').count() === 0, '搜索态不出现「选中全省」');
await page.fill('#cascPanel #cascQ', '');
await page.waitForTimeout(200);

/* 选两个省 → 确定 → 触发器用标签块展示，可单个删除
   （区划代码：省 2 位、市 4 位、区县 6 位；树里 32 江苏省 在 33 浙江省 之前，
     所以折叠后留下的那个标签是 32） */
await page.click('#cascPanel .frow[data-casc-node="33"]');
await page.click('#cascPanel .frow[data-casc-node="32"]');
await page.waitForTimeout(200);
await page.click('#cascPanel [data-casc-ok]');
await page.waitForTimeout(300);
s = await snap();
ok(s.chRegion.length === 1 && s.chRegion[0] === '32',
  '地域触发器的已选值同样以标签块展示（一行四列只留 1 个）', s.chRegion);
ok(s.moreRegion === '+1', '其余地域折叠为「+N」', s.moreRegion);
await page.click('#rgHome .tag .x');
await page.waitForTimeout(300);
s = await snap();
ok(s.chRegion.length === 1 && s.chRegion[0] === '33',
  '点地域标签上的 × → 只删掉第一个，另一项保留', s.chRegion);

console.log('\n【6】生效值随检索提交给后端');
await setGroup('industry', ['智能硬件', '新能源']);
await setGroup('type', ['稳岗']);
await setGroup('deadline', ['近 30 天']);
s = await snap();
ok(/行业：/.test(s.triggers[0] || '') && s.chIndustry.join('/') === '智能硬件',
  '行业多选回显（标签块 + 折叠）', s.triggers[0]);

await page.click('[data-go="search"]');
await page.waitForSelector('#pipeBar', { timeout: 15000 });
await page.waitForTimeout(800);
const body = searchBodies[searchBodies.length - 1] || {};
ok(searchBodies.length >= 1, '发起了 POST /api/v1/searches', searchBodies.length);
ok(body.industries === '智能硬件 / 新能源', '请求体带上行业（多选拼串）', body.industries);
ok(body.types === '稳岗', '请求体带上类型', body.types);
ok(body.deadline === '近 30 天', '请求体带上截止时间', body.deadline);
ok(Array.isArray(body.regions) && body.regions.length >= 1, 'regions 仍是数组（地域链路未受影响）', body.regions);
ok(body.regions.indexOf('浙江省') >= 0, '地域已选值确实进了请求体', body.regions);
/* 取消这次检索，后面的用例不依赖它 */
await page.click('[data-cancel]');
await page.waitForTimeout(400);

console.log('\n【7】游客出口：顶栏一步退出 → 回到闸门');
await page.click(OPEN_GUEST_EXIT);
await page.waitForTimeout(400);
ok(await page.locator('.auth-card').count() === 1, '点「退出」→ 回到登录闸门');
const guestFlag = await page.evaluate(() => {
  try { return sessionStorage.getItem('policy_agent_guest'); } catch (e) { return 'n/a'; }
});
ok(guestFlag === null, '游客身份已从 sessionStorage 撤销（不是只改了界面）', guestFlag);
const gateOpen = await page.evaluate(() => typeof AUTH !== 'undefined' && !!AUTH.gateOpen && AUTH.gateOpen());
ok(!gateOpen, '闸门重新关闭，必须再次二选一');
ok(await page.locator('.auth-card [data-auth-guest]').count() >= 1, '闸门回到了「登录 or 游客」的二选一形态');
await shot(page, '30-guest-exit');
/* 回到游客态，后续登录用例从干净状态开始 */
await page.click('.auth-card [data-auth-guest]');
await page.waitForSelector('#homeQ', { timeout: 15000 });

console.log('\n【8】登录：记住一次 → 刷新免登录；超期 → 自动退出');
const dbOk = await page.evaluate(async (base) => {
  try {
    const r = await fetch(base + '/api/v1/db/status');
    const j = await r.json();
    return !!(j && j.available);
  } catch (e) { return false; }
}, BASE);

if (!dbOk) {
  console.log('  ⚠ MySQL 未就绪，跳过「登录记忆 / 超期」两段（账号接口此时返回 503）');
} else {
  const uname = 'filt' + String(Date.now()).slice(-9);
  const reg = await page.evaluate(async ({ base, uname }) => {
    const r = await fetch(base + '/api/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: uname, password: 'Abc123456', displayName: '筛选自检' }),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, { base: BASE, uname });
  ok((reg.status === 200 || reg.status === 201) && reg.body && reg.body.token,
    '注册接口返回 token', reg.status);

  /* 走真实界面登录一次，让 AUTH 把凭证写进 localStorage */
  await page.evaluate(() => localStorage.clear());
  await page.evaluate(() => sessionStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#af_username', { timeout: 15000 });
  await page.fill('#af_username', uname);
  await page.fill('#af_password', 'Abc123456');
  await page.click('#authSubmit');
  await page.waitForSelector('.hist-list, .empty, #histQ', { timeout: 20000 });

  const rec = await page.evaluate(() => {
    const raw = localStorage.getItem('policy_agent_token');
    try { return JSON.parse(raw); } catch (e) { return { t: raw }; }
  });
  ok(!!rec && !!rec.t, '登录后本地凭证落盘');
  ok(rec && rec.d === 7, '凭证里记下了有效期 7 天（与服务端 AUTH_TOKEN_TTL_DAYS 一致）', rec && rec.d);
  ok(rec && typeof rec.at === 'number' && Date.now() - rec.at < 120000, '凭证里记下了签发时间');
  ok(await page.locator(OPEN_GUEST_EXIT).count() === 0, '登录后顶栏不再显示游客出口');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  const gateAfterReload = await page.locator('.auth-card').count();
  const authed = await page.evaluate(() => typeof AUTH !== 'undefined' && !!AUTH.authed && AUTH.authed());
  ok(gateAfterReload === 0 && authed, '刷新页面仍在登录态（「登录一次就记住」成立）');

  /* 把签发时间挪到 8 天前：模拟「超过一定时间」 */
  await page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem('policy_agent_token'));
    raw.at = Date.now() - 8 * 86400000;
    localStorage.setItem('policy_agent_token', JSON.stringify(raw));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.auth-card', { timeout: 15000 });
  const left = await page.evaluate(() => localStorage.getItem('policy_agent_token'));
  ok(left === null, '超期后本地凭证被丢弃（不是留着等 401）', left);
  const expiredToast = await page
    .waitForSelector('#toasts .toast', { timeout: 5000 })
    .then((h) => h.textContent())
    .then((t) => t.replace(/\s+/g, ' ').trim())
    .catch(() => '');
  ok(/保留满\s*7\s*天/.test(expiredToast), '给出「为什么又要登录」的明确提示', expiredToast);
  const stillAuthed = await page.evaluate(() => typeof AUTH !== 'undefined' && !!AUTH.authed && AUTH.authed());
  ok(!stillAuthed, '过期后不再是登录态，且闸门重新要求登录 / 游客二选一');
  await shot(page, '28-login-expired');
}

console.log('\n【9】面板搜索框：逐键输入不重复、中文组词不丢（打 1 下不许变 3 个）');
/* 回归点：面板每次 input 都整块 innerHTML 重绘 → 正在输入的 <input> 节点被换掉
    ① 中文输入法组词被中断（中文打不进去）；
    ② 按键的默认动作把字符往「新」输入框里再插一次（按一下 y 出来三个 y）。
   现在只重画列表 / 摘要，输入框节点原地不动；组词期间连列表都不重画。 */
await ensureHome(page);
await page.click('[data-opt-trigger="industry"]');
await page.waitForSelector('#optPanel', { timeout: 5000 });
await page.click('#optPanel [data-opt-clear]');
await page.waitForTimeout(150);
await page.evaluate(() => { document.querySelector('#optPanel #optQ').__probe = 'keep'; });
await page.type('#optPanel #optQ', 'yzy', { delay: 45 });
await page.waitForTimeout(250);
const optVal = await page.locator('#optPanel #optQ').inputValue();
ok(optVal === 'yzy', '选项面板：打 3 下就是 3 个字符（不重复插入）', optVal);
ok(await page.evaluate(() => !!document.querySelector('#optPanel #optQ').__probe),
  '按键后搜索框仍是同一个 DOM 节点（没被 innerHTML 换掉）');
await shot(page, '33-opt-search-typed');

await page.keyboard.press('Escape');
await page.waitForTimeout(150);
await page.click('#rgHome');
await page.waitForSelector('#cascPanel', { timeout: 5000 });
await page.type('#cascPanel #cascQ', 'zz', { delay: 45 });
await page.waitForTimeout(250);
const cascVal = await page.locator('#cascPanel #cascQ').inputValue();
ok(cascVal === 'zz', '地域面板：同样不重复插入', cascVal);

/* 中文组词：compositionstart → 带 isComposing 的 input（列表不许重画）→ compositionend（这时才过滤） */
const composed = await page.evaluate(() => {
  const inp = document.querySelector('#cascPanel #cascQ');
  const body = document.querySelector('#cascPanel .fpanel-body');
  const before = body.firstElementChild;
  inp.focus();
  inp.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
  inp.value = '杭州';
  const ev = new InputEvent('input', { bubbles: true });
  Object.defineProperty(ev, 'isComposing', { value: true });
  inp.dispatchEvent(ev);
  const untouched = body.firstElementChild === before;
  const midQuery = (typeof CASC_STATE !== 'undefined') ? CASC_STATE.query : null;
  inp.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
  return { untouched, midQuery, query: (typeof CASC_STATE !== 'undefined') ? CASC_STATE.query : null };
});
ok(composed.untouched && composed.midQuery !== '杭州',
  '输入法组词期间不重绘列表、也不动草稿（候选词不会被打断）', composed.midQuery);
ok(composed.query === '杭州', '候选词上屏（compositionend）后才真正过滤', composed.query);
/* Esc 在组词中属于「取消候选词」，不该顺手关面板 —— keydown 里已按 isComposing 让路 */
const escKept = await page.evaluate(() => {
  const inp = document.querySelector('#cascPanel #cascQ');
  const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
  Object.defineProperty(ev, 'isComposing', { value: true });
  inp.dispatchEvent(ev);
  return !!document.querySelector('#cascPanel');
});
ok(escKept, '组词中的 Esc 不会关掉面板（让输入法先吃掉）');
await page.click('#cascPanel [data-casc-clear]');
await page.fill('#cascPanel #cascQ', '');
await page.waitForTimeout(150);

console.log('\n【10】结果列表：地域只回显「当前这份结果的地域」，不能再选');
await page.click('#cascPanel .frow[data-casc-node="33"]');
await page.click('#cascPanel [data-casc-ok]');
await page.waitForTimeout(250);
/* 发起一次检索（随后立刻取消）。注意回显的口径是「**当前这份结果**是按什么地域检索出来的」
   —— 它跟随后端给的结果集元数据 list.regionsUsed，而不是「刚在筛选栏里选了什么」。
   这次检索被取消了、结果没落地，列表里躺着的仍是上一次的结果集，
   所以回显**不该**提前变成刚选的浙江省（否则就成了「列表还显示旧数据、说明却写着新条件」）。 */
await page.click('[data-go="search"]');
await page.waitForSelector('#pipeBar', { timeout: 15000 });
await page.waitForTimeout(900);
await page.click('[data-cancel]');
await page.waitForTimeout(400);

await page.click('[data-nav="list"]');
await page.waitForSelector('#rgListSlot', { timeout: 10000 });
const ro = await page.evaluate(() => {
  const slot = document.querySelector('#rgListSlot');
  const trig = slot && slot.querySelector('.trigger');
  return {
    readonly: !!trig && trig.classList.contains('readonly'),
    hasOpenAttr: !!slot.querySelector('[data-region-trigger]'),
    caret: !!slot.querySelector('.caret'),
    del: !!slot.querySelector('.tag .x'),
    clear: !!slot.querySelector('.clear-slot'),
    chips: Array.from(slot.querySelectorAll('.tag')).map((t) => t.textContent.trim()),
    hint: (document.querySelector('.fb-hint') || {}).textContent,
  };
});
ok(ro.readonly, '结果列表的地域是只读触发器（.trigger.readonly）');
ok(!ro.hasOpenAttr, '  且不挂 data-region-trigger（点了不会弹面板）');
ok(!ro.caret && !ro.del && !ro.clear, '  且没有 caret / × / 清空（不可改）', ro);
const used = await page.evaluate(
  () => (typeof DATA !== 'undefined' && DATA.list && DATA.list.regionsUsed) || []);
ok(used.length > 0 && ro.chips.join('/') === used.join('/'),
  '  回显 = 结果集的 list.regionsUsed（描述「这份结果是按什么地域检索的」）',
  { chips: ro.chips, used });
ok(ro.chips.indexOf('浙江省') < 0,
  '  检索还没落地时不会提前写成「刚选的筛选条件」（列表里还是上一次的结果）', ro.chips);
await page.click('#rgListSlot .trigger');
await page.waitForTimeout(300);
ok(await page.locator('#cascPanel').count() === 0, '点它不会再次打开地域面板');
ok(!/三级多选/.test(ro.hint || ''), '旁边的说明也改成「检索条件回显」口径', ro.hint);
await shot(page, '32-list-region-readonly');

/* 回首页把筛选改成别的地区，再回列表：回显必须纹丝不动 —— 它描述结果集，不是筛选栏 */
await page.click('[data-nav="home"]');
await page.waitForTimeout(300);
await page.click('#rgHome');
await page.waitForTimeout(300);
await page.click('#cascPanel .frow[data-casc-node="32"]');
await page.click('#cascPanel [data-casc-ok]');
await page.waitForTimeout(250);
await page.click('[data-nav="list"]');
await page.waitForSelector('#rgListSlot', { timeout: 10000 });
const chips2 = await page.evaluate(() => {
  const slot = document.querySelector('#rgListSlot');
  return Array.from(slot.querySelectorAll('.tag')).map((t) => t.textContent.trim());
});
ok(chips2.join('/') === used.join('/'),
  '  回首页改筛选 → 列表回显不变（跟的是结果集，不是筛选栏）', chips2);

/* ---------------------------------------------------------------
   地域草稿：面板里勾了但没点「确定」→ 关面板必须**明确废弃并还原**。
   以前是把草稿与已生效合并发给后端，于是随手点过的省份会静默生效，
   检索记录里出现「查询问的是杭州、地域却是西藏 + 新疆」这种自相矛盾的条目。
   --------------------------------------------------------------- */
console.log('\n【11】地域草稿未点「确定」→ 明确废弃，绝不静默生效');
await page.click('[data-nav="home"]');
await page.waitForTimeout(300);
const baseline = await page.evaluate(() => ({
  draft: CASCADE.draft.size, applied: CASCADE.applied.size,
}));
await page.click('#rgHome');
await page.waitForTimeout(350);
await page.click('#cascPanel .frow[data-casc-node="54"]');   // 54 = 西藏自治区
await page.waitForTimeout(220);
const mid = await page.evaluate(() => ({ draft: CASCADE.draft.size, applied: CASCADE.applied.size }));
ok(mid.draft === baseline.draft + 1 && mid.applied === baseline.applied,
  '面板里勾选只改草稿，已生效条件纹丝不动', `draft ${mid.draft} / applied ${mid.applied}`);
await page.keyboard.press('Escape');
await page.waitForTimeout(450);
const toastTxt = await page.locator('#toasts .toast').last().innerText().catch(() => '');
ok(toastTxt.indexOf('没点「确定」') >= 0, '关面板时明确提示「改动没确定、已还原」', toastTxt.trim());
const after = await page.evaluate(() => ({ draft: CASCADE.draft.size, applied: CASCADE.applied.size }));
ok(after.draft === baseline.draft && after.applied === baseline.applied,
  '草稿被还原：不会带进下一次检索', `draft ${after.draft} / applied ${after.applied}`);
ok((await page.locator('#rgHome').innerText()).indexOf('西藏') < 0,
  '触发器上不会出现没确定过的省份', await page.locator('#rgHome').innerText());

/* 真的发起一次检索：载荷里的地域必须**只有已生效的**那一个口径 */
const appliedNames = await page.evaluate(() => CASCADE.selectedNodes(false).map((n) => n.name));
await page.click('[data-go="search"]');
await page.waitForSelector('#pipeBar', { timeout: 15000 });
await page.waitForTimeout(700);
const sentRegions = (searchBodies[searchBodies.length - 1] || {}).regions || [];
ok(sentRegions.indexOf('西藏自治区') < 0,
  '检索载荷里没有「勾了没确定」的省份', JSON.stringify(sentRegions));
ok(sentRegions.join('/') === appliedNames.join('/'),
  '载荷地域 = 已生效地域（唯一口径，不再 draft ∪ applied）',
  `${sentRegions.join('/')} vs ${appliedNames.join('/')}`);
await page.click('[data-cancel]');
await page.waitForTimeout(300);

ok(errs.length === 0, '全程无 JS 报错', errs.slice(0, 3));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
await browser.close();
process.exit(fail ? 1 : 0);
