/* ============================================================
   屏幕渲染 · 3 结果列表 + 4 政策详情 + 5 简报预览与导出
   —— 全部文案与字段取自 DATA.*（data/*.json）
   ============================================================ */

/* ---------- 结果卡片 ---------- */
function policyCard(p, picked) {
  const C = DATA.list.card;
  const badge = p.unverified
    ? `<span class="badge badge-warn">${ICON.alert}${DATA.fmt(C.unverified, { n: p.unverified })}</span>`
    : `<span class="badge badge-ok">${ICON.ok}${C.verified}</span>`;
  const lvl = `<span class="lvl ${p.levelKey}">${p.level}</span>`;
  return `
  <article class="result-card ${picked ? 'picked' : ''}" data-policy="${p.id}">
    <span class="rc-corner mono-sm">${p.corner}</span>
    <div class="rc-top">
      <span class="checkbox ${picked ? 'on' : ''}" data-pick="${p.id}">${picked ? ICON.check : ''}</span>
      <div class="rc-name" data-open="${p.id}">${p.name}</div>
      <div class="rc-badges">${badge}</div>
    </div>
    <div class="rc-meta">
      <span>${p.issuer}</span><span class="sep">·</span>${lvl}<span class="sep">·</span>
      <span>${p.types}</span><span class="sep">·</span><span>${DATA.fmt(C.publish, { d: p.publish })}</span>
      <span class="sep">·</span><span>${p.valid}</span><span class="sep">·</span><span>${p.dedup}</span>
    </div>
    <div class="rc-kv">
      <span class="item"><span class="k">${C.kDeadline}</span><span class="v">${p.daysLeft ? DATA.fmt(C.deadlineValue, { deadline: p.deadline, n: p.daysLeft }) : `<b>${p.deadline}</b>`}</span></span>
      <span class="item"><span class="k">${C.kSubsidy}</span><span class="v">${p.subsidy}</span></span>
      <span class="item"><span class="k">${C.kConditions}</span><span class="v">${p.conditions.join(' / ')}</span></span>
    </div>
    <div class="rc-foot">
      <span>${C.srcPrefix}${p.sources.map((s) => s.name).join(' · ')}</span>
      <span class="spacer"></span>
      <span>${C.footHint}</span>
    </div>
  </article>`;
}

/* ============================================================
   3 · 结果列表
   ============================================================ */
const LIST_STATE = { picked: new Set(), view: 'grid', sort: null, page: 1, compareOpen: false };

/** 新一份结果集落地 ⇒ 列表屏的「临时态」全部从零开始。

    用户报过：再次检索后列表头仍写着「已勾选 4 条」、工具条写着「对比 (4)」，
    可那 4 条是**上一份结果**的勾选，在当前列表里一条都找不到（「全选」还是未勾状态）
    —— 数字与眼前的东西对不上，还会被带进对比 / 简报。

    勾选是「对眼前这份结果的表态」，换了结果集就必须清空；页码与对比浮层同理。
    调用点覆盖所有「灌进一份新结果集」的路径：发起检索（screens-a.js）与
    历史回放 / 启动回放（经 data.js → hydrateBackend）。

    注意：**启动时也一条都不勾**（app.js → boot() 显式 `new Set()`）。
    曾经启动会灌入 `list.defaultPicked`（后端 top2）当「演示态」，结果是刚进应用
    就有 2 条勾选、简报中心还照着它们排版 —— 用户会以为自己选过。 */
function resetListForNewResult() {
  LIST_STATE.picked = new Set();
  LIST_STATE.page = 1;
  LIST_STATE.compareOpen = false;
  /* 简报横幅同理：上一份文件的清单来自上一份结果集，留着只会误导
     （文件名与内容都对不上眼前这份清单了）。 */
  if (typeof BRIEF_STATE !== 'undefined') briefInvalidate();
}

/** 勾选 / 范围 / 格式一变，上一份简报就不再对应眼前这份设置 —— 收掉成功横幅。 */
function briefInvalidate() {
  BRIEF_STATE.exported = false;
  BRIEF_STATE.result = null;
  BRIEF_STATE.error = '';
}

/* ---------- 排序（data 驱动） ----------
   下拉菜单、按钮文案、分页说明、本地重排都读同一份 tools.sortOptions。
   原型只在本地重排、不重新请求后端，所以排序键全部取自政策实体已有的字段。 */
function listSortKey() {
  return LIST_STATE.sort || DATA.list.tools.sortDefault;
}
function listSortLabel(v) {
  const key = v || listSortKey();
  const o = (DATA.list.tools.sortOptions || []).find((x) => x.v === key);
  return o ? o.label : '';
}
function sortedPolicies() {
  const items = DATA.policies.items.slice();
  const P = DATA.list.tools;
  /* 权威度 = 政策层级由高到低；层级名没被收录的排到最后（不是排到最前） */
  const rank = (lv) => {
    const i = (P.levelOrder || []).indexOf(lv);
    return i < 0 ? 99 : i;
  };
  const by = {
    authority: (a, b) => rank(a.level) - rank(b.level)
      || String(b.publish).localeCompare(String(a.publish)),
    publish: (a, b) => String(b.publish).localeCompare(String(a.publish)),
    deadline: (a, b) => (a.daysLeft == null ? 1e9 : a.daysLeft) - (b.daysLeft == null ? 1e9 : b.daysLeft),
    confidence: (a, b) => (b.confidence || 0) - (a.confidence || 0),
  };
  return items.sort(by[listSortKey()] || by.authority);
}

/** 排序下拉菜单。**常驻在 DOM 里、用 `.sortwrap.open` 控制显隐** ——
 *  展开 / 收起只摘挂一个 class、不重渲染，这样「点外面收起」不会因为
 *  某个分支提前 `return` 而漏掉（重渲染会把正在被点的节点换掉）。 */
function sortMenuHTML() {
  const cur = listSortKey();
  return `
    <div class="sortmenu" id="sortMenu" role="listbox">
      ${(DATA.list.tools.sortOptions || []).map((o) => `
        <button class="sortopt ${o.v === cur ? 'on' : ''}" data-sort-opt="${escHtml(o.v)}" role="option">
          <span class="so-main">
            <span class="so-t">${escHtml(o.label)}</span>
            <span class="so-h">${escHtml(o.hint)}</span>
          </span>
          <span class="so-c">${o.v === cur ? ICON.check : ''}</span>
        </button>`).join('')}
    </div>`;
}

/* ---------- 表格视图 ----------
   一行 = 一条政策。勾选 / 打开详情复用卡片同款的 data-pick / data-open，
   所以事件层不需要为表格新增分支。 */
function policyRow(p, picked) {
  const T = DATA.list.table;
  const C = DATA.list.card;
  const left = p.daysLeft == null ? T.leftUnknown : DATA.fmt(T.leftUnit, { n: p.daysLeft });
  const urgent = p.daysLeft != null && p.daysLeft <= 30;
  return `
  <tr class="rt-row ${picked ? 'picked' : ''}" data-policy="${p.id}">
    <td class="rt-pick"><span class="checkbox ${picked ? 'on' : ''}" data-pick="${p.id}">${picked ? ICON.check : ''}</span></td>
    <td class="rt-name">
      <span class="rt-n" data-open="${p.id}">${p.name}</span>
      <span class="rt-sub">${p.issuer} · ${p.dedup}${p.unverified ? ` · ${DATA.fmt(C.unverified, { n: p.unverified })}` : ''}</span>
    </td>
    <td><span class="lvl ${p.levelKey}">${p.level}</span></td>
    <td class="rt-types">${p.types}</td>
    <td class="mono-sm">${p.publish}</td>
    <td class="mono-sm">${p.deadline}</td>
    <td class="mono-sm ${urgent ? 'urgent' : ''}">${left}</td>
    <td class="rt-subsidy">${p.subsidy}</td>
  </tr>`;
}

function listTableHTML(rows) {
  const T = DATA.list.table;
  const C = T.cols;
  if (!rows.length) return `<div class="result-table"><div class="fpanel-empty">${T.empty}</div></div>`;
  return `
  <div class="result-table scroll">
    <table>
      <thead>
        <tr>
          <th class="rt-pick"></th>
          <th>${C.name}</th>
          <th>${C.level}</th>
          <th>${C.types}</th>
          <th>${C.publish}</th>
          <th>${C.deadline}</th>
          <th>${C.left}</th>
          <th>${C.subsidy}</th>
        </tr>
      </thead>
      <tbody>${rows.map((p) => policyRow(p, LIST_STATE.picked.has(p.id))).join('')}</tbody>
    </table>
  </div>`;
}

/* ---------- 分页 ----------
   页码口径（共几条）**以当前结果集的实际条数 `DATA.policies.items.length` 为准**。
   原型里结果集是全量在手的（本地切片，不向后端分页要数据），所以「声明一个比实际更大的
   总数」只会有害无益 —— 翻到没有数据的页码就是一张空页。历史问题正是如此：
   静态 bootstrap 声明「共 96 条」（那是内置样例集的规模），而一次检索实际只产出 10 条，
   于是第 2 页起全是「本页暂无内容」。
   `list.pager.total` 只在「本地一条都没有」时兜底（例如数据尚未装载的空态）。
   每页条数 `perPage` 仍是后端给的结果集元数据。 */
function listActualTotal() {
  return (DATA.policies && DATA.policies.items) ? DATA.policies.items.length : 0;
}
function listTotal() {
  const actual = listActualTotal();
  if (actual > 0) return actual;
  const n = Number((DATA.list.pager || {}).total);
  return n > 0 ? n : 0;
}
function listPerPage() {
  const n = Number((DATA.list.pager || {}).perPage);
  return n > 0 ? n : 20;
}
function listPageCount() {
  return Math.max(1, Math.ceil(listTotal() / listPerPage()));
}
function listPage() {
  const n = Number(LIST_STATE.page) || 1;
  return Math.min(Math.max(1, Math.round(n)), listPageCount());
}
/** 本页要渲染的条目（先按当前排序口径排好，再取本页那一段） */
function pageItems() {
  const all = sortedPolicies();
  const per = listPerPage();
  const start = (listPage() - 1) * per;
  return all.slice(start, start + per);
}

/* ---------- 对比视图 ----------
   勾选 2–5 条后并排比对核心字段；比对项与顺序全部来自 data/list.json → compare.rows，
   取值口径集中在 compareValue()，加字段只要改数据 + 这一个 switch。 */
function compareValue(k, p) {
  const T = DATA.list.table;
  const C = DATA.list.card;
  const by = {
    level: () => p.level,
    issuer: () => p.issuer,
    types: () => p.types,
    industries: () => p.industries,
    publish: () => p.publish,
    deadline: () => p.deadline,
    left: () => (p.daysLeft == null ? T.leftUnknown : DATA.fmt(T.leftUnit, { n: p.daysLeft })),
    subsidy: () => p.subsidy,
    conditions: () => (p.conditions || []).join(' / '),
    sources: () => (p.sources || []).map((s) => s.name).join(' / '),
    confidence: () => Number(p.confidence || 0).toFixed(2),
    verify: () => (p.unverified
      ? DATA.fmt(C.unverified, { n: p.unverified })
      : C.verified),
  };
  return (by[k] || (() => ''))();
}

/** 已勾选的政策（按当前排序顺序展示，和列表里看到的先后一致） */
function pickedPolicies() {
  return sortedPolicies().filter((p) => LIST_STATE.picked.has(p.id));
}

function comparePanelHTML() {
  const C = DATA.list.compare;
  const list = pickedPolicies();
  if (!LIST_STATE.compareOpen || list.length < 2) return '';

  const rows = C.rows.map((r) => {
    const vals = list.map((p) => compareValue(r.k, p));
    const same = vals.every((v) => v === vals[0]);
    return `
      <tr class="${same ? 'same' : 'diff'}">
        <th scope="row">
          <span class="cmp-lb">${escHtml(r.label)}</span>
          <span class="cmp-tag ${same ? 'same' : 'diff'}">${same ? C.sameBadge : C.diffBadge}</span>
        </th>
        ${vals.map((v) => `<td>${escHtml(v)}</td>`).join('')}
      </tr>`;
  }).join('');

  return `
  <div class="cmp-mask" data-cmp-mask="1">
    <div class="cmp-panel" role="dialog" aria-modal="true" aria-label="${escHtml(C.title)}">
      <div class="cmp-head">
        <div class="cmp-title">
          <h3>${escHtml(C.title)}</h3>
          <p>${escHtml(DATA.fmt(C.sub, { n: list.length, fields: C.rows.length }))}</p>
        </div>
        <button class="btn btn-outline btn-sm" data-cmp-close="1">${escHtml(C.close)}</button>
      </div>
      <div class="cmp-body scroll">
        <table class="cmp-table">
          <thead>
            <tr>
              <th class="cmp-f">${escHtml(C.fieldHead)}</th>
              ${list.map((p) => `<th><span class="lvl ${p.levelKey}">${p.level}</span>${escHtml(p.name)}</th>`).join('')}
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  </div>`;
}

function pagerHTML() {
  const P = DATA.list.pager;
  const cur = listPage();
  const pages = listPageCount();
  const btn = (v) => `<button class="pg ${v === cur ? 'on' : ''}" data-page="${v}"
      aria-label="${escHtml(DATA.fmt(v === cur ? P.currentAria : P.pageAria, { n: v }))}"
      ${v === cur ? 'aria-current="page"' : ''}>${v}</button>`;
  const dots = `<span class="pg-dots mono-sm">${escHtml(P.ellipsis)}</span>`;
  /* 页数少就全列（5 页没必要省略号）；多了才窗口化：首、尾、当前页前后各一。 */
  const nums = [];
  if (pages <= 7) {
    for (let i = 1; i <= pages; i++) nums.push(btn(i));
  } else {
    for (let i = 1; i <= pages; i++) {
      if (i === 1 || i === pages || Math.abs(i - cur) <= 1) nums.push(btn(i));
      else if (nums[nums.length - 1] !== dots) nums.push(dots);
    }
  }
  return `
  <div class="pager">
    <span>${DATA.fmt(P.textTpl, {
      total: listTotal(), perPage: listPerPage(), cur, pages, sort: listSortLabel(),
    })}</span>
    <span class="spacer"></span>
    <button class="pg pg-nav" data-page="${cur - 1}" ${cur <= 1 ? 'disabled' : ''}
      aria-label="${escHtml(P.prev)}" title="${escHtml(P.prev)}">${escHtml(P.prev)}</button>
    ${nums.join('')}
    <button class="pg pg-nav" data-page="${cur + 1}" ${cur >= pages ? 'disabled' : ''}
      aria-label="${escHtml(P.next)}" title="${escHtml(P.next)}">${escHtml(P.next)}</button>
  </div>`;
}

/* 结果列表顶部的地域是**只读回显** —— 它回答「这份结果是按什么地域检索出来的」。
   要改地域条件得回首页改完重新检索，所以这里的触发器不给 caret / 清空 / ×，
   也不挂 data-region-trigger（点了不会弹面板）。 */
function renderList() {
  const L = DATA.list;
  const items = pageItems();
  const n = LIST_STATE.picked.size;
  const cmp = Math.max(L.tools.minCompare, n);
  const isRows = LIST_STATE.view === 'rows';
  const body = items.length
    ? (isRows
      ? listTableHTML(items)
      : `<div class="result-list scroll">${items.map((p) => policyCard(p, LIST_STATE.picked.has(p.id))).join('')}</div>`)
    : `<div class="result-list scroll"><div class="fpanel-empty">${escHtml(L.pager.empty)}</div></div>`;

  return `
  <div class="screen">
    ${topBar('list')}
    <div class="list-body">
      <div class="list-head">
        <h2>${(L.head || {}).title || ''}</h2>
        <span class="meta">${(L.head || {}).meta || ''}</span>
        ${(DATA.search || {}).understood === false ? `
        <div class="banner warn" style="margin-top:2px">
          <span class="bn-ic">${ICON.alert}</span>
          <div class="bn-main">
            <div class="bn-ttl">${escHtml((DATA.search || {}).notUnderstoodTitle || '您的搜索我不太理解')}</div>
            <div class="bn-desc">${escHtml((DATA.search || {}).notUnderstoodDesc || '请换个说法重试，或用筛选条件选好地域 / 行业 / 类型后再发起检索。')}</div>
          </div>
        </div>` : ''}
        <div class="list-tools">
          <div class="sortwrap">
            <button class="select-like" data-sort="1"
              title="${escHtml(L.tools.sortTitle)}">${L.tools.sortPrefix}${escHtml(listSortLabel())} ${ICON.caret}</button>
            ${sortMenuHTML()}
          </div>
          <div class="viewseg">
            <button class="btn btn-sm ${isRows ? 'btn-ghost' : 'btn-outline on'}" data-view="grid">${ICON.grid}${L.tools.grid}</button>
            <button class="btn btn-sm ${isRows ? 'btn-outline on' : 'btn-ghost'}" data-view="rows">${ICON.rows}${L.tools.rows}</button>
          </div>
          <button class="btn btn-outline btn-sm" data-compare="1"
            title="${escHtml(L.tools.compareTitle)}">${DATA.fmt(L.tools.compare, { n: cmp })}</button>
          <button class="btn btn-solid btn-sm" data-go="brief">${ICON.down}${L.tools.export}</button>
        </div>
      </div>

      <div class="filterbar">
        <div class="fb-row">
          <span class="fb-label">${L.filter.regionLabel}</span>
          <span class="fb-tags" id="rgListSlot">${regionTrigger({
            max: DATA.region.trigger.denseMax, id: 'rgList', dense: true,
            readonly: true, label: '', none: L.filter.regionNone,
          })}</span>
          <span class="fb-hint">${L.filter.regionHint}</span>
        </div>
        <div class="fb-row">
          <span class="fb-label">${L.filter.condLabel || ''}</span>
          <span class="hint">${searchedCondSummary()}</span>
        </div>
      </div>

      <div class="listhead-row">
        <span class="checkbox ${items.length && items.every((p) => LIST_STATE.picked.has(p.id)) ? 'on' : ''}"
          data-select-all="1">${items.length && items.every((p) => LIST_STATE.picked.has(p.id)) ? ICON.check : ''}</span>
        <span>${DATA.fmt(L.selectAll, { n: items.length })}</span>
        <span class="spacer"></span>
        <span id="pickCount">${DATA.fmt(L.pickedCount, { n })}</span>
        <button class="btn btn-link" data-go="brief">${L.genBrief}</button>
      </div>

      ${body}

      ${pagerHTML()}
    </div>
    ${comparePanelHTML()}
  </div>`;
}

/* ============================================================
   4 · 政策详情 · 字段级溯源
   ============================================================ */
/* ============================================================
   4 · 政策详情
   ------------------------------------------------------------
   左栏回答「我能不能申、申了怎么走」：
     · 申报条件 = **逐条自查清单**（可勾选）。用户反馈的「申请的相关条例不明确、
       没法直观看到自己想申请的政策」就出在这儿 —— 以前每条是一整段长句，
       关键数字与办理路径全埋在文字里，读不出「我到底要满足哪几条」。
     · 申报流程 / 申报入口 = 补上「满足之后去哪办」。光把条件读懂还不够，
       用户下一步要知道找谁、在哪提交。
       两者由 detailGuidance() 用 data/detail.json 的模板 + 本条政策的发文机关渲染；
       同一份结果还会随提问一起送给后端，模型的事实底座因此也含流程与入口。
   右栏 = 「问政策」AI 对话（原来那块「原文快照 · 字段级溯源」整块让位）。
     溯源能力**没有被砍掉** —— 收进「查看原文」按钮的弹层（#snapDialog）：
     「逐字段可回溯到公开原文」是这款产品的立身之本，不能因为让位给对话就丢掉。
   ============================================================ */
const DETAIL_STATE = {
  checks: {},        // { [policyId]: { [i]: true } } 自查勾选（纯前端视图状态，不落库）
  chat: {},          // { [policyId]: { messages, loading, error, loaded } }
  snapOpen: false,   // 原文快照弹层：只摘挂 hidden，不重渲染（免滚动位置/输入焦点丢失）
};

/** 关键数字高亮：把「决定能不能申」的数字挑出来加视觉权重。
    只加样式、不动文本 —— 复制出去仍是原句。先 escHtml 再匹配是安全的：
    数字与单位都不含被转义的字符。 */
const KEYNUM_RE = /(\d[\d,.]*\s*(?:万元|亿元|元|%|％|个月|年|天|吨标准煤|人|件|台（套）))/g;

function markKeyNumbers(text) {
  return escHtml(text).replace(KEYNUM_RE, '<mark class="kn">$1</mark>');
}

/** 本条政策的申报流程 / 申报入口：模板（data/detail.json）× 本条政策的发文机关。
    返回两份：`steps/channels` 是给后端用的纯文本行，`stepList/channelList` 是给左栏画卡片用的。 */
function detailGuidance(p) {
  const D = DATA.detail;
  const issuer = p.issuer || '受理单位';
  const fill = (s) => DATA.fmt(String(s || ''), { issuer });
  const steps = (D.steps.items || []).map((it) => ({ t: fill(it.t), d: fill(it.d) }));
  const channels = (D.channel.items || []).map((it) => ({ k: fill(it.k), v: fill(it.v) }));
  return {
    stepList: steps,
    channelList: channels,
    steps: steps.map((x) => x.t + '：' + x.d),
    channels: channels.map((x) => x.k + '：' + x.v),
  };
}

/** 随提问送出的政策上下文（字段名与后端 app/llm/prompts.py → _chat_policy_block 对齐）。
    只送回答用得上的字段 —— 别把整条政策原样吐回去，那会把提示词撑满。 */
function policyChatContext(p) {
  return {
    id: p.id,
    name: p.name,
    level: p.level,
    issuer: p.issuer,
    publish: p.publish,
    deadline: p.deadline,
    daysLeft: p.daysLeft,
    subsidy: p.subsidy,
    types: p.types,
    industries: p.industries,
    conditions: p.conditions || [],
    conditionsFull: p.conditionsFull || [],
    materials: p.materials || [],
    sources: (p.sources || []).map((s) => ({ name: (typeof s === 'string' ? s : s.name) })),
  };
}

/* ---------- 自查清单 ---------- */
function checkMap(pid) {
  if (!DETAIL_STATE.checks[pid]) DETAIL_STATE.checks[pid] = {};
  return DETAIL_STATE.checks[pid];
}

/** 自查进度的一句话（三种措辞，见 data/detail.json → conditions）。 */
function checkSummary(p, pid) {
  const C = DATA.detail.conditions;
  const total = (p.conditionsFull || []).length;
  if (!total) return '';
  const n = Object.keys(checkMap(pid)).length;
  if (!n) return DATA.fmt(C.sumNone, { m: total });
  if (n >= total) return DATA.fmt(C.sumAll, { n, m: total });
  return DATA.fmt(C.sumSome, { n, m: total, k: total - n });
}

/* ---------- 对话面板 ---------- */
function chatState(pid) {
  if (!DETAIL_STATE.chat[pid]) {
    DETAIL_STATE.chat[pid] = { messages: [], loading: false, error: '', loaded: false, epoch: 0 };
  }
  return DETAIL_STATE.chat[pid];
}

function isSignedIn() {
  return typeof AUTH !== 'undefined' && typeof AUTH.authed === 'function' && AUTH.authed();
}

function chatMsgHTML(m) {
  const C = DATA.detail.chat;
  const mine = m.role === 'user';
  const meta = [];
  if (!mine) {
    meta.push(`<span class="cm-tag ${m.degraded ? 'warn' : ''}">${
      escHtml(m.degraded ? C.degradedTag : C.modelTag)}</span>`);
    if (m.unsaved) meta.push(`<span class="cm-tag ghost">${escHtml(C.unsavedTag)}</span>`);
  }
  return `
    <div class="cmsg ${mine ? 'me' : 'ai'}">
      <div class="cm-body">${escHtml(m.content).replace(/\n/g, '<br>')}</div>
      ${meta.length ? `<div class="cm-meta">${meta.join('')}</div>` : ''}
    </div>`;
}

function chatBodyHTML(pid) {
  const C = DATA.detail.chat;
  const st = chatState(pid);
  const parts = [];
  if (!st.messages.length && !st.loading) {
    parts.push(`
      <div class="chat-empty">
        <span class="ce-ic">${ICON.chat}</span>
        <h4>${escHtml(C.emptyTitle)}</h4>
        <p>${escHtml(C.emptyDesc)}</p>
        <div class="chat-sugs">${(C.suggestions || []).map((s) =>
          `<button class="sug" data-chat-sug="${escHtml(s)}">${escHtml(s)}</button>`).join('')}</div>
      </div>`);
  }
  parts.push(st.messages.map(chatMsgHTML).join(''));
  if (st.loading) {
    parts.push(`<div class="cmsg ai typing"><span class="dot"></span><span class="dot"></span>`
      + `<span class="dot"></span><span class="typing-t">${escHtml(C.thinking)}</span></div>`);
  }
  if (st.error) {
    parts.push(`<div class="chat-err">${ICON.alert}<span>${escHtml(st.error)}</span></div>`);
  }
  return parts.join('');
}

/** 右栏对话面板（原来的 .srcpanel 位置）。 */
function chatPanelHTML(pid) {
  const C = DATA.detail.chat;
  const st = chatState(pid);
  const signed = isSignedIn();
  return `
  <aside class="chatpanel">
    <header>
      <h3>${ICON.chat}<span>${escHtml(C.title)}</span></h3>
      <span class="spacer"></span>
      ${st.messages.length
        ? `<button class="btn btn-ghost btn-sm" data-chat-clear="1">${escHtml(C.clear)}</button>` : ''}
    </header>
    <p class="cp-sub">${escHtml(C.sub)}</p>
    <div class="cp-body scroll" id="chatBody">${chatBodyHTML(pid)}</div>
    ${signed ? '' : `<div class="cp-guest">
      <span>${escHtml(C.guestNotice)}</span>
      <button class="btn btn-link btn-sm" data-go="login">${escHtml(C.guestGo)}</button>
    </div>`}
    <div class="cp-foot">
      <textarea id="chatQ" class="cp-in" rows="1"
        placeholder="${escHtml(C.placeholder)}"></textarea>
      <button class="btn btn-solid btn-sm cp-send" data-chat-send="1" type="button">
        ${ICON.send}<span>${escHtml(C.send)}</span>
      </button>
    </div>
  </aside>`;
}

/** 按后端给出的**真实字符偏移**把原文里的命中句包进 <mark>。
    先 escHtml 再按偏移切 —— 只要切点在标签外就安全：偏移来自纯文本，
    而转义只会让文本变长，所以必须**先转义再切**会错位。因此这里反过来：
    先按纯文本偏移切段，再对每段分别转义后拼接。 */
function markByOffsets(text, spans) {
  const t = String(text || '');
  const list = (spans || [])
    .filter((s) => Array.isArray(s) && s.length === 2 && s[0] >= 0 && s[1] > s[0] && s[1] <= t.length)
    .sort((a, b) => a[0] - b[0]);
  if (!list.length) return escHtml(t);
  let out = '';
  let cur = 0;
  list.forEach(([s, e]) => {
    if (s < cur) return;                       // 与前一段重叠 → 跳过（后端已去重，防御）
    out += escHtml(t.slice(cur, s)) + '<mark>' + escHtml(t.slice(s, e)) + '</mark>';
    cur = e;
  });
  return out + escHtml(t.slice(cur));
}

/** 原文快照弹层主体（与改造前的右栏内容一致，只是换了容器）。 */
function snapBodyHTML(p) {
  const D = DATA.detail;
  const conds = p.conditionsFull || [];
  const hl = conds[1] || conds[0] || '';
  /* 快照正文跟「本条政策」走：优先用后端随条下发的 p.snapshot（**纯文本**原文摘录）。
     高亮不再由后端塞 <mark>，而是前端按 p.snapshotMarks 里那组**真实字符偏移**插入 ——
     这样「偏移说的地方」和「高亮的地方」天然是同一处，不会再各说一套
     （改造前后端下发的是 `1200 + index*437` 的编造偏移，和正文毫无关系）。
     没有偏移也没有摘录的（离线样例集）退化为本条条件原文 + 关键数字高亮。 */
  const raw = typeof p.snapshot === 'string' ? p.snapshot : '';
  let body;
  if (raw && Array.isArray(p.snapshotMarks) && p.snapshotMarks.length) {
    body = markByOffsets(raw, p.snapshotMarks);
  } else if (raw) {
    body = escHtml(raw);
  } else {
    body = `……${markKeyNumbers(hl)}……`;
  }
  /* 连原文摘录都没有（远端模型没给 excerpt）时如实说明，别让人以为这就是原文 */
  const synth = p.snapshotSynthetic
    ? `<div class="banner warn" style="padding:8px 10px;margin-bottom:8px">
         <span class="bn-ic">${ICON.alert}</span>
         <div class="bn-main"><div class="bn-desc">${escHtml(D.snapshot.syntheticNote)}</div></div>
       </div>`
    : '';
  const srcRows = (p.sources || []).map((s) => {
    const name = typeof s === 'string' ? s : s.name;
    const kind = typeof s === 'string' ? '' : (s.kind || '');
    /* 「打开原文」必须是真的能点：数据源给了 url 就用 url；实在没有的（大模型自造
       政策名等），落中国政府网站内检索该政策名 —— 官方域直达检索结果，
       绝不送百度（2026-10-14 用户二度实测踩到）。 */
    const url = (typeof s === 'object' && s && s.url)
      || 'https://sousuo.www.gov.cn/sousuo/search.shtml?code=17da70961a7&searchWord='
        + encodeURIComponent((p.name || name || '').replace(/^《|》$/g, ''));
    return `
    <li>
      <span class="sp">${escHtml(name)}${escHtml(D.snapshot.sourceSep)}${escHtml(kind)}</span>
      <a class="btn btn-link" href="${escHtml(url)}" target="_blank" rel="noopener noreferrer">${escHtml(D.snapshot.openSource)} ${ICON.ext}</a>
    </li>`;
  }).join('');
  /* 底部那行「高亮：… · 字符偏移 X–Y」印的是**第一条真正命中的**区间与它的真实偏移。
     没有命中区间就整行不印 —— 以前这里印的是 p.offset（编造值），
     与上面正文对不上，正是用户说的「有些条件在原文中都看不到」。 */
  const marks = Array.isArray(p.snapshotMarks) ? p.snapshotMarks : [];
  const first = marks.length ? marks[0] : null;
  const hlText = first ? raw.slice(first[0], first[1]) : '';
  const offRow = first
    ? `<div class="off" style="margin-top:8px">${escHtml(D.snapshot.hlPrefix)}${
      escHtml(hlText.slice(0, D.snapshot.hlMax))}…${
      escHtml(DATA.fmt(D.snapshot.hlSuffix, { o: first[0] + '–' + first[1] }))}</div>`
    : '';
  return `
    <div class="snap">
      ${synth}
      ${body}
      ${offRow}
    </div>
    <div>
      <div class="sec-head" style="margin-bottom:6px">
        <h3 style="font-size:13px">${escHtml(DATA.fmt(D.snapshot.sourcesTitle, { dedup: p.dedup }))}</h3>
      </div>
      <ul class="srclist">${srcRows}</ul>
    </div>
    <div class="banner info" style="padding:10px 12px">
      <span class="bn-ic">${ICON.info}</span>
      <div class="bn-main"><div class="bn-desc">${escHtml(D.snapshot.notice)}</div></div>
    </div>`;
}

function renderDetail(policyId, target) {
  const D = DATA.detail;
  const p = DATA.policyById(policyId);
  const pid = p.id;
  const tgt = target || D.defaultTarget;
  const checks = checkMap(pid);

  /* 申报条件：逐条自查。`.clause` 这个类名要保留（闸门 verify_search_browser 盯着它计数）。
     用 div + data-check 而不是原生 <input type=checkbox>：整行都是热区，
     也免掉 label 包 input 时「点一次却触发两遍」的经典坑。

     ★ 核验状态是**逐条**的（p.conditionsDetail，后端 grounding 算出来的）：
       改造前只有一个政策级的置信度，还只印在 `conditionsFull[1]` 那一行上 ——
       其余条款既没有分数也没有偏移，用户看不出到底哪条可信（2026-10-14 用户实测
       「有些条件在原文中都看不到」）。现在每条都印自己的分数、真实字符偏移与原文依据。
       没有 conditionsDetail 的（离线样例集没有后端）沿用旧口径：只在目标条款上印
       政策级置信度，且**不印字符偏移** —— 样例集本来就没有原文，凭空编一个偏移
       正是这次要修掉的东西。 */
  const cd = p.conditionsDetail || [];
  const clauseMeta = (d) => {
    const C = D.conditions;
    const statusText = (C.status || {})[d.status] || (C.status || {}).unmatched || C.badge;
    const cls = d.status === 'verified' ? 'badge-ok'
      : d.status === 'normalized' ? 'badge-info'
        : d.status === 'digit_mismatch' ? 'badge-danger' : 'badge-warn';
    const ic = d.status === 'verified' ? ICON.ok : ICON.alert;
    const conf = Number(d.confidence || 0).toFixed(2);
    const tip = d.evidence
      ? ` title="${escHtml(DATA.fmt(C.evidence, { e: String(d.evidence).slice(0, 120) }))}"`
      : '';
    const tail = d.offset
      ? `<span class="mono-sm">${escHtml(DATA.fmt(C.offset, { o: d.offset }))}</span>`
      : `<span class="mono-sm">${escHtml(C.noOffset)}</span>`;
    return `<span class="cmeta"><span class="badge ${cls}"${tip}>${ic}${
      escHtml(DATA.fmt(statusText, { c: conf }))}</span>${tail}</span>`;
  };
  const clauses = (p.conditionsFull || []).map((full, i) => {
    const short = (p.conditions || [])[i] || '';
    const on = !!checks[i];
    const isTarget = (tgt === 'clause2' && i === 1);
    const d = cd[i];
    const meta = d ? clauseMeta(d) : (isTarget
      ? `<span class="cmeta"><span class="badge badge-warn">${ICON.alert}${
        DATA.fmt(D.conditions.badge, { c: Number(p.confidence || 0).toFixed(2) })}</span></span>`
      : '');
    return `
    <div class="clause clause-check ${on ? 'on' : ''} ${isTarget ? 'target' : ''}"
         data-check="${i}" role="checkbox" aria-checked="${on ? 'true' : 'false'}" tabindex="0">
      <span class="cbox" aria-hidden="true">${ICON.check}</span>
      <span class="cw">
        <span class="ctop">
          <span class="cshort">${escHtml(short || full)}</span>
          <span class="clabel">${escHtml(D.conditions.checkLabel)}</span>
        </span>
        ${short ? `<span class="cfull">${markKeyNumbers(full)}</span>` : ''}
        ${meta}
      </span>
    </div>`;
  }).join('');

  const mats = (p.materials || []).map((m) => `<li>${escHtml(m)}</li>`).join('');

  /* 三问答案条 */
  const qaVars = [
    { cond: String(p.matched || '').split(' · ')[0], tail: String(p.matched || '').split(' · ')[1] || '' },
    { deadline: p.deadline, n: p.daysLeft },
    { n: (p.materials || []).length },
  ];
  const qaRow = D.qa.map((q, i) => {
    let v = DATA.fmt(q.tpl, qaVars[i]);
    if (q.em && qaVars[i].cond) v = v.replace(qaVars[i].cond, `<em>${escHtml(qaVars[i].cond)}</em>`);
    return `<div class="qa"><span class="qk">${escHtml(q.k)}</span><span class="qv">${v}</span></div>`;
  }).join('');

  /* 政策字段（键 → 取值规则由 data 驱动） */
  const F = D.fields;
  const fieldVal = (row) => {
    if (row.v !== undefined) return row.v;
    const v = p[row.f];
    switch (row.t) {
      case 'before': return v + F.beforeSuffix;
      case 'deadlineDays': return `${p.deadline} · 剩 ${p.daysLeft} 天`;
      case 'srcNames': return (p.sources || []).map((s) => (typeof s === 'string' ? s : s.name)).join(' / ');
      case 'confidence': return `平均 ${F.avgConfidence} · 最低 ${p.confidence.toFixed(2)}`;
      default: return v;
    }
  };

  const g = detailGuidance(p);
  const totalConds = (p.conditionsFull || []).length;
  const doneConds = Object.keys(checks).length;
  const allDone = totalConds > 0 && doneConds >= totalConds;

  return `
  <div class="screen">
    ${topBar('detail')}
    <div class="detail-body scroll" id="detailScroll">
      <div class="detail-main">
        <div class="detail-topline">
          <button class="btn btn-ghost btn-sm detail-back" data-go="list"
                  title="${escHtml(D.backTitle)}">${ICON.back}${escHtml(D.back)}</button>
          <div class="crumb"><a data-go="list">${escHtml(D.crumb[0])}</a><span>/</span><span>${escHtml(D.crumb[1])}</span></div>
        </div>
        <h1 class="detail-title">${escHtml(p.name)}</h1>
        <div class="detail-tags">
          <span class="lvl ${p.levelKey}">${escHtml(p.level)}</span>
          <span class="badge badge-plain">${escHtml(p.types)}</span>
          <span class="badge badge-plain">${escHtml(p.industries)}</span>
          <span class="badge badge-ok">${escHtml(p.valid)}</span>
          <span class="spacer" style="flex:1"></span>
          <button class="btn btn-outline btn-sm" data-snap-open="1">${escHtml(D.snapshot.open)}</button>
          <button class="btn btn-outline btn-sm" data-go="brief">${escHtml(D.actions.brief)}</button>
          <button class="btn btn-outline btn-sm" data-compare="1">${escHtml(D.actions.compare)}</button>
        </div>

        <div class="qa-row">${qaRow}</div>

        <div class="fieldbox">
          <header>
            <h3>${escHtml(D.conditions.title)}</h3>
            <span class="spacer"></span>
            <span class="selfsum ${allDone ? 'ok' : ''}" id="condSummary">${escHtml(checkSummary(p, pid))}</span>
            ${doneConds ? `<button class="btn btn-link btn-sm" data-check-reset="1">${escHtml(D.conditions.reset)}</button>` : ''}
          </header>
          <div class="fbody condlist">${clauses}</div>
          <div class="condhint">${escHtml(allDone ? D.conditions.passHint : D.conditions.partialHint)}</div>
        </div>

        <div class="fieldbox">
          <header><h3>${escHtml(D.steps.title)}</h3><span class="spacer"></span>
            <span class="hint">${escHtml(DATA.fmt(D.steps.hint, { n: g.stepList.length }))}</span></header>
          <div class="fbody">
            <ol class="steplist">
              ${g.stepList.map((s) => `<li><span class="sn">${ICON.check}</span><div class="sc">
                <div class="st">${escHtml(s.t)}</div><div class="sd">${escHtml(s.d)}</div></div></li>`).join('')}
            </ol>
          </div>
        </div>

        <div class="fieldbox">
          <header><h3>${escHtml(D.channel.title)}</h3><span class="spacer"></span>
            <span class="hint">${escHtml(D.channel.hint)}</span></header>
          <div class="fbody chlist">
            ${g.channelList.map((c) => `<div class="chrow">
              <span class="chk">${escHtml(c.k)}</span><span class="chv">${escHtml(c.v)}</span></div>`).join('')}
          </div>
        </div>

        <div class="fieldbox">
          <header><h3>${escHtml(D.materials.title)}</h3><span class="spacer"></span><span class="hint">${escHtml(D.materials.hint)}</span></header>
          <div class="fbody"><ul class="matlist">${mats}</ul></div>
        </div>

        <div class="fieldbox">
          <header><h3>${escHtml(F.title)}</h3><span class="spacer"></span><span class="hint">${escHtml(F.hint)}</span></header>
          <div class="fbody" style="display:grid;grid-template-columns:1fr 1fr;gap:2px 24px">
            ${F.rows.map((row) => `<div class="kv"><span class="k">${escHtml(row.k)}</span><span class="v">${escHtml(fieldVal(row))}</span></div>`).join('')}
          </div>
        </div>
      </div>

      ${chatPanelHTML(pid)}
    </div>

    <div class="snapdlg" id="snapDialog" ${DETAIL_STATE.snapOpen ? '' : 'hidden'}>
      <div class="snapdlg-mask" data-snap-close="1"></div>
      <div class="snapdlg-panel">
        <header>
          <h3>${escHtml(D.snapshot.title)}</h3>
          <span class="spacer"></span>
          <span class="hint">${escHtml(D.snapshot.sub)}</span>
          <button class="btn btn-ghost btn-sm" data-snap-close="1">${escHtml(D.snapshot.close)}</button>
        </header>
        <div class="snapdlg-body scroll">${snapBodyHTML(p)}</div>
        <div class="disclaimer">${escHtml(D.snapshot.disclaimer)}</div>
      </div>
    </div>
  </div>`;
}

/* ---------- 详情屏挂载：把这条政策的历史对话读回来 ---------- */
function mountDetail() {
  const pid = APP.policyId;
  /* 整页滚动位置回填：勾自查 / 发提问都会重画整屏，别让用户从头再滚一遍 */
  const keep = DETAIL_STATE.keepScroll;
  const body = document.getElementById('detailScroll');
  if (body) body.scrollTop = (keep && keep.pid === pid) ? keep.top : 0;
  if (!pid) return;
  const st = chatState(pid);
  if (st.loaded) return;          // 每条政策只读一次；之后由 chatSend/chatClear 维护
  st.loaded = true;
  if (!isSignedIn()) return;      // 游客：后端没有他的对话，不必白跑一趟
  st.loading = true;
  render();                       // 先把「正在读取…」显示出来（再次进 mountDetail 会被 loaded 挡住）
  const epoch = st.epoch || 0;
  DATA.api.chatHistory(pid)
    .then((res) => { if (st.epoch === epoch) st.messages = (res && res.messages) || []; })
    .catch(() => { if (st.epoch === epoch) st.error = DATA.detail.chat.loadFailed; })
    .then(() => {
      if (st.epoch !== epoch) return;   // 读取期间用户清空了对话 → 丢弃这批历史，别复活
      st.loading = false;
      if (APP.screen === 'detail' && APP.policyId === pid) render();
      scrollChatBottom();
    });
}

function scrollChatBottom() {
  const b = document.getElementById('chatBody');
  if (b) b.scrollTop = b.scrollHeight;
}

function focusChat(sel) {
  const box = document.getElementById('chatQ');
  if (!box) return;
  if (sel) box.value = sel;
  try { box.focus(); } catch (e) { /* 忽略 */ }
  scrollChatBottom();
}

/** 发一条提问：先本地落一条用户气泡，再等后端（失败就地报错，不静默吞掉）。 */
function chatSend() {
  const pid = APP.policyId;
  const box = document.getElementById('chatQ');
  if (!pid || !box) return;
  const q = String(box.value || '').trim();
  if (!q) return;
  const st = chatState(pid);
  if (st.loading) return;

  const C = DATA.detail.chat;
  const p = DATA.policyById(pid);
  const g = detailGuidance(p);

  box.value = '';
  st.error = '';
  st.messages.push({ role: 'user', content: q });
  st.loading = true;
  const epoch = st.epoch || 0;
  render();

  DATA.api.chatSend({
    policyId: pid,
    question: q,
    policy: Object.assign({}, policyChatContext(p), { steps: g.steps, channels: g.channels }),
  })
    .then((res) => {
      if (st.epoch !== epoch) return;   // 等模型期间用户点了「清空」→ 迟到的回答直接丢弃
      st.messages.push({
        role: 'assistant',
        content: String((res && res.answer) || ''),
        degraded: !!(res && res.degraded),
        unsaved: !(res && res.saved),
      });
    })
    .catch((err) => {
      if (st.epoch !== epoch) return;
      st.error = C.errorTitle + '：' + ((err && err.message) || '未知错误');
    })
    .then(() => {
      if (st.epoch !== epoch) return;
      st.loading = false;
      if (APP.screen === 'detail' && APP.policyId === pid) render();
      focusChat();
    });
}

/** 清空这条政策的对话。游客本来就没落库，直接清本地；登录用户要后端真删。 */
function chatClear() {
  const pid = APP.policyId;
  const st = chatState(pid);
  const C = DATA.detail.chat;
  /* 作废「正在飞的那一问」：真实模型一轮要十几秒，用户等不及点了清空，
     若不作废，迟到的回答会在清空之后把气泡又追加回来（8000 实测到过）。 */
  st.epoch = (st.epoch || 0) + 1;
  st.loading = false;
  const done = () => { st.messages = []; st.error = ''; toast(C.cleared, 'info'); render(); };
  if (!isSignedIn()) return done();
  DATA.api.chatClear(pid)
    .then(done)
    .catch((err) => {
      st.error = C.errorTitle + '：' + ((err && err.message) || '未知错误');
      render();
    });
}

function toggleSnap(open) {
  DETAIL_STATE.snapOpen = open;
  const dlg = document.getElementById('snapDialog');
  if (dlg) dlg.hidden = !open;
}

/* ============================================================
   5 · 简报预览与导出（成功态）
   ------------------------------------------------------------
   ★ 勾选联动：预览与导出的清单是**同一份**（briefScopedPolicies()，取结果列表里已勾选的政策）；
     一条都没勾时预览与导出都给空 —— 预览显示「暂未选择政策」空态，导出明确报错，
     **绝不用演示政策顶替**（以前预览会退回 brief.previewIds 指定的那两条样例看排版，
     用户会以为它们真的在简报里）。
   ★ 导出范围真生效：切到「当前筛选结果」就取整份结果集（按当前排序口径）。
   ★ 真实文件：POST /api/v1/briefs → 后端生成 XLSX / DOCX / PDF → Blob 另存。
     后端不在就明确报错，**不再假报「导出成功」**（那正是用户反馈的问题）。
   ============================================================ */
const BRIEF_STATE = {
  template: null,
  scope: null,
  format: null,
  exported: false,   // 成功横幅开关：生成成功才置 true
  result: null,      // 后端返回的简报元数据：{briefId,fileName,downloadUrl,summary,…}
  busy: false,       // 生成中：按钮转圈 + 禁用，防重复点击
  error: '',         // 最近一次失败原因（就地显示，不必翻控制台）
};

/** 简报用的政策清单（预览与导出**同一份**，且不含任何演示兜底）。
    取「结果列表里已勾选的政策」；导出范围切到「当前筛选结果」就取整份结果集（按当前排序口径）。
    一条都没有就返回空数组 —— 以前这里会退回 brief.previewIds 指定的演示政策，
    结果用户一条都没勾却看见两条政策排在纸上，会以为它们真的在简报里。 */
function briefScopedPolicies() {
  return BRIEF_STATE.scope === 'filtered' ? sortedPolicies() : pickedPolicies();
}

/** 预览区主体：有清单就排纸，空清单给空态（绝不用演示政策顶替） */
function briefPreviewBody() {
  if (briefScopedPolicies().length) return `<div class="paper scroll">${briefPaper()}</div>`;
  const P = DATA.brief.preview;
  /* 空态的两种成因不同：勾选范围下是「还没勾」，筛选范围下是「本次检索没有结果」——
     给出的下一步动作也不同（一个回列表勾选，一个回首页重检）。 */
  const filtered = BRIEF_STATE.scope === 'filtered';
  return `
    <div class="paper scroll is-empty" id="briefEmpty">
      <span class="pempty-ic">${ICON.brief}</span>
      <h4>${escHtml(filtered ? P.emptyFilteredTitle : P.emptyTitle)}</h4>
      <p>${escHtml(filtered ? P.emptyFilteredDesc : P.emptyDesc)}</p>
      <button class="btn btn-outline btn-sm" data-go="${filtered ? 'home' : 'list'}">${
        escHtml(filtered ? P.emptyFilteredGo : P.emptyGo)}</button>
    </div>`;
}

/** 导出范围的可读名（进文件名与文件内的「导出范围」一行） */
function briefScopeName() {
  const names = DATA.brief.scopeNames || {};
  return names[BRIEF_STATE.scope] || names.picked || '';
}

/** 导出范围选项的完整说法（含条数）：已勾选 n 条 / 当前筛选结果（n 条） */
function briefScopeLabel(opt) {
  const o = opt || ((DATA.brief.settings.scope.options || [])
    .find((x) => x.v === BRIEF_STATE.scope)) || {};
  return DATA.fmt(o.label || '', {
    picked: LIST_STATE.picked.size,
    total: listTotal(),
  });
}

/** 「已解析出条件」四行原样带给后端（与结果屏同一枚口径，前端不再自己拼） */
function briefConditions() {
  const parsed = (DATA.search && DATA.search.parsed) || [];
  return parsed.filter((l) => typeof l === 'string').slice(0, 6);
}

/** 一条政策 → 简报接口需要的字段（缺的留空，后端会退化处理） */
function briefPolicyPayload(p) {
  const src = (p.sources || [])
    .map((s) => (typeof s === 'string' ? s : ((s && s.name) || '')))
    .filter(Boolean);
  return {
    name: p.name,
    level: p.level,
    issuer: p.issuer,
    types: p.types,
    industries: p.industries,
    publish: p.publish,
    deadline: p.deadline,
    daysLeft: p.daysLeft,
    subsidy: p.subsidy,
    confidence: p.confidence,
    matched: p.matched,
    conditions: p.conditions || [],
    conditionsFull: p.conditionsFull || [],
    materials: p.materials || [],
    sources: src.map((name) => ({ name })),
  };
}

function briefPaper() {
  const B = DATA.brief.paper;
  const all = briefScopedPolicies();
  const max = Number(DATA.brief.previewMax) || 0;
  const list = max > 0 ? all.slice(0, max) : all;

  const pretty = (p) => DATA.fmt(B.itemTpl, {
    name: p.name,
    level: p.level,
    conditions: (p.conditions || []).join(B.joinSep),
    deadline: p.deadline,
    subsidy: p.subsidy,
    materials: (p.materials || []).map((m) => String(m).replace(B.materialStrip, '')).join(B.joinSep),
    source: (p.sources && p.sources.length)
      ? (p.sources[0].name || '') + (p.sources.length > 1 ? DATA.fmt(B.dedupWrap, { dedup: p.dedup }) : '')
      : '',
  });

  const head = DATA.fmt(B.headTpl, {
    title: B.title,
    meta: DATA.fmt(B.metaTpl, {
      time: DATA.brief.generatedAt,
      sources: DATA.stats.policySources,
      n: all.length,
    }),
  });

  /* AI 综述：只有后端生成成功后才在预览里出现（没导出时只给清单） */
  const r = BRIEF_STATE.result;
  const sum = (r && r.summary) ? [
    '<div class="psum">',
    `<div class="psum-h">${escHtml(DATA.fmt(B.summaryHead,
      { src: r.summarySource === 'llm' ? B.srcLlm : B.srcRule }))}</div>`,
    String(r.summary).split(/\n+/).filter(Boolean)
      .map((t) => `<p>${escHtml(t)}</p>`).join(''),
    '</div>',
  ].join('') : '';

  /* 预览有上限（previewMax，默认 20）：清单几百条时不能把 DOM 撑爆，
     但要把「导出文件里是全量」说清楚，别让人以为只导出了这 20 条。 */
  const cut = (max > 0 && all.length > list.length)
    ? `<div class="pcut">${escHtml(DATA.fmt(B.previewCut, { shown: list.length, n: all.length }))}</div>`
    : '';

  return [head, sum, list.map(pretty).join('\n  '), cut, B.footTpl]
    .filter(Boolean).join('\n  ');
}

function renderBrief() {
  const B = DATA.brief;
  const S = B.settings;
  const picked = LIST_STATE.picked.size;

  /* 导出范围与格式同构：都是 data-seg 单选。范围选「已勾选」但一条没勾 → 置灰。 */
  const seg = (group, opt) => {
    const dis = group === 'scope' && opt.v === 'picked' && picked === 0;
    const label = group === 'scope' ? briefScopeLabel(opt) : opt.label;
    return `<button class="sg ${BRIEF_STATE[group] === opt.v ? 'on' : ''} ${dis ? 'dis' : ''}"
      data-seg="${group}:${opt.v}" ${dis ? 'disabled' : ''}>${label}</button>`;
  };

  const success = BRIEF_STATE.exported ? `
    <div class="banner ok" id="briefBanner">
      <span class="bn-ic">${ICON.ok}</span>
      <div class="bn-main">
        <div class="bn-ttl">${escHtml(DATA.fmt(B.success.title, { file: briefFileName() }))}</div>
        <div class="bn-desc">${escHtml(B.success.desc)}</div>
      </div>
      <div class="bn-acts">
        ${BRIEF_STATE.result ? `<button class="btn btn-outline btn-sm" data-brief-download="1">${B.success.download}</button>` : ''}
        <button class="btn btn-outline btn-sm" data-brief-reveal="1" ${BRIEF_STATE.result ? '' : 'disabled'}>${B.success.open}</button>
      </div>
    </div>` : '';

  const failure = (!BRIEF_STATE.exported && BRIEF_STATE.error) ? `
    <div class="banner warn" id="briefError">
      <span class="bn-ic">${ICON.alert}</span>
      <div class="bn-main">
        <div class="bn-ttl">${escHtml(DATA.fmt(B.errors.failed, { msg: BRIEF_STATE.error }))}</div>
        <div class="bn-desc">${escHtml(B.errors.offline)}</div>
      </div>
    </div>` : '';

  return `
  <div class="screen">
    ${topBar('brief')}
    <div class="brief-body">
      <aside class="brief-side">
        <div class="setbox">
          <h3>${S.title}</h3>
          <div class="setrow">
            <span class="sl">${S.template.label}</span>
            <div class="seg">${S.template.options.map((o) => seg('template', o)).join('')}</div>
          </div>
          <div class="setrow">
            <span class="sl">${S.scope.label}</span>
            <div class="seg">${S.scope.options.map((o) => seg('scope', o)).join('')}</div>
          </div>
          <div class="setrow">
            <span class="sl">${S.format.label}</span>
            <div class="seg">${S.format.options.map((o) => seg('format', o)).join('')}</div>
          </div>
          <button class="btn btn-primary btn-lg" style="width:100%" data-export="1" ${BRIEF_STATE.busy ? 'disabled' : ''}>${
            BRIEF_STATE.busy ? '<i class="spin"></i>' + S.generating : S.submit}</button>
          <span class="hint">${S.hint}</span>
        </div>
        ${success}
        ${failure}
      </aside>

      <section class="brief-preview">
        <header>
          <span>${DATA.fmt(B.preview.title, { x: BRIEF_STATE.template === 'detail' ? B.preview.detail : B.preview.onepage })}</span>
          <span class="spacer"></span>
          <button class="btn btn-ghost btn-sm" data-toast="${DATA.app.toast.fitWidth}">${B.preview.fit}</button>
        </header>
        ${briefPreviewBody()}
      </section>
    </div>
  </div>`;
}

/** 导出文件名：后端生成成功就用后端给的真名（含日期与范围）；
    还没生成过则用本地兜底名，只用于「还没导出」时的界面文案。 */
function briefFileName() {
  const r = BRIEF_STATE.result;
  if (r && r.fileName) return r.fileName;
  const B = DATA.brief;
  return B.fileNameBase + '.' + (B.ext[BRIEF_STATE.format] || B.ext.xlsx);
}

/* ---------- 导出链路（由 app.js 的事件层调用） ---------- */

/** 点「生成并导出简报」：收集当前设置 → 后端生成真文件 → 触发浏览器下载 */
function briefExport() {
  if (BRIEF_STATE.busy) return Promise.resolve(false);
  const list = briefScopedPolicies();
  if (!list.length) {
    toast(DATA.brief.errors.empty, 'warn');
    return Promise.resolve(false);
  }
  if (!DATA.api || typeof DATA.api.createBrief !== 'function') {
    toast(DATA.brief.errors.offline, 'warn');
    return Promise.resolve(false);
  }

  BRIEF_STATE.busy = true;
  BRIEF_STATE.error = '';
  BRIEF_STATE.exported = false;
  render();

  return DATA.api.createBrief({
    format: BRIEF_STATE.format,
    template: BRIEF_STATE.template,
    scope: BRIEF_STATE.scope,
    scopeLabel: briefScopeName(),
    conditions: briefConditions(),
    policies: list.map(briefPolicyPayload),
  }).then((res) => {
    BRIEF_STATE.busy = false;
    BRIEF_STATE.result = res;
    BRIEF_STATE.exported = true;
    toast(DATA.fmt(DATA.app.toast.exportDone, { file: res.fileName }), 'ok');
    render();
    /* 下载单独走一条链：它自己有 catch，失败不会把「生成成功」误报成失败 */
    briefDownload();
    return true;
  }).catch((err) => {
    BRIEF_STATE.busy = false;
    BRIEF_STATE.result = null;
    BRIEF_STATE.exported = false;
    BRIEF_STATE.error = (err && err.message) ? err.message : String(err);
    render();
    return false;
  });
}

/** 下载（或重新下载）刚生成的文件：取 Blob → 触发浏览器另存 */
function briefDownload() {
  const r = BRIEF_STATE.result;
  if (!r || !r.briefId) return Promise.resolve(false);
  return DATA.api.downloadBrief(r).then((blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = r.fileName || '政策简报';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ } }, 4000);
    return true;
  }).catch((err) => {
    /* 文件被手动清理：按错误码给专属提示并清掉失效引用（按钮不再对幽灵文件可点） */
    if (err && err.code === 'BRIEF_MISSING') {
      BRIEF_STATE.result = null;
      render();
      toast(DATA.brief.errors.missing, 'warn');
      return false;
    }
    toast(DATA.fmt(DATA.brief.errors.downloadFailed,
      { msg: (err && err.message) ? err.message : String(err) }), 'warn');
    return false;
  });
}

/** 打开文件所在文件夹：后端优先去**下载文件夹**定位浏览器存的那份
    （找到 → 选中它；没找到 → 打开下载文件夹本身），两条路给不同提示。 */
function briefReveal() {
  const r = BRIEF_STATE.result;
  if (!r || !r.briefId) {
    toast(DATA.brief.errors.empty, 'warn');
    return Promise.resolve(false);
  }
  return DATA.api.revealBrief(r.briefId).then((res) => {
    toast(res && res.located === false
      ? DATA.app.toast.openFolderMiss : DATA.app.toast.openFolder, 'info');
    return res;
  }).catch((err) => {
    if (err && err.code === 'BRIEF_MISSING') {
      BRIEF_STATE.result = null;
      render();
      toast(DATA.brief.errors.missing, 'warn');
      return false;
    }
    toast(DATA.fmt(DATA.brief.errors.failed,
      { msg: (err && err.message) ? err.message : String(err) }), 'warn');
    return false;
  });
}
