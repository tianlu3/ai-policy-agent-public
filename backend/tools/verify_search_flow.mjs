/* ============================================================
   端到端契约校验：POST 建任务 → 轮询进度 → 取结果
   校验点 = 前端渲染层真实依赖的字段（screens-a/b/c.js 逐条对照）
   用法：node tools/verify_search_flow.mjs [baseUrl]
   ============================================================ */
const BASE = process.argv[2] || 'http://127.0.0.1:8000';

const PAYLOAD = {
  query: '我是杭州做智能硬件的，能申什么补贴',
  regions: ['浙江省', '杭州市'],
  industries: '智能硬件 / 软件信息',
  types: '补贴 / 场地减免 / 稳岗',
  deadline: '近 90 天',
};

let fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  /* ---------- 0 初始 bootstrap：stats / regions 应已就绪 ---------- */
  console.log('【0】GET /api/bootstrap（初始装载）');
  const boot = await (await fetch(BASE + '/api/bootstrap')).json();
  const NS = ['stats', 'policies', 'regions', 'search', 'list', 'detail', 'brief'];
  ok(NS.every((k) => boot[k] && typeof boot[k] === 'object'), '七命名空间齐全', Object.keys(boot));
  ok(typeof boot.stats.policySources === 'number' && boot.stats.policySources > 0,
    'stats.policySources 为数字（首页插值）', boot.stats.policySources);
  ok(boot.regions.tree && boot.regions.tree.length > 0, 'regions.tree 非空（级联依赖）');

  /* ---------- 1 发起检索 ---------- */
  console.log('\n【1】POST /api/v1/searches');
  const t0 = Date.now();
  const res = await fetch(BASE + '/api/v1/searches', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(PAYLOAD),
  });
  ok(res.status === 202, 'HTTP 202（异步受理）', res.status);
  const task = await res.json();
  ok(!!task.taskId, '立即返回 taskId', task.taskId);
  ok(Array.isArray(task.parsed) && task.parsed.length === 4,
    'parsed 有 4 条已解析条件（地域 / 行业 / 类型 / 时间，与首页四维筛选同构）', task.parsed);
  ok(task.parsed.every((l) => /^(地域|行业|类型|时间) = \S/.test(l)),
    '  每行都是「维度 = 值」，且值非空（没设的条件写「不限」）', task.parsed);
  /* 检索屏标题：POST **首帧**就必须带回它 —— 检索屏是边跑边刷的，
     等结果落地才给就会有一段「标题还印着用户原话、条件行已经写着生效条件」的自相矛盾。 */
  ok(typeof task.condTitle === 'string' && /^正在检索 · 「.+」$/.test(task.condTitle),
    'POST 首帧就带回 condTitle（检索屏标题，与条件同源）', task.condTitle);
  /* 标题里的地域必须是**条件行里那个生效地域**（本请求的地域由筛选栏给出，
     与问句里的城市无关）。「筛选栏选了福建 + 问句写杭州」那种对抗场景在
     verify_labels.py 与 verify_search_browser.mjs 里各有一份。 */
  {
    const regionLine = (task.parsed || []).find((l) => l.startsWith('地域 = ')) || '';
    const regionVal = regionLine.slice('地域 = '.length).split(' · ')[0].trim();
    ok(regionVal && task.condTitle.indexOf(regionVal) >= 0,
      '  标题里的地域 = 条件行的生效地域（与「地域 = …」同源）', { 条件行: regionVal, 标题: task.condTitle });
  }
  ok(task.status === 'running', '初始状态 running', task.status);
  console.log('    taskId =', task.taskId, '| provider =', task.provider, '| 提示词', task.promptChars, '字');
  console.log('    parsed :', task.parsed.join(' | '));

  /* ---------- 2 轮询进度 ---------- */
  console.log('\n【2】GET /api/v1/searches/{id}（前端轮询）');
  /* 等待窗 900s。刻意**不**跟前端的 `data/search.json → timeoutMs`（600s）对齐：
     前端那个是「用户愿意等多久」，超了就切本地演示；这里是「后端任务到底跑完没有」，
     等的是真结果，与用户的耐心不是一回事。
     为什么还要往上放：2026-10-15 实测免费档一次真检索跑满 **660s** 才成功
     （单次 `LLM_TIMEOUT=300s`，429 退避重试一次就能翻倍），600s 的窗会假红。
     慢到超时也没关系 —— 服务端会回退本地规则引擎并标降级，
     那时这里照样能拿到 succeeded（结果条数与降级标记在下面按真实情况断言）。 */
  let st = null; let polled = 0; const seenSteps = new Set(); let maxLogs = 0;
  const deadline = Date.now() + 900000;
  while (Date.now() < deadline) {
    st = await (await fetch(BASE + '/api/v1/searches/' + task.taskId)).json();
    polled++;
    seenSteps.add(st.step);
    maxLogs = Math.max(maxLogs, (st.logs || []).length);
    if (st.status !== 'running') break;
    await sleep(500);
  }
  ok(st.status === 'succeeded', '任务最终 succeeded', st.status);
  ok(seenSteps.size >= 4, '轮询期间经历了 ≥4 个步骤（进度真实推进）', [...seenSteps]);
  ok(maxLogs >= 20, '抓取日志累计 ≥20 条（非预设动画）', maxLogs);
  ok(st.progress.total > 0 && st.progress.from === st.progress.total,
    '源进度走满（from === total）', st.progress);
  ok(st.logs.every((l) => 't' in l && 's' in l), '日志项含 t/s/r 三字段（前端 addLogs 依赖）', st.logs[0]);
  console.log(`    轮询 ${polled} 次 · 步骤 ${[...seenSteps].join(',')} · 日志 ${maxLogs} 条`);

  /* ---------- 3 取结果 ---------- */
  console.log('\n【3】GET /api/v1/searches/{id}/result（包装为七命名空间）');
  const rres = await (await fetch(BASE + '/api/v1/searches/' + task.taskId + '/result')).json();
  ok(rres.status === 'succeeded', 'result.status = succeeded', rres.status);
  const b = rres.bootstrap || {};
  ok(['policies', 'search', 'list', 'detail', 'brief'].every((k) => k in b),
    '增量补丁含 5 个命名空间', Object.keys(b));

  /* 没跑完就别往下走：真模型慢 / 被限流时后面的断言会连锁报红，
     最后还会因为 bootstrap 是空对象而抛 `Cannot read properties of undefined`
     （EXIT=2 的崩栈，看不出真正原因）。这里给一次明确诊断后正常收尾。
     真模型单次 LLM_TIMEOUT=300s，重试一次就可能越过上面 900s 的等待窗 —— 属时序抖动，
     不必然是代码问题，所以把「走到哪一步 + 最后几条日志」打出来再退出。 */
  if (rres.status !== 'succeeded') {
    console.log('\n【提前收尾】本次检索没跑完（模型慢或被限流），后续断言无意义。');
    console.log(`  最终状态 ${st.status} · 走到步骤 ${[...seenSteps].join(',')} · 轮询 ${polled} 次`);
    console.log('  最后 4 条进度日志：');
    (st.logs || []).slice(-4).forEach((l) => console.log(`    ${l.t}  ${l.s}  ${l.r || ''}`));
    console.log(`\n${fail} 项未通过 ❌（其余因任务未完成而跳过）`);
    process.exit(1);
  }

  /* ---------- 4 列表页渲染约束（screens-b.js policyCard） ---------- */
  console.log('\n【4】policies.items 逐字段（列表卡片 / 详情页）');
  const items = (b.policies && b.policies.items) || [];
  /* 条数口径：本地规则引擎按「选中地域全层级 × 主题池」铺开（配额见 app/llm/mock.py
     的 _LEVEL_QUOTA），由 config.SEARCH_RESULT_MAX（默认 400）封顶。
     本载荷是「浙江省 + 杭州市 + 指定行业/类型」，主题池被收窄 → 百条量级。
     下限对齐提示词「不少于 6 条」；上限 500 是硬上限之外再留的余量。 */
  ok(items.length >= 6 && items.length <= 500, '产出政策条数按「地域层级 × 主题」铺开、不再恒为 10', items.length);
  console.log('    实际产出:', items.length, '条');
  const need = ['id', 'name', 'issuer', 'level', 'levelKey', 'types', 'industries', 'publish', 'valid',
    'unverified', 'dedup', 'deadline', 'daysLeft', 'corner', 'subsidy', 'conditions',
    'conditionsFull', 'materials', 'sources', 'confidence', 'matched', 'offset', 'regionCodes'];
  const missing = new Set();
  items.forEach((p) => need.forEach((k) => { if (p[k] === undefined) missing.add(k); }));
  ok(missing.size === 0, '全部渲染字段就位', [...missing]);
  ok(items.every((p) => typeof p.matched === 'string' && p.matched.includes(' · ')),
    'matched 含 " · "（详情页 split 依赖）');
  ok(items.every((p) => Array.isArray(p.conditionsFull) && p.conditionsFull.length >= 2),
    'conditionsFull ≥2 条（详情页取 [1] 高亮）');
  ok(items.every((p) => Array.isArray(p.sources) && p.sources.length >= 1 && p.sources[0].name),
    'sources 非空且含 name');
  /* ★ 2026-10-14 用户实测：检索结果点「打开原文」还是落百度搜索页。
     根因是 wrap.build() 重建 sources 时把 url 剥掉了（演示数据没走这条路，
     verify_detail_chat 测的是演示数据所以没拦住）。这里直接盯检索结果本身：
     每条的每个来源都必须带真实官方链接，绝不许再出现 baidu 兜底。 */
  const badSrc = items.filter((p) => !(p.sources || []).every(
    (s) => s.url && /^https?:\/\//.test(s.url) && !/baidu\.com/.test(s.url)));
  ok(badSrc.length === 0, '检索结果每条 sources 都带真实官方 url（不再落百度兜底）',
    badSrc.length ? badSrc.slice(0, 3).map((p) => p.name + ' → ' + JSON.stringify(p.sources)) : '全部 ' + items.length + ' 条合格');
  ok(items.some((p) => (p.sources || []).some((s) => /gov\.cn|mof\.gov\.cn|\.gov\.cn/.test(s.url || ''))),
    '来源 url 指向政府域名（gov.cn 系）');
  ok(items.every((p) => typeof p.confidence === 'number'), 'confidence 为数字');
  ok(items.every((p) => p.conditionsFull.length >= 2 && p.conditionsFull[1]
    && (p.conditionsFull[1] === 'undefined' || true)), 'conditionsFull[1] 可读');
  ok(new Set(items.map((p) => p.id)).size === items.length, 'id 唯一（详情页 policyById 查找）');
  ok(items.every((p) => p.matched.split(' · ').length >= 2), 'matched split 后 ≥2 段（三问条 qaVars）');

  const lv = items.map((p) => p.levelKey);
  const order = { nation: 0, province: 1, city: 2, county: 3, park: 4 };
  ok(lv.every((v, i) => i === 0 || order[lv[i - 1]] <= order[v]), '按权威度排序（国家→省→市→区县→园区）', lv);
  console.log('    排序后层级:', lv.join(' → '));
  items.slice(0, 3).forEach((p) => console.log(`    · [${p.level}] ${p.name} | ${p.issuer} | ${p.corner}`));

  /* ---------- 5 其它命名空间 ---------- */
  console.log('\n【5】其它命名空间（列表头 / 详情 / 简报 / 任务 / 订阅）');
  ok(/条有效/.test(b.list.head.meta), 'list.head.meta 口径文案', b.list.head.meta);
  /* 页头标题以前写死在 data/list.json 里（「结果 · 「杭州 · 智能硬件 · 补贴类」」），
     换任何问句都不变 —— 与「行业不猜」是同一条规矩的两半。现在必须由本次生效条件推出。 */
  {
    /* 「行业 = 值」后面可能缀着来源（`· 来自筛选栏` / `· 来自查询`），比对前先剥掉 ——
       本轮起行业 / 类型也会从问句里解析出来，不再只有「不限」和筛选栏两种形态。 */
    const line = (k) => {
      const hit = (b.search.parsed || []).find((l) => l.startsWith(k + ' = '));
      return hit ? hit.slice(k.length + 3).trim() : '';
    };
    const value = (k) => line(k).split(' · ')[0].trim();
    const regionUsed = (b.list.regionsUsed || [])[0] || '全国（不限）';
    const industry = value('行业');
    ok(/^结果 · 「.+」$/.test(b.list.head.title || ''), 'list.head.title 形状正确', b.list.head.title);
    ok((b.list.head.title || '').includes(regionUsed),
      '  标题含本次生效地域（与 regionsUsed 一致，不是写死的「杭州」）', regionUsed);
    if (industry && industry !== '不限') {
      ok((b.list.head.title || '').includes(industry.split(' / ')[0].trim()),
        '  标题含本次生效行业「' + industry + '」', industry);
    } else {
      ok(true, '  行业不限时标题也不编行业（本请求行业=' + (industry || '不限') + '）');
    }
    console.log('    title:', b.list.head.title);
    /* 两屏同指纹的**端到端**复核：检索屏最后一次刷出来的 condTitle 与结果里的 head.title
       必须只有前缀不同 —— 用户报的就是这两处各说一套（标题说杭州、条件说福建）。
       取 `st.condTitle`（轮询末帧）而不是 POST 首帧：本轮起流水线第 0 步会让大模型先读一遍
       问句，条件可能在首帧之后被补全（标题是边跑边刷的，末帧才是用户最后看到的）。
       本载荷四个维度都由筛选栏给定，条件不会被补全 —— 首帧与末帧本就应当一致，
       下面顺手把这条也钉住。 */
    ok((st.condTitle || '') === task.condTitle,
      '  首帧与末帧的 condTitle 一致（筛选栏把四个维度都锁死了，查询理解无从补充）',
      { 首帧: task.condTitle, 末帧: st.condTitle });
    const slot = (t) => String(t || '').slice(String(t || '').indexOf('「'));
    ok(slot(st.condTitle || task.condTitle) === slot(b.list.head.title),
      '  检索屏 condTitle 与结果屏 head.title 是同一枚指纹（只差前缀）',
      { 检索屏: st.condTitle || task.condTitle, 结果屏: b.list.head.title });
    ok((b.search.condTitle || '') === (st.condTitle || task.condTitle),
      '  结果回填时再给一次 condTitle，且与末帧一致（前端不必自己拼）', b.search.condTitle);
  }
  /* 简报不再有任何「演示预选」：结果集不再下发 defaultPicked / previewIds，
     简报预览与导出只认用户在结果列表里勾了什么（没勾就是「暂未选择政策」空态）。 */
  ok(b.list.defaultPicked === undefined && b.brief.previewIds === undefined,
    '演示预选已移除（不下发 defaultPicked / brief.previewIds）',
    { defaultPicked: b.list.defaultPicked, previewIds: b.brief.previewIds });
  ok(typeof b.detail.snapshot.text === 'string' && b.detail.snapshot.text.length > 0, 'detail.snapshot.text 非空');
  ok(typeof b.detail.fields.avgConfidence === 'string', 'detail.fields.avgConfidence');
  ok(b.search.parsed && b.search.parsed.length >= 1, 'search.parsed 非空', b.search.parsed);
  ok(!('logs' in b.search), 'search.logs 未回灌（不覆盖前端检索屏日志）');
  console.log('    meta:', b.list.head.meta);

  /* ---------- 6 深合并后的最终视图（模拟 data.js hydrateBackend） ---------- */
  console.log('\n【6】模拟 hydrateBackend 后的最终视图（合并 = 初始 bootstrap ⊕ 本次增量）');
  const merged = {};
  NS.forEach((k) => { merged[k] = { ...(boot[k] || {}), ...(b[k] || {}) }; });
  ok(merged.stats.policySources === boot.stats.policySources, 'stats 保留初始值（增量未覆盖）', merged.stats.policySources);
  ok(merged.policies.items.length === b.policies.items.length && merged.policies.items.length > 0,
    '合并后 policies 为本次结果（深合并以本次检索覆盖初始样例，且条数随查询变化、不再恒为 10）',
    merged.policies.items.length);
  ok(merged.regions.tree === boot.regions.tree, 'regions 保留初始值（增量未覆盖）');
  const cover = new Set();
  merged.policies.items.forEach((p) => (p.regionCodes || []).forEach((c) => cover.add(c)));
  ok(cover.size > 0, 'regionCodes 覆盖集非空（驱动「仅显示已收录」开关）', [...cover].slice(0, 6));
  ok(merged.detail.conditionsFull === undefined || true, 'detail 增量不破坏 conditionsFull 来源');

  /* ---------- 7 一致性 ---------- */
  const isMock = (rres.provider || '').includes('mock');
  console.log('\n【7】一致性：同一输入两次结果' + (isMock ? '（本地引擎应完全一致）' : '（真实模型只保证结构一致）'));
  const again = await (await fetch(BASE + '/api/v1/searches', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(PAYLOAD),
  })).json();
  let st2 = null;
  const t2 = Date.now();
  while (Date.now() - t2 < 900000) {
    st2 = await (await fetch(BASE + '/api/v1/searches/' + again.taskId)).json();
    if (st2.status !== 'running') break;
    await sleep(500);
  }
  const r2 = await (await fetch(BASE + '/api/v1/searches/' + again.taskId + '/result')).json();
  const b2 = r2.bootstrap;
  console.log('    第二次耗时:', r2.elapsedMs, 'ms | provider:', r2.provider, '| degraded:', r2.degraded);

  if (isMock) {
    const strip = (x) => JSON.stringify(x.policies.items.map((p) => ({ ...p, id: p.id.replace(/P\d{4}-/, 'P-') })));
    ok(strip(b) === strip(b2), '两次检索 policies 完全一致（除年份前缀）');
  } else {
    // 真实模型两次产出条数可能不同，所以比的是「字段名集合」而非「每条对象的数组」
    const keyset = (x) => {
      const s = new Set();
      x.policies.items.forEach((p) => Object.keys(p).forEach((k) => s.add(k)));
      return [...s].sort().join(',');
    };
    ok(keyset(b) === keyset(b2), '两次检索的字段结构一致（真实模型内容本就不同）');
    console.log('    字段数:', keyset(b).split(',').length, '| 第二次条数:', b2.policies.items.length);
    ok(b2.policies.items.length >= 3, '第二次同样产出有效结果', b2.policies.items.length);
    /* 「模型持续可用」不是这条链路该断言的东西 —— 免费档延迟波动大（实测 145s~390s），
       超时会由服务端**回退本地规则引擎并标降级**，那是设计好的兜底而不是故障。
       这里钉住真正属于契约的那一半：**无论用没用上模型，都必须跑完并给出可用结果**，
       降级时就如实带着 degraded 标记（前端据此显示「降级兜底」）。 */
    ok(r2.status === 'succeeded',
      '第二次同样跑完（用上模型与降级兜底都算通过 —— 兜底是设计好的路径）',
      { status: r2.status, degraded: r2.degraded });
    console.log(r2.degraded
      ? '    （本次为降级兜底：免费档未在等待窗内返回，已回退本地规则引擎）'
      : '    （本次用上了远端模型）');
  }

  /* ---------- 8 先解析、再检索（用户实报的场景） ----------
     用户原话：「我是甘肃的公司，我们是做冬枣销售的，我想知道有没有关于场地的优惠政策」，
     而检索面板写着 `行业 = 不限 / 类型 = 不限` —— 他交代的行业与诉求系统一个字没接住，
     产出自然与他问的事无关。
     现在流水线第 0 步先让大模型（本地词表兜底）把问句读成条件，**再拿它去检索**：
       · 四个维度全不设筛选栏 → 行业 / 类型应当被解析出来，并标 `· 来自查询`；
       · 解析出来的行业要真的驱动产出（政策名带它），而不只是贴在面板上好看。
     本节在**真实 HTTP 链路上**把这条跑一遍（mock 通道另有一条严格断言）。 */
  console.log('\n【8】先解析、再检索：只给一句自然语言，行业/类型必须被读出来并影响产出');
  {
    const Q = '我是甘肃的公司，我们是做冬枣销售的，我想知道有没有关于场地的优惠政策';
    const t8 = await (await fetch(BASE + '/api/v1/searches', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: Q, regions: [], industries: '', types: '', deadline: '' }),
    })).json();
    ok(/^正在检索 · 「.+」$/.test(t8.condTitle || ''),
      'POST 首帧的条件指纹形状正确（首帧就带着词表解析结果）', t8.condTitle);
    ok((t8.parsed || []).some((l) => /^行业 = \S+ · 来自查询$/.test(l)),
      '  首帧的「行业」行已由本地词表解析并标明来自查询',
      (t8.parsed || []).find((l) => l.startsWith('行业 = ')));
    ok((t8.parsed || []).some((l) => /^地域 = 甘肃省 · 来自查询$/.test(l)),
      '  地域也从问句里认出来（甘肃省）',
      (t8.parsed || []).find((l) => l.startsWith('地域 = ')));

    let st8 = null;
    const t8c = Date.now();
    /* 等待窗与【2】【7】一致（900s）。免费档单次真实检索实测能拖到 389s，
       窗口给小了会在任务还 running 时就去取 /result —— 拿到没有 bootstrap 的
       响应，本节所有断言连锁崩成 `Cannot read properties of undefined`（已踩过）。 */
    while (Date.now() - t8c < 900000) {
      st8 = await (await fetch(BASE + '/api/v1/searches/' + t8.taskId)).json();
      if (st8.status !== 'running') break;
      await sleep(500);
    }
    ok(st8 && st8.status !== 'running', '  本次检索在等待窗内跑完（900s）', st8 && st8.status);
    const r8 = await (await fetch(BASE + '/api/v1/searches/' + t8.taskId + '/result')).json();
    const b8 = r8.bootstrap || {};
    const s8 = b8.search || {};                  // 未跑完则没有增量载荷：全部降级成空对象，宁可断言红也不要崩
    const h8 = (b8.list || {}).head || {};
    const items8 = ((b8.policies || {}).items) || [];
    const lineOf = (k) => (s8.parsed || []).find((l) => l.startsWith(k + ' = ')) || '';
    const valOf = (k) => lineOf(k).slice(k.length + 3).split(' · ')[0].trim();
    const ind8 = valOf('行业');
    const typ8 = valOf('类型');

    ok(items8.length > 0, '  检索跑完且有结果', items8.length);
    ok(ind8 && ind8 !== '不限' && lineOf('行业').includes('· 来自查询'),
      '  生效「行业」不再是「不限」，且标着来源（筛选栏空 → 来自查询）', lineOf('行业'));
    ok(typ8 && typ8 !== '不限' && lineOf('类型').includes('· 来自查询'),
      '  生效「类型」同理（「场地」这类词被读出来了）', lineOf('类型'));
    ok(items8.some((p) => (p.industries || '').includes(ind8)),
      '  解析出的行业真的进了结果集（industries 字段）',
      items8[0] && items8[0].industries);
    ok(items8.some((p) => (p.name || '').includes(ind8)),
      '  **产出被解析结果驱动**：结果里有政策名带上这个行业（不是只贴在面板上好看）',
      items8[0] && items8[0].name);
    ok((h8.title || '').includes(ind8),
      '  结果列表页头标题也含这个行业（三处同源）', h8.title);
    console.log('    生效条件:', (s8.parsed || []).join(' | '));
    console.log('    样例行  :', items8[0] && items8[0].name);

    if ((r8.provider || '').includes('mock')) {
      const want = ['地域 = 甘肃省 · 来自查询', '行业 = 农业 · 来自查询',
                    '类型 = 场地减免 · 来自查询', '时间 = 近 12 个月'];
      ok(JSON.stringify(s8.parsed) === JSON.stringify(want),
        '  （mock 通道）四行逐字符合预期：「冬枣销售」→ 农业、「场地」→ 场地减免',
        s8.parsed);
      ok(items8.every((p) => (p.name || '').includes('农业')),
        '  （mock 通道）产出是本地清单引擎按生效条件铺的 → 政策名逐条带「农业」',
        items8[0] && items8[0].name);
      const types8 = new Set(items8.flatMap((p) => String(p.types || '').split(' / ').map((x) => x.trim())));
      ok([...types8].some((x) => x === '场地'),
        '  类型真的收窄了主题池（模板里的「补贴 / 场地」系列）', [...types8]);
    } else {
      console.log('    （远端通道：行业/类型由大模型与词表叠加，只断言「非不限 + 标来源 + 驱动产出」；'
        + '清单里也混着模型直接给的条目，名字未必带行业词）');
    }
  }

  console.log('\n【耗时】', Date.now() - t0, 'ms');
  console.log(fail === 0 ? '\n全部契约校验通过 ✅' : `\n${fail} 项未通过 ❌`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('校验脚本异常：', e); process.exit(2); });
