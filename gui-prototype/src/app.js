/* ============================================================
   原型外壳：数据装载 / 屏幕切换 / 缩放适配 / 事件装配 / Toast
   —— 本文件不含业务数据，屏幕清单与全部提示文案取自 DATA.app
   ============================================================ */
const APP = {
  screen: 'home',
  query: '',
  policyId: null,
  target: null,
  cascOpen: false,
  cascAnchorId: null,
  optOpen: null,        // 当前展开的条件面板组（industry | type | deadline）
  optAnchorId: null,
};

/* 面板搜索框的输入法状态：组词期间不重绘列表（否则中文打不进去） */
const PANEL_IME = { composing: false };

/* 渲染注册表：键与 data/app.json → screens[].key 一一对应 */
const SCREEN_RENDER = {
  home: () => renderHome(),
  search: () => renderSearch(APP.query),
  list: () => renderList(),
  detail: () => renderDetail(APP.policyId, APP.target),
  brief: () => renderBrief(),
  login: () => renderLogin(),
  history: () => renderHistory(),
};
const SCREEN_MOUNT = {
  search: () => mountSearch(go),
  detail: () => mountDetail(),
  login: () => mountLogin(go),
  history: () => mountHistory(go),
};

let SCREENS = [];
function defineScreens() {
  SCREENS = DATA.app.screens.map((s) => Object.assign({}, s, {
    render: SCREEN_RENDER[s.key],
    mount: SCREEN_MOUNT[s.key],
  }));
}

/* ---------- 外壳 DOM ----------
   原型不占任何额外画面：原先的「01…11 屏索引条」与左下角的画布缩放胶囊都已移除，
   各屏入口统一收进产品自己的顶栏导航（data/app.json → nav），与应用内跳转完全一致。
   画布恒定按窗口等比铺满（＝原来的「适应窗口」，不再提供「实际尺寸」切换）。
   构建戳仍在：build.py 会往产物里写 window.__BUILD__，浏览器控制台可直接读。 */
function buildShell() {
  document.body.innerHTML = `
    <main class="proto-viewport center" id="viewport">
      <div class="proto-stage" id="stage-wrap">
        <div class="proto-canvas" id="canvas"><div id="stage"></div></div>
      </div>
    </main>
    <div class="toast-layer" id="toasts"></div>`;
}

/* ---------- 缩放适配 ----------
   画布不留边距、也不封顶在 1 倍：始终按窗口等比铺满，这样窗口多大，
   应用就多大，四周不出现「框」（视口与画布同色，留白看不出来）。 */
function getScale() {
  const vp = document.getElementById('viewport');
  const w = vp.clientWidth;
  const h = vp.clientHeight;
  if (w <= 0 || h <= 0) return 1;   // 首帧未布局时先按原尺寸，避免算出 0 倍
  return Math.min(w / 1440, h / 900);
}
function applyScale() {
  const canvas = document.getElementById('canvas');
  const wrap = document.getElementById('stage-wrap');
  const s = getScale();
  canvas.dataset.scale = s;
  canvas.style.transform = `scale(${s})`;
  wrap.style.width = 1440 * s + 'px';
  wrap.style.height = 900 * s + 'px';
}
let rafId = null;
window.addEventListener('resize', () => {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(applyScale);
});

/* ---------- 渲染 ---------- */
function render() {
  const def = SCREENS.find((s) => s.key === APP.screen) || SCREENS[0];
  const stage = document.getElementById('stage');
  stage.innerHTML = def.render();
  document.getElementById('canvas').style.background = 'var(--bg)';
  if (def.mount) def.mount();
  if (APP.cascOpen) mountCascPanel(APP.cascAnchorId);
  if (APP.optOpen) mountOptPanel(APP.optOpen, APP.optAnchorId);
  /* 顶栏「检索中 n%」在换屏后要重新接上（后台任务不因换屏而中断） */
  if (typeof paintRunPill === 'function') paintRunPill();
  applyScale();
}

function go(key, opts) {
  /* 闸门：未登录且未选择「游客身份」时，一切跳转都拦回「登录 / 注册」页
     （产品顶栏、屏索引条、键盘左右键、屏内 data-go 全部走这里） */
  if (typeof AUTH !== 'undefined' && AUTH.gateOpen && !AUTH.gateOpen() && key !== 'login') {
    key = 'login';
  }
  if (opts && opts.policyId) {
    APP.policyId = opts.policyId;
    /* ★ 归一化：进详情屏时把 policyId 归一为当前结果集里真实存在的政策 id。
       policyById() 对查不到的 id 会兜底回 items[0] —— 若不同步归一，渲染按
       items[0].id 读自查勾选、点击按旧 id 写，两把钥匙开两把锁，
       表现就是「点申报条件永远勾不上」（从对话记录 / 历史回放点开旧 id 必现）。 */
    if (key === 'detail' && typeof DATA !== 'undefined' && DATA.policyById) {
      const _pp = DATA.policyById(opts.policyId);
      if (_pp && _pp.id) APP.policyId = _pp.id;
    }
  }
  if (opts && opts.target !== undefined) APP.target = opts.target;
  if (APP.screen !== key) { APP.cascOpen = false; APP.optOpen = null; }
  APP.screen = key;
  try { history.replaceState(null, '', '#' + key); } catch (e) { /* file:// */ }
  render();
}

/* ---------- 统一筛选面板（地域 / 行业 / 类型 / 截止时间） ----------
   两个浮层共用同一套挂载 / 定位 / 刷新逻辑，只有面板尺寸不同：
     · 地域是三级级联，680×566；行业 / 类型 / 截止时间是单列列表，460×400。
   绝对定位贴在被点触发器下方，点遮罩 / Esc 关闭；勾选只写草稿，
   点「确定」才把草稿提交为生效值并重绘首页摘要。

   z 序（重要）：
     45 optLayer  选项面板浮层
     46 .trigger  触发器（要浮在 45 的遮罩之上，否则「再点一下收起」点不到）
     47 cascLayer 地域级联浮层
   地域面板高 566，触发器在首页第 1 行（y≈468）时下方只剩 432，**装不下**，
   于是会被夹到 y=326 而盖住触发器本身。此时若面板仍在触发器之下，
   面板顶部那一行（列标题、「选中全省」）就会永远点不到 —— 所以地域浮层压在 47：
   盖住触发器是它的代价，收起改用 Esc / 点遮罩 / 点「确定」。 */
const PANEL_Z = { casc: 47, opt: 45 };
const PANEL_SIZE = { casc: { w: 680, h: 566 }, opt: { w: 460, h: 400 } };

/**
 * 挂一个筛选浮层。
 * @param {string} kind  'casc' | 'opt'
 * @param {string} id    浮层元素前缀（cascLayer / optLayer）
 * @param {string} anchorId 触发器 id；省略则取屏内第一个同类型触发器
 * @param {string} html  面板 HTML
 * @param {string} findSel 兜底用的触发器选择器
 */
function mountFilterPanel(kind, id, anchorId, html, findSel) {
  const stage = document.getElementById('stage');
  const anchor = anchorId ? stage.querySelector('#' + anchorId) : stage.querySelector(findSel);
  if (!anchor) return;
  const size = PANEL_SIZE[kind];

  let layer = document.getElementById(id + 'Layer');
  if (!layer) {
    layer = document.createElement('div');
    layer.id = id + 'Layer';
    layer.style.cssText = 'position:absolute;inset:0;z-index:' + PANEL_Z[kind];
    layer.innerHTML = '<div id="' + id + 'Backdrop" style="position:absolute;inset:0"></div>'
      + '<div id="' + id + 'Host" style="position:absolute"></div>';
    document.querySelector('.screen').appendChild(layer);
  }
  const host = document.getElementById(id + 'Host');
  host.innerHTML = html;

  /* 锚点定位（画布坐标系）：优先贴在触发器下方，放不下就夹到视口底部 */
  const canvas = document.getElementById('canvas');
  const s = parseFloat(canvas.dataset.scale || '1');
  const cr = canvas.getBoundingClientRect();
  const tr = anchor.getBoundingClientRect();
  const left = (tr.left - cr.left) / s;
  const top = (tr.bottom - cr.top) / s + 8;
  host.style.left = Math.max(16, Math.min(left, 1440 - size.w - 16)) + 'px';
  host.style.top = Math.max(8, Math.min(top, 900 - size.h - 8)) + 'px';

  document.getElementById(id + 'Backdrop').onclick = (kind === 'casc' ? closeCasc : closeOpt);
  return anchor;
}

function mountCascPanel(anchorId) {
  const v = cascView();
  /* 挂载时就把三列的「内容身份」记下来。
     以前这里清成空数组，于是**用户第一次勾选**时没有旧身份可比 ——
     位置根本存不下来，第一次点选仍会弹回顶部（正是用户实报的那一下）。 */
  resetPanelScroll(v.keys);
  const a = mountFilterPanel('casc', 'casc', anchorId, cascPanelHTML(v), '[data-region-trigger]');
  if (!a) return;
  APP.cascAnchorId = a.id;
  const input = document.getElementById('cascQ');
  if (input) {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
}

/** 焦点只在「已经丢了」的时候才抢回来。
 *  输入过程中的每次重绘都 focus + setSelectionRange 会打断输入法组词（中文就打不进去）。 */
function restoreCaret(input) {
  if (!input || document.activeElement === input) return;
  input.focus();
  try { input.setSelectionRange(input.value.length, input.value.length); } catch (e) { /* 忽略 */ }
}

/** 当前「真正该刷新」的那块面板：浮层（cascHost）优先，其次兜底 getElementById。 */
function livePanel(preferHostId, id) {
  const host = document.getElementById(preferHostId);
  const inLayer = host && host.querySelector('#' + id);
  return inLayer || document.getElementById(id);
}

/* ---------- 面板滚动位置中继 ----------
   面板的列表是整块 innerHTML 换掉的（理由见 patchCascPanel），换掉就把滚动条弹回了顶部 ——
   用户把「省级行政区」翻到广西壮族自治区，一勾选又得从头往下翻。
   这里按「内容身份」记住位置：身份没变（只是勾了一行）就放回原处；
   身份变了（换了展开的省 / 市、改了搜索词）就回顶部 —— 换了人的名单停在旧位置没有意义。 */
const PANEL_SCROLL = { keys: [], pos: new Map() };

/** 面板每次新建（浮层重新挂载）都清空位置记忆：重新打开的面板应当从顶部开始看。
 *  `keys` 是这份新名单的「内容身份」，必须一并登记 —— 否则用户**第一次**勾选时
 *  无旧身份可比，位置存不下来（勾一下照样弹回顶部，只是 bug 藏得更深）。 */
function resetPanelScroll(keys) {
  PANEL_SCROLL.keys = Array.from(keys || []);
  PANEL_SCROLL.pos.clear();
}

/** 滚动容器列表：sel 为空串表示「容器本身就是滚动区」（选项面板），否则取它的子孙列（级联三列）。 */
function panelScrollEls(body, sel) {
  return sel ? Array.from(body.querySelectorAll(sel)) : [body];
}

/** 换掉 body 的列表内容，并尽力保持各滚动容器原有的位置。
 *  @param sel  列选择器；空串 = body 自身
 *  @param keys 与滚动容器一一对应的内容身份键 */
function swapPanelBody(body, sel, keys, html) {
  panelScrollEls(body, sel).forEach((el, i) => {
    const k = PANEL_SCROLL.keys[i];
    if (k !== undefined) PANEL_SCROLL.pos.set(k, el.scrollTop);
  });
  body.innerHTML = html;
  panelScrollEls(body, sel).forEach((el, i) => {
    const k = keys[i];
    el.scrollTop = k === undefined ? 0 : (PANEL_SCROLL.pos.get(k) || 0);
  });
  PANEL_SCROLL.keys = Array.from(keys);
}

/** 就地刷新级联面板：只换「三列列表 + 摘要 + 确定(n)」，头部（含搜索框）原封不动。
 *  为什么不能整块 innerHTML 重绘：那会把 <input> 节点一起换掉 ——
 *    ① 中文输入法正在组词时节点被替换 → 组词中断，中文根本打不进去；
 *    ② 同一个按键的默认动作会把字符往「新」输入框里再插一次 → 按一下 y 出来三个 y。
 *  返回 false 表示面板不在 DOM 里，由调用方决定要不要整屏重绘。 */
function patchCascPanel() {
  const panel = livePanel('cascHost', 'cascPanel');
  if (!panel) return false;
  const v = cascView();
  const body = panel.querySelector('.fpanel-body');
  /* 三列各是独立的滚动容器（.casc-list）；整列重画后把滚动位置放回去。 */
  if (body) swapPanelBody(body, '.casc-list', v.keys, cascBodyHTML(v));
  const sum = panel.querySelector('.fpanel-foot .sum');
  if (sum) sum.textContent = v.sum;
  const ok = panel.querySelector('[data-casc-ok]');
  if (ok) ok.textContent = DATA.fmt(v.L.ok, { n: v.sel.length });
  const sw = panel.querySelector('.casc-switch');
  if (sw) sw.classList.toggle('on', !!v.showAll);
  restoreCaret(panel.querySelector('#cascQ'));
  return true;
}

/** 只刷新面板内容（勾选 / 输入时不重建整屏，也不重建输入框本身） */
function refreshCasc() {
  if (patchCascPanel()) return;
  /* 面板不在 DOM 里（比如正站在别的屏）—— 只能整屏重绘，
     否则点一行勾选只改了计数、界面纹丝不动，像是点了个寂寞。 */
  render();
}

function openCasc(anchorEl) {
  closeOpt();
  APP.cascOpen = true;
  CASCADE.resetFromApplied();
  mountCascPanel(anchorEl ? anchorEl.id : null);
}
/** 关闭级联面板。
 *  ★ 这里有「一套地域」的守门逻辑：面板里勾了但没点「确定」的改动**一律不带出去** ——
 *   还原成已生效条件，并明确提示一次。此前是把草稿与已生效**合并**发给后端，于是
 *   用户在面板里随手点过的省份（没点确定就 Esc / 点别处）会静默生效：
 *   检索记录里出现「查询写杭州、地域却是西藏 + 新疆」这种自相矛盾的条目。 */
function closeCasc() {
  APP.cascOpen = false;
  const l = document.getElementById('cascLayer');
  if (l) l.remove();
  if (typeof CASCADE !== 'undefined' && CASCADE.draft && CASCADE.applied) {
    const dirty = CASCADE.draft.size !== CASCADE.applied.size
      || [...CASCADE.draft].some((c) => !CASCADE.applied.has(c));
    if (dirty) {
      CASCADE.resetFromApplied();
      /* 注意：这里是模块级函数，取文案要走 DATA（bindEvents 内的 TS 不在作用域里） */
      toast(DATA.app.toast.regionDraftDiscarded, 'info');
    }
  }
}

function mountOptPanel(group, anchorId) {
  const v = optView(group);
  resetPanelScroll([v.key]);            /* 理由同 mountCascPanel：第一次勾选也要能存下位置 */
  const a = mountFilterPanel('opt', 'opt', anchorId, optPanelHTML(group, v), '[data-opt-trigger]');
  if (a) APP.optAnchorId = a.id;
}

/** 就地刷新选项面板：只换列表 + 摘要 + 底部按钮，搜索框不动（理由同 patchCascPanel）。 */
function patchOptPanel() {
  const panel = livePanel('optHost', 'optPanel');
  if (!panel) return false;
  const v = optView(APP.optOpen);
  const body = panel.querySelector('.fpanel-body');
  /* 选项面板只有一个滚动容器 —— 就是 .fpanel-body 自己（sel 传空串表示「容器本身」）。 */
  if (body) swapPanelBody(body, '', [v.key], optRowsHTML(v));
  const sum = panel.querySelector('.fpanel-foot .sum');
  if (sum) sum.textContent = v.sum;
  const ok = panel.querySelector('[data-opt-ok]');
  if (ok) ok.textContent = filterText('ok', { n: v.n });
  const all = panel.querySelector('[data-opt-all]');
  if (all) {
    all.textContent = v.allOn ? filterText('unselectAll') : filterText('selectAll');
    all.classList.toggle('on', v.allOn);
  }
  restoreCaret(panel.querySelector('#optQ'));
  return true;
}

/** 只刷新面板内容（勾选 / 输入时不重建整屏，也不重建输入框本身） */
function refreshOpt() {
  if (patchOptPanel()) return;
  render();
}

function openOpt(group, anchorEl) {
  closeCasc();
  FILTER_STATE.ensure();
  FILTER_STATE.resetFromApplied();
  APP.optOpen = group;
  mountOptPanel(group, anchorEl ? anchorEl.id : null);
}
function closeOpt() {
  APP.optOpen = null;
  const l = document.getElementById('optLayer');
  if (l) l.remove();
}

/* ---------- Toast ---------- */
const TOAST_ICON = { ok: ICON.ok, warn: ICON.alert, danger: ICON.alert, info: ICON.info };
function toast(msg, type) {
  const t = document.createElement('div');
  t.className = 'toast ' + (type || 'info');
  t.innerHTML = `<span class="ic">${TOAST_ICON[type || 'info']}</span><span>${msg}</span>`;
  document.getElementById('toasts').appendChild(t);
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 260);
  }, 2400);
}

/* ---------- 右下角通知卡片 ----------
   比 toast 更「实」：带标题、说明与操作按钮，需要用户看一眼再决定要不要过去。
   典型场景：检索在后台跑完时用户已经切到别的屏 —— 不强行把他拽走。 */
function notice(opts) {
  const o = opts || {};
  const host = document.getElementById('toasts');
  if (!host) return null;
  const type = o.type || 'ok';
  const el = document.createElement('div');
  el.className = 'toast notice ' + type;
  el.innerHTML = `<span class="ic">${TOAST_ICON[type] || ICON.info}</span>`
    + '<div class="nt-main">'
    + `<div class="nt-ttl">${o.title || ''}</div>`
    + (o.desc ? `<div class="nt-desc">${o.desc}</div>` : '')
    + '</div>'
    + '<div class="nt-acts">'
    + (o.action ? `<button class="btn btn-solid btn-sm" data-notice-act="1">${o.action}</button>` : '')
    + (o.closeLabel === false ? '' : `<button class="btn btn-ghost btn-sm" data-notice-close="1">${o.closeLabel || '知道了'}</button>`)
    + '</div>';

  let timer = null;
  const dismiss = () => {
    if (timer) clearTimeout(timer);
    el.classList.add('out');
    setTimeout(() => el.remove(), 260);
  };
  const closeBtn = el.querySelector('[data-notice-close]');
  if (closeBtn) closeBtn.addEventListener('click', dismiss);
  const actBtn = el.querySelector('[data-notice-act]');
  if (actBtn) {
    actBtn.addEventListener('click', () => {
      dismiss();
      if (typeof o.onAction === 'function') o.onAction();
    });
  }
  host.appendChild(el);
  if (o.timeoutMs) timer = setTimeout(dismiss, o.timeoutMs);
  return el;
}

/* ---------- 事件装配 ---------- */
function bindEvents() {
  const TS = DATA.app.toast;

  document.addEventListener('click', (e) => {
    const el = (sel) => e.target.closest(sel);

    /* 排序下拉：点它以外任何地方都收起。
       放在最前面 —— 后面的分支大多会 return，摆到末尾会被跳过。 */
    const openSort = document.querySelector('.sortwrap.open');
    if (openSort && !el('.sortwrap')) openSort.classList.remove('open');

    /* 屏内跳转 */
    const toBtn = el('[data-to]');
    if (toBtn) return go(toBtn.dataset.to);
    /* 顶栏「检索中 n%」：回检索屏看进度 —— 标记为「只是回来看」，不重新发起检索 */
    if (el('[data-run]')) {
      SEARCH_STATE.reenter = true;
      return go('search');
    }
    const goBtn = el('[data-go]');
    if (goBtn) {
      const key = goBtn.dataset.go;
      if (key === 'search') {
        /* 只有从首页发起才重新取输入框的值；回到运行中的检索屏时保持原查询。
           输入为空就**按空检索**——绝不能静默换成演示问句：用户只勾了地域、
           行业/类型都是「不限」，塞进默认问句后条件行会凭空多出
           「行业 = 智能硬件 · 来自查询」，结果集也被无关条件收窄（2026-10-15 用户实报）。 */
        const box = document.getElementById('homeQ');
        if (box) APP.query = (box.value || '').trim();
        return go('search');
      }
      return go(key);
    }

    /* 示例胶囊 */
    const ex = el('[data-example]');
    if (ex) {
      APP.query = ex.dataset.example;
      return go('search');
    }

    /* 条件精确筛选：行业 / 类型 / 截止时间
       面板内部的行 / 清空 / 确定 都不嵌在触发器里，故与地域一样不成顺序依赖；
       但仍按「小控件先判」的惯例写，避免将来结构变化时被外层吃掉。 */
    const optRow = el('[data-opt-val]');
    if (optRow) {
      const g = APP.optOpen;
      if (!g) return;
      const draft = FILTER_STATE.draft[g];
      const v = optRow.dataset.optVal;
      if (FILTER_STATE.isSingle(g)) {
        if (draft.has(v)) draft.delete(v); else { draft.clear(); draft.add(v); }
      } else if (draft.has(v)) draft.delete(v);
      else draft.add(v);
      return refreshOpt();
    }
    /* 「全选 / 取消全选」：作用于当前可见（搜索后）的选项，与地域的「选中全省」同一类快捷操作 */
    if (el('[data-opt-all]')) {
      if (APP.optOpen) FILTER_STATE.toggleAll(APP.optOpen);
      return refreshOpt();
    }
    const optClear = el('[data-opt-clear]');
    if (optClear) { if (APP.optOpen) FILTER_STATE.draft[APP.optOpen].clear(); return refreshOpt(); }
    /* 触发器上的「清空」：不进面板也能一步清掉该维度，与地域触发器的清空一致 */
    const optQuickClear = el('[data-opt-clear-q]');
    if (optQuickClear) {
      const host = optQuickClear.closest('[data-opt-trigger]');
      const key = host && host.dataset.optTrigger;
      if (key) {
        FILTER_STATE.ensure();
        FILTER_STATE.applied[key] = new Set();
        FILTER_STATE.draft[key] = new Set();
        toast(DATA.fmt(TS.filterApplied, {
          label: String(DATA.home.filter[key].label).replace(/[：:]\s*$/, ''),
          value: filterText('none'),
        }), 'info');
        return render();
      }
    }
    const optOk = el('[data-opt-ok]');
    if (optOk) {
      const g = APP.optOpen;
      if (!g) return;
      const vals = Array.from(FILTER_STATE.draft[g]);
      FILTER_STATE.applied[g] = new Set(vals);
      closeOpt();
      toast(DATA.fmt(TS.filterApplied, {
        label: String(DATA.home.filter[g].label).replace(/[：:]\s*$/, ''),
        value: vals.filter((v) => v !== filterText('none')).join(DATA.home.filter.joinSep)
          || filterText('none'),
      }), 'info');
      return render();
    }

    /* 已选标签块上的 × —— 唯一的删除热区。四个维度共用同一个控件，故放在触发器判断之前。
       值从哪来就在哪删：行政区划代码命中 CASCADE，否则按选项文案归属到对应维度。 */
    const fdrop = el('[data-fdrop]');
    if (fdrop) {
      const v = fdrop.dataset.fdrop;
      if (CASCADE.node(v)) {
        CASCADE.applied.delete(v);
        CASCADE.draft = new Set(CASCADE.applied);
        return render();
      }
      const g = FILTER_STATE.GROUPS.filter((k) => FILTER_STATE.opts(k).indexOf(v) >= 0)[0];
      if (g) { FILTER_STATE.ensure().drop(g, v); return render(); }
    }
    const optTrig = el('[data-opt-trigger]');
    if (optTrig) {
      const g = optTrig.dataset.optTrigger;
      if (APP.optOpen === g) { closeOpt(); return render(); }
      return openOpt(g, optTrig);
    }

    /* 地域触发器（内部的「标签 × / 清空 / +N」已在上面的共用分支处理） */
    const clear = el('[data-clear-region]');
    if (clear) {
      CASCADE.applied.clear();
      CASCADE.draft = new Set();
      toast(TS.regionCleared, 'info');
      return render();
    }
    const trigger = el('[data-region-trigger]');
    if (trigger) { APP.cascOpen ? closeCasc() : openCasc(trigger); return; }

    /* 级联面板 */
    const cnode = el('[data-casc-node]');
    if (cnode) {
      const code = cnode.dataset.cascNode;
      CASCADE.toggle(code);
      const n = CASCADE.node(code);
      if (n && n.level === 1 && code !== CASCADE.NATION) {
        CASCADE.activeProvince = n;
        CASCADE.activeCity = (n.children || [])[0] || null;
      } else if (n && n.level === 2) {
        CASCADE.activeCity = n;
      }
      return refreshCasc();
    }
    /* 「选中全省」快捷操作：一键勾上 / 取消当前省下全部地级市。
       纯增量 —— 不改省名自身是否勾选，也不碰其他省份。 */
    if (el('[data-casc-prov-all]')) {
      const prov = CASCADE.activeProvince;
      const r = CASCADE.toggleProvinceAll();
      toast(DATA.fmt(TS.provinceAll, {
        verb: r.allOn ? TS.provinceAllOff : TS.provinceAllOn,
        name: prov.name,
        n: r.n,
      }), 'info');
      return refreshCasc();
    }
    const only = el('[data-only-data]');
    if (only) { CASC_STATE.onlyWithData = !CASC_STATE.onlyWithData; return refreshCasc(); }
    const ok = el('[data-casc-ok]');
    if (ok) {
      CASCADE.commit();
      closeCasc();
      toast(DATA.fmt(TS.regionApplied, { summary: CASCADE.summaryText(false) }), 'ok');
      return render();
    }
    const cc = el('[data-casc-clear]');
    if (cc) { CASCADE.clear(); return refreshCasc(); }
    if (e.target.closest('#cascBackdrop')) return closeCasc();
    if (e.target.closest('#optBackdrop')) return closeOpt();

    /* 游客身份的快捷出口：顶栏那颗「退出」，一步回到登录闸门
       （不必先点进登录页再找出口 —— 这就是把入口「提前」的全部意义） */
    if (el('[data-auth-drop-guest]') && typeof AUTH !== 'undefined' && AUTH.dropGuest) {
      AUTH.dropGuest();
      AUTH.status = 'guest';
      toast(DATA.auth.toast.guestLeft, 'info');
      return go('login');
    }

    /* 结果列表 */
    const pick = el('[data-pick]');
    if (pick) {
      const id = pick.dataset.pick;
      LIST_STATE.picked.has(id) ? LIST_STATE.picked.delete(id) : LIST_STATE.picked.add(id);
      briefInvalidate();   /* 勾选变了 ⇒ 上一份简报的清单不再对应，收掉成功横幅 */
      return render();
    }
    if (el('[data-select-all]')) {
      /* 「全选」是**本页**全选（文案也写「本页 n 条」）—— 翻页后的勾选各自独立累加，
         不会因为点了一次全选就把 96 条全勾上。 */
      const page = pageItems();
      const allOn = page.length > 0 && page.every((p) => LIST_STATE.picked.has(p.id));
      page.forEach((p) => { allOn ? LIST_STATE.picked.delete(p.id) : LIST_STATE.picked.add(p.id); });
      briefInvalidate();
      return render();
    }
    const open = el('[data-open]');
    if (open) return go('detail', { policyId: open.dataset.open, target: DATA.detail.defaultTarget });

    /* 简报 */
    const seg = el('[data-seg]');
    if (seg) {
      const [g, v] = seg.dataset.seg.split(':');
      BRIEF_STATE[g] = v;
      /* 范围 / 模板 / 格式任一变化，上一份文件就不再是这一套设置下的产物 */
      briefInvalidate();
      return render();
    }
    /* 「生成并导出简报」：真去后端生成文件，再触发浏览器下载。
       以前这里只有一句 setTimeout + toast（「显示导出但没有文件」就是这个原因）。 */
    if (el('[data-export]')) return briefExport();
    if (el('[data-brief-download]')) return briefDownload();
    if (el('[data-brief-reveal]')) return briefReveal();

    /* 轻交互占位 */
    const tst = el('[data-toast]');
    if (tst) return toast(tst.dataset.toast, 'info');
    /* 结果列表：排序下拉 / 视图切换。
       排序只在本地重排（不重新检索），选完即收起；视图切换保留已勾选项。 */
    const sortOpt = el('[data-sort-opt]');
    if (sortOpt) {
      LIST_STATE.sort = sortOpt.dataset.sortOpt;
      toast(DATA.fmt(TS.sortChanged, { sort: listSortLabel() }), 'info');
      return render();
    }
    const sortBtn = el('[data-sort]');
    if (sortBtn) {
      /* 展开 / 收起只摘挂 class，不走 render —— 见 screens-b.js → sortMenuHTML() */
      const wrap = sortBtn.closest('.sortwrap');
      if (wrap) wrap.classList.toggle('open');
      return;
    }
    const viewBtn = el('[data-view]');
    if (viewBtn) {
      const v = viewBtn.dataset.view;
      if (LIST_STATE.view !== v) {
        LIST_STATE.view = v;
        toast(DATA.fmt(TS.viewChanged, {
          view: v === 'rows' ? DATA.list.tools.rows : DATA.list.tools.grid,
        }), 'info');
      }
      return render();
    }
    /* 结果列表：翻页。切片 + 重渲染，然后把列表滚回顶部 ——
       不滚的话会停在上一页的滚动位置，看着像「点了没反应」。 */
    const pageBtn = el('[data-page]');
    if (pageBtn && !pageBtn.disabled) {
      const to = Number(pageBtn.dataset.page);
      if (to >= 1 && to <= listPageCount() && to !== listPage()) {
        LIST_STATE.page = to;
        render();
        const sc = document.querySelector('.result-list.scroll, .result-table.scroll');
        if (sc) sc.scrollTop = 0;
      }
      return;
    }

    /* 对比视图（结果列表工具条 + 详情页「加入对比」共用一个 data-compare） */
    if (el('[data-compare]')) {
      const n = LIST_STATE.picked.size;
      const T = DATA.list.tools;
      const C = DATA.list.compare;
      /* 详情页语境：用户眼前只有这一条政策，没有勾选框可点 ——
         以前只会弹「至少勾选 2 条才能对比（当前 1 条）」然后停在这，等于死路。
         现在点「加入对比」就把**当前政策真加进对比清单**：
           · 凑够 2 条 → 直接回结果列表并打开对比浮层；
           · 还差条数 → 回结果列表让用户接着勾，并说清还差几条。 */
      if (APP.screen === 'detail') {
        const cur = DATA.policyById(APP.policyId);
        const pid = (cur && cur.id) || APP.policyId;
        if (pid && !LIST_STATE.picked.has(pid)) LIST_STATE.picked.add(pid);
        const m = LIST_STATE.picked.size;
        const max = T.maxCompare || 5;
        if (m > max) {
          return toast(DATA.fmt(C.tooMany, { n: m, max }), 'info');
        }
        if (m >= (T.minCompare || 2)) {
          LIST_STATE.compareOpen = true;
          go('list');
          return toast(DATA.fmt(DATA.detail.compareTips.addedOpen, { n: m }), 'ok');
        }
        go('list');
        return toast(DATA.fmt(DATA.detail.compareTips.needMore, { more: (T.minCompare || 2) - m }), 'info');
      }
      if (n < T.minCompare) return toast(DATA.fmt(C.needMore, { n }), 'info');
      if (n > (T.maxCompare || 5)) {
        return toast(DATA.fmt(C.tooMany, { n, max: T.maxCompare || 5 }), 'info');
      }
      LIST_STATE.compareOpen = true;
      return render();
    }
    if (el('[data-cmp-close]')) { LIST_STATE.compareOpen = false; return render(); }
    /* 点遮罩空白处关闭；点面板内部不关（面板也嵌在遮罩里，所以要先排除 .cmp-panel） */
    if (el('[data-cmp-mask]') && !el('.cmp-panel')) {
      LIST_STATE.compareOpen = false;
      return render();
    }
    /* ---------- 政策详情：自查清单 / 原文快照弹层 / AI 对话 ---------- */
    /* 自查勾选：整行都是热区（见 screens-b.js 的 .clause-check），
       状态只存前端（DETAIL_STATE.checks），不落库 —— 它是「我看了一眼」的临时标记。 */
    const chk = el('[data-check]');
    if (chk) {
      const i = Number(chk.dataset.check);
      /* 与 renderDetail 同一把钥匙：APP.policyId 若已不在当前结果集里，
         policyById 会兜底到 items[0]，读写必须都用归一后的 id（见 go() 里的注释）。 */
      const _cp = DATA.policyById(APP.policyId);
      const map = checkMap((_cp && _cp.id) || APP.policyId);
      if (map[i]) delete map[i]; else map[i] = true;
      return render();
    }
    if (el('[data-check-reset]')) {
      const _rp = DATA.policyById(APP.policyId);
      DETAIL_STATE.checks[(_rp && _rp.id) || APP.policyId] = {};
      return render();
    }
    /* 对话记录卡片有 role="button" + tabindex=0，键盘也要能打开 */
    const thread = el('[data-thread-open]');
    if (thread) return go('detail', { policyId: thread.dataset.threadOpen });
    /* 原文快照弹层：只摘挂 hidden，不重渲染 —— 否则对话输入框里打了一半的字会被冲掉 */
    if (el('[data-snap-open]')) return toggleSnap(true);
    if (el('[data-snap-close]')) return toggleSnap(false);

    if (el('[data-chat-send]')) return chatSend();
    if (el('[data-chat-clear]')) return chatClear();
    const sug = el('[data-chat-sug]');
    if (sug) { focusChat(sug.dataset.chatSug); return chatSend(); }

    const nav = el('[data-nav]');
    if (nav) return go(nav.dataset.nav);
  });

  /* 面板搜索框：级联面板（#cascQ）与选项面板（#optQ）各管各的草稿过滤。
     两条铁律（都是「打不了中文 / 一个字变三个」踩出来的）：
       ① 输入法组词期间不重绘 —— 候选词还没上屏就重画列表会打断组词；
       ② 重绘只换列表 / 摘要，绝不换 <input> 节点（见 patchCascPanel / patchOptPanel）。 */
  const syncPanelQuery = (t) => {
    if (t.id === 'cascQ') { CASC_STATE.query = t.value; refreshCasc(); return; }
    if (t.id === 'optQ') { if (APP.optOpen) FILTER_STATE.q[APP.optOpen] = t.value; refreshOpt(); }
  };
  document.addEventListener('input', (e) => {
    if (!e.target || e.isComposing || PANEL_IME.composing) return;
    syncPanelQuery(e.target);
  });
  document.addEventListener('compositionstart', (e) => {
    if (e.target && (e.target.id === 'cascQ' || e.target.id === 'optQ')) PANEL_IME.composing = true;
  });
  document.addEventListener('compositionend', (e) => {
    if (!e.target || (e.target.id !== 'cascQ' && e.target.id !== 'optQ')) return;
    PANEL_IME.composing = false;
    syncPanelQuery(e.target);   /* 候选词上屏后再过滤一次 */
  });

  /* 详情页整页滚动位置要跨重绘保留：详情屏里勾一条自查 / 发一条提问都会 render()
     重画整屏，滚到一半突然弹回顶部，用户得重新往下找 —— 这里记住、mountDetail 回填。 */
  document.addEventListener('scroll', (e) => {
    const t = e.target;
    if (t && t.id === 'detailScroll') DETAIL_STATE.keepScroll = { pid: APP.policyId, top: t.scrollTop };
  }, true);

  /* 键盘 */
  document.addEventListener('keydown', (e) => {
    /* Esc 在输入法里是「取消组词」，不能顺手把面板也关了 */
    if (e.isComposing || PANEL_IME.composing) return;
    if (e.key === 'Escape' && APP.cascOpen) return closeCasc();
    if (e.key === 'Escape' && APP.optOpen) { closeOpt(); return render(); }
    /* 原文快照弹层的 Esc 要在「输入框直接返回」之前判掉：
       它在结构上是盖在详情屏上的一层，跟对比浮层同级。 */
    if (e.key === 'Escape' && DETAIL_STATE.snapOpen) return toggleSnap(false);
    /* 对比浮层是「模态」的：Esc 先关它，再轮到排序下拉 */
    if (e.key === 'Escape' && LIST_STATE.compareOpen) {
      LIST_STATE.compareOpen = false;
      return render();
    }
    if (e.key === 'Escape') {
      const openSort = document.querySelector('.sortwrap.open');
      if (openSort) { openSort.classList.remove('open'); return; }
    }
    /* 对话输入框：Enter 发送、Shift+Enter 换行。
       组词期间的 Enter 是「选词上屏」，上面那道 isComposing 已经拦掉了。 */
    if (e.target && e.target.id === 'chatQ' && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      return chatSend();
    }
    /* 自查行支持键盘操作（它是 role="checkbox" 的 div，没有原生行为） */
    if (e.target && e.target.dataset && e.target.dataset.check !== undefined
        && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      const i = Number(e.target.dataset.check);
      const _kp = DATA.policyById(APP.policyId);
      const map = checkMap((_kp && _kp.id) || APP.policyId);
      if (map[i]) delete map[i]; else map[i] = true;
      return render();
    }
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    const idx = SCREENS.findIndex((s) => s.key === APP.screen);
    if (e.key === 'ArrowRight') go(SCREENS[(idx + 1) % SCREENS.length].key);
    if (e.key === 'ArrowLeft') go(SCREENS[(idx - 1 + SCREENS.length) % SCREENS.length].key);
  });

  /* 登录保留期到点后，即便不刷新页面也要生效：
     用户切回标签页 / 重新聚焦时复核一次，过期就退回登录闸门并说明原因。 */
  window.addEventListener('focus', () => {
    if (typeof AUTH === 'undefined' || typeof AUTH.authed !== 'function') return;
    if (AUTH.authed()) return;                 // 凭证仍然有效
    if (!AUTH.expired) return;                 // 本来就是游客，不打扰
    AUTH.expired = false;
    toast(DATA.fmt(DATA.auth.toast.expired, { days: AUTH.ttlDays }), 'warn');
    if (APP.screen === 'login') render(); else go('login');
  });
}

/* ---------- 启动：装载数据 → 恢复会话/回放上次结果 → 决定首屏 → 初始化外壳 ----------
   首屏规则：闸门未开（未登录且未选游客身份）→ 一律「登录 / 注册」页；
             闸门已开 → 深链优先，其次已登录进首页（有历史则结果列表）。 */
function boot() {
  defineScreens();

  /* 把数据交给各状态机（逻辑侧不再写死任何业务值） */
  CASCADE.init(DATA.regions.tree, DATA.regions.defaults);
  /* 启动时**一条都不勾**：不替用户预选演示政策。
     以前这里会灌入 DATA.list.defaultPicked（后端 top2），于是刚进应用就「已有 2 条勾选」，
     简报中心还会拿这两条排版 —— 用户会以为自己选过，或者以为简报里真有它们。 */
  LIST_STATE.picked = new Set();
  BRIEF_STATE.template = DATA.brief.settings.template.options[0].v;
  BRIEF_STATE.scope = DATA.brief.settings.scope.options[0].v;
  BRIEF_STATE.format = DATA.brief.settings.format.options[0].v;
  APP.policyId = DATA.policies.items[0].id;

  buildShell();
  bindEvents();
  const hash = (location.hash || '').replace('#', '');
  const hasHash = SCREENS.some((s) => s.key === hash);

  /* 首屏规则
     ① 闸门未开（未登录、也没选「以游客身份继续」）→ 一律停在「登录 / 注册」页，
        URL 深链也不放行：想进首页等界面，必须先登录或以游客身份进入；
     ② 闸门已开 → 尊重深链；
     ③ 否则 → 首页（已登录且库里有上次结果时，回放后自动落到结果列表）。 */
  const gated = typeof AUTH !== 'undefined' && !!AUTH.gateOpen && !AUTH.gateOpen();
  if (gated) {
    APP.screen = 'login';
  } else if (hasHash) {
    APP.screen = hash;
  }
  render();

  /* 启动反馈：登录恢复 / 登录过期 / 数据库没连上（都在外壳就绪后再提示） */
  if (typeof AUTH !== 'undefined') {
    if (AUTH.expired) {
      AUTH.expired = false;
      toast(DATA.fmt(DATA.auth.toast.expired, { days: AUTH.ttlDays }), 'warn');
    } else if (AUTH.status === 'offline') {
      toast(DATA.auth.states.offlineTitle, 'warn');
    } else if (AUTH.restored) {
      /* 已登录且库里有上次结果 → 直接落到结果列表，不必重新检索 */
      if (!hasHash && !gated) go('list');
      toast(DATA.fmt(DATA.auth.toast.restored, {
        summary: AUTH.restored.summary || (AUTH.restored.query || ''),
      }), 'ok');
    } else if (AUTH.authed()) {
      toast(DATA.fmt(DATA.auth.toast.loginOk, { name: AUTH.name() }), 'info');
    }
  }
}

/* ============================================================
   启动链路：数据装载 → 登录会话恢复 → 首屏渲染
   AUTH 由 src/screens-d.js 提供；若缺失（裁剪版构建）则跳过，退化为游客模式。
   ------------------------------------------------------------
   ★ 失败必须是**可诊断的**：以前任何一步抛错都只显示一句
     「数据加载失败：<原始 message>」，连是哪一步、哪一行都不知道。
     现在会额外打印「失败阶段 + 调用栈」，缺字段这类问题一眼可定位。
   ============================================================ */
function shellCopy() {
  return (typeof DATA !== 'undefined' && DATA.app && DATA.app.shell) || {};
}
/* 阶段名的最后兜底：**装载阶段失败时 data/app.json 本身就没读到**，
   此时 DATA.app.shell 是空的，只能靠源码里的常量把阶段说清楚。
   （与 screens-a.js 的 FILTER_LABELS 同一个套路：数据读到了就用数据，读不到就用兜底。） */
const BOOT_STAGE_FALLBACK = {
  load: '数据装载（data/*.json 或后端 /api/bootstrap）',
  auth: '登录会话恢复（/api/v1/auth/me）',
  render: '首屏渲染',
};
function showBootError(err, stage) {
  const H = shellCopy();
  const msg = err && err.message ? err.message : String(err);
  const stack = err && err.stack ? String(err.stack).split('\n').slice(0, 8).join('\n') : '';
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const stageText = (H.loadStages && H.loadStages[stage]) || BOOT_STAGE_FALLBACK[stage] || stage;
  document.body.innerHTML = '<pre style="padding:24px;font:13px/1.7 ui-monospace,monospace;color:#b42318;white-space:pre-wrap">'
    + (H.loadError || '数据加载失败：') + esc(msg)
    + '\n\n' + (H.loadStage || '【失败阶段】') + stageText
    + (stack ? '\n\n' + (H.loadStack || '【调用栈】') + '\n' + esc(stack) : '')
    + '\n\n' + (H.loadHint || '单文件版（ai-policy-agent-prototype.html）双击即可打开；dev.html 需在 gui-prototype 目录起 HTTP 服务访问。')
    + '</pre>';
}

let BOOT_STAGE = 'load';
DATA.load()
  .then(() => {
    BOOT_STAGE = 'auth';
    return (typeof AUTH !== 'undefined' && AUTH.bootstrap ? AUTH.bootstrap() : null);
  })
  .then(() => { BOOT_STAGE = 'render'; boot(); })
  .catch((err) => {
    if (typeof console !== 'undefined' && console.error) {
      console.error('[boot] 启动失败（阶段：' + BOOT_STAGE + '）', err);
    }
    showBootError(err, BOOT_STAGE);
  });
