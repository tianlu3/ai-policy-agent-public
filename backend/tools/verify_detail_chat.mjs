/* 政策详情「看得懂 + 问得到」验收 —— 左栏自查清单 / 申报流程入口 / 原文快照弹层 / AI 对话
   =================================================================================
   用户的两条反馈驱动了这个脚本：
     ① 「政策详情里申请的相关条例不明确，用户没法直观地看到他想要申请的政策」
        → 申报条件变成**逐条自查清单**（可勾选 + 关键数字高亮），并补上
          「申报流程 / 申报入口」。本脚本【1】【2】盯这两块。
     ② 「把右栏做成一个大模型对话框，聊天记录存到 MySQL」
        → 右栏整块换成对话面板，原文快照收进弹层；登录后一问一答写 chat_messages。
          本脚本【3】盯弹层、【4】【5】盯游客对话、【6】盯登录落库 + 重进回读。

   用法：node tools/verify_detail_chat.mjs [url]      默认 http://127.0.0.1:8010（mock）
   对 8000（auto）也能跑：【5】的来源标签两种取值都接受（大模型回答 / 规则回答）。
*/
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(pathToFileURL(resolve(
  process.env.PW_WORKSPACE || 'C:/Users/22866/.workbuddy/binaries/node/workspace', 'noop.js'
)));
const pw = await import(pathToFileURL(require.resolve('playwright')).href);
const chromium = pw.chromium || (pw.default && pw.default.chromium);

const BASE = process.argv[2] || 'http://127.0.0.1:8010';
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
const shot = (n) => page.screenshot({ path: join(SHOTS, n + '.png'), fullPage: false }).catch(() => {});

/** 等助手答复：判据是「非 typing 的 ai 气泡条数 ≥ want」，不是「存在一个非 typing 的 ai」。
    后者会被上一轮已经渲染好的回答立刻命中 —— 等于没等，真实模型下必然踩空。 */
const waitAnswer = async (want) => {
  await page.waitForFunction(
    (n) => document.querySelectorAll('.cmsg.ai:not(.typing)').length >= n,
    want, { timeout: 180000 });
};
const aiCount = () => page.locator('.cmsg.ai:not(.typing)').count();

const enterGuest = async () => {
  const guest = page.locator('.auth-card [data-auth-guest]');
  if (await guest.count()) { await guest.first().click(); await wait(700); }
};
/** 跳到详情屏（本脚本聚焦详情屏本身，检索链路另有 verify_search_browser 覆盖） */
const openDetail = async () => {
  await page.evaluate(() => {
    const id = DATA.policies.items[0].id;
    go('detail', { policyId: id, target: DATA.detail.defaultTarget });
  });
  await wait(500);
};

await page.goto(BASE + '/', { waitUntil: 'load' });
await wait(1100);
await enterGuest();
await openDetail();
console.log('被测地址：' + BASE + '\n');

const COND = await page.evaluate(() => DATA.policies.items[0].conditionsFull.length);

/* ============================================================
   【1】左栏 · 申报条件 = 逐条自查清单
   ============================================================ */
console.log('【1】申报条件：逐条自查清单（用户反馈「条例不明确」的那块）');
ok(await page.locator('.clause').count() === COND,
  '条件条数 = 本条政策的 conditionsFull 条数', COND + ' 条');
ok(await page.locator('.clause-check .cbox').count() === COND,
  '每条都带一个自查勾选框（不是纯文本段落了）');
ok(await page.locator('.clause .cshort').count() === COND,
  '每条都有「短句摘要」做标题（长句退到副行，方便扫读）');
ok(await page.locator('.clause .cfull').count() === COND,
  '每条都保留完整原文条款（摘要不替代原文）');
ok(await page.locator('mark.kn').count() > 0,
  '关键数字被高亮（金额 / 年限 / 比例这类决定能不能申的数字）',
  (await page.locator('mark.kn').first().innerText().catch(() => '')));

let sum = await page.locator('#condSummary').innerText();
ok(/还没开始自查/.test(sum), '未勾选时摘要说「还没开始自查」', sum);
ok(await page.locator('[data-check-reset]').count() === 0, '未勾选时不显示「重新自查」按钮');

await page.locator('.clause-check').first().click();
await wait(220);
ok(await page.locator('.clause-check.on').count() === 1, '点一条 → 该条变「已满足」态');
ok(await page.locator('[data-check-reset]').count() === 1, '勾选后出现「重新自查」按钮');
sum = await page.locator('#condSummary').innerText();
ok(/已自查 1 \/ \d+ 条/.test(sum), '摘要同步成「已自查 1 / n 条」', sum);
await shot('chat-01-selfcheck');

await page.locator('.clause-check').first().click();
await wait(220);
ok(await page.locator('.clause-check.on').count() === 0, '再点一下 → 取消勾选（可反复自查）');

for (let i = 0; i < COND; i += 1) { await page.locator('.clause-check').nth(i).click(); await wait(120); }
sum = await page.locator('#condSummary').innerText();
ok(/条件全部满足/.test(sum), '全部勾满 → 摘要说「条件全部满足，可以准备材料了」', sum);
ok((await page.locator('.condhint').innerText()).includes('申报流程'),
  '勾满后提示「接着看下面的申报流程」');
await page.locator('[data-check-reset]').click();
await wait(220);
ok(await page.locator('.clause-check.on').count() === 0, '「重新自查」一键清空');

/* ============================================================
   【2】左栏 · 申报流程与申报入口
   ============================================================ */
console.log('\n【2】申报流程 / 申报入口：补上「满足条件之后去哪办」');
const STEPS = await page.evaluate(() => DATA.detail.steps.items.length);
const CHANS = await page.evaluate(() => DATA.detail.channel.items.length);
ok(await page.locator('.steplist li').count() === STEPS, '申报流程按模板渲染出每一步', STEPS + ' 步');
ok(await page.locator('.chlist .chrow').count() === CHANS, '申报入口逐条列出', CHANS + ' 条');
const stepTxt = await page.locator('.steplist').innerText();
ok(/对照条件自查/.test(stepTxt) && /资金拨付/.test(stepTxt), '流程首尾都在（自查 → 拨付）');
const chanTxt = await page.locator('.chlist').innerText();
ok(/线上申报/.test(chanTxt) && /线下窗口/.test(chanTxt), '入口区分线上 / 线下');
const issuer = await page.evaluate(() => DATA.policies.items[0].issuer);
ok(chanTxt.includes(issuer), '线下窗口写的是本条政策的发文机关（不是写死的地名）', issuer);
ok(/原文未收录/.test(chanTxt), '原文没有的信息明说「未收录」，不臆造联系方式');
await shot('chat-02-guidance');

/* ★ 滚动 = 详情页整页滚（.detail-body 是滚动容器），不是左右各滚各的：
   只让左栏自己滚的话，鼠标悬在右栏对话面板上时滚轮完全无效（右栏不是左栏的
   子元素，滚动链传不过去）—— 用户实拍「这几个都没往下滑」。
   还要防一个更隐蔽的回归：.fieldbox 自带 overflow:hidden，若被 flex 压扁，
   内容会在每个块内部被裁掉、且 scrollHeight == clientHeight 根本无物可滚。
   样例数据在 1440×900 下常常「刚好放得下」，量不出滚动路径 ——
   所以先把容器压矮逼出真溢出，量完再把样式摘掉，不影响后面几节。 */
const styleTag = await page.addStyleTag({ content: '#detailScroll{max-height:460px!important}' });
await wait(250);
const reach = await page.evaluate(() => {
  const b = document.getElementById('detailScroll');
  const m = document.querySelector('.detail-main');
  if (!b || !m) return null;
  const boxes = Array.from(m.querySelectorAll('.fieldbox'));
  const squeezed = boxes.filter((bx) => bx.scrollHeight - bx.clientHeight > 2).length;
  b.scrollTop = b.scrollHeight;
  const last = boxes[boxes.length - 1];
  const bb = b.getBoundingClientRect();
  const lb = last.getBoundingClientRect();
  const panel = document.querySelector('.chatpanel');
  return {
    overflowY: getComputedStyle(b).overflowY,
    need: b.scrollHeight - b.clientHeight,
    squeezed,
    blocks: boxes.length,
    over: Math.round(lb.bottom - bb.bottom),
    panelTopPinned: Math.round(panel.getBoundingClientRect().top),
    panelH: Math.round(panel.getBoundingClientRect().height),
  };
});
ok(reach && reach.overflowY === 'auto',
  '详情页是整页滚动容器（左右两栏一起滚，不是只有左栏）', reach && reach.overflowY);
ok(reach && reach.need > 0,
  '压矮后确实出现真溢出（量得出滚动距离，不是「正好塞满」的假阳性）',
  reach && ('需滚 ' + reach.need + 'px'));
ok(reach && reach.squeezed === 0,
  '没有任何一个块被 flex 压扁（压扁 = 内容在块内被裁 + 无物可滚，用户报过的原始 bug）',
  reach && ('被压扁 ' + reach.squeezed + ' 块'));
ok(reach && reach.blocks === 5, '左栏五块齐全：条件 / 流程 / 入口 / 材料 / 字段',
  reach && reach.blocks + ' 块');
ok(reach && reach.over <= 0,
  '滚到底后最后一块「政策字段」完整落在可视区内（没被裁掉）',
  reach && ('超出 ' + Math.max(0, reach.over) + 'px'));
ok(reach && reach.panelTopPinned > 0 && reach.panelTopPinned < 200 && reach.panelH > 300,
  '滚到底时对话面板仍钉在可视区顶部（sticky，不跟着内容滚走）',
  reach && ('面板 top=' + reach.panelTopPinned + 'px 高=' + reach.panelH + 'px'));
/* 鼠标悬在右栏上滚轮也要能滚整页（滚动链要通到公共父级） */
await page.mouse.move(1180, 300);
for (let i = 0; i < 4; i += 1) { await page.mouse.wheel(0, -240); await wait(60); }
const wheelBack = await page.evaluate(() =>
  Math.round(document.getElementById('detailScroll').scrollTop));
ok(wheelBack < reach.need,
  '悬在右栏对话面板上滚轮也能滚整页（向上滚回 ' + wheelBack + 'px）');
await styleTag.evaluate((el) => el.remove());
await wait(200);
await page.evaluate(() => { const b = document.getElementById('detailScroll'); if (b) b.scrollTop = 0; });

/* ============================================================
   【3】原文快照弹层（右栏让位给对话后，溯源仍要够得着）
   ============================================================ */
console.log('\n【3】原文快照：从右栏搬进「查看原文」弹层，溯源能力没丢');
ok(await page.locator('#snapDialog').count() === 1, '弹层常驻 DOM');
ok(await page.locator('#snapDialog').isHidden(), '默认收起（不占画面）');
await page.click('[data-snap-open]');
await wait(320);
ok(await page.locator('#snapDialog').isVisible(), '点「查看原文」→ 弹层打开');
ok(await page.locator('#snapDialog .snap').count() === 1, '弹层里有原文快照正文');
ok(await page.locator('#snapDialog .snap mark').count() > 0, '快照里的高亮仍在');
ok(await page.locator('#snapDialog .srclist li').count() >= 1, '多源溯源清单在');
ok(await page.locator('#snapDialog .disclaimer').count() === 1, '免责声明在');

/* ★ 快照必须跟「本条政策」走：曾经 detail.snapshot.text 全局共用结果集第一条的快照，
   打开节能政策却看到技改政策的「营业收入不低于 2000 万元」，与下方申报条件对不上。
   这里取当前政策的 p.snapshot（无则本条 conditionsFull[1]）前 10 个非空白字符，
   断言弹层正文里确实有它 —— 换任何一条政策打开都得对得上。 */
const snapConsist = await page.evaluate(() => {
  const p = DATA.policyById(APP.policyId);
  const raw = (typeof p.snapshot === 'string' && p.snapshot)
    ? p.snapshot.replace(/<\/?mark>/g, '')
    : (p.conditionsFull || [])[1] || (p.conditionsFull || [])[0] || '';
  const expect = raw.replace(/\s+/g, '').slice(0, 10);
  const txt = document.querySelector('#snapDialog .snap').textContent.replace(/\s+/g, '');
  return { expect, hit: txt.indexOf(expect) >= 0 };
});
ok(snapConsist.hit, '快照正文跟当前打开的政策走（不是结果集第一条的）', '应含「' + snapConsist.expect + '…」');

/* 「打开原文」必须是真的能点：真 <a>、真外链、新标签打开。 */
ok(await page.locator('#snapDialog .srclist a.btn-link[target="_blank"]').count() >= 1,
  '「打开原文」是真链接（<a target=_blank>，不再是死按钮）');
const snapHref = await page.locator('#snapDialog .srclist a.btn-link').first().getAttribute('href');
ok(/^https?:\/\//.test(snapHref || ''), '原文链接是合法外链', snapHref);
/* 用户要求直达原文页：数据源配了真实政策文件 URL，不该再落回「搜政策名」的兜底 */
ok(snapHref && !/baidu\.com/.test(snapHref), '直达官方原文（不再落回搜索兜底）', snapHref);

await shot('chat-03-snapshot-dialog');

await page.keyboard.press('Escape');
await wait(300);
ok(await page.locator('#snapDialog').isHidden(), 'Esc 关闭弹层');
await page.click('[data-snap-open]');
await wait(300);
await page.locator('.snapdlg-mask').click({ position: { x: 8, y: 8 } });
await wait(300);
ok(await page.locator('#snapDialog').isHidden(), '点遮罩也能关（Esc 与遮罩两条路都通）');

/* ============================================================
   【4】右栏 · 对话面板（游客）
   ============================================================ */
console.log('\n【4】右栏对话面板：空态 + 建议问题 + 游客提示');
ok(await page.locator('.chatpanel').count() === 1, '右栏是对话面板（原 .srcpanel 已不在）');
ok(await page.locator('.srcpanel').count() === 0, '原来的「原文快照」栏位已让位（不是两层叠着）');
ok((await page.locator('.chatpanel > header h3').innerText()).includes('问政策'),
  '面板标题是「问政策」');
ok(await page.locator('.chat-empty').count() === 1, '首次进来是空态');
const SUG = await page.evaluate(() => DATA.detail.chat.suggestions.length);
ok(await page.locator('.chat-sugs .sug').count() === SUG, '给出建议问题', SUG + ' 条');
ok(await page.locator('.cp-guest').count() === 1, '游客身份时显示「对话不会保存」提示条');
ok((await page.locator('.cp-guest').innerText()).includes('登录后可长期保留'),
  '提示条说清「登录后才保留」');
ok(await page.locator('[data-chat-clear]').count() === 0, '没有消息时不显示「清空对话」');
await shot('chat-04-empty');

/* ============================================================
   【5】发一条提问：真调后端 → 助手回复进气泡
   ============================================================ */
console.log('\n【5】提问链路：点建议问题 → 用户气泡 + 助手回答');
/* 挑「要交什么材料？」这类**能映到本条政策字段**的建议问题来点。
   用「我这种情况能不能申？」会踩到一个不稳定点：这句话没有上下文，真实模型
   合理地反问「请提供您的注册资本/营收…」—— 回答其实是从本条政策的条款里长出来的，
   但字面上既没有政策名也没有「条件 / 材料」这些词，断言会误报。 */
const sugList = await page.evaluate(() => DATA.detail.chat.suggestions.slice());
const sugIdx = Math.max(0, sugList.findIndex((s) => /材料/.test(s)));
note('点第 ' + (sugIdx + 1) + ' 个建议问题：' + sugList[sugIdx]);
await page.locator('.chat-sugs .sug').nth(sugIdx).click();
await waitAnswer(1);
await wait(400);
ok(await page.locator('.cmsg.me').count() === 1, '用户提问渲染成自己的气泡');
ok(await page.locator('.cmsg.ai').count() === 1, '助手回答渲染成对方气泡');
const askTxt = await page.locator('.cmsg.me .cm-body').innerText();
const ansTxt = await page.locator('.cmsg.ai .cm-body').innerText();
note('问：' + askTxt.replace(/\s+/g, ' ').slice(0, 40));
note('答：' + ansTxt.replace(/\s+/g, ' ').slice(0, 60));
ok(ansTxt.length > 20, '回答不是空壳（有实际内容）', ansTxt.length + ' 字');
const pname = await page.evaluate(() => DATA.policies.items[0].name);
/* 「回答紧扣本条政策」怎么判才稳？——**不能用关键词表**。
   实测真实模型答「需提交技改补贴申请表（加盖公章）、设备投资发票及审计报告复印件。」，
   这是本条政策 materials 的原样搬运，却既没有政策名也没有「材料 / 条件」这些词，
   关键词表会误报。改成**结构化重合**：把本条政策的各字段拼成「事实底座」，
   看回答与它有没有一段 ≥6 字的连续重合 —— 中文里 6 个字逐字连抄基本不可能是巧合，
   而模型本来就被要求逐字引用原文（提示词硬约束）。 */
const ground = await page.evaluate((ans) => {
  const ctx = policyChatContext(DATA.policyById(DATA.policies.items[0].id));
  const norm = (t) => String(t).replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
  const bag = norm(Object.values(ctx).flat().filter((v) => typeof v === 'string').join(''));
  const win = 6;
  const B = new Set();
  for (let i = 0; i + win <= bag.length; i += 1) B.add(bag.slice(i, i + win));
  const a = norm(ans);
  const hits = [];
  for (let i = 0; i + win <= a.length; i += 1) {
    const g = a.slice(i, i + win);
    if (B.has(g) && hits.indexOf(g) === -1) hits.push(g);
  }
  return { name: ctx.name, hits: hits.slice(0, 3), n: hits.length };
}, ansTxt);
ok(ground.n > 0 || ansTxt.includes(pname),
  '回答紧扣本条政策（与政策字段有 ≥6 字连续重合，是原文搬运不是套话）',
  ground.n ? ('命中「' + ground.hits.join('」/「') + '」') : '未命中');
const tagTxt = await page.locator('.cmsg.ai .cm-tag').first().innerText();
ok(/大模型回答|规则回答/.test(tagTxt),
  '助手气泡标明来源（大模型回答 / 规则回答 —— 降级不冒充模型）', tagTxt);
ok(await page.locator('.cm-tag.ghost').count() === 1,
  '游客这一条带「未保存」标记（后端确实没落库）',
  await page.locator('.cm-tag.ghost').first().innerText());
ok(await page.locator('.chat-empty').count() === 0, '有消息后空态消失');
ok(await page.locator('[data-chat-clear]').count() === 1, '有消息后出现「清空对话」');
await shot('chat-05-answered');

/* 输入框：打字期间不重建节点（否则中文输入法会被打断） */
await page.evaluate(() => { document.getElementById('chatQ').dataset.marker = 'm1'; });
await page.fill('#chatQ', '这家公司还能拿到多少补贴？');
await wait(200);
ok(await page.evaluate(() => document.getElementById('chatQ').dataset.marker === 'm1'),
  '在输入框打字不会重建节点（输入法安全）');
await page.locator('#chatQ').press('Enter');
await waitAnswer(2);
await wait(500);
ok(await page.locator('.cmsg.me').count() === 2, 'Enter 直接发送（不必点按钮）');
ok(await page.locator('.chat-empty').count() === 0, '第二轮对话继续追加');

/* 清空 */
await page.locator('[data-chat-clear]').click();
await wait(600);
ok(await page.locator('.cmsg').count() === 0, '「清空对话」把消息清掉');
ok(await page.locator('.chat-empty').count() === 1, '清空后回到空态');

/* ★ 清空必须作废「正在飞的那一问」。
   真实模型一轮十几秒，用户等不及点了清空；如果没有作废机制，迟到的回答会在
   清空之后把气泡又追加回来 —— 8000 实跑就抓到过这两条断言红。
   这里在页面内同一个 tick 里「先发再清」，确保清空一定早于回答落地。 */
await page.evaluate(() => {
  document.getElementById('chatQ').value = '清空时这条还在飞';
  chatSend();
  chatClear();
});
await wait(3000);
ok(await page.locator('.cmsg').count() === 0,
  '清空瞬间在飞的那一问，回答落地后也不会「复活」（迟到回答被丢弃）');
ok(await page.locator('.chat-empty').count() === 1, '清空后仍停在空态');

/* ============================================================
   【6】登录后：一问一答落 MySQL，重进详情能读回来
   ============================================================ */
console.log('\n【6】登录态：对话落库 + 重进详情回读');
const uname = 'chatgate' + Date.now().toString().slice(-8);
const cred = await page.evaluate(async (u) => {
  const j = (o) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
  await fetch('/api/v1/auth/register', j({ username: u, password: 'Passw0rd!2026', displayName: '对话闸门' }));
  const r = await (await fetch('/api/v1/auth/login', j({ username: u, password: 'Passw0rd!2026' }))).json();
  return { token: r.token || '', user: r.user || null };
}, uname);
ok(!!cred.token, '注册并登录成功（本次闸门账号）', uname);

await page.evaluate((c) => {
  /* 必须走 AUTH.write 落 localStorage —— 只改内存变量的话，下面 reload 就白写了。
     真实登录按钮走的就是这条路（见 screens-d.js 的登录成功分支）。 */
  AUTH.write(c.token);
  DATA.api.setToken(c.token);
  AUTH.token = c.token;
  AUTH.user = c.user;
  AUTH.status = 'ok';
  DETAIL_STATE.chat = {};        // 换身份后重来一遍，别沿用游客那段内存态
  DETAIL_STATE.checks = {};
}, cred);

await page.reload({ waitUntil: 'load' });
/* 等会话恢复完（bootstrap 会去 /auth/me 把 user 补上，authed() 才为真） */
await page.waitForFunction(() => typeof AUTH !== 'undefined' && AUTH.authed(), null,
  { timeout: 30000 });
await wait(400);
await openDetail();
ok(await page.locator('.cp-guest').count() === 0, '登录后不再显示游客提示条');

const q = '申报材料要准备哪些？';
await page.fill('#chatQ', q);
await page.locator('[data-chat-send]').click();
await waitAnswer(1);
await wait(500);
ok(await page.locator('.cm-tag.ghost').count() === 0,
  '登录后这条不再带「未保存」（后端已落库）');

/* 重进详情：历史应当从 MySQL 读回来 */
await page.evaluate(() => { DETAIL_STATE.chat = {}; });
await page.evaluate(() => go('list'));
await wait(400);
await openDetail();
await page.waitForSelector('.cmsg', { timeout: 30000 });
await wait(1200);
ok(await page.locator('.cmsg.me').count() >= 1, '重进详情 → 历史提问被读回来');
ok(await page.locator('.cmsg.ai').count() >= 1, '历史回答也在');
const backQ = await page.locator('.cmsg.me .cm-body').first().innerText();
ok(backQ.includes('申报材料'), '回读的正是刚才那句（内容对得上）', backQ.replace(/\s+/g, ' ').slice(0, 30));
await shot('chat-06-history');

const apiHistory = await page.evaluate(async () => {
  const r = await DATA.api.chatHistory(DATA.policies.items[0].id);
  return r.messages || [];
});
ok(apiHistory.length >= 2, '接口读到的历史 ≥ 2 条（一问一答成对）', apiHistory.length + ' 条');
ok(apiHistory[0].role === 'user' && apiHistory[1].role === 'assistant',
  '顺序是「先问后答」（正序返回，前端直接从上往下铺）');
ok(apiHistory.every((m) => m.policyId === apiHistory[0].policyId),
  '对话按政策隔离（policyId 一致）');

/* ---------- 「对话记录」页：按政策聚合的会话卡片 ----------
   用户反馈：对话按政策隔离，想看上次的问答得先找到那条政策，很不方便 ——
   所以检索记录屏加了「对话记录」页签，点卡片直接跳回那条政策的详情页接着聊。 */
console.log('\n【6b】对话记录页签：聚合卡片 + 点卡片回详情');
await page.evaluate(() => go('history'));
await wait(700);
ok(await page.locator('[data-hist-tab="chat"]').count() === 1, '检索记录屏出现「对话记录」页签');
await page.locator('[data-hist-tab="chat"]').click();
await page.waitForSelector('.thread-card', { timeout: 30000 });
await wait(400);
ok(await page.locator('.thread-card').count() >= 1, '页签里出现会话卡片（按政策聚合）');
const thName = await page.locator('.thread-card .hc-q').first().innerText();
ok(thName.includes(pname), '卡片写的是这条政策的名字（写入时的政策名快照）',
  thName.replace(/\s+/g, ' ').slice(0, 34));
const qaTxt = (await page.locator('.thread-card .hc-cond').first().innerText()).replace(/\s+/g, ' ');
ok(/1 次提问 · 2 条对话/.test(qaTxt), '卡片统计的是问答条数', qaTxt.trim());
const prevTxt = (await page.locator('.thread-card .hc-meta').first().innerText()).replace(/\s+/g, ' ');
ok(/最近提问/.test(prevTxt), '卡片带最后一句提问的预览', prevTxt.trim().slice(0, 34));
await page.locator('.thread-card').first().click();
await page.waitForSelector('.chatpanel', { timeout: 20000 });
await wait(600);
ok(/^detail:/.test(await page.evaluate(() => APP.screen + ':' + APP.policyId)),
  '点卡片 → 回到该政策的详情页');
await page.waitForSelector('.cmsg', { timeout: 30000 });
ok(await page.locator('.cmsg.me').count() >= 1, '详情页对话面板把这段历史带了回来');

/* 清空接口：真的把库里的删掉 */
await page.evaluate(() => DATA.api.chatClear(DATA.policies.items[0].id));
const after = await page.evaluate(async () => {
  const r = await DATA.api.chatHistory(DATA.policies.items[0].id);
  return (r.messages || []).length;
});
ok(after === 0, '清空后库里这条政策的对话为 0 条', String(after));

/* ============================================================
   【7】无 JS 运行时错误
   ============================================================ */
console.log('\n【7】运行时');
ok(errs.length === 0, '全程无 JS 运行时错误', errs.slice(0, 3).join(' | ') || '（无）');

console.log('\n断言 ' + pass + ' 项通过，' + fail + ' 项未通过' + (fail === 0 ? ' ✅' : ' ❌'));
console.log('截图见 backend/_shots/chat-*.png');
await browser.close();
process.exit(fail === 0 ? 0 : 1);
