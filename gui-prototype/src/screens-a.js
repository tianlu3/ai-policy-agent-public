/* ============================================================
   屏幕渲染 · 公共件 + 1 首页检索 + 2 检索中
   —— 全部文案与字段取自 DATA.*（data/*.json），本文件只保留视图逻辑
   ============================================================ */

/* ---------- 产品顶栏 ---------- */
function topBar(active) {
  const A = DATA.app;
  /* 闸门未开（未登录且未选「游客身份」）时，站在登录页上的用户点导航只会被拦回来 ——
     与其「点了没反应」，不如明确置灰。账号区不停用（它就是登录入口）。 */
  const locked = typeof AUTH !== 'undefined' && typeof AUTH.gateOpen === 'function' && !AUTH.gateOpen();
  const gateTip = (typeof escHtml === 'function' && DATA.auth) ? escHtml(DATA.auth.gate.hint) : '';
  const lock = locked ? ` disabled title="${gateTip}"` : '';
  const nav = A.nav.map((n) =>
    `<button data-nav="${n.screen}" class="${n.key === active ? 'on' : ''}"${lock}>${n.label}</button>`).join('');
  /* 账号区由 src/screens-d.js 提供；缺失时退回静态文案 */
  const account = (typeof authChip === 'function')
    ? authChip()
    : `<span class="tb-pill">${A.brand.pill}</span>`;
  /* 状态胶囊：只作状态展示（原「异常降级」跳转入口已随该屏一起移除） */
  const status = `<span class="tb-status" id="tbStatus" title="${A.status.title}"><span class="dot"></span>${A.status.text}</span>`;
  return `
  <header class="topbar">
    <div class="tb-logo">
      <span class="mark">${ICON.logo}</span>
      <span class="tb-name">${A.brand.name}</span>
      <span class="tb-pill">${A.brand.pill}</span>
    </div>
    <div class="tb-spacer"></div>
    <nav class="tb-nav">${nav}</nav>
    <div class="tb-spacer"></div>
    <span class="tb-run-slot" id="tbRunSlot"></span>
    ${status}
    ${account}
  </header>`;
}

/* ============================================================
   条件精确筛选 · 统一控件（四个维度共用）
   ------------------------------------------------------------
   地域 / 行业 / 类型 / 截止时间在结构上就是同一个组件，差别只在数据来源：
     · 地域     → CASCADE（三级级联，每级独立勾选）
     · 行业 / 类型 → FILTER_STATE，多选，多个值按 OR 生效
     · 截止时间  → FILTER_STATE，单选（home.filter.deadline.single）
   因此触发器与面板都只有一份实现，任何一维改样式，四维同时生效：
     · 触发器 filterTrigger() —— [维度标签] + 已选标签块（可单个 × 删除）+ 清空 + caret
     · 面板骨架 .fpanel      —— 头部（标题 / 快捷操作 / 搜索 / 提示）+ 列表 + 底部（摘要 / 清空 / 确定(n)）
   已生效值随检索一并提交给后端（startSearch 的 regions / industries / types / deadline）。
   ============================================================ */

/** 面板骨架文案（四个维度共用，单源在 data/app.json → filterLabels） */
const FILTER_LABELS = {
  panelHint: '勾选即改草稿，点「确定」才生效',
  clear: '清空',
  ok: '确定（{n}）',
  none: '不限',
  selectAll: '全选',
  unselectAll: '取消全选',
  empty: '没有匹配的选项',
};
/* data/app.json 装载完成后覆盖上面的兜底值（Node 自检里也能拿到真值） */
function filterLabels() {
  return (typeof DATA !== 'undefined' && DATA.app && DATA.app.filterLabels) || FILTER_LABELS;
}
function filterText(key, vars) {
  const v = filterLabels()[key];
  const s = v === undefined ? FILTER_LABELS[key] : v;
  return vars && typeof DATA !== 'undefined' && DATA.fmt ? DATA.fmt(s, vars) : s;
}

/** 已选标签块：最多 max 个，其余折叠为「+N」
 *  × 是唯一的删除热区 —— 标签本体不是：否则点触发器中段（标签所在处）
 *  会变成「删掉这个条件」，而不是展开面板，用户会莫名丢失已选条件。
 *  readonly 时不渲染 × —— 只读展示（结果列表的地域就是这种）。 */
function triggerTags(items, max, dropAttr, readonly) {
  const list = items || [];
  const n = max || 1;
  const chips = list.slice(0, n).map((it) => (readonly
    ? `<span class="tag" title="${escHtml(it.name)}">${escHtml(it.name)}</span>`
    : `<span class="tag" title="${escHtml(it.name)}">${escHtml(it.name)}<i class="x" ${
      dropAttr}="${escHtml(it.code)}">${ICON.x}</i></span>`)).join('');
  const more = list.length > n
    ? `<span class="tag more" title="${escHtml(list.slice(n).map((i) => i.name).join(' / '))}">+${list.length - n}</span>`
    : '';
  return chips + more;
}

/**
 * 筛选触发器（地域 / 行业 / 类型 / 截止时间完全同构）。
 * @param {object} o
 *   id / label / none   —— 元素 id、维度标签（含冒号）、未选时的占位文案
 *   items               —— 已选 [{code, name}]；code 同时用于单个 × 删除
 *   max / dense         —— 最多展示几个标签块 / 紧凑样式
 *   triggerAttr / triggerVal —— 打开面板的数据属性（地域 data-region-trigger="1"；
 *                                选项维度 data-opt-trigger="<组名>"，值即维度关键字）
 *   clearAttr / dropAttr—— 清空、单个删除的数据属性
 *   open / title        —— 面板是否展开 / 悬浮说明
 *   readonly            —— 只读展示：不挂打开面板的数据属性、无 caret、无清空、无 ×。
 *                          用于「结果列表」——那里的地域是检索条件的回显，不该再被改。
 */
function filterTrigger(o) {
  const items = o.items || [];
  const more = o.more || '';
  const shown = items.length
    ? `<span class="tags">${triggerTags(items, o.max, o.dropAttr, o.readonly)}</span>`
    : `<span class="tags"><span class="ph">${escHtml(o.none)}</span></span>`;
  /* label 传空串则整块省略 —— 结果列表的行首已经有「地域」这个表头，
     回显里再写一遍「地域：」就成了「地域 · 地域：浙江省」的重复。 */
  const lab = o.label ? `<span class="tv"><b>${escHtml(o.label)}</b></span>` : '';
  if (o.readonly) {
    return `
  <div class="trigger readonly ${o.dense ? 'dense' : ''} ${items.length ? 'active' : ''}"
       id="${o.id}" title="${escHtml(o.title || o.none)}">
    ${lab}
    ${shown}
  </div>${more}`;
  }
  return `
  <div class="trigger ${o.dense ? 'dense' : ''} ${items.length ? 'active' : ''} ${o.open ? 'open' : ''}"
       id="${o.id}" ${o.triggerAttr}="${escHtml(o.triggerVal === undefined ? '1' : o.triggerVal)}"
       title="${escHtml(o.title || o.none)}">
    ${lab}
    ${shown}
    ${items.length ? `<span class="clear-slot" ${o.clearAttr}="1">${escHtml(o.clearLabel)}</span>` : ''}
    <span class="caret">${ICON.caret}</span>
  </div>${more}`;
}

/** 结果列表要展示的「本次检索地域」。
 *  检索发起时冻结一份（SEARCH_STATE.regions）—— 列表页回答的是
 *  「这份结果是按什么地域检索出来的」，用户回首页改了筛选也不该跟着变。
 *  从未检索过（深链直接进列表）时退回当前已选，等价于「待检索的条件」。 */
/* 结果列表顶部「地域」回显要回答的是「这份结果是按什么地域检索出来的」——
   所以以**后端给出的实际生效地域**（list.regionsUsed）为准：它既可能是筛选栏所选，
   也可能是筛选栏为空时从查询文本里识别到的城市（如「我是杭州做智能硬件的」→ 杭州市）。
   后端没给（离线演示 / 本地降级）才退回「本次检索时冻结的筛选栏地域」。 */
function searchedRegionNames() {
  const used = DATA.list && DATA.list.regionsUsed;
  if (Array.isArray(used)) return used.slice();
  if (typeof SEARCH_STATE !== 'undefined' && SEARCH_STATE.regions && SEARCH_STATE.regions.length) {
    return SEARCH_STATE.regions.slice();
  }
  return (typeof CASCADE !== 'undefined' && CASCADE.selectedNodes)
    ? CASCADE.selectedNodes(false).map((n) => n.name)
    : [];
}

/** 从检索屏那四行「已解析出条件」里取某个维度的值（'' = 没有这一行）。 */
function searchedCondValue(key) {
  const parsed = (DATA.search && DATA.search.parsed) || [];
  const prefix = key + ' = ';
  for (const line of parsed) {
    if (typeof line === 'string' && line.indexOf(prefix) === 0) {
      return line.slice(prefix.length).trim();
    }
  }
  return '';
}

/** 「地域 1 个 · 行业 2 个 · 类型 3 个 · 截止：近 90 天」——
    结果列表第二条筛选行用的条件摘要。

    为什么不用首页那套（FILTER_STATE + CASCADE.count）：结果屏描述的是**结果集**，
    不是当前筛选栏。曾经这里填的是 CASCADE.count(false)，于是出现「地域 0 个」
    与上方回显的「杭州市」当场打架 —— 那个地域是用户问句里的「杭州」带出来的，
    筛选栏本来就没勾。所以口径与「本次生效地域」一致：regionsUsed + search.parsed。
    四个分片的文案（{n} 个 / 截止：{v} / 分隔符）与首页共用 data/home.json → filter.parts。 */
function searchedCondSummary() {
  const PT = ((DATA.home || {}).filter || {}).parts || {};
  const sep = PT.sep || ' · ';
  const count = (v) => (v && v !== '不限') ? v.split(' / ').filter(Boolean).length : 0;
  const rc = searchedRegionNames().length;
  const ni = count(searchedCondValue('行业'));
  const nt = count(searchedCondValue('类型'));
  const dl = searchedCondValue('时间');
  const dlv = (dl && dl !== '不限') ? dl : '';
  return [
    rc && PT.regionSome ? DATA.fmt(PT.regionSome, { n: rc })
      : (PT.regionNone || ''),
    ni && PT.industry ? DATA.fmt(PT.industry, { n: ni }) : '',
    nt && PT.type ? DATA.fmt(PT.type, { n: nt }) : '',
    dlv && PT.deadline ? DATA.fmt(PT.deadline, { v: dlv }) : '',
  ].filter(Boolean).join(sep);
}

/** 检索屏标题：与结果列表页头标题是**同一枚「条件指纹」**（地域 / 行业 / 类型），
    只有前缀不同（`正在检索 · ` / `结果 · `，两处前缀都在 backend/app/labels.py）。

    为什么不让前端拼：用户报过「标题写着我问句里的杭州、下面条件行却写着筛选栏的福建省/福州市」——
    就是标题显示原话、条件显示生效值造成的自相矛盾。现在两屏都只印后端给的那一枚指纹：
    后端在轮询首帧里带回 `condTitle`（那时条件已算好），结果集回填时再给一次；
    离线演示用 test_date.js 的样板值。都没有才退回旧的问句回显（`data/search.json → echoPrefix`），
    这样后端异常时用户仍能看见自己在问什么。

    ★ 例外：**真实检索刚发起、指纹还没回来**的那一段（真实模型下 LLM 查询理解要十几秒，
    免费档更久）不能再印样板指纹 —— 它是写死「杭州市 · 智能硬件 · 补贴」的演示数据，
    用户筛了福建省却看见杭州市，等于替用户编了一份条件。这一段按本意印问句回显。 */
function searchCondTitle(query) {
  const running = typeof SEARCH_STATE !== 'undefined' && !!SEARCH_STATE.running;
  /* 空问句固定回显「未填写问句 · 按已选筛选条件检索」—— 后端条件指纹（全国（不限）·…）
     到货也不覆盖：用户没写字，标题就该如实说「这次是按筛选条件检的」。 */
  if (!(query || '').trim()) {
    return escHtml(DATA.search.emptyEcho || '未填写问句 · 按已选筛选条件检索');
  }
  const fromState = (typeof SEARCH_STATE !== 'undefined' && SEARCH_STATE.condTitle) || '';
  const sample = (DATA.search && DATA.search.condTitle) || '';
  const t = fromState || (running ? '' : sample);
  /* 没写问句时不印「正在检索：「」」—— 改印中性回显（文案在 data/search.json）。
     后端指纹到货后这行会被 condTitle 覆盖，这里只负责待机窗不空洞也不编条件。 */
  const full = t || (query
    ? (DATA.search.echoPrefix + '「' + query + '」')
    : (DATA.search.echoPrefix + (DATA.search.emptyEcho || '')));
  /* 「…」那一段沿用既有的品牌色（.search-echo .q span），前缀保持墨色：
     这次只该改内容，不该顺手换掉视觉。取不到「」就整句原样输出。 */
  const i = full.indexOf('「');
  return i > 0
    ? escHtml(full.slice(0, i)) + '<span>' + escHtml(full.slice(i)) + '</span>'
    : escHtml(full);
}

/* ---------- 离线 / 本地降级时的「地域跟随」 ----------
   单文件版（双击打开、没后端）或后端不可用时，检索走 runLocalDemoSearch，结果直接沿用
   内置样例（默认 杭州市）。于是「用户明明搜了湖南省，提示却还是杭州市」——
   就是这里没跟随。所以在「本地完成」时，用「用户实际选的地域 / 问句里提到的地域」
   覆盖这几处显示（地域回显、页头标题、检索屏标题、已解析条件首行），让离线演示也跟着查询走。 */
function matchRegionInText(text) {
  const tree = (DATA.regions && DATA.regions.tree) || [];
  const out = [];
  const seen = new Set();
  const stripSuffix = (n) => {
    for (const s of ['特别行政区', '自治区', '自治州', '自治县', '地区', '盟', '省', '市', '县', '区']) {
      if (n.length > s.length && n.endsWith(s)) return n.slice(0, -s.length);
    }
    return n;
  };
  const walk = (list) => {
    for (const node of (list || [])) {
      if (!node) continue;
      const code = node[0], name = node[1];
      if (code === '00' || !name) { walk(node[3]); continue; }
      if (text.indexOf(name) >= 0) {
        if (!seen.has(code)) { seen.add(code); out.push(name); }
        walk(node[3]); continue;
      }
      const short = stripSuffix(name);
      if (short.length >= 2 && text.indexOf(short) >= 0 && !seen.has(code)) {
        seen.add(code); out.push(name);
      }
      walk(node[3]);
    }
  };
  walk(tree);
  return out;
}

function localEffectiveRegion() {
  const picked = [];
  if (typeof CASCADE !== 'undefined' && CASCADE.selectedNodes) {
    const m = new Map();
    CASCADE.selectedNodes(true).forEach((n) => m.set(n.code, n));   // 草稿（面板里勾的）
    CASCADE.selectedNodes(false).forEach((n) => m.set(n.code, n));  // 已生效
    m.forEach((n) => picked.push(n));
  }
  picked.sort((a, b) => (a.level - b.level) || (a.code < b.code ? -1 : 1));
  const names = picked.map((n) => n.name);
  if (names.length) return { names, source: '来自筛选栏' };
  const fromQ = matchRegionInText(APP.query || '');
  if (fromQ.length) return { names: fromQ, source: '来自查询' };
  return { names: [], source: '' };
}

/* 把内置样例里写死的「浙江省 / 杭州市」换成「本次地域」，让列表读起来一致。
   始终从首帧快照（DATA.__pristinePolicies）重新生成，避免二次替换把上一轮地域又改掉。 */
function remapLocalItems(names) {
  if (!names || !names.length) return;
  const src = (DATA.policies && DATA.policies.items) || [];
  if (!src.length) return;
  if (!DATA.__pristinePolicies) {
    try { DATA.__pristinePolicies = JSON.parse(JSON.stringify(src)); } catch (e) { return; }
  }
  const base = DATA.__pristinePolicies;
  const prov = names.find((n) => /省|自治区|特别行政区/.test(n)) || names[0];
  const city = names.find((n) => /市/.test(n)) || prov;
  const swap = (s) => (typeof s === 'string') ? s.replace(/浙江省/g, prov).replace(/杭州市/g, city) : s;
  DATA.policies.items = base.map((it) => {
    const c = JSON.parse(JSON.stringify(it));
    if (c.name) c.name = swap(c.name);
    if (c.issuer) c.issuer = swap(c.issuer);
    if (Array.isArray(c.conditions)) c.conditions = c.conditions.map(swap);
    if (Array.isArray(c.conditionsFull)) c.conditionsFull = c.conditionsFull.map(swap);
    if (Array.isArray(c.materials)) c.materials = c.materials.map(swap);
    if (Array.isArray(c.sources)) c.sources.forEach((s) => { if (s && s.name) s.name = swap(s.name); });
    return c;
  });
  if (DATA.detail && DATA.detail.snapshot && typeof DATA.detail.snapshot.text === 'string')
    DATA.detail.snapshot.text = swap(DATA.detail.snapshot.text);
}

/* 与后端 labels.region_text 同一条收敛口径：地域最多列前两个，其余收成「等 n 项」。
   标题若把 17 个区县全铺出来，会把整行挤爆（旁边的「排序」被压成一列一个字）。 */
function briefRegionText(names) {
  const arr = (names || []).filter(Boolean);
  if (!arr.length) return '全国（不限）';
  const head = arr.slice(0, 2).join(' / ');
  return arr.length > 2 ? head + ' 等 ' + arr.length + ' 项' : head;
}

function applyLocalRegionOverride() {
  const r = localEffectiveRegion();
  const regionText = briefRegionText(r.names);
  const sep = (DATA.home && DATA.home.filter && DATA.home.filter.joinSep) || ' / ';
  const ind = (typeof FILTER_STATE !== 'undefined' && FILTER_STATE.values)
    ? (FILTER_STATE.values('industry').join(sep) || '不限') : '不限';
  const typ = (typeof FILTER_STATE !== 'undefined' && FILTER_STATE.values)
    ? (FILTER_STATE.values('type').join(sep) || '不限') : '不限';
  const src = r.source ? (' · ' + r.source) : '';

  if (!DATA.list) DATA.list = {};
  DATA.list.regionsUsed = r.names.slice();
  if (!DATA.list.head) DATA.list.head = {};
  DATA.list.head.title = '结果 · 「' + regionText + ' · ' + ind + ' · ' + typ + '」';

  if (!DATA.search) DATA.search = {};
  DATA.search.condTitle = '正在检索 · 「' + regionText + ' · ' + ind + ' · ' + typ + '」';
  if (!Array.isArray(DATA.search.parsed)) DATA.search.parsed = [];
  const p0 = '地域 = ' + regionText + src;
  if (DATA.search.parsed.length) DATA.search.parsed[0] = p0;
  else DATA.search.parsed = [p0, '行业 = ' + ind, '类型 = ' + typ, '时间 = 近 12 个月'];

  if (typeof SEARCH_STATE !== 'undefined') {
    SEARCH_STATE.regions = r.names.slice();
    SEARCH_STATE.condTitle = DATA.search.condTitle;
  }
  if (r.names.length) { try { remapLocalItems(r.names); } catch (e) { /* 降级不致命 */ } }
}

/* ---------- 地域触发框（供首页 / 列表页 / 地域页复用）
   readonly: true → 结果列表用：只回显「本次检索的地域」，不可再选。 ---------- */
function regionTrigger(opts) {
  const T = DATA.region.trigger;
  const o = Object.assign({ max: T.normMax, dense: false, id: 'rg' }, opts || {});
  /* 可写触发器必须用**区划代码**做 code —— 标签上的 × 是 data-fdrop="<code>"，
     删除时要落回 CASCADE.node(code)；只读回显没有 ×，code 用名字即可（快照里存的就是名字）。 */
  const items = o.readonly
    ? searchedRegionNames().map((n) => ({ code: n, name: n }))
    : CASCADE.selectedNodes(false).map((n) => ({ code: n.code, name: n.name }));
  const title = items.length ? items.map((i) => i.name).join(' / ') : (o.none || T.empty);
  return filterTrigger({
    id: o.id,
    /* label: '' 表示行首已有表头，不要在回显里重复维度名 */
    label: o.label === undefined ? T.label : o.label,
    none: o.none || T.empty,
    items,
    max: o.max,
    dense: o.dense,
    readonly: o.readonly,
    clearLabel: T.clear,
    triggerAttr: 'data-region-trigger',
    triggerVal: '1',
    clearAttr: 'data-clear-region',
    dropAttr: 'data-fdrop',
    open: typeof APP !== 'undefined' && !!APP.cascOpen,
    title,
  });
}

/* ---------- 行业 / 类型 / 截止时间：状态机 ---------- */
const FILTER_STATE = {
  GROUPS: ['industry', 'type', 'deadline'],
  applied: {},          // 已生效 { 组: Set<选项文案> }
  draft: {},            // 面板里的草稿
  q: {},                // 面板内的搜索词
  ready: false,
  /* 首次使用前按 home.json 的默认值播种（幂等，可放心在渲染前调用） */
  ensure() {
    if (this.ready) return this;
    const F = (DATA.home && DATA.home.filter) || {};
    this.GROUPS.forEach((g) => {
      const s = new Set(this.split((F[g] || {}).value));
      this.applied[g] = new Set(s);
      this.draft[g] = new Set(s);
      this.q[g] = '';
    });
    this.ready = true;
    return this;
  },
  split(v) {
    return String(v === null || v === undefined ? '' : v)
      .split(/\s*\/\s*/).map((s) => s.trim()).filter(Boolean);
  },
  cfg(g) { return ((DATA.home && DATA.home.filter) || {})[g] || {}; },
  opts(g) { return this.cfg(g).options || []; },
  isSingle(g) { return this.cfg(g).single === true; },
  resetFromApplied() {
    this.GROUPS.forEach((g) => { this.draft[g] = new Set(this.applied[g]); this.q[g] = ''; });
  },
  /** 某组已生效的选项文案 */
  pick(g) { return Array.from(this.applied[g] || []); },
  /** 该维度是否真的在起作用（截止时间选「不限」＝不起作用） */
  active(g) {
    const v = this.pick(g);
    if (!v.length) return 0;
    if (g === 'deadline' && v[0] === filterLabels().none) return 0;
    return v.length;
  },
  values(g) { return this.active(g) ? this.pick(g) : []; },
  /** 触发器要展示的项：单选组选「不限」时按未选处理 */
  display(g) {
    const v = this.pick(g);
    if (this.isSingle(g) && v.length === 1 && v[0] === filterLabels().none) return [];
    return v.map((x) => ({ code: x, name: x }));
  },
  /** 面板列表：按搜索词过滤后的可见选项 */
  visible(g) {
    const q = (this.q[g] || '').trim();
    const all = this.opts(g);
    return q ? all.filter((o) => o.indexOf(q) >= 0) : all;
  },
  /** 撤销单个选项（触发器上的 ×） */
  drop(g, v) {
    if (!this.applied[g]) return;
    this.applied[g].delete(v);
    if (this.draft[g]) this.draft[g].delete(v);
  },
  /** 全选 / 取消全选当前可见项（单选组不适用） */
  toggleAll(g) {
    if (this.isSingle(g)) return;
    const d = this.draft[g];
    const list = this.visible(g);
    if (!list.length) return;
    const allOn = list.every((v) => d.has(v));
    if (allOn) list.forEach((v) => d.delete(v));
    else { d.delete(filterLabels().none); list.forEach((v) => d.add(v)); }
  },
  allOn(g) {
    const d = this.draft[g];
    const list = this.visible(g);
    return !!list.length && list.every((v) => d.has(v));
  },
};

/** 某一组的下拉触发器（与地域触发器同一份实现） */
function optTrigger(group) {
  const F = DATA.home.filter;
  const cfg = F[group] || {};
  const items = FILTER_STATE.display(group);
  return filterTrigger({
    id: 'ft_' + group,
    label: cfg.label,
    none: filterLabels().none,
    items,
    max: F.tagMax || 1,
    clearLabel: filterLabels().clear,
    triggerAttr: 'data-opt-trigger',
    triggerVal: group,
    clearAttr: 'data-opt-clear-q',
    dropAttr: 'data-fdrop',
    open: typeof APP !== 'undefined' && APP.optOpen === group,
    title: items.length ? items.map((i) => i.name).join(F.joinSep) : filterLabels().none,
  });
}

/* 面板切成三块视图模型：头部（含搜索框）/ 列表 / 底部（摘要 + 按钮）。
   拆开的原因见 app.js → patchOptPanel()：**输入时只重画列表，绝不换掉 <input> 节点**，
   否则中文输入法组词会被打断，且同一个按键的字符会被重复插进去。 */
function optView(group) {
  const F = DATA.home.filter;
  const cfg = F[group] || {};
  const draft = (FILTER_STATE.draft[group] || new Set());
  const n = draft.size;
  const q = FILTER_STATE.q[group] || '';
  return {
    F,
    cfg,
    group,
    single: FILTER_STATE.isSingle(group),
    draft,
    visible: FILTER_STATE.visible(group),
    q,
    /* 列表的内容身份：换了维度或改了搜索词就是另一份名单，滚动位置不该沿用
       （app.js → swapPanelBody() 用它决定要不要把滚动条放回原处）。 */
    key: `opt|${group}|${q}`,
    n,
    sum: n ? DATA.fmt(F.panel.sumHas, { n, names: Array.from(draft).join(F.joinSep) }) : F.panel.sumNone,
    allOn: FILTER_STATE.allOn(group),
  };
}

function optRowsHTML(v) {
  return v.visible.length
    ? v.visible.map((o) => {
      const on = v.draft.has(o);
      return `<div class="frow ${on ? 'on' : ''}" data-opt-val="${escHtml(o)}">
        <span class="box">${on ? ICON.check : ''}</span><span class="rn">${escHtml(o)}</span></div>`;
    }).join('')
    : `<div class="fpanel-empty">${filterText('empty')}</div>`;
}

function optHeadHTML(v) {
  return `
      <div class="fpanel-head">
        <div class="fpanel-head-top">
          <span class="fp-ttl">${v.cfg.panelTitle || v.cfg.label}</span>
          <span class="fp-spacer"></span>
          ${v.single ? '' : `<button class="fp-act ${v.allOn ? 'on' : ''}" data-opt-all="1">${
            v.allOn ? filterText('unselectAll') : filterText('selectAll')}</button>`}
        </div>
        <div class="fpanel-head-bar">
          ${v.cfg.searchPlaceholder ? `<label class="fp-search">${ICON.searchSm}
            <input id="optQ" placeholder="${escHtml(v.cfg.searchPlaceholder)}" value="${escHtml(v.q)}"></label>` : ''}
          <span class="fp-hint">${filterText('panelHint')}</span>
        </div>
      </div>`;
}

function optFootHTML(v) {
  return `
      <div class="fpanel-foot">
        <span class="sum">${escHtml(v.sum)}</span>
        <button class="btn btn-outline btn-sm" data-opt-clear="1">${filterText('clear')}</button>
        <button class="btn btn-solid btn-sm" data-opt-ok="1">${filterText('ok', { n: v.n })}</button>
      </div>`;
}

/** 选项面板（浮层内容）；骨架与地域面板 .fpanel 完全一致。
 *  `view` 可由调用方传入，避免挂载时把 optView() 算两遍（那份视图里带着滚动位置的身份键）。 */
function optPanelHTML(group, view) {
  /* 只认真正的视图对象：`.map(optPanelHTML)` 这类写法会把数组下标当第二个参数传进来。 */
  const v = (view && typeof view === 'object') ? view : optView(group);
  return `
  <div class="fpanel opt-panel" id="optPanel">${optHeadHTML(v)}
    <div class="fpanel-body scroll">${optRowsHTML(v)}</div>${optFootHTML(v)}
  </div>`;
}

/* ============================================================
   1 · 首页检索
   ============================================================ */
function renderHome() {
  const H = DATA.home;
  FILTER_STATE.ensure();

  const caps = H.capabilities.map((c) => `
    <div class="capcard">
      <span class="ic">${ICON[c.icon]}</span>
      <h4>${c.title}</h4>
      <p>${c.desc}</p>
    </div>`).join('');

  const examples = H.examples
    .map((e) => `<button class="chip plain" data-example="${e}">${e}</button>`).join('');

  /* 条件摘要：四个维度各自「有值才算一项」——
     地域未选即「不限」；行业 / 类型清空后该维度不再计入；截止时间选「不限」等同不加约束。 */
  const PT = H.filter.parts;
  const rc = CASCADE.count(false);
  const ni = FILTER_STATE.active('industry');
  const nt = FILTER_STATE.active('type');
  const dl = FILTER_STATE.active('deadline') ? FILTER_STATE.pick('deadline')[0] : '';
  const parts = [
    rc ? DATA.fmt(PT.regionSome, { n: rc }) : PT.regionNone,
    ni ? DATA.fmt(PT.industry, { n: ni }) : '',
    nt ? DATA.fmt(PT.type, { n: nt }) : '',
    dl ? DATA.fmt(PT.deadline, { v: dl }) : '',
  ].filter(Boolean);
  const selectedN = (rc ? 1 : 0) + (ni ? 1 : 0) + (nt ? 1 : 0) + (dl ? 1 : 0);
  const summary = DATA.fmt(H.filter.summary, { n: selectedN, parts: parts.join(PT.sep) });

  return `
  <div class="screen">
    ${topBar('home')}
    <div class="home-body">
      <section class="hero">
        <span class="boot-pill"><i class="dot"></i>${DATA.fmt(H.bootTpl, { n: DATA.stats.policySources })}</span>
        <h1>${H.title}</h1>
        <p class="hero-sub">${H.sub}</p>
        <div class="searchbox">
          ${ICON.search}
          <input id="homeQ" placeholder="${H.placeholder}">
          <button class="go btn btn-primary" data-go="search">${H.go}</button>
        </div>
        <div class="examples"><span>${H.tryLabel}</span>${examples}</div>
      </section>

      <section class="filterpanel">
        <div class="fp-ttl">${H.filter.title}</div>
        <div class="fp-row">
          ${regionTrigger({ max: H.filter.tagMax, id: 'rgHome' })}
          ${optTrigger('industry')}
          ${optTrigger('type')}
          ${optTrigger('deadline')}
        </div>
        <div class="fp-summary" id="homeSummary">${summary}</div>
      </section>

      <section class="caprow">${caps}</section>
    </div>
  </div>`;
}

/* ============================================================
   2 · 检索中（加载态）
   ------------------------------------------------------------
   检索是**后台任务**，与当前停在哪一屏无关：
     · SEARCH_STATE 持有「进度视图模型」，轮询循环只读写它，不依赖屏幕 DOM；
     · 用户切到简报中心 / 结果列表等其它屏后，轮询照常推进；
     · 回到检索屏由 paintSearchScreen() 按视图模型重绘，**不会重复发起检索**；
     · 完成时若用户已不在检索屏 → 右下角弹一张通知卡片（可点「查看结果」）。
   ============================================================ */
const SEARCH_STATE = {
  running: false,          // 是否有任务在跑（唯一存活判据）
  taskId: null,
  timers: [],
  engineNoticed: false,
  reenter: false,          // 本次 go('search') 只是「回来看进度」，不是新检索
  local: false,            // 已降级为本地演示动画
  /* ---- 进度视图模型（切屏不丢） ---- */
  pct: 0,
  step: 0,
  title: '',
  connLost: false,        // 后端连不上（被杀 / 网络断）：横幅常亮 + 自动重试
  connMsg: '',            // 横幅当前文案（断连重试中 / 重试超时 / 任务因重启丢失）
  /* 首次「连着失败」的时间戳。宽限期（S.connGraceMs）内只静默重试、不亮黄条：
     演示场景里后端重启/瞬断一两秒很常见，一看黄条就以为系统挂了。
     超过宽限期仍连不上才亮横幅，且此后文案随重试进展升级。 */
  connSince: 0,
  countFrom: 0,
  countTotal: 0,
  parsed: [],
  /* 检索屏标题（后端给的条件指纹）。空则退回问句回显，见 searchCondTitle()。 */
  condTitle: '',
  /* 本次问句：只用于标题的 tooltip，屏幕本身改印条件指纹了 */
  query: '',
  logs: [],
  paintedLogs: 0,          // 已经画到 DOM 上的日志条数（重入检索屏时归零重画）
  regions: [],             // 本次检索冻结的地域条件（结果列表只读回显用）
};

/* 产品顶栏的「检索中 n%」指示：任意屏都能看到，点它回到检索屏看进度。
   顶栏要同时放下 9 项导航 + 状态 + 账号，再加入一枚胶囊会挤到换行 ——
   所以检索期间它**顶替**「内置示例数据可用」那枚状态胶囊（优先级更高的信息），跑完再换回来。 */
function paintRunPill() {
  const slot = document.getElementById('tbRunSlot');
  if (!slot) return;
  const statusEl = document.getElementById('tbStatus');
  if (statusEl) statusEl.hidden = SEARCH_STATE.running;
  if (!SEARCH_STATE.running) {
    if (slot.innerHTML) slot.innerHTML = '';
    return;
  }
  let btn = slot.querySelector('.tb-run');
  if (!btn) {
    const T = DATA.search;
    slot.innerHTML = `<button class="tb-run" data-run="1" title="${escHtml(T.runPillTitle)}">`
      + `<i class="spin"></i><span>${escHtml(T.runPill)}</span><b>0%</b></button>`;
    btn = slot.querySelector('.tb-run');
  }
  const b = btn.querySelector('b');
  if (b) b.textContent = Math.round(SEARCH_STATE.pct) + '%';
}

/* 把视图模型画到检索屏上。当前不在检索屏 / 屏幕已被重渲染 → 直接返回，进度仍继续推进。 */
function paintSearchScreen() {
  if (APP.screen !== 'search') return;
  const S = DATA.search;
  const bar = document.getElementById('pipeBar');
  if (!bar) return;

  bar.style.width = Math.max(0, Math.min(100, SEARCH_STATE.pct)) + '%';

  const count = document.getElementById('pipeCount');
  if (count) count.textContent = SEARCH_STATE.countFrom + ' / ' + SEARCH_STATE.countTotal + ' ' + S.progress.unit;

  const title = document.getElementById('pipeTitle');
  if (title) title.textContent = SEARCH_STATE.title || S.progress.title;

  document.querySelectorAll('[data-step]').forEach((el, i) => {
    el.classList.toggle('done', i < SEARCH_STATE.step);
    el.classList.toggle('now', i === SEARCH_STATE.step);
  });

  const parsedBox = document.getElementById('pipeParsed');
  if (parsedBox && SEARCH_STATE.parsed.length) {
    parsedBox.innerHTML = '<span>' + S.parsedLabel + '</span>' +
      SEARCH_STATE.parsed.map((p) => '<span class="pk">' + p + '</span>').join('');
  }

  /* 标题：条件指纹随轮询首帧回来（真实模型下 LLM 查询理解要十几秒，免费档更久）。
     到货就换上；**还没到货也要重画一次** —— 挂载时渲染的那份是 test_date.js 的样板指纹
     （写死「杭州市 · 智能硬件 · 补贴」），不重画就会一直挂在屏上，用户筛了福建省却看见杭州市。
     重画走 searchCondTitle()，它认得「正在检索但还没指纹」这一档并改印问句回显。 */
  const echo = document.getElementById('pipeEcho');
  if (echo && (SEARCH_STATE.condTitle || SEARCH_STATE.running)) {
    const want = searchCondTitle(SEARCH_STATE.query);
    if (echo.innerHTML !== want) echo.innerHTML = want;
    /* 问句原文 tooltip 与进度重画保持同步（挂载后 query 才到的情况） */
    if (SEARCH_STATE.query && echo.dataset.tip !== SEARCH_STATE.query) {
      echo.dataset.tip = SEARCH_STATE.query;
      echo.setAttribute('aria-label', SEARCH_STATE.query);
    }
  }

  /* 断连横幅：后端被杀 / 网络抖动时如实说出来，恢复后自动消失 ——
     绝不白屏、不无限转圈，也不悄悄换成假数据（2026-10-16 用户口径）。 */
  const connLost = document.getElementById('pipeConnLost');
  if (connLost) {
    connLost.hidden = !SEARCH_STATE.connLost;
    connLost.querySelector('.bn-ttl').textContent = SEARCH_STATE.connMsg || S.connLost;
  }

  const logs = document.getElementById('fetchLogs');
  if (logs) {
    /* 自动跟滚只在「用户本来就贴着底部」时做 —— 他要是正往上翻历史日志，
       每来一条就把他拽回底部，等于根本看不了（2026-10-15 用户报「没法下滑查看」）。
       判定要放在 append 之前：追加本身会改变 scrollHeight。 */
    const stick = logs.scrollHeight - logs.scrollTop - logs.clientHeight < 24;
    for (let i = SEARCH_STATE.paintedLogs; i < SEARCH_STATE.logs.length; i++) {
      const l = SEARCH_STATE.logs[i] || {};
      const li = document.createElement('li');
      li.innerHTML = '<span class="lt">' + (l.t || '') + '</span>'
        + '<span class="ls">' + (l.s || '') + '</span>'
        + '<span class="lr">' + (l.r || '') + '</span>';
      logs.appendChild(li);
    }
    SEARCH_STATE.paintedLogs = SEARCH_STATE.logs.length;
    if (stick) logs.scrollTop = logs.scrollHeight;
  }
}

function haltSearch() {
  SEARCH_STATE.running = false;
  SEARCH_STATE.timers.forEach((t) => { if (typeof t === 'function') t(); else clearTimeout(t); });
  SEARCH_STATE.timers = [];
}

/* 检索屏上的「取消检索」 */
function bindSearchCancel(go) {
  const btn = document.querySelector('[data-cancel]');
  if (!btn) return;
  btn.addEventListener('click', () => {
    if (SEARCH_STATE.taskId && DATA.api) {
      DATA.api.cancelSearch(SEARCH_STATE.taskId).catch(() => {});
      SEARCH_STATE.taskId = null;
    }
    haltSearch();
    paintRunPill();
    toast(DATA.app.toast.cancelSearch, 'info');
    go('home');
  });
}

/* ---------- 降级：本地演示动画（后端不可用 / 任务失败 / 超时） ---------- */
function runLocalDemoSearch() {
  const S = DATA.search;
  SEARCH_STATE.running = true;
  SEARCH_STATE.local = true;
  const span = S.progress.total - S.progress.from;
  let pct = 0;
  const tick = setInterval(() => {
    if (!SEARCH_STATE.running) return;
    pct = Math.min(100, pct + S.tickStep);
    SEARCH_STATE.pct = pct;
    SEARCH_STATE.countFrom = Math.round(S.progress.from + (pct / 100) * span);
    SEARCH_STATE.countTotal = S.progress.total;
    const idx = Math.min(S.runningTitles.length - 1,
      Math.floor(pct / (100 / S.runningTitles.length)));
    SEARCH_STATE.step = idx;
    SEARCH_STATE.title = S.runningTitles[idx];
    paintSearchScreen();
    paintRunPill();
    if (pct >= 100) { clearInterval(tick); finishSearch(null, 'local'); }
  }, S.tickMs);
  SEARCH_STATE.timers.push({ clear: () => clearInterval(tick) });

  (S.logs || []).forEach((l, i) => {
    SEARCH_STATE.timers.push(setTimeout(() => {
      if (!SEARCH_STATE.running) return;
      SEARCH_STATE.logs = (S.logs || []).slice(0, i + 1);
      paintSearchScreen();
    }, S.logDelayMs + i * S.logGapMs));
  });
}

/**
 * 一次检索的收尾（成功 / 失败 / 降级完成都走这里）。
 *
 *   跨屏友好：
 *     · 用户还在检索屏 → 沿用原行为，出结果后自动跳结果列表；
 *     · 用户已切到简报中心等其它屏 → **不打断他**，右下角弹一张通知卡，
 *       点「查看结果」才过去。
 *   失败且人还在检索屏 → 用本地演示动画兜住，避免演示断在半路。
 */
function finishSearch(bootstrap, outcome, msg) {
  /* 失败兜底：还在检索屏就继续跑本地演示（和从前一致） */
  if (outcome === 'failed' && APP.screen === 'search') {
    runLocalDemoSearch();
    return;
  }

  haltSearch();
  if (bootstrap) DATA.hydrateBackend(bootstrap);

  /* 本地降级（无后端 / 任务失败 / 超时）：用「用户本次实际选的地域 / 问句里提到的地域」
     覆盖内置样例里写死的「杭州市」默认提示，让离线演示也跟着查询走。 */
  if (outcome === 'local' && !bootstrap) applyLocalRegionOverride();

  /* 登录用户：结果已在服务端落库，刷新「我的数据」并让检索记录页下次重新拉取 */
  if (typeof AUTH !== 'undefined' && AUTH.authed && AUTH.authed()) {
    if (typeof HISTORY !== 'undefined') HISTORY.loaded = false;
    if (AUTH.refreshMine) AUTH.refreshMine();
  }
  paintRunPill();

  /* 还在检索屏：沿用原来的「出结果自动跳结果列表」。
     但那 finishDelayMs 的宽限期里用户可能已经自己切走了 —— 到点再确认一次，
     切走了就不拽他，改为右下角通知。 */
  if (APP.screen === 'search') {
    SEARCH_STATE.timers.push(setTimeout(() => {
      if (APP.screen === 'search') go('list');
      else showFinishNotice(outcome, msg);
    }, DATA.search.finishDelayMs));
    return;
  }

  /* 人已经切走：右下角弹通知，不强行改他的落地屏 */
  showFinishNotice(outcome, msg);
}

/* 右下角「检索完成 / 未完成」通知卡片（用户已经不在检索屏时用） */
function showFinishNotice(outcome, msg) {
  const N = DATA.search.notify;
  /* 通知里展示「这次检索的是啥」：问句优先；没写问句就展示生效地域 ——
     都没有才给中性占位。不能回落 defaultQuery（那是演示文案，不是用户的检索）。 */
  const q = APP.query || (SEARCH_STATE.regions || []).join(' / ') || '本次检索';
  const n = (DATA.policies && DATA.policies.items) ? DATA.policies.items.length : 0;
  if (outcome === 'failed') {
    notice({
      type: 'warn',
      title: N.failTitle,
      desc: DATA.fmt(N.failDesc, { msg: msg || '' }),
      action: N.failAction,
      closeLabel: N.close,
      onAction: () => go('list'),
      timeoutMs: N.failStayMs,
    });
    return;
  }
  notice({
    type: 'ok',
    title: N.doneTitle,
    desc: DATA.fmt(N.doneDesc, { query: q.length > 20 ? q.slice(0, 20) + '…' : q, n: n }),
    action: N.doneAction,
    closeLabel: N.close,
    onAction: () => go('list'),
    timeoutMs: N.doneStayMs,
  });
}

/**
 * 挂载检索流程。
 *
 *   正常路径：POST /api/v1/searches 建任务 → 轮询进度（步骤 / 源进度 / 抓取日志）
 *             → 完成后取结果回填十命名空间 → 跳结果列表。
 *   后台路径：轮询**不因切屏而中断**；完成时用户若已不在检索屏，
 *             不强行跳转，改为右下角弹通知（「查看结果」一键过去）。
 *   降级路径：接口不可用 / 任务失败 / 超时 → 本地演示动画，保证不白屏、演示可继续。
 */
function mountSearch(go) {
  const S = DATA.search;

  /* ① 从顶栏「检索中 n%」点回来：按现有进度重绘，绝不另起一个任务 */
  if (SEARCH_STATE.running && SEARCH_STATE.reenter) {
    SEARCH_STATE.reenter = false;
    SEARCH_STATE.paintedLogs = 0;
    paintSearchScreen();
    bindSearchCancel(go);
    return;
  }

  /* ② 已有任务在跑，但用户又发起了新检索：先弃掉旧任务，避免两个循环同时写状态 */
  if (SEARCH_STATE.running) {
    if (SEARCH_STATE.taskId && DATA.api) DATA.api.cancelSearch(SEARCH_STATE.taskId).catch(() => {});
    haltSearch();
  }

  /* ③ 全新一次检索：重置视图模型 */
  SEARCH_STATE.running = true;
  SEARCH_STATE.taskId = null;
  SEARCH_STATE.local = false;
  SEARCH_STATE.reenter = false;
  SEARCH_STATE.connLost = false;   // 新检索不该继承上一轮的断连横幅/宽限计时
  SEARCH_STATE.connMsg = '';
  SEARCH_STATE.connSince = 0;
  SEARCH_STATE.pct = 0;
  SEARCH_STATE.step = 0;
  SEARCH_STATE.title = S.runningTitles[0] || S.progress.title;
  SEARCH_STATE.countFrom = S.progress.from;
  SEARCH_STATE.countTotal = S.progress.total;
  SEARCH_STATE.parsed = [];
  SEARCH_STATE.condTitle = '';
  /* 问句原样带走：空就是空。defaultQuery 只是**离线演示**用的样板文案，
     绝不能替用户发起真实检索 —— 否则筛选栏明明全是「不限」，
     条件行却多出「行业 = 智能硬件 · 来自查询」（2026-10-15 用户实报）。 */
  SEARCH_STATE.query = APP.query || '';
  SEARCH_STATE.logs = [];
  SEARCH_STATE.paintedLogs = 0;
  /* 冻结本次检索的地域条件：结果列表要展示「这份结果是按什么地域检索的」，
     之后用户回首页改了筛选，也不该让列表页上的说明跟着变。后端 / 本地降级两条路都走这里。 */
  SEARCH_STATE.regions = (typeof CASCADE !== 'undefined' && CASCADE.selectedNodes)
    ? CASCADE.selectedNodes(false).map((n) => n.name)
    : [];
  /* 新一轮检索 = 一份新的结果集，所以结果列表的**勾选与页码**都从零开始
     （排序方案 LIST_STATE.sort 是用户偏好，跨检索保留）。
     用户报过：再次检索后仍显示「已勾选 4 条 / 对比 (4)」，而那 4 条是上一份结果里的，
     在当前列表里一条都找不到 —— 数字与眼前的东西对不上。 */
  resetListForNewResult();
  paintSearchScreen();
  paintRunPill();
  bindSearchCancel(go);

  /* ---------- 正常路径：后端真实检索（轮询与屏幕解耦） ---------- */
  function poll(taskId, startedAt) {
    if (!SEARCH_STATE.running) return;
    DATA.api.searchStatus(taskId)
      .then((st) => {
        if (!SEARCH_STATE.running) return;
        /* 一连上就清掉断连横幅 —— 中断期间任务还在后端跑，恢复后续看进度 */
        if (SEARCH_STATE.connLost) {
          SEARCH_STATE.connLost = false;
          SEARCH_STATE.connMsg = '';
        }
        SEARCH_STATE.connSince = 0;  // 连通即重置宽限计时
        const total = (st.progress && st.progress.total) || 0;
        const from = (st.progress && st.progress.from) || 0;
        SEARCH_STATE.pct = total ? (from / total) * 100 : 0;
        SEARCH_STATE.countFrom = from;
        SEARCH_STATE.countTotal = total;
        SEARCH_STATE.step = st.step || 0;
        SEARCH_STATE.title = (S.runningTitles[st.step || 0]) || S.progress.title;
        if (st.parsed && st.parsed.length) SEARCH_STATE.parsed = st.parsed;
        if (st.condTitle) SEARCH_STATE.condTitle = st.condTitle;
        if (st.logs && st.logs.length) SEARCH_STATE.logs = st.logs;
        paintSearchScreen();
        paintRunPill();

        if (st.status === 'running') {
          if (Date.now() - startedAt > S.timeoutMs) {
            toast(DATA.fmt(S.timeoutHint, { s: Math.round(S.timeoutMs / 1000) }), 'warn');
            haltSearch();
            runLocalDemoSearch();
            return;
          }
          SEARCH_STATE.timers.push(setTimeout(() => poll(taskId, startedAt), S.pollMs));
          return;
        }
        if (st.status !== 'succeeded') {
          haltSearch();
          finishSearch(null, 'failed', st.error || st.status);
          return;
        }
        DATA.api.searchResult(taskId)
          .then((res) => { if (SEARCH_STATE.running) finishSearch(res && res.bootstrap, 'ok'); })
          .catch((err) => {
            if (!SEARCH_STATE.running) return;
            haltSearch();
            finishSearch(null, 'failed', err && err.message ? err.message : err);
          });
      })
      .catch((err) => {
        if (!SEARCH_STATE.running) return;
        /* 断连不降级、不白屏：横幅 + 定时重试。检索任务还在后端跑着，
           恢复后下一次轮询接上进度即可继续（2026-10-16 用户口径）。
           两类终态不再重试：重试超过总窗口（S.timeoutMs）/ 后端重启导致任务丢失。
           ★ 宽限期（S.connGraceMs）：刚断的这几秒只静默重试、不亮黄条 ——
           演示时后端重启/网络抖动一两秒就满屏黄条，观感像系统挂了。 */
        if (err && err.code === 'TASK_NOT_FOUND') {
          SEARCH_STATE.connLost = true;
          SEARCH_STATE.connMsg = S.connTaskLost;
          paintSearchScreen();
          haltSearch();
          toast(S.connTaskLost, 'warn');
          return;
        }
        if (Date.now() - startedAt > S.timeoutMs) {
          SEARCH_STATE.connLost = true;
          SEARCH_STATE.connMsg = S.connLostGiveUp;
          paintSearchScreen();
          haltSearch();
          toast(DATA.fmt(S.backendFailed, { msg: (err && err.message) ? err.message : err }), 'warn');
          return;
        }
        if (!SEARCH_STATE.connSince) SEARCH_STATE.connSince = Date.now();
        const graceMs = Number(S.connGraceMs) > 0 ? Number(S.connGraceMs) : 15000;
        if (Date.now() - SEARCH_STATE.connSince < graceMs) {
          /* 宽限期内：静默重试，屏幕上什么都不变（进度条停在原处，用户无感） */
          SEARCH_STATE.connLost = false;
          SEARCH_STATE.connMsg = '';
          SEARCH_STATE.timers.push(setTimeout(() => poll(taskId, startedAt), S.pollMs));
          return;
        }
        SEARCH_STATE.connLost = true;
        SEARCH_STATE.connMsg = S.connLost;
        paintSearchScreen();
        SEARCH_STATE.timers.push(setTimeout(() => poll(taskId, startedAt), S.pollMs * 2));
      });
  }

  if (DATA.api && typeof fetch === 'function') {
    /* 首次检索时说明当前用的是哪个抽取引擎（本地免费引擎 / 云端免费模型） */
    if (!SEARCH_STATE.engineNoticed) {
      SEARCH_STATE.engineNoticed = true;
      DATA.api.llmStatus()
        .then((st) => { if (st && st.note) toast(st.note, st.isRemote ? 'ok' : 'info'); })
        .catch(() => {});
    }

    /* 地域：只发**已生效**的（applied）。
       面板里「勾了但没点确定」的草稿不算数 —— 这是「点确定才生效」的口径；
       以前把 draft ∪ applied 一起发，导致随手点过的省份静默生效，
       检索记录里就会出现「查询问的是杭州、地域却是西藏 + 新疆」这种自相矛盾的条目。
       草稿被丢弃时 closeCasc() 会明确提示，不会静默吞掉用户的勾选。
       后端优先级：显式地域 > 查询文本识别，所以筛选栏没选时仍能从问句里识别到杭州市。 */
    const selectedRegions = (typeof CASCADE !== 'undefined' && CASCADE.selectedNodes)
      ? CASCADE.selectedNodes(false).map((n) => n.name)
      : [];
    /* 首页「条件精确筛选」的四个维度一并交给服务端，供其整合进提示词。
       行业 / 类型是多选 → 用「 / 」拼成一个字符串；截止时间是单选 → 取唯一值。 */
    FILTER_STATE.ensure();
    const sep = (DATA.home && DATA.home.filter && DATA.home.filter.joinSep) || ' / ';
    const join = (g) => FILTER_STATE.values(g).join(sep);
    const first = (g) => FILTER_STATE.values(g)[0] || '';

    DATA.api.startSearch({
      query: APP.query || '',
      regions: selectedRegions,
      industries: join('industry'),
      types: join('type'),
      deadline: first('deadline'),
    })
      .then((task) => {
        if (!SEARCH_STATE.running) return;
        SEARCH_STATE.taskId = task.taskId;
        if (task.parsed) SEARCH_STATE.parsed = task.parsed;
        if (task.condTitle) SEARCH_STATE.condTitle = task.condTitle;
        if (task.progress) {
          SEARCH_STATE.countFrom = task.progress.from || 0;
          SEARCH_STATE.countTotal = task.progress.total || 0;
        }
        SEARCH_STATE.step = task.step || 0;
        paintSearchScreen();
        poll(task.taskId, Date.now());
      })
      .catch((err) => {
        toast(DATA.fmt(S.backendFailed, { msg: err && err.message ? err.message : err }), 'warn');
        runLocalDemoSearch();
      });
  } else {
    runLocalDemoSearch();
  }
}

function renderSearch(query) {
  const S = DATA.search;
  const q = query || '';   // 空就空 —— 演示指纹由 searchCondTitle() 按 running/离线状态自己决定
  const steps = S.steps.map((s, i) =>
    `<div class="step" data-step="${i}"><span class="sn">${i + 1}</span><span class="sl">${s}</span><i class="line"></i></div>`).join('');

  const parsed = S.parsed.map((p) => `<span class="pk">${p}</span>`).join('');

  return `
  <div class="screen">
    ${topBar('home')}
    <div class="search-body">
      <div class="banner warn" id="pipeConnLost" hidden>
        <span class="bn-ic">${ICON.alert}</span>
        <div class="bn-main">
          <div class="bn-ttl"></div>
          <div class="bn-desc">检索任务仍在后端运行，恢复连接后进度自动接上。</div>
        </div>
      </div>
      <div class="search-echo">
        <div class="q" id="pipeEcho" data-tip="${escHtml(q)}" aria-label="${escHtml(q)}">${searchCondTitle(q)}</div>
        <div class="parsed" id="pipeParsed">
          <span>${S.parsedLabel}</span>
          ${parsed}
        </div>
      </div>

      <div class="pipeline">${steps}</div>

      <div class="progress-card">
        <div class="progress-top">
          <span class="pt" id="pipeTitle">${S.progress.title}</span>
          <span class="pv" id="pipeCount">${S.progress.from} / ${S.progress.total} ${S.progress.unit}</span>
          <span class="pc">${S.progress.path}</span>
        </div>
        <div class="bar"><i id="pipeBar" style="width:0%"></i></div>
        <ul class="loglist" id="fetchLogs"></ul>
      </div>

      <div style="display:flex;align-items:center;gap:14px">
        <button class="btn btn-outline" data-cancel="1">${S.cancel}</button>
        <span class="hint">${S.hint}</span>
      </div>
    </div>
  </div>`;
}
