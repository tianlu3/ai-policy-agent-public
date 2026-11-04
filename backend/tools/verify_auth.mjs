/* ============================================================
   账号体系 + 检索记录 契约验证（无需浏览器）
   ------------------------------------------------------------
   覆盖「注册 → 登录 → 检索落库 → 历史列表 → 结果回放 → 跨账号隔离
        → 删除 → 登出 → 失效凭证」的完整链路，并逐条断言接口契约。

   脚本是**幂等**的：同一个用户名重复执行会改为登录，
   因此可以直接对着开发库反复跑。
   用法：node tools/verify_auth.mjs [baseUrl]
   ============================================================ */

const BASE = (process.argv[2] || 'http://127.0.0.1:8000').replace(/\/$/, '');

let fail = 0;
let pass = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + label); } else {
    fail++;
    console.log('  ✗ ' + label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''));
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const section = (t) => console.log('\n【' + t + '】');

async function call(method, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}

/* ---------- 固定测试账号（幂等） ---------- */
const USER_A = { username: 'verify_auth_a', password: 'Verify2026', displayName: '契约校验甲' };
const USER_B = { username: 'verify_auth_b', password: 'Verify2026', displayName: '契约校验乙' };

async function ensureUser(u, extra = {}) {
  const reg = await call('POST', '/api/v1/auth/register', { body: { ...u, ...extra } });
  if (reg.status === 201) return { token: reg.data.token, created: true };
  if (reg.status === 409) {
    const login = await call('POST', '/api/v1/auth/login',
      { body: { username: u.username, password: u.password } });
    if (login.status !== 200) throw new Error('登录失败：' + JSON.stringify(login.data));
    return { token: login.data.token, created: false };
  }
  throw new Error('注册异常：HTTP ' + reg.status + ' ' + JSON.stringify(reg.data));
}

async function waitTask(token, taskId, ms = 300000) {
  const deadline = Date.now() + ms;
  let last = null;
  while (Date.now() < deadline) {
    const st = await call('GET', '/api/v1/searches/' + taskId, { token });
    last = st.data;
    if (!last || last.status !== 'running') return last;
    await sleep(250);
  }
  return last;
}

console.log('目标服务：' + BASE);

/* ============================================================ */
section('1 MySQL 接入状态');
const dbStatus = await call('GET', '/api/v1/db/status');
ok(dbStatus.status === 200, 'GET /api/v1/db/status 可访问', dbStatus.status);
ok(dbStatus.data.available === true, '数据库可用（连接池已建立）', dbStatus.data);
/* 驱动断言按引擎感知：MySQL 模式 = PyMySQL；SQLite 兜底模式 = sqlite3（免装 MySQL 的评审场景） */
const engine = dbStatus.data.engine || 'mysql';
ok(engine === 'sqlite' ? /sqlite3/.test(dbStatus.data.driver || '') : /pymysql/.test(dbStatus.data.driver || ''),
   engine === 'sqlite' ? '驱动为 sqlite3（兜底模式）' : '驱动为 PyMySQL', dbStatus.data.driver);
ok(dbStatus.data.ping === true, '真实探活 SELECT 1 通过');
['users', 'sessions', 'search_records'].forEach((t) => {
  ok((dbStatus.data.tables || []).includes(t), '数据表已建：' + t, dbStatus.data.tables);
});

/* 验证码通道：echo=回显（全链路断言）；email=真发（只做冒烟，测试邮件发真实收件箱防退回） */
/* email 通道冒烟收件箱：默认发件人自发自收（QQ 允许），绝不占用用户的真实邮箱
   —— 2286675123@qq.com 曾被测试账号抢绑，害得用户改绑 409，别再用它当默认值。 */
const TEST_EMAIL = process.env.TEST_EMAIL || 'tester@example.com';
const ECHO = (dbStatus.data.codeChannel || 'echo') !== 'email';
console.log(`[i] 验证码通道：${ECHO ? 'echo（回显，全链路断言）' : `email（真发，测试邮件 → ${TEST_EMAIL}）`}`);

/* ============================================================ */
section('2 游客（未登录）行为');
const guestMe = await call('GET', '/api/v1/auth/me');
ok(guestMe.status === 401, '未带凭证取 /auth/me → 401', guestMe.status);
ok(guestMe.data?.error?.code === 'UNAUTHORIZED', '错误体为 {error:{code,message}}', guestMe.data);
const guestHist = await call('GET', '/api/v1/history');
ok(guestHist.status === 401, '未带凭证取 /history → 401', guestHist.status);
const badToken = await call('GET', '/api/v1/auth/me', { token: 'not-a-real-token' });
ok(badToken.status === 401, '伪造 Token → 401', badToken.status);

/* ============================================================ */
section('3 注册 / 登录');
const a = await ensureUser(USER_A, {
  email: 'verify_auth_a@example.com', company: '杭州智造科技有限公司',
  industry: '智能硬件', regionCode: '330100', regionName: '杭州市',
});
ok(!!a.token, a.created ? '注册成功并直接下发 Token' : '账号已存在，改为登录成功');
let tokenA = a.token;

const dup = await call('POST', '/api/v1/auth/register', { body: USER_A });
ok(dup.status === 409 && dup.data?.error?.code === 'CONFLICT', '重复用户名注册 → 409 CONFLICT', dup.data);

const badPwd = await call('POST', '/api/v1/auth/login',
  { body: { username: USER_A.username, password: 'definitely-wrong' } });
ok(badPwd.status === 401 && badPwd.data?.error?.code === 'BAD_CREDENTIALS',
  '错误密码 → 401 BAD_CREDENTIALS', badPwd.data);

const weak = await call('POST', '/api/v1/auth/register',
  { body: { username: 'verify_weak_user', password: '12345678', displayName: '弱密码' } });
ok(weak.status === 400 && weak.data?.error?.code === 'VALIDATION_ERROR',
  '纯数字密码被拒 → 400 VALIDATION_ERROR', weak.data);

const meRes = await call('GET', '/api/v1/auth/me', { token: tokenA });
ok(meRes.status === 200, '带 Token 取 /auth/me → 200');
ok(meRes.data.user?.username === USER_A.username, '/auth/me 返回当前用户', meRes.data.user?.username);
ok(meRes.data.user?.regionName === '杭州市', '注册时写入的企业档案已带出', meRes.data.user?.regionName);
ok(meRes.data.user?.passwordHash === undefined && JSON.stringify(meRes.data).indexOf('pbkdf2') < 0,
  '响应体不含任何口令哈希');
ok(meRes.data.stats && typeof meRes.data.stats.searches === 'number', '/auth/me 带我的统计');
ok('latest' in meRes.data, '/auth/me 带「最近一次检索」字段（供首屏回放）');

const patch = await call('PATCH', '/api/v1/auth/profile',
  { token: tokenA, body: { company: '杭州智造科技有限公司（已更新）', industry: '智能硬件 / 软件信息' } });
ok(patch.status === 200 && /已更新/.test(patch.data.user.company), 'PATCH /auth/profile 更新档案生效');

/* 档案支持邮箱/手机号：已绑邮箱的变更需验证码（echo 回显），手机号归一化照旧 */
const dupEmail = `verify_auth_dup_${Date.now() % 100000}@example.com`;
if (ECHO) {
  const bindA = await call('POST', '/api/v1/auth/profile/email-code',
    { token: tokenA, body: { email: dupEmail } });
  ok(bindA.status === 200 && /^\d{6}$/.test(bindA.data?.code || ''),
    '发绑定验证码（echo 回显）', bindA.data);
  const pfOk = await call('PATCH', '/api/v1/auth/profile',
    { token: tokenA, body: { email: dupEmail, emailCode: bindA.data?.code, phone: '138 0013-8000' } });
  ok(pfOk.status === 200 && pfOk.data.user?.email === dupEmail, 'PATCH 档案修改邮箱（带验证码）', pfOk.data);
  ok(pfOk.data.user?.phone === '13800138000', '手机号去空格/横线归一化', pfOk.data.user?.phone);
} else {
  /* email 通道验证码不回显，换绑链路无法自动断言；手机号不涉及验证码，照常断言 */
  const pfPhone = await call('PATCH', '/api/v1/auth/profile',
    { token: tokenA, body: { phone: '138 0013-8000' } });
  ok(pfPhone.status === 200 && pfPhone.data.user?.phone === '13800138000',
    '手机号去空格/横线归一化（email 通道跳过邮箱换绑断言）', pfPhone.data.user?.phone);
}
const pfBadEmail = await call('PATCH', '/api/v1/auth/profile',
  { token: tokenA, body: { email: 'not-an-email' } });
ok(pfBadEmail.status === 400, '非法邮箱 → 400', pfBadEmail.status);
const pfBadPhone = await call('PATCH', '/api/v1/auth/profile',
  { token: tokenA, body: { phone: 'abc123' } });
ok(pfBadPhone.status === 400, '非法手机号 → 400', pfBadPhone.status);

/* ============================================================ */
section('4 登录状态下发起检索 → 自动落库');
const before = await call('GET', '/api/v1/history', { token: tokenA });
const beforeTotal = before.data.total;

const start = await call('POST', '/api/v1/searches', {
  token: tokenA,
  body: {
    query: '我是杭州做智能硬件的，能申什么补贴',
    regions: ['浙江省', '杭州市'],
    industries: '智能硬件',
    types: '补贴',
    deadline: '近 90 天',
  },
});
ok(start.status === 202, 'POST /api/v1/searches → 202', start.status);
ok(start.data.signedIn === true, '任务已识别为登录用户（signedIn=true）', start.data.signedIn);
const taskId = start.data.taskId;

const final = await waitTask(tokenA, taskId);
ok(final?.status === 'succeeded', '任务执行成功', final?.status);
ok(typeof final?.recordId === 'number' && final.recordId > 0,
  '任务状态里带回落库记录号 recordId', final?.recordId);

const result = await call('GET', `/api/v1/searches/${taskId}/result`, { token: tokenA });
ok(result.status === 200, '取检索结果 → 200');
ok(result.data.recordId > 0, '结果体同样带 recordId');
const ns = Object.keys(result.data.bootstrap || {});
['policies', 'list', 'detail', 'brief', 'search'].forEach((k) => {
  ok(ns.includes(k), '结果包装仍为七命名空间子集：' + k, ns.join(','));
});
['degrade', 'tasks', 'subscribe'].forEach((k) => {
  ok(!ns.includes(k), '已删屏的命名空间不再回灌：' + k);
});

/* ============================================================ */
section('5 检索记录：列表 / 回放 / 隔离 / 删除');
const after = await call('GET', '/api/v1/history', { token: tokenA });
ok(after.status === 200, 'GET /api/v1/history → 200');
ok(after.data.total === beforeTotal + 1, '历史条数 +1（本次检索已落库）', after.data.total);
const rec = (after.data.items || [])[0];
ok(!!rec, '历史列表非空');
ok(rec.id === final.recordId, '列表首条即本次记录（按 id 倒序）', rec.id);
ok(rec.query === '我是杭州做智能硬件的，能申什么补贴', '条件里的问句已存库', rec.query);
ok(Array.isArray(rec.regions) && rec.regions.length === 2, '地域条件以数组存库', rec.regions);
ok(rec.status === 'succeeded' && rec.itemCount > 0, '列表项带状态与条数', rec.status);
ok(rec.summary && rec.summary.length > 4, '列表项带一句话口径', rec.summary);
ok(rec.bootstrap === undefined, '列表接口**不**返回结果大对象（保持轻量）');
ok(!JSON.stringify(rec).includes('"resultJson"'), '列表接口不泄露 result_json 字段');

const detail = await call('GET', '/api/v1/history/' + rec.id, { token: tokenA });
ok(detail.status === 200, 'GET /api/v1/history/{id} → 200');
ok(detail.data.record?.id === rec.id, '返回对应记录');
const boot = detail.data.bootstrap || {};
const items = (boot.policies && boot.policies.items) || [];
ok(items.length === rec.itemCount, '回放结果条数与记录一致（同一次结果快照）', [items.length, rec.itemCount]);
ok(items.length > 0 && !!items[0].name && !!items[0].issuer, '回放结果字段完整（可直接渲染列表页）');
ok(!!(boot.list && boot.list.head && boot.list.head.meta), '回放含列表口径 meta', boot.list?.head?.meta);

const missing = await call('GET', '/api/v1/history/99999999', { token: tokenA });
ok(missing.status === 404 && missing.data?.error?.code === 'RECORD_NOT_FOUND',
  '不存在的记录号 → 404 RECORD_NOT_FOUND', missing.data);

/* 跨账号隔离：乙不能读甲记录 */
const b = await ensureUser(USER_B);
const tokenB = b.token;
const cross = await call('GET', '/api/v1/history/' + rec.id, { token: tokenB });
ok(cross.status === 404, '另一个账号读取他人记录 → 404（按 user_id 隔离）', cross.status);
const bHist = await call('GET', '/api/v1/history', { token: tokenB });
ok(bHist.data.items.every((x) => x.id !== rec.id), '乙的历史列表中看不到甲的记录');

/* 游客检索不落库 */
const guestStart = await call('POST', '/api/v1/searches', {
  body: { query: '游客身份检索一次', regions: ['浙江省'] },
});
ok(guestStart.status === 202 && guestStart.data.signedIn === false, '游客检索任务 signedIn=false');
const guestFinal = await waitTask(null, guestStart.data.taskId);
ok(guestFinal?.status === 'succeeded', '游客检索照常成功（主链路不受账号体系影响）');
ok(guestFinal?.recordId === null, '游客检索不产生落库记录（recordId=null）', guestFinal?.recordId);
const afterGuest = await call('GET', '/api/v1/history', { token: tokenA });
ok(afterGuest.data.total === after.data.total, '游客检索未污染登录用户的历史');

/* 删除 */
const del = await call('DELETE', '/api/v1/history/' + rec.id, { token: tokenA });
ok(del.status === 200 && del.data.ok === true, 'DELETE /api/v1/history/{id} → 200');
const delAgain = await call('DELETE', '/api/v1/history/' + rec.id, { token: tokenA });
ok(delAgain.status === 404, '重复删除同一条 → 404');
const afterDel = await call('GET', '/api/v1/history', { token: tokenA });
ok(afterDel.data.total === beforeTotal, '删除后条数回到检索前', afterDel.data.total);

/* ============================================================ */
section('6 检索记录的「地域」= 该次检索实际生效的地域');
/* 筛选栏没选（regions 为空）时，生效地域取自查询文本（「杭州」→ 杭州市）——
   记录里必须存它，而不是存成空（历史卡片会显示成「全国（不限）」，与实际不符）。 */
const noFilter = await call('POST', '/api/v1/searches', {
  token: tokenA,
  body: { query: '我是杭州做智能硬件的，能申什么补贴', regions: [], industries: '智能硬件', types: '补贴' },
});
ok(noFilter.status === 202, '未选筛选栏时也能发起检索 → 202', noFilter.status);
const nfFinal = await waitTask(tokenA, noFilter.data.taskId);
ok(nfFinal?.status === 'succeeded', '该次检索成功', nfFinal?.status);
const nfHist = await call('GET', '/api/v1/history', { token: tokenA });
const nfRec = (nfHist.data.items || [])[0];
ok(Array.isArray(nfRec?.regions) && nfRec.regions.indexOf('杭州市') >= 0,
  '筛选栏为空时，记录里的地域 = 从查询文本识别到的杭州市', nfRec?.regions);
ok((nfRec?.regions || []).indexOf('全国（不限）') < 0, '不再落成「全国（不限）」这种空口径');
await call('DELETE', '/api/v1/history/' + (nfRec?.id ?? 0), { token: tokenA });

/* ============================================================ */
section('7 登出与会话失效');
const me2 = await call('GET', '/api/v1/auth/me', { token: tokenA });
ok(me2.status === 200, '登出前凭证有效');
const out = await call('POST', '/api/v1/auth/logout', { token: tokenA });
ok(out.status === 200 && out.data.removed === true, 'POST /api/v1/auth/logout → 会话已删除');
const afterOut = await call('GET', '/api/v1/auth/me', { token: tokenA });
ok(afterOut.status === 401, '登出后原 Token 立即失效 → 401', afterOut.status);
const histOut = await call('GET', '/api/v1/history', { token: tokenA });
ok(histOut.status === 401, '登出后历史接口同样不可访问 → 401');

/* 乙仍在线，互不影响 */
const meB = await call('GET', '/api/v1/auth/me', { token: tokenB });
ok(meB.status === 200, '登出甲不影响乙的会话（会话按 Token 独立）');

/* 登录仍可拿回数据 */
const relogin = await call('POST', '/api/v1/auth/login',
  { body: { username: USER_A.username, password: USER_A.password } });
ok(relogin.status === 200 && !!relogin.data.token, '重新登录成功（企业档案仍在）');
tokenA = relogin.data.token;   // 旧 Token 已登出，档案收尾用新 Token
ok(relogin.data.user.regionName === '杭州市', '重新登录后档案随账号带出', relogin.data.user.regionName);

/* 邮箱唯一性：乙抢绑甲的邮箱 → 409（占用校验先于验证码）；甲清空邮箱需向当前邮箱验证 */
if (ECHO) {
  const pfDup = await call('PATCH', '/api/v1/auth/profile',
    { token: tokenB, body: { email: dupEmail } });
  ok(pfDup.status === 409, '邮箱被其他账号绑定 → 409', pfDup.data);
  /* 清空绑定的码发往当前绑定邮箱（= dupEmail），与上面换绑的码同键 (user_id, email)，
     撞 60s 冷却时轮询等它过期 —— 网关快慢都要稳定绿。 */
  let clrA = null;
  for (let i = 0; i < 30; i++) {
    clrA = await call('POST', '/api/v1/auth/profile/email-code',
      { token: tokenA, body: { email: dupEmail } });
    if (clrA.status === 200 || clrA.data?.error?.code !== 'EMAIL_CODE_COOLDOWN') break;
    if (i === 0) console.log('[i] 撞 60s 冷却，每 3s 轮询等过期…');
    await new Promise((r) => setTimeout(r, 3000));
  }
  ok(clrA.status === 200 && /^\d{6}$/.test(clrA.data?.code || ''),
    '发清空绑定用验证码（发往当前绑定邮箱）', clrA.data);
  const pfClear = await call('PATCH', '/api/v1/auth/profile',
    { token: tokenA, body: { email: '', emailCode: clrA.data?.code, phone: '' } });
  ok(pfClear.status === 200 && pfClear.data.user?.email === null && pfClear.data.user?.phone === null,
    '验证码通过后清空邮箱/手机号 → 置空', pfClear.data);
} else {
  const pfClearPhone = await call('PATCH', '/api/v1/auth/profile',
    { token: tokenA, body: { phone: '' } });
  ok(pfClearPhone.status === 200 && pfClearPhone.data.user?.phone === null,
    '清空手机号 → 置空', pfClearPhone.data);
  console.log('[i] email 通道：邮箱换绑/清空需真实验证码，已跳过自动断言');
}

/* ============================================================ */
section('8 忘记密码：验证码重置（原型直接回传验证码）');
const FR = ECHO
  ? { username: 'verify_auth_reset', password: 'Reset2026', displayName: '契约校验丙',
      email: 'verify_auth_reset@example.com' }
  : { username: 'verify_auth_reset_live', password: 'Reset2026', displayName: '契约校验丙',
      email: TEST_EMAIL };   // email 通道：验证码真发到测试收件箱，不退回
await ensureUser(FR);
const frLogin = await call('POST', '/api/v1/auth/login',
  { body: { username: FR.username, password: FR.password } });
ok(frLogin.status === 200, '重置流程前置：临时账号可登录');

const fEmpty = await call('POST', '/api/v1/auth/forgot', { body: { account: '' } });
ok(fEmpty.status === 400, '空账号 → 400', fEmpty.status);
const fUnknown = await call('POST', '/api/v1/auth/forgot',
  { body: { account: 'no_such_user_xyz' } });
ok(fUnknown.status === 400 && fUnknown.data?.error?.code === 'USER_NOT_FOUND',
  '不存在的账号 → 400 USER_NOT_FOUND', fUnknown.data);

const fOk = await call('POST', '/api/v1/auth/forgot', { body: { account: FR.username } });
/* 通道自适应：echo 回显 code 可断言全链路；email 真发只回脱敏地址，重置链路无法自动断言 */
const echoMode = fOk.data?.channel !== 'email';
ok(fOk.status === 200 && (echoMode ? /^\d{6}$/.test(fOk.data?.code || '') : !!fOk.data?.sentTo),
  `下发验证码 → 200（${echoMode ? "echo 回显" : `email 真发 → ${fOk.data?.sentTo}`}）`, fOk.data);
ok(fOk.data?.expiresIn === 300, '验证码有效期 300s', fOk.data?.expiresIn);
const fAgain = await call('POST', '/api/v1/auth/forgot', { body: { account: FR.username } });
ok(fAgain.status === 400 && fAgain.data?.error?.code === 'CODE_COOLDOWN',
  '冷却期内重发 → 400 CODE_COOLDOWN', fAgain.data);

if (echoMode) {
  const wrongCode = fOk.data.code === '000000' ? '111111' : '000000';
  const rWrong = await call('POST', '/api/v1/auth/reset',
    { body: { account: FR.username, code: wrongCode, password: 'NewPass2026' } });
  ok(rWrong.status === 400 && rWrong.data?.error?.code === 'CODE_MISMATCH',
    '错误验证码 → 400 CODE_MISMATCH', rWrong.data);
  const rWeak = await call('POST', '/api/v1/auth/reset',
    { body: { account: FR.username, code: fOk.data.code, password: '123' } });
  ok(rWeak.status === 400, '弱密码 → 400', rWeak.status);
  const rOk = await call('POST', '/api/v1/auth/reset',
    { body: { account: FR.username, code: fOk.data.code, password: 'NewPass2026' } });
  ok(rOk.status === 200 && rOk.data?.reset === true, '正确验证码 → 重置成功', rOk.data);

  const rReuse = await call('POST', '/api/v1/auth/reset',
    { body: { account: FR.username, code: fOk.data.code, password: 'Another2026' } });
  ok(rReuse.status === 400, '验证码一次性（复用 → 400）', rReuse.status);
  const oldIn = await call('POST', '/api/v1/auth/login',
    { body: { username: FR.username, password: FR.password } });
  ok(oldIn.status === 401, '旧密码登录 → 401', oldIn.status);
  const newIn = await call('POST', '/api/v1/auth/login',
    { body: { username: FR.username, password: 'NewPass2026' } });
  ok(newIn.status === 200 && !!newIn.data.token, '新密码登录成功');
  const meOld = await call('GET', '/api/v1/auth/me', { token: frLogin.data?.token });
  ok(meOld.status === 401, '重置后既有会话全部作废 → 401', meOld.status);

  /* 用邮箱作为账号再走一遍（独立冷却键），并把密码改回原值保持脚本幂等 */
  const fBack = await call('POST', '/api/v1/auth/forgot',
    { body: { account: FR.email } });
  ok(fBack.status === 200 && /^\d{6}$/.test(fBack.data?.code || ''),
    '邮箱账号同样可下发验证码', fBack.data);
  const rBack = await call('POST', '/api/v1/auth/reset',
    { body: { account: fBack.data?.account, code: fBack.data?.code, password: FR.password } });
  ok(rBack.status === 200, '按邮箱通道重置回原密码（脚本保持幂等）', rBack.data);
  const backIn = await call('POST', '/api/v1/auth/login',
    { body: { username: FR.username, password: FR.password } });
  ok(backIn.status === 200, '恢复原密码后可正常登录');
} else {
  console.log('[i] email 通道：验证码不回显，跳过重置链路自动断言（回归请以 CODE_CHANNEL=echo 启动后端）');
  const fEmail = await call('POST', '/api/v1/auth/forgot', { body: { account: FR.email } });
  ok(fEmail.status === 200 && fEmail.data?.channel === 'email' && !!fEmail.data?.sentTo,
    'email 通道：邮箱账号同样下发（响应只含脱敏地址，不含验证码）', fEmail.data);
  if (fEmail.status === 200) ok(/\*\*\*/.test(fEmail.data.sentTo || '') && !new RegExp(FR.email).test(fEmail.data.sentTo || ''),
    '收件地址已脱敏（不出现完整邮箱）', fEmail.data.sentTo);
}

console.log("\n[9] 修改密码 + 更换绑定邮箱（echo 全链路；email 仅冒烟）");
const PCU = Date.now().toString(36);   // 每次运行唯一，避免上次的绑定邮箱残留影响幂等
const PC = { username: `gate_pwd_${PCU}`, password: 'OldPass2026', password2: 'OldPass2026',
             displayName: '闸门改密', email: '' };
await ensureUser(PC);
const pcLogin = await call('POST', '/api/v1/auth/login',
  { body: { username: PC.username, password: PC.password } });
ok(pcLogin.status === 200, '改密流程前置：临时账号可登录');
const pcLogin2 = await call('POST', '/api/v1/auth/login',
  { body: { username: PC.username, password: PC.password } });

const pwWrong = await call('POST', '/api/v1/auth/password',
  { token: pcLogin.data.token, body: { oldPassword: 'WrongOld123', newPassword: 'NewPass2026' } });
ok(pwWrong.status === 401 && pwWrong.data?.error?.code === 'BAD_CREDENTIALS',
  '旧密码错误 → 401 BAD_CREDENTIALS', pwWrong.data);
const pwWeak = await call('POST', '/api/v1/auth/password',
  { token: pcLogin.data.token, body: { oldPassword: PC.password, newPassword: '123' } });
ok(pwWeak.status === 400, '新密码过弱 → 400', pwWeak.status);
const pwOk = await call('POST', '/api/v1/auth/password',
  { token: pcLogin.data.token, body: { oldPassword: PC.password, newPassword: 'NewPass2026' } });
ok(pwOk.status === 200 && pwOk.data?.changed === true, '修改密码成功', pwOk.data);
const meCur = await call('GET', '/api/v1/auth/me', { token: pcLogin.data.token });
ok(meCur.status === 200, '当前会话保留 → me 200', meCur.status);
const meOther = await call('GET', '/api/v1/auth/me', { token: pcLogin2.data?.token });
ok(meOther.status === 401, '其他会话被踢 → 401', meOther.status);
const pcNewIn = await call('POST', '/api/v1/auth/login',
  { body: { username: PC.username, password: 'NewPass2026' } });
ok(pcNewIn.status === 200, '新密码可登录');
await call('POST', '/api/v1/auth/password',
  { token: pcLogin.data.token, body: { oldPassword: 'NewPass2026', newPassword: PC.password } });

/* --- 更换绑定邮箱：首次绑定免码 → 变更需码（email 通道验证码不回显，跳过） --- */
if (ECHO) {
  const B1 = `gate_bind_old_${PCU}@example.com`, B2 = `gate_bind_new_${PCU}@example.com`;
  const bindFirst = await call('PATCH', '/api/v1/auth/profile',
    { token: pcLogin.data.token, body: { email: B1 } });
  ok(bindFirst.status === 200 && bindFirst.data?.user?.email === B1,
    '首次绑定邮箱免验证码 → 200', bindFirst.data?.user?.email);
  const bindNoCode = await call('PATCH', '/api/v1/auth/profile',
    { token: pcLogin.data.token, body: { email: B2 } });
  ok(bindNoCode.status === 400 && bindNoCode.data?.error?.code === 'EMAIL_CODE_REQUIRED',
    '已绑定改邮箱且无验证码 → 400 EMAIL_CODE_REQUIRED', bindNoCode.data);
  const bc = await call('POST', '/api/v1/auth/profile/email-code',
    { token: pcLogin.data.token, body: { email: B2 } });
  ok(bc.status === 200 && /^\d{6}$/.test(bc.data?.code || ''),
    '发绑定验证码 → 200（echo 回显）', bc.data);
  const bcAgain = await call('POST', '/api/v1/auth/profile/email-code',
    { token: pcLogin.data.token, body: { email: B2 } });
  ok(bcAgain.status === 400 && bcAgain.data?.error?.code === 'EMAIL_CODE_COOLDOWN',
    '发码冷却 → 400 EMAIL_CODE_COOLDOWN', bcAgain.data);
  const bindWrong = await call('PATCH', '/api/v1/auth/profile',
    { token: pcLogin.data.token,
      body: { email: B2, emailCode: bc.data.code === '000000' ? '111111' : '000000' } });
  ok(bindWrong.status === 400 && bindWrong.data?.error?.code === 'EMAIL_CODE_MISMATCH',
    '绑定验证码错误 → 400 EMAIL_CODE_MISMATCH', bindWrong.data);
  const bindOk = await call('PATCH', '/api/v1/auth/profile',
    { token: pcLogin.data.token, body: { email: B2, emailCode: bc.data.code } });
  ok(bindOk.status === 200 && bindOk.data?.user?.email === B2,
    '验证码正确 → 换绑成功', bindOk.data?.user?.email);
  const bindEmailLogin = await call('POST', '/api/v1/auth/login',
    { body: { username: B2, password: PC.password } });
  ok(bindEmailLogin.status === 200, '新邮箱可作登录名');
  const bindDup = await call('PATCH', '/api/v1/auth/profile',
    { token: pcLogin.data.token, body: { email: FR.email } });
  ok(bindDup.status === 409, '绑定他人已占用的邮箱 → 409', bindDup.status);
} else {
  console.log('[i] email 通道：绑定验证码不回显，跳过换绑链路断言（回归请以 CODE_CHANNEL=echo 启动后端）');
}

console.log(`\n断言 ${pass} 项通过${fail ? `，${fail} 项未通过 ❌` : '，全部通过 ✅'}`);
process.exit(fail === 0 ? 0 : 1);
