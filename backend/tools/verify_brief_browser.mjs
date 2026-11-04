/* 简报中心验收 —— 「勾选联动 + 真文件下载」的常驻闸门
   ================================================================
   用户报的两件事，这里逐条用真浏览器点一遍：
     ① 在结果列表勾了政策，简报中心却没跟着变  → 预览 / 导出清单必须等于勾选；
     ② 提示「导出成功」但根本没有文件           → 必须真下载到文件，且内容含勾选的政策；
   另外覆盖：导出范围真生效、三种格式、重新下载、后端不可用时不假装成功、
             一条没勾时的明确提示。

   用法：node tools/verify_brief_browser.mjs [url]     默认 http://127.0.0.1:8010
*/
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import zlib from 'node:zlib';

const require = createRequire(pathToFileURL(resolve(
  process.env.PW_WORKSPACE || 'C:/Users/22866/.workbuddy/binaries/node/workspace', 'noop.js'
)));
const pw = await import(pathToFileURL(require.resolve('playwright')).href);
const chromium = pw.chromium || (pw.default && pw.default.chromium);

const BASE = process.argv[2] || 'http://127.0.0.1:8010';
const SHOTS = join(dirname(fileURLToPath(import.meta.url)), '..', '_shots');
const DL = join(SHOTS, '_brief-downloads');
mkdirSync(DL, { recursive: true });

let pass = 0;
let fail = 0;
const ok = (c, m, extra) => {
  if (c) { pass += 1; console.log('  ok   ' + m + (extra === undefined ? '' : '   → ' + extra)); }
  else { fail += 1; console.log('  FAIL ' + m + (extra === undefined ? '' : '   → ' + extra)); }
};
const note = (m) => console.log('  ·    ' + m);

/* ---------- 迷你 zip 读取（XLSX / DOCX 都是 zip，用来核「文件里真的有那些政策」） ---------- */
function unzipEntry(buf, want) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是 zip：找不到 EOCD');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('中央目录损坏');
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const cmtLen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8');
    if (name === want) {
      const lNameLen = buf.readUInt16LE(lho + 26);
      const lExtraLen = buf.readUInt16LE(lho + 28);
      const start = lho + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(start, start + compSize);
      return method === 0 ? raw : zlib.inflateRawSync(raw);
    }
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return null;
}

const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, acceptDownloads: true });
const errs = [];
const NOISE = /api\/v1\/db\/status|net::ERR_FAILED|net::ERR_CONNECTION_REFUSED|Failed to fetch|Download is starting/;
page.on('pageerror', (e) => { if (!NOISE.test(String(e))) errs.push(String(e)); });
page.on('console', (m) => { if (m.type() === 'error' && !NOISE.test(m.text())) errs.push(m.text()); });

const wait = (ms) => page.waitForTimeout(ms);
const cards = () => page.locator('.result-card');
const paperText = () => page.locator('.brief-preview .paper').innerText();
const scopeLabel = (v) => page.locator(`[data-seg="scope:${v}"]`).innerText();
const pgNum = (n) => page.locator(`.pager .pg:not(.pg-nav)[data-page="${n}"]`);
const pickedSize = () => page.evaluate(() => LIST_STATE.picked.size);

/** 本页「全选」只作用本页 —— 想清空全部勾选，得逐页点两轮（全选中 → 全取消）。
    启动**不预勾选**任何政策，所以这里是从 0 开始的完整两轮；逐页走一遍仍然必要，
    因为「全选」的口径就是本页。 */
async function clearAllPicks() {
  const pages = await page.evaluate(() => listPageCount());
  for (let round = 0; round < 2; round += 1) {
    for (let i = 1; i <= pages; i += 1) {
      await pgNum(i).click();
      await wait(200);
      await page.locator('[data-select-all]').click();
      await wait(180);
    }
  }
  await pgNum(1).click();
  await wait(250);
}

/** 点「生成并导出简报」，等真下载，返回 { file, name, bytes } */
async function exportAndGrab(tag) {
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 90000 }),
    page.locator('[data-export]').click(),
  ]);
  const file = join(DL, tag);
  await dl.saveAs(file);
  return { file, name: dl.suggestedFilename(), bytes: existsSync(file) ? statSync(file).size : 0 };
}

await page.goto(BASE + '/', { waitUntil: 'load' });
await wait(1100);
const guest = page.locator('.auth-card [data-auth-guest]');
if (await guest.count()) { await guest.first().click(); await wait(700); }
console.log('被测地址：' + BASE);

/* ============================================================
   ① 结果列表勾选 → 简报中心跟着变
   ============================================================ */
console.log('\n【① 勾选联动】');
await page.click('[data-nav="list"]');
await wait(700);
ok(await page.locator('.list-body').count() === 1, '已进入结果列表屏');

await clearAllPicks();
ok(await pickedSize() === 0, '逐页「全选」两轮后勾选归零', String(await pickedSize()));

/* 只勾 3 条，并记下它们的名字 */
const PICK_N = 3;
const pickedNames = [];
for (let i = 0; i < PICK_N; i += 1) {
  const card = cards().nth(i);
  pickedNames.push((await card.locator('.rc-name').innerText()).trim());
  await card.locator('[data-pick]').click();
  await wait(220);
}
note('勾选：' + pickedNames.join(' / '));
/* 同一页里「没勾」的那一条：用来验「没勾的不会被导进去」 */
const otherCard = (await cards().nth(PICK_N).locator('.rc-name').innerText()).trim();
ok(await pickedSize() === PICK_N, `列表里勾了 ${PICK_N} 条`, String(await pickedSize()));

await page.click('[data-nav="brief"]');
await wait(700);
ok(await page.locator('.brief-body').count() === 1, '已进入简报中心');
ok((await scopeLabel('picked')).indexOf(`已勾选 ${PICK_N} 条政策`) >= 0,
  '导出范围的「已勾选」跟着勾选数走', await scopeLabel('picked'));

let paper = await paperText();
const inPaper = pickedNames.filter((n) => paper.indexOf(n) >= 0);
ok(inPaper.length === PICK_N, `预览里能看到勾选的 ${PICK_N} 条政策`, `命中 ${inPaper.length}/${PICK_N}`);
ok(paper.indexOf('企业扶持政策简报（一页纸）') >= 0 && paper.indexOf('免责声明') >= 0,
  '简报正文的头尾模板照常渲染');
const total = await page.evaluate(() => DATA.policies.items.length);
ok(paper.indexOf(`共 ${total} 条政策`) < 0,
  '预览的「共 n 条」按导出清单算（不是整个结果集）', `n=${PICK_N} / total=${total}`);
await page.screenshot({ path: join(SHOTS, '37-brief-picked.png') });

/* ============================================================
   ② 真文件下载（XLSX）
   ============================================================ */
console.log('\n【② 真文件下载】');
const x = await exportAndGrab('brief-picked.xlsx');
ok(x.bytes > 2000, 'XLSX 真的落到了磁盘', `${x.bytes} B · ${x.name}`);
ok(/\.xlsx$/.test(x.name), '文件名带 .xlsx 后缀', x.name);
ok(/^政策简报_/.test(x.name), '文件名以「政策简报_日期」开头', x.name);
const xb = readFileSync(x.file);
ok(xb.readUInt32LE(0) === 0x04034b50, 'XLSX 魔数正确（PK\\x03\\x04）',
  [...xb.subarray(0, 2)].map((v) => v.toString(16)).join(' '));
const sheet1 = unzipEntry(xb, 'xl/worksheets/sheet1.xml');
ok(!!sheet1, 'XLSX 里有 xl/worksheets/sheet1.xml');
const sheetTxt = sheet1 ? sheet1.toString('utf8') : '';
const inSheet = pickedNames.filter((n) => sheetTxt.indexOf(n) >= 0);
ok(inSheet.length === PICK_N, `导出的表格里就是勾选的那 ${PICK_N} 条`, `命中 ${inSheet.length}/${PICK_N}`);
ok(sheetTxt.indexOf(otherCard) < 0, '没勾的那条没被导进去', otherCard);
ok(!!unzipEntry(xb, 'xl/worksheets/sheet2.xml'), 'XLSX 里带第二张表（简报综述）');

const banner = await page.locator('.banner.ok').innerText();
ok(banner.indexOf('导出成功：') >= 0 && banner.indexOf(x.name) >= 0,
  '成功横幅印的是真实文件名', banner.split('\n')[0]);
ok(banner.indexOf('真实文件已下载到本机') >= 0, '横幅说明已下载到本机');
ok(await page.locator('.banner.warn').count() === 0, '成功态下没有错误横幅');
await page.screenshot({ path: join(SHOTS, '38-brief-exported.png') });

/* ============================================================
   ③ 换格式 → 上一份简报失效 → 生成 PDF
   ============================================================ */
console.log('\n【③ 三种格式】');
await page.click('[data-seg="format:pdf"]');
await wait(350);
ok(await page.locator('.banner.ok').count() === 0, '切成 PDF 后，上一份 XLSX 的成功横幅收起（设置变了）');

const p = await exportAndGrab('brief-picked.pdf');
ok(p.bytes > 2000, 'PDF 真的落到了磁盘', `${p.bytes} B · ${p.name}`);
ok(/\.pdf$/.test(p.name), '文件名带 .pdf 后缀', p.name);
const pb = readFileSync(p.file);
ok(pb.subarray(0, 5).toString('latin1') === '%PDF-', 'PDF 头正确（%PDF-）', pb.subarray(0, 5).toString('latin1'));
ok(pb.includes(Buffer.from('/STSong-Light')) || pb.includes(Buffer.from('FontFile')),
  'PDF 内嵌了中文 CID 字体（不会乱码）');

await page.click('[data-seg="format:doc"]');
await wait(300);
const d = await exportAndGrab('brief-picked.docx');
ok(/\.docx$/.test(d.name), 'Doc 选项导出 .docx（不是 .doc）', d.name);
const db = readFileSync(d.file);
const docXml = unzipEntry(db, 'word/document.xml');
ok(!!docXml, 'DOCX 里有 word/document.xml');
const docTxt = docXml ? docXml.toString('utf8') : '';
ok(pickedNames.filter((n) => docTxt.indexOf(n) >= 0).length === PICK_N,
  'DOCX 正文里也是勾选的那几条', `命中 ${pickedNames.filter((n) => docTxt.indexOf(n) >= 0).length}/${PICK_N}`);

/* ============================================================
   ④ 「重新下载」拿到的是同一份文件
   ============================================================ */
console.log('\n【④ 重新下载】');
const [dl2] = await Promise.all([
  page.waitForEvent('download', { timeout: 30000 }),
  page.locator('[data-brief-download]').click(),
]);
ok(dl2.suggestedFilename() === d.name, '重新下载的文件名与刚才一致', dl2.suggestedFilename());

/* ============================================================
   ⑤ 导出范围真生效：切「当前筛选结果」= 整份结果集
   ============================================================ */
console.log('\n【⑤ 导出范围】');
await page.click('[data-seg="scope:filtered"]');
await wait(400);
const fl = await scopeLabel('filtered');
ok(fl.indexOf(`当前筛选结果（${total} 条）`) >= 0, '范围标签显示结果集总数', fl);
const previewMax = await page.evaluate(() => Number(DATA.brief.previewMax) || 0);
const shown = await page.locator('.brief-preview .pitem').count();
ok(shown === Math.min(previewMax, total), '预览只铺前 previewMax 条（不撑爆 DOM）', `${shown} 条`);
const cutTxt = await page.locator('.brief-preview .pcut').innerText();
ok(cutTxt.indexOf(`前 ${shown} 条`) >= 0 && cutTxt.indexOf(`全部 ${total} 条`) >= 0,
  '并把「导出文件里是全量」说清楚', cutTxt);
paper = await paperText();
ok(pickedNames.filter((n) => paper.indexOf(n) >= 0).length >= 1,
  '整份结果集包含刚才勾选的那几条（范围是超集）');
await page.screenshot({ path: join(SHOTS, '39-brief-filtered.png') });

/* ============================================================
   ⑥ 勾选一变，上一份简报就失效（不会挂着对不上的成功横幅）
   ============================================================ */
console.log('\n【⑥ 勾选变化使简报失效】');
await page.click('[data-seg="scope:picked"]');
await wait(300);
await page.click('[data-nav="list"]');
await wait(500);
await cards().nth(PICK_N).locator('[data-pick]').click();  /* 多勾一条 */
await wait(300);
await page.click('[data-nav="brief"]');
await wait(500);
ok(await page.locator('.banner.ok').count() === 0, '勾选变了 → 成功横幅不再挂着（文件名/清单都对不上）');
ok((await scopeLabel('picked')).indexOf(`已勾选 ${PICK_N + 1} 条政策`) >= 0,
  '导出范围的条数跟着更新', await scopeLabel('picked'));

/* ============================================================
   ⑦ 后端不可用：明确报错，不假装成功
   ============================================================ */
console.log('\n【⑦ 后端不可用】');
await page.route('**/api/v1/briefs', (r) => r.abort());
let downloaded = 0;
page.once('download', () => { downloaded += 1; });
await page.locator('[data-export]').click();
await wait(2500);
ok(await page.locator('.banner.ok').count() === 0, '没有假报「导出成功」');
const warn = await page.locator('.banner.warn').count();
ok(warn === 1, '给出了醒目的失败横幅', String(warn));
const warnTxt = warn ? await page.locator('.banner.warn').innerText() : '';
ok(warnTxt.indexOf('简报生成失败') >= 0, '横幅写明失败原因', warnTxt.split('\n')[0]);
ok(downloaded === 0, '确实没有产生任何下载');
await page.unroute('**/api/v1/briefs');

/* ============================================================
   ⑧ 一条都没勾：明确提示，且不发起生成
   ============================================================ */
console.log('\n【⑧ 空清单】');
await page.click('[data-nav="list"]');
await wait(500);
await clearAllPicks();
ok(await pickedSize() === 0, '清空所有勾选', String(await pickedSize()));
await page.click('[data-nav="brief"]');
await wait(500);
ok(await page.locator('[data-seg="scope:picked"]').isDisabled(),
  '「已勾选」这个范围被置灰（点不出一个空简报）');
/* 用户报过：一条政策都没勾，预览里却排着 2 条没选过的政策 —— 必须给「暂未选择政策」空态 */
ok((await paperText()).indexOf('暂未选择政策') >= 0,
  '预览给空态「暂未选择政策」（不再拿演示政策占位）',
  (await paperText()).replace(/\s+/g, ' ').slice(0, 60));
let downloads = 0;
page.once('download', () => { downloads += 1; });
await page.evaluate(() => { const h = document.getElementById('toasts'); if (h) h.innerHTML = ''; });
await page.locator('[data-export]').click();
await wait(900);
const toastTxt = await page.locator('#toasts .toast').first().innerText().catch(() => '');
ok(toastTxt.indexOf('请先在结果列表勾选要导出的政策') >= 0, '给出可操作的提示', toastTxt.replace(/\n/g, ' '));
ok(downloads === 0, '没有产生下载（不会拿演示政策凑数）');

/* ============================================================
   ⑨ 控制台不应当有未预期的报错
   ============================================================ */
console.log('\n【⑨ 控制台】');
ok(errs.length === 0, '页面无未预期报错', errs.slice(0, 3).join(' | '));

console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项`);
console.log('下载留档：' + DL);
await browser.close();
process.exit(fail ? 1 : 0);
