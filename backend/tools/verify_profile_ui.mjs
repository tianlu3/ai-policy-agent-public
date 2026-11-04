/* ============================================================
   档案页交互验收（对 8010 mock 跑）：
     【A】账号安全区块默认收起 → 点「修改密码」才展开三个密码框
     【B】已绑邮箱的验证码行默认收起 → 点「修改邮箱」才展开
     【C】展开后的验证码行能真实走通「发送验证码」（echo 回显）
     【D】档案卡内容超高时 .auth-card 自己滚（.screen 定高的老规矩）
   用法：node tools/verify_profile_ui.mjs [url]   默认 http://127.0.0.1:8010
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

/* 后端准备：注册专用账号并直接绑邮箱/填长档案（保证卡片内容超高、已绑态可验） */
const U = {
  username: `profile_ui_${Date.now() % 1000000}`,
  password: 'Profile2026', displayName: '档案验收',
};
const reg = await fetch(BASE + '/api/v1/auth/register', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(U),
});
if (reg.status !== 201 && reg.status !== 409) {
  console.log('准备账号失败：HTTP ' + reg.status); process.exit(1);
}
const login = await fetch(BASE + '/api/v1/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: U.username, password: U.password }),
});
const token = (await login.json()).token;
const boundEmail = `${U.username}@example.com`;
const longCompany = '杭州智造科技有限公司'.repeat(6);
await fetch(BASE + '/api/v1/auth/profile', {
  method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
  body: JSON.stringify({ email: boundEmail, company: longCompany, industry: '智能硬件 / 软件信息' }),
});

const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const wait = (ms) => page.waitForTimeout(ms);
const shown = (id) => page.evaluate((sel) => {
  const el = document.getElementById(sel);
  return el ? el.style.display !== 'none' && el.offsetParent !== null : null;
}, id);

await page.goto(BASE + '/', { waitUntil: 'load' });
await wait(1100);
await page.locator('#af_username').fill(U.username);
await page.locator('#af_password').fill(U.password);
await page.locator('#authSubmit').click();
await wait(1200);
await page.locator('.tb-user').first().click();
await page.waitForSelector('#pf_displayName', { timeout: 10000 });
ok(true, '登录后进入账号屏（档案表单已渲染）');

/* ---------- 【A】账号安全默认收起，点「修改密码」展开 ---------- */
console.log('【A】账号安全 · 点击后展开');
ok(await shown('pfPwdGrid') === false, '密码三联框默认隐藏');
ok(await shown('pfPwdActs') === false, '「修改密码」提交按钮默认隐藏');
ok(await page.locator('[data-pwd-edit]').count() === 1, '「修改密码」按钮在账号安全标题行');
await page.locator('[data-pwd-edit]').click();
await wait(200);
ok(await shown('pfPwdGrid') === true, '点「修改密码」后三联框展开');
ok(await shown('pfPwdActs') === true, '提交按钮随之展开');
ok(await page.evaluate(() => document.activeElement && document.activeElement.id === 'pw_old'),
  '展开后焦点落在「当前密码」输入框');

/* ---------- 【B】验证码行默认收起，点「修改邮箱」展开 ---------- */
console.log('【B】修改邮箱 · 点击后展开换绑面板');
ok(await page.locator('[data-email-edit]').count() === 1, '已绑邮箱 → 「修改邮箱」按钮存在');
ok(await shown('pfCodeRow') === false, '换绑面板默认隐藏');
ok(await page.locator('#pf_email').getAttribute('readonly') !== null, '当前邮箱为只读展示');
await page.locator('[data-email-edit]').click();
await wait(200);
ok(await shown('pfCodeRow') === true, '点「修改邮箱」后换绑面板展开');
ok(await page.locator('#pf_emailNew').isVisible(), '「更换到的邮箱」输入栏可见');
ok(await page.locator('[data-bind-confirm]').isVisible(), '「确认更换」按钮可见');
ok(await page.locator('#pfBindSend').isVisible(), '「发送验证码」按钮可见');

/* ---------- 【C0】再点一次按钮要能收回（不想改了就收回去） ---------- */
console.log('【C0】再次点击收回');
await page.locator('[data-email-edit]').click();
await wait(200);
ok(await shown('pfCodeRow') === false, '再点「修改邮箱」→ 换绑面板收回');
await page.locator('[data-pwd-edit]').click();
await wait(200);
ok(await shown('pfPwdGrid') === false && await shown('pfPwdActs') === false,
  '再点「修改密码」→ 三联框与提交按钮收回');
await page.locator('[data-email-edit]').click();
await wait(200);
ok(await shown('pfCodeRow') === true, '第三次点击 → 面板再次展开');

/* ---------- 【C】完整换绑：发码（echo 回显）→ 确认更换 → 新邮箱生效 ---------- */
console.log('【C】完整换绑链路（echo 回显）');
const newEmail = `rebind_${Date.now() % 100000}@example.com`;
await page.fill('#pf_emailNew', newEmail);
await page.locator('#pfBindSend').click();
await wait(1200);
const note = await page.locator('#pfBindNote').innerText().catch(() => '');
const mCode = note.match(/(\d{6})/);
ok(!!mCode, '点发送 → echo 回显验证码出现', note.replace(/\s+/g, ' ').slice(0, 60));
await page.fill('#pf_emailCode', mCode ? mCode[1] : '000000');
await page.locator('[data-bind-confirm]').click();
await wait(1500);
const curEmail = await page.locator('#pf_email').inputValue().catch(() => '');
ok(curEmail === newEmail, '确认更换后当前邮箱已变为新邮箱', curEmail || '（空）');
ok(await shown('pfCodeRow') === false, '换绑成功后面板自动收起');

/* ---------- 【D】档案卡超高时自己滚 ---------- */
console.log('【D】档案页可滚动');
await page.locator('[data-pwd-edit]').click();   // 重新展开密码面板，把内容撑高
await wait(300);
const scroll = await page.evaluate(() => {
  const el = document.querySelector('.auth-card');
  if (!el) return null;
  const overflowY = getComputedStyle(el).overflowY;
  const canScroll = el.scrollHeight > el.clientHeight;
  let moved = 0;
  if (canScroll) { el.scrollTop = 240; moved = el.scrollTop; }
  return { overflowY, sh: el.scrollHeight, ch: el.clientHeight, moved };
});
ok(!!scroll && scroll.overflowY === 'auto', '.auth-card overflow-y:auto', scroll && scroll.overflowY);
ok(!!scroll && scroll.sh > scroll.ch, '内容超高（scrollHeight>clientHeight）',
  scroll && `${scroll.sh}>${scroll.ch}`);
ok(!!scroll && scroll.moved > 0, '设置 scrollTop 后真的滚动了', scroll && scroll.moved);
await page.screenshot({ path: join(SHOTS, '_profile_ui.png') });

await browser.close();
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
