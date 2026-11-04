/* ============================================================
   忘记密码 + 登录失败按钮复位的浏览器快速验收（对 8010 mock 跑）：
     【A】登录失败（错密码）→ 报错出现且按钮文字复位为「登录」，不再卡转圈
     【B】登录卡有「忘记密码？」入口 → 进入重置表单
     【C】获取验证码 → 回显验证码 → 重置成功 → 回登录并预填账号
     【D】占位文案为虚构人物（zhangsan / 张三）
   用法：node tools/verify_forgot_ui.mjs [url]   默认 http://127.0.0.1:8010
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

/* 后端注册一个专用账号（幂等：409 则视为已存在） */
const U = { username: 'forgot_ui_user', password: 'Forgot2026', displayName: '界面验收', email: 'forgot_ui_user@example.com' };
const reg = await fetch(BASE + '/api/v1/auth/register', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(U),
});
if (reg.status !== 201 && reg.status !== 409) {
  console.log('准备账号失败：HTTP ' + reg.status); process.exit(1);
}

const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const wait = (ms) => page.waitForTimeout(ms);

await page.goto(BASE + '/', { waitUntil: 'load' });
await wait(1100);

/* ---------- 【D】占位文案 ---------- */
console.log('【D】占位文案为虚构人物');
const ph = await page.locator('#af_username').getAttribute('placeholder');
ok(/zhangsan/.test(ph || '') && !/luliulin/i.test(ph || ''), '用户名占位 = 如 zhangsan', ph);

/* ---------- 【A】登录失败按钮复位 ---------- */
console.log('【A】登录失败后按钮复位');
await page.locator('#af_username').fill(U.username);
await page.locator('#af_password').fill('WrongPass999');
await page.locator('#authSubmit').click();
await wait(900);
const btnText = await page.locator('#authSubmit').innerText();
ok(/登录/.test(btnText) && !/登录中/.test(btnText), '按钮文字已复位（不含「登录中」）', btnText.trim());
ok(!(await page.locator('#authSubmit').getAttribute('class') || '').includes('is-busy'), '按钮 is-busy 已移除');
ok(await page.locator('#authErr.show').count() === 1, '错误横幅可见');
await page.screenshot({ path: join(SHOTS, '_auth_fail_reset.png') });

/* ---------- 【B】忘记密码入口 ---------- */
console.log('【B】忘记密码入口');
ok(await page.locator('[data-auth-forgot]').count() === 1, '登录卡有「忘记密码？」入口');
await page.locator('[data-auth-forgot]').click();
await wait(500);
ok(await page.locator('#forgotForm').count() === 1, '进入重置表单');
ok((await page.locator('#fg_account').inputValue()) === U.username, '账号预填当前输入的用户名');

/* ---------- 【C】完整重置链路 ---------- */
console.log('【C】验证码重置链路');
await page.locator('[data-forgot-send]').click();
await wait(900);
const note = await page.locator('.auth-code-note').innerText().catch(() => '');
const codeMatch = note.match(/(\d{6})/);
if (!codeMatch && /邮箱/.test(note)) {
  console.log(`[i] 后端为 email 真发通道（验证码不回显）：${note.slice(0, 50)}`);
  console.log('[i] 本闸门仅覆盖 echo 回显链路；请以 CODE_CHANNEL=echo 启动后端后重跑。');
  console.log(`\n断言 ${pass} 项通过，SKIPPED（email 通道不适用）`);
  process.exit(0);
}
ok(!!codeMatch, '验证码已回显在界面', note.slice(0, 40));
await page.locator('#fg_code').fill(codeMatch ? codeMatch[1] : '000000');
await page.locator('#fg_new').fill('NewPass2026');
await page.screenshot({ path: join(SHOTS, '_auth_forgot.png') });
await page.locator('#fgSubmit').click();
await wait(900);
ok(await page.locator('#authForm').count() === 1, '重置成功 → 回到登录表单');
ok((await page.locator('#af_username').inputValue()) === U.username, '登录表单预填账号');

/* 新密码能真登进去 */
await page.locator('#af_password').fill('NewPass2026');
await page.locator('#authSubmit').click();
await wait(1400);
const signedIn = await page.evaluate(() => !!(AUTH.token && AUTH.user));
ok(signedIn, '用新密码真实登录成功');
const toastText = await page.evaluate(() => document.body.innerText.includes('密码已重置'));
ok(toastText, '「密码已重置」提示出现过');

await browser.close();
console.log(`\n断言 ${pass} 项通过${fail ? `，${fail} 项未通过 ❌` : '，全部通过 ✅'}`);
process.exit(fail === 0 ? 0 : 1);
