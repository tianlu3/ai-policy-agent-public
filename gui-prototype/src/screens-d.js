/* ============================================================
   屏幕渲染 · 10 登录 / 注册 + 11 检索记录
   ------------------------------------------------------------
   · 文案与展示配置取自 DATA.auth / DATA.history（data/*.json）
   · 数据来自后端 MySQL：
       users           注册用户 + 企业档案（填一次即长期生效）
       sessions        登录会话（Bearer Token 的 SHA-256 摘要）
       search_records  每次检索的条件与结果快照（登录后自动回放）
   · 未登录 / 数据库未就绪时退化为游客模式：检索主链路照常可用。
   ============================================================ */

/* ---------- 小工具 ---------- */
function escHtml(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ============================================================
   账号状态机
   ============================================================ */
const AUTH = {
  KEY: 'policy_agent_token',
  GUEST_KEY: 'policy_agent_guest',   // 本次会话已明确选择「以游客身份继续」
  token: null,
  user: null,
  mine: null,        // { stats, latest }
  status: 'idle',    // idle | loading | ok | guest | offline
  mode: 'login',     // login | register | forgot
  busy: false,
  error: '',
  offlineReason: '',
  /* 忘记密码（AUTH.mode === 'forgot'）的运行时状态 */
  forgot: { account: '', note: '', countdown: 0, timer: null },
  restored: null,    // 本次启动回放成功的历史记录
  /* 登录凭证保留期（天）。服务端会在登录响应里下发 ttlDays（AUTH_TOKEN_TTL_DAYS），
     这里只是「服务端没说」时的兜底；两者口径应保持一致。 */
  ttlDays: 7,
  issuedAt: 0,       // 本地凭证的签发时间戳（0 = 旧格式 / 未知）
  expired: false,    // 本次启动发现本地凭证已超期 → 给一次明确提示
  /* 账号服务是否可用（后端在跑 + MySQL 已连接）。
     仅用于把登录页上的提示切换成「连不上库 / 连不上后端」两种措辞 ——
     无论可用与否，首屏都是登录页（必须登录或游客登录才放行）。 */
  serviceAvailable: false,
  networkIssue: false,   // 压根连不上后端（离线单文件版 / 服务未启动）
  _guestMem: false,      // sessionStorage 不可用时的内存兜底
};

/* ---------- 本地凭证存取（localStorage 不可用时退化为「本次会话有效」） ----------
   存的是一个 JSON：{"t": token, "at": 签发时间戳, "d": 有效期天数}。
   「登录一次就记住」靠它；「超过一定时间要重新登录」也靠它 ——
   到期后前端直接丢弃，不必等服务端 401 才知道。
   兼容旧格式：直接存的纯 token 字符串仍能读，只是签发时间未知（at = 0，
   此时不做过期判定，交给服务端会话状态裁决）。 */
AUTH.store = function () {
  try { return window.localStorage || null; } catch (e) { return null; }
};
AUTH.read = function () {
  const s = AUTH.store();
  let raw = null;
  try { raw = (s && s.getItem(AUTH.KEY)) || null; } catch (e) { return null; }
  if (!raw) return null;
  let rec = null;
  if (raw.charAt(0) === '{') {
    try { rec = JSON.parse(raw); } catch (e) { rec = null; }
  }
  if (!rec || !rec.t) rec = { t: raw, at: 0, d: 0 };   // 旧格式兜底
  AUTH.issuedAt = rec.at || 0;
  if (rec.d) AUTH.ttlDays = rec.d;
  return rec;
};
AUTH.write = function (token, at, days) {
  const s = AUTH.store();
  const rec = { t: token, at: at || Date.now(), d: days || AUTH.ttlDays };
  AUTH.issuedAt = rec.at;
  try { if (s) s.setItem(AUTH.KEY, JSON.stringify(rec)); } catch (e) { /* 隐私模式等，忽略 */ }
};
AUTH.forget = function () {
  const s = AUTH.store();
  try { if (s) s.removeItem(AUTH.KEY); } catch (e) { /* 忽略 */ }
  AUTH.token = null;
  AUTH.user = null;
  AUTH.mine = null;
  AUTH.issuedAt = 0;
  if (DATA.api && DATA.api.setToken) DATA.api.setToken(null);
};
/** 本地保留期是否已到（at = 0 表示无从判定 → 交给服务端） */
AUTH.stale = function () {
  if (!AUTH.issuedAt) return false;
  return Date.now() - AUTH.issuedAt > Math.max(1, AUTH.ttlDays) * 86400000;
};
/** 到期即退：丢凭证 + 标记原因（首屏 / 回到页面时据此给出「为什么又要登录」） */
AUTH.expire = function () {
  AUTH.forget();
  AUTH.expired = true;
  AUTH.status = 'guest';
};
/** 到期日（YYYY-MM-DD），用于账号区展示 */
AUTH.expiresOn = function () {
  if (!AUTH.issuedAt) return '';
  const d = new Date(AUTH.issuedAt + Math.max(1, AUTH.ttlDays) * 86400000);
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
};
AUTH.authed = function () {
  if (!(AUTH.user && AUTH.token)) return false;
  /* 保留期到点即失效：不必等下次启动、也不必等服务端 401 */
  if (AUTH.stale()) { AUTH.expire(); return false; }
  return true;
};
/* 显示名 —— **永远不返回 undefined**。
   服务端 user 字段缺失 / 命名不符时（例如只回了一个 {}），以前这里会返回 undefined，
   上层 `.slice(0,1)` 直接抛 TypeError，把整个 boot 干掉、只剩一页「数据加载失败」。
   姓名是纯展示信息，缺了就退化成空串，绝不该让它拖垮首屏。 */
AUTH.name = function () {
  if (!AUTH.authed()) return '';
  const u = AUTH.user || {};
  return u.displayName || u.username || '';
};
/* 头像首字（取显示名第一个字符；没有则用占位符） */
AUTH.initial = function (fallback) {
  const nm = AUTH.name();
  return (nm && nm.charAt(0)) || fallback || '?';
};

/* ============================================================
   闸门：打开应用后必须先「登录」或「以游客身份继续」才能进入首页等界面
   ------------------------------------------------------------
   游客身份记在 sessionStorage —— 同一标签页刷新不会被反复拦（进入后的
   正常跳转/刷新是允许的），但重新打开一个标签页/窗口会再次要求选择。
   ============================================================ */
AUTH.guestStore = function () {
  try { return window.sessionStorage || null; } catch (e) { return null; }
};
AUTH.guest = function () {
  const s = AUTH.guestStore();
  try { return !!(s && s.getItem(AUTH.GUEST_KEY)) || AUTH._guestMem; } catch (e) { return AUTH._guestMem; }
};
AUTH.continueAsGuest = function () {
  AUTH._guestMem = true;
  const s = AUTH.guestStore();
  try { if (s) s.setItem(AUTH.GUEST_KEY, '1'); } catch (e) { /* 隐私模式，内存兜底 */ }
  return AUTH;
};
AUTH.dropGuest = function () {
  AUTH._guestMem = false;
  const s = AUTH.guestStore();
  try { if (s) s.removeItem(AUTH.GUEST_KEY); } catch (e) { /* 忽略 */ }
};
/* 闸门是否已开：已登录，或已明确选择游客身份 */
AUTH.gateOpen = function () { return AUTH.authed() || AUTH.guest(); };

/* 无凭证时探测「账号服务是否可用」，用于决定要不要把登录页作为首屏：
   后端没跑 / MySQL 没连接时若仍摆出登录页，用户点进去才发现登不了，体验很差。 */
AUTH.probeService = function () {
  if (!DATA.api || !DATA.api.dbStatus) {
    AUTH.serviceAvailable = false;
    return Promise.resolve(AUTH);
  }
  return DATA.api.dbStatus().then(function (st) {
    AUTH.serviceAvailable = !!(st && st.available);
    AUTH.offlineReason = AUTH.serviceAvailable ? '' : ((st && st.error) || '');
    /* 探活到「后端在跑但库没连上」时，直接把首屏标成 offline ——
       否则用户要对着一个填完才告诉他登不进去的表单反复试。
       已登录（ok）的会话不受影响。 */
    if (!AUTH.serviceAvailable && AUTH.status !== 'ok') AUTH.status = 'offline';
    return AUTH;
  }, function (err) {
    AUTH.serviceAvailable = false;
    AUTH.networkIssue = true;
    AUTH.offlineReason = (err && err.message) || String(err);
    return AUTH;
  });
};

/* ---------- 启动时恢复会话，并回放最近一次检索结果 ---------- */
AUTH.bootstrap = function () {
  const rec = AUTH.read();
  AUTH.token = rec ? rec.t : null;
  /* 先判本地保留期：超期直接丢弃并标记，首屏就能明确告知「为什么又要登录」。 */
  if (AUTH.token && AUTH.stale()) {
    AUTH.expire();
    return AUTH.probeService();
  }
  if (!AUTH.token || !DATA.api) {
    AUTH.status = 'guest';
    /* 没有本地凭证：探一下账号服务是否可用（决定首屏是否是登录页） */
    return AUTH.probeService();
  }
  DATA.api.setToken(AUTH.token);
  AUTH.status = 'loading';

  return DATA.api.me().then(function (res) {
    AUTH.user = res.user;
    AUTH.mine = res;
    AUTH.status = 'ok';
    AUTH.serviceAvailable = true;
    AUTH.offlineReason = '';
    AUTH.networkIssue = false;
    const latest = res.latest;
    if (!latest || !latest.id) return null;
    /* 关键：把上次结果直接灌回前端，省掉一次重复检索 */
    return DATA.api.historyDetail(latest.id).then(function (d) {
      if (d && d.bootstrap) {
        DATA.hydrateBackend(d.bootstrap);
        AUTH.restored = d.record || latest;
      }
      return d;
    }).catch(function () { return null; });
  }).catch(function (err) {
    if (err && err.status === 401) {
      /* 凭证已过期/被踢下线：安静地退回游客态（服务本身是好的） */
      AUTH.forget();
      AUTH.status = 'guest';
      AUTH.serviceAvailable = true;
    } else if (err && err.status === 503) {
      /* 后端在跑，但 MySQL 没连上 —— 提示「账号功能暂不可用」 */
      AUTH.status = 'offline';
      AUTH.serviceAvailable = false;
      AUTH.offlineReason = (err && err.message) || String(err);
    } else {
      /* 压根连不上后端（离线单文件版 / 服务未启动）：安静退回游客态 */
      AUTH.status = 'guest';
      AUTH.serviceAvailable = false;
      AUTH.networkIssue = true;
      AUTH.offlineReason = (err && err.message) || String(err);
    }
    return null;
  }).then(function () { return AUTH; });
};

AUTH.adopt = function (res) {
  AUTH.token = res.token || null;
  if (res.ttlDays) AUTH.ttlDays = res.ttlDays;
  /* 记下「什么时候登录的 + 能记多久」，下次启动据此判断是否要重新登录 */
  if (AUTH.token) AUTH.write(AUTH.token, Date.now(), AUTH.ttlDays);
  if (DATA.api && DATA.api.setToken) DATA.api.setToken(AUTH.token);
  AUTH.user = res.user || null;
  AUTH.status = 'ok';
  AUTH.expired = false;
  AUTH.error = '';
  AUTH.offlineReason = '';
  return res;
};

AUTH.submitLogin = function (username, password) {
  if (AUTH.busy) return Promise.reject(new Error('请稍候'));
  AUTH.busy = true;
  AUTH.error = '';
  return DATA.api.login({ username: username, password: password }).then(function (res) {
    AUTH.busy = false;
    return AUTH.adopt(res);
  }, function (err) {
    AUTH.busy = false;
    throw err;
  });
};

AUTH.submitRegister = function (payload) {
  if (AUTH.busy) return Promise.reject(new Error('请稍候'));
  AUTH.busy = true;
  AUTH.error = '';
  return DATA.api.register(payload).then(function (res) {
    AUTH.busy = false;
    return AUTH.adopt(res);
  }, function (err) {
    AUTH.busy = false;
    throw err;
  });
};

AUTH.doLogout = function () {
  return DATA.api.logout().catch(function () { return null; }).then(function () {
    AUTH.forget();
    /* 同时撤销本次会话的游客身份：退登后回到闸门，要求重新选择登录 / 游客 */
    AUTH.dropGuest();
    AUTH.status = 'guest';
    AUTH.error = '';
  });
};

AUTH.refreshMine = function () {
  if (!AUTH.authed()) return Promise.resolve(null);
  return DATA.api.me().then(function (res) {
    AUTH.user = res.user;
    AUTH.mine = res;
    return res;
  }).catch(function () { return null; });
};

/* ---------- 顶栏账号区（供 topBar 复用） ----------
   三态：已登录 / 游客 / 未进入。游客态必须**可辨识 + 有一步出口**：
   从前游客只能看到一枚「登录 / 注册」，想退出只能刷新或自己猜 ——
   现在顶栏明确标出「游客 · 未保存」，右侧直接给「退出」（PRD Q10）。 */
function authChip() {
  /* 数据 / 文案缺失时**绝不能抛错**：这里在 boot() 的渲染链上，
     一旦抛错整个应用只会剩一页「数据加载失败」。
     所以 guest 段的每个键都带兜底，badge 缺失也不影响「游客 · 退出」两步走。 */
  const G = (DATA.auth && DATA.auth.guest) || {};
  const gBadge = G.badge || '游客';
  if (AUTH.authed()) {
    const nm = AUTH.name();
    return '<button class="tb-user on" data-go="login" title="账号与档案 · 点此查看">'
      + '<span class="av">' + escHtml(AUTH.initial('?')) + '</span>'
      + '<span class="un">' + escHtml(nm || '已登录') + '</span>'
      + '<span class="tb-pill on">已登录</span></button>';
  }
  if (AUTH.guest()) {
    return '<span class="tb-guest">'
      + '<button class="tb-user guest" data-go="login" title="' + escHtml(G.chipTitle || gBadge) + '">'
      + '<span class="av">' + escHtml(gBadge.slice(0, 1)) + '</span>'
      + '<span class="un">' + escHtml(gBadge) + '</span>'
      + '<span class="tb-pill warn">' + escHtml(G.pill || '') + '</span></button>'
      + '<button class="tb-drop" data-auth-drop-guest="1" title="' + escHtml(G.exitShortTitle || '退出游客身份') + '">'
      + escHtml(G.exitShort || '退出') + '</button>'
      + '</span>';
  }
  const off = AUTH.status === 'offline';
  return '<button class="tb-user" data-go="login" title="'
    + (off ? '数据库未连接，账号功能不可用' : '登录后自动保存检索记录，下次打开直接回放')
    + '">' + ICON.user
    + '<span class="un">' + (off ? '未连接数据库' : '登录 / 注册') + '</span></button>';
}

/* ============================================================
   10 · 登录 / 注册 / 账号
   ============================================================ */
function renderLogin() {
  const A = DATA.auth;
  return `
  <div class="screen">
    ${topBar('login')}
    <div class="auth-body">
      ${authAside(A)}
      ${AUTH.user ? authAccountPanel(A) : authFormPanel(A)}
    </div>
  </div>`;
}

/* ---------- 左侧说明栏 ---------- */
function authAside(A) {
  const points = A.aside.points.map((p) => `
    <li><span class="pt-ic">${ICON[p.icon] || ICON.doc}</span>
      <div><b>${p.title}</b><span>${p.desc}</span></div></li>`).join('');
  return `
  <section class="auth-aside">
    <div class="aa-kicker">${A.aside.kicker}</div>
    <h2>${A.aside.title}</h2>
    <p class="aa-sub">${A.aside.sub}</p>
    <ul class="aa-list">${points}</ul>
    <div class="aa-foot">${ICON.lock}${A.aside.foot}</div>
  </section>`;
}

/* ---------- 按条件预填：注册时把首页/级联里已经选好的条件带进来 ---------- */
function authDefaults() {
  const F = (DATA.home && DATA.home.filter) || {};
  const list = (typeof CASCADE !== 'undefined' && CASCADE.selectedNodes)
    ? (CASCADE.selectedNodes(false) || []) : [];
  const city = list.filter((n) => n.level === 2)[0]
    || list.filter((n) => n.level === 1)[0] || list[0] || null;
  /* 行业取「条件精确筛选」里已生效的多选项（可能为空 → 不限） */
  const ind = (typeof FILTER_STATE !== 'undefined' && FILTER_STATE.ensure)
    ? FILTER_STATE.ensure().values('industry').join(F.joinSep || ' / ')
    : ((F.industry && F.industry.value) || '');
  return {
    industry: ind,
    regionName: list.map((n) => n.name).join(' / '),
    regionCode: city ? city.code : '',
  };
}

function authField(opts) {
  const o = opts || {};
  const hint = o.hint ? `<span class="aff-h">${o.hint}</span>` : '';
  return `
  <label class="aff ${o.wide ? 'wide' : ''}">
    <span class="aff-l">${o.label}</span>
    <input id="${o.id}" type="${o.type || 'text'}" placeholder="${o.placeholder || ''}"
      value="${escHtml(o.value || '')}" autocomplete="${o.autocomplete || 'off'}"
      ${o.inputmode ? `inputmode="${o.inputmode}"` : ''}>
    ${hint}
  </label>`;
}

/* ---------- 未登录：登录 / 注册 / 忘记密码表单 ---------- */
function authFormPanel(A) {
  const mode = AUTH.mode === 'register' ? 'register'
    : (AUTH.mode === 'forgot' ? 'forgot' : 'login');
  const C = A[mode];
  const F = A.fields;
  const D = authDefaults();
  const FG = AUTH.forgot;

  const tabs = `
    <div class="auth-tabs">
      <button data-auth-tab="login" class="${mode !== 'register' ? 'on' : ''}">${A.tabs.login}</button>
      <button data-auth-tab="register" class="${mode === 'register' ? 'on' : ''}">${A.tabs.register}</button>
    </div>`;

  const forgotLink = mode === 'login' ? `
      <div class="auth-forgot">
        <button type="button" class="btn-link" data-auth-forgot="1">${A.forgot.link}</button>
      </div>` : '';

  const form = mode === 'forgot' ? `
    <form class="auth-form" id="forgotForm" novalidate>
      ${authField({ id: 'fg_account', label: C.accountLabel, placeholder: C.accountPlaceholder,
        hint: A.fields.username.hint, value: FG.account, autocomplete: 'username' })}
      <div class="fg-coderow">
        ${authField({ id: 'fg_code', label: C.codeLabel, placeholder: C.codePlaceholder,
          hint: '', inputmode: 'numeric' })}
        <button type="button" class="btn btn-outline fg-send" id="fgSend"
          data-forgot-send ${FG.countdown > 0 ? 'disabled' : ''}>${FG.countdown > 0 ? DATA.fmt(C.resendIn, { n: FG.countdown }) : C.sendCode}</button>
      </div>
      ${authField({ id: 'fg_new', label: C.newPasswordLabel, placeholder: C.newPasswordPlaceholder,
        type: 'password', hint: '', autocomplete: 'new-password' })}
      ${FG.note ? `<div class="auth-code-note">${ICON.info}<span>${escHtml(FG.note)}</span></div>` : ''}
      <button class="btn btn-primary btn-lg auth-submit" id="fgSubmit" type="submit">${C.submit}</button>
    </form>` : mode === 'login' ? `
    <form class="auth-form" id="authForm" novalidate>
      ${authField({ id: 'af_username', label: F.username.label, placeholder: F.username.placeholder,
        hint: F.username.hint, autocomplete: 'username', value: AUTH.lastUsername || '' })}
      ${authField({ id: 'af_password', label: F.password.label, placeholder: F.password.placeholder,
        type: 'password', autocomplete: 'current-password' })}
      ${forgotLink}
      <button class="btn btn-primary btn-lg auth-submit" id="authSubmit" type="submit">${C.submit}</button>
    </form>` : `
    <form class="auth-form" id="authForm" novalidate>
      <div class="aff-grid">
        ${authField({ id: 'af_username', label: F.username.label, placeholder: F.username.placeholder,
          hint: F.username.hint, autocomplete: 'username' })}
        ${authField({ id: 'af_displayName', label: F.displayName.label, placeholder: F.displayName.placeholder,
          hint: F.displayName.hint })}
        ${authField({ id: 'af_password', label: F.password.label, placeholder: F.password.placeholder,
          type: 'password', hint: F.password.hint, autocomplete: 'new-password' })}
        ${authField({ id: 'af_password2', label: F.password2.label, placeholder: F.password2.placeholder,
          type: 'password', autocomplete: 'new-password' })}
        ${authField({ id: 'af_email', label: F.email.label, placeholder: F.email.placeholder,
          hint: F.email.hint, autocomplete: 'email' })}
        ${authField({ id: 'af_company', label: F.company.label, placeholder: F.company.placeholder,
          hint: F.company.hint })}
        ${authField({ id: 'af_industry', label: F.industry.label, placeholder: F.industry.placeholder,
          hint: F.industry.hint, value: D.industry })}
        <label class="aff">
          <span class="aff-l">${A.regionField.label}</span>
          <input id="af_regionName" type="text" value="${escHtml(D.regionName)}"
            placeholder="${escHtml(A.regionField.empty)}">
          <span class="aff-h">${A.regionField.hint}</span>
        </label>
      </div>
      <button class="btn btn-primary btn-lg auth-submit" id="authSubmit" type="submit">${C.submit}</button>
    </form>`;

  /* 账号服务几种不可用形态：库没起（offline）/ 后端没跑（networkIssue）。
     无论哪种，闸门都要求「登录 or 游客身份」二选一，故横幅里直接给出游客出口。 */
  const S = A.states;
  let banner = '';
  if (AUTH.status === 'offline') {
    banner = `
    <div class="banner warn" style="margin-bottom:2px">
      <span class="bn-ic">${ICON.alert}</span>
      <div class="bn-main">
        <div class="bn-ttl">${S.offlineTitle}</div>
        <div class="bn-desc">${S.offlineDesc}<br>${escHtml(AUTH.offlineReason || '')}</div>
      </div>
      <div class="bn-acts"><button class="btn btn-outline btn-sm" data-auth-guest="1">${S.offlineCta}</button></div>
    </div>`;
  } else if (AUTH.networkIssue) {
    banner = `
    <div class="banner warn" style="margin-bottom:2px">
      <span class="bn-ic">${ICON.alert}</span>
      <div class="bn-main">
        <div class="bn-ttl">${S.networkTitle}</div>
        <div class="bn-desc">${S.networkDesc}</div>
      </div>
      <div class="bn-acts"><button class="btn btn-outline btn-sm" data-auth-guest="1">${S.offlineCta}</button></div>
    </div>`;
  }
  const offline = banner;
  const G = A.guest;
  /* 已经是游客：把「当前身份 + 一步退出」直接摆在表单上方，
     下面那排「以游客身份继续」就没有意义了，换成状态说明。 */
  const isGuest = AUTH.guest();

  return `
  <section class="auth-card card">
    ${tabs}
    <div class="auth-head">
      <h3>${C.title}</h3>
      <span>${C.sub}</span>
    </div>
    ${offline}
    ${isGuest ? `
    <div class="banner info" style="margin-bottom:2px">
      <span class="bn-ic">${ICON.info}</span>
      <div class="bn-main">
        <div class="bn-ttl">${G.exitTitle}</div>
        <div class="bn-desc">${G.exitNote}</div>
      </div>
      <div class="bn-acts"><button class="btn btn-outline btn-sm" data-auth-drop-guest="1">${G.exitAction}</button></div>
    </div>` : ''}
    <div class="auth-err ${AUTH.error ? 'show' : ''}" id="authErr">
      ${AUTH.error ? ICON.alert + '<span>' + escHtml(AUTH.error) + '</span>' : ''}
    </div>
    ${form}
    <div class="auth-remember">${ICON.lock}<span>${DATA.fmt(A.rememberNote, { days: AUTH.ttlDays })}</span></div>
    <div class="auth-switch">
      <span>${C.switchHint}</span>
      <button class="btn-link" data-auth-tab="${mode === 'login' ? 'register' : 'login'}">${C.switchAction}</button>
    </div>
    <div class="auth-guest">
      <span class="gate-note">${ICON.lock}${isGuest ? G.exitNote : A.gate.note}</span>
      ${isGuest ? '' : `
      <div class="ag-row">
        <button class="btn btn-outline btn-sm" data-auth-guest="1">${G.title}</button>
        <span class="hint">${G.note}</span>
      </div>`}
    </div>
  </section>`;
}

/* ---------- 已登录：账号与档案 + 我的数据 ---------- */
function authAccountPanel(A) {
  const C = A.account;
  const u = AUTH.user || {};
  const st = (AUTH.mine && AUTH.mine.stats) || {};
  const none = `<span class="none">${C.emptyValue}</span>`;
  const val = (v) => (v === null || v === undefined || v === '' ? none : escHtml(v));

  const stats = [
    { k: 'searches', v: st.searches },
    { k: 'succeeded', v: st.succeeded },
    { k: 'failed', v: st.failed },
    { k: 'activeSessions', v: st.activeSessions },
  ].map((s) => `
    <div class="ac-stat"><span>${C.stats[s.k]}</span>
      <b class="num">${s.v === null || s.v === undefined ? 0 : s.v}</b></div>`).join('');

  const restored = AUTH.restored ? `
    <div class="banner ok" style="margin-top:2px">
      <span class="bn-ic">${ICON.ok}</span>
      <div class="bn-main">
        <div class="bn-ttl">已自动回放上次检索结果</div>
        <div class="bn-desc">「${escHtml(AUTH.restored.query || '')}」 · ${escHtml(AUTH.restored.summary || '')} · ${escHtml(AUTH.restored.createdAt || '')}</div>
      </div>
      <div class="bn-acts"><button class="btn btn-outline btn-sm" data-go="list">查看结果</button></div>
    </div>` : '';

  return `
  <section class="auth-card card">
    <div class="ac-head">
      <span class="ac-av">${escHtml(AUTH.initial('?'))}</span>
      <div class="ac-id">
        <div class="ac-nm">${escHtml(AUTH.name() || '已登录')}
          <span class="badge badge-ok badge-lg">${C.badge}</span></div>
        <div class="ac-sub">${escHtml(u.username || '')}${u.email ? ' · ' + escHtml(u.email) : ''}
          · 注册于 ${escHtml(u.createdAt || '')}</div>
      </div>
      <button class="btn btn-outline btn-sm" data-auth-logout="1">${C.actions.logout}</button>
    </div>

    ${restored}

    <div class="ac-sec">
      <div class="sec-head"><h4>${C.profileTitle}</h4>
        <span class="spacer" style="flex:1"></span>
        <span class="hint">${C.editHint}</span></div>
      <div class="aff-grid">
        ${authField({ id: 'pf_displayName', label: A.fields.displayName.label, value: u.displayName || '' })}
        ${u.email ? `
        <div class="aff wide">
          <span class="aff-l">${A.fields.email.label}</span>
          <div class="pf-emailrow">
            <input id="pf_email" type="text" readonly
              value="${escHtml(u.email || '')}" autocomplete="off" title="${C.emailBindHint}">
            <button type="button" class="btn btn-outline btn-sm" id="pfEmailEdit"
              data-email-edit="1">${C.emailEditBtn}</button>
          </div>
          <span class="aff-h">${C.emailBindHint}</span>
        </div>
        <div class="aff wide pf-bindpanel" id="pfCodeRow" style="display:none">
          <div class="aff">
            <span class="aff-l">${C.newEmailLabel}</span>
            <input id="pf_emailNew" type="text" placeholder="${A.fields.email.placeholder || ''}"
              autocomplete="off" inputmode="email">
          </div>
          <div class="fg-coderow aff-coderow">
            ${authField({ id: 'pf_emailCode', label: C.bindCodeLabel, placeholder: C.bindCodePlaceholder,
              hint: '', inputmode: 'numeric' })}
            <button type="button" class="btn btn-outline fg-send" id="pfBindSend"
              data-bind-send="1">${C.sendBindCode}</button>
          </div>
          <div class="pf-bindacts">
            <button type="button" class="btn btn-solid btn-sm" id="pfBindConfirm"
              data-bind-confirm="1">${C.bindConfirm}</button>
          </div>
        </div>` : `
        ${authField({ id: 'pf_email', label: A.fields.email.label,
          placeholder: A.fields.email.placeholder,
          hint: C.emailBindFreeHint, value: u.email || '' })}`}
        ${authField({ id: 'pf_phone', label: A.fields.phone.label,
          placeholder: A.fields.phone.placeholder, hint: A.fields.phone.hint, value: u.phone || '' })}
        ${authField({ id: 'pf_company', label: A.fields.company.label,
          placeholder: A.fields.company.placeholder, value: u.company || '' })}
        ${authField({ id: 'pf_industry', label: A.fields.industry.label,
          placeholder: A.fields.industry.placeholder, value: u.industry || '' })}
        ${authField({ id: 'pf_regionName', label: A.regionField.label, value: u.regionName || '' })}
      </div>
      <div class="auth-code-note" id="pfBindNote" style="display:none"></div>
      <div class="ac-acts">
        <button class="btn btn-solid btn-sm" data-profile-save="1">${C.actions.profile}</button>
        <button class="btn btn-outline btn-sm" data-go="history">${C.actions.history}</button>
        <button class="btn btn-ghost btn-sm" data-go="home">${C.actions.search}</button>
      </div>
    </div>

    <div class="ac-sec">
      <div class="sec-head"><h4>${C.pwdTitle}</h4>
        <span class="spacer" style="flex:1"></span>
        <span class="hint">${C.pwdEditHint}</span>
        <button type="button" class="btn btn-outline btn-sm" id="pfPwdEdit"
          data-pwd-edit="1">${C.pwdEditBtn}</button></div>
      <div class="aff-grid" id="pfPwdGrid" style="display:none">
        ${authField({ id: 'pw_old', label: C.pwdOldLabel, type: 'password',
          hint: '', autocomplete: 'current-password' })}
        ${authField({ id: 'pw_new', label: C.pwdNewLabel, type: 'password',
          placeholder: A.forgot.newPasswordPlaceholder, hint: '', autocomplete: 'new-password' })}
        ${authField({ id: 'pw_new2', label: C.pwdNew2Label, type: 'password',
          hint: '', autocomplete: 'new-password' })}
      </div>
      <div class="ac-acts" id="pfPwdActs" style="display:none">
        <button class="btn btn-outline btn-sm" data-pwd-save="1">${C.pwdSubmit}</button>
      </div>
    </div>

    <div class="ac-sec">
      <div class="sec-head"><h4>${C.statsTitle}</h4>
        <span class="spacer" style="flex:1"></span>
        <span class="hint">${DATA.fmt(C.sessionNote, { days: AUTH.ttlDays })}${
          AUTH.expiresOn() ? ' · ' + DATA.fmt(C.sessionExpire, { date: AUTH.expiresOn() }) : ''}</span></div>
      <div class="ac-stats">${stats}</div>
      <div class="hint">最近检索：${val(st.lastSearchAt)}</div>
    </div>
  </section>`;
}

/* ---------- 挂载：表单提交 / 切换 / 退出 / 保存档案 ---------- */
function mountLogin(go) {
  const A = DATA.auth;
  const host = document.querySelector('.screen');
  if (!host) return;

  host.querySelectorAll('[data-auth-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      AUTH.mode = btn.dataset.authTab;
      AUTH.error = '';
      render();
    });
  });

  /* 忘记密码：登录表单 → 重置表单（预填用户名输入框的现值，而非 lastUsername
     —— lastUsername 只在登录成功后才有值，输错密码时是空的） */
  host.querySelectorAll('[data-auth-forgot]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const cur = document.getElementById('af_username');
      const typed = cur && cur.value ? cur.value.trim() : '';
      AUTH.mode = 'forgot';
      AUTH.error = '';
      AUTH.forgot = {
        account: typed || AUTH.lastUsername || '',
        note: '', countdown: 0, timer: null,
      };
      render();
    });
  });

  /* 忘记密码 · 获取验证码（60s 冷却；原型模式下验证码直接回显） */
  const fgSend = host.querySelector('[data-forgot-send]');
  if (fgSend) {
    fgSend.addEventListener('click', () => {
      const C = A.forgot;
      const account = (document.getElementById('fg_account') || {}).value || '';
      AUTH.forgot.account = account.trim();
      if (!AUTH.forgot.account) return showAuthErr(A.errors.required.replace('{label}', C.accountLabel));
      if (AUTH.forgot.countdown > 0) return;
      fgSend.disabled = true;
      fgSend.innerHTML = '<i class="spin dark"></i>';
      DATA.api.forgotPassword(AUTH.forgot.account).then((res) => {
        if (res.channel === 'email') {
          AUTH.forgot.note = DATA.fmt(C.codeSentEmail, { sentTo: res.sentTo || '', seconds: res.expiresIn });
        } else {
          AUTH.forgot.note = DATA.fmt(C.codeSent, { code: res.code, seconds: res.expiresIn });
        }
        AUTH.error = '';
        let n = 60;
        AUTH.forgot.countdown = n;
        if (AUTH.forgot.timer) clearInterval(AUTH.forgot.timer);
        const tick = () => {
          AUTH.forgot.countdown = n;
          const b = document.getElementById('fgSend');
          if (!b) { clearInterval(AUTH.forgot.timer); return; }
          if (n <= 0) {
            clearInterval(AUTH.forgot.timer);
            AUTH.forgot.timer = null;
            b.disabled = false;
            b.textContent = C.sendCode;
            return;
          }
          b.textContent = DATA.fmt(C.resendIn, { n: n });
          n -= 1;
        };
        tick();
        AUTH.forgot.timer = setInterval(tick, 1000);
        render();
      }).catch((err) => {
        fgSend.disabled = false;
        fgSend.textContent = C.sendCode;
        showAuthErr((err && err.message) || A.errors.fallback.replace('{msg}', String(err)));
      });
    });
  }

  /* 忘记密码 · 提交重置 */
  const forgotForm = document.getElementById('forgotForm');
  if (forgotForm) {
    forgotForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const C = A.forgot;
      const val = (id) => {
        const el = document.getElementById(id);
        return el ? el.value.trim() : '';
      };
      const account = val('fg_account');
      const code = val('fg_code');
      const password = document.getElementById('fg_new')
        ? document.getElementById('fg_new').value : '';
      if (!account) return fgFail(A.errors.required.replace('{label}', C.accountLabel));
      if (!code) return fgFail(C.codeRequired);
      if (password.length < 6 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
        return fgFail(A.errors.passwordWeak);
      }
      AUTH.forgot.account = account;
      const btn = document.getElementById('fgSubmit');
      if (btn) {
        btn.classList.add('is-busy');
        btn.innerHTML = '<i class="spin"></i>' + C.submitting;
      }
      DATA.api.resetPassword({ account: account, code: code, password: password })
        .then(() => {
          AUTH.forgot = { account: '', note: '', countdown: 0, timer: null };
          AUTH.mode = 'login';
          AUTH.error = '';
          AUTH.lastUsername = account;
          toast(C.resetOk, 'ok');
          render();
        })
        .catch((err) => {
          fgFail((err && err.message) || A.errors.fallback.replace('{msg}', String(err)));
        });

      function fgFail(msg) {
        AUTH.error = msg;
        const btn2 = document.getElementById('fgSubmit');
        if (btn2) {
          btn2.classList.remove('is-busy');
          btn2.innerHTML = A.forgot.submit;
        }
        showAuthErr(msg);
        return false;
      }
    });
  }

  function showAuthErr(msg) {
    AUTH.error = msg;
    const box = document.getElementById('authErr');
    if (box) {
      box.className = 'auth-err show';
      box.innerHTML = ICON.alert + '<span>' + escHtml(msg) + '</span>';
    }
    return false;
  }

  host.querySelectorAll('[data-auth-guest]').forEach((btn) => {
    btn.addEventListener('click', () => {
      AUTH.error = '';
      /* 闸门的另一半：记下「本次会话以游客身份进入」，此后不再拦（同一标签页刷新有效） */
      AUTH.continueAsGuest();
      go('home');
    });
  });

  const logout = host.querySelector('[data-auth-logout]');
  if (logout) {
    logout.addEventListener('click', () => {
      logout.classList.add('is-busy');
      logout.innerHTML = '<i class="spin dark"></i>' + A.account.actions.logout;
      AUTH.doLogout().then(() => {
        toast(A.account.logoutDone, 'info');
        /* 退登同时撤销游客身份 —— 回到闸门，重新二选一 */
        go('login');
      });
    });
  }

  const save = host.querySelector('[data-profile-save]');
  if (save) {
    save.addEventListener('click', () => {
      const get = (id) => {
        const el = document.getElementById(id);
        return el ? el.value.trim() : '';
      };
      /* 已绑邮箱的账号：邮箱换绑走独立的「修改邮箱 → 确认更换」流程（带验证码），
         主保存不再携带 email，免得每次保存都撞 EMAIL_CODE_REQUIRED */
      const bound = !!(AUTH.user && AUTH.user.email);
      const patch = {
        displayName: get('pf_displayName'),
        phone: get('pf_phone'),
        company: get('pf_company'),
        industry: get('pf_industry'),
        regionName: get('pf_regionName'),
      };
      if (!bound) patch.email = get('pf_email');
      save.classList.add('is-busy');
      DATA.api.updateProfile(patch).then((res) => {
        AUTH.user = res.user;
        toast(A.account.saved, 'ok');
        render();
      }).catch((err) => {
        save.classList.remove('is-busy');
        AUTH.error = DATA.fmt(A.errors.fallback, { msg: (err && err.message) || err });
        render();
      });
    });
  }

  /* 修改邮箱：点「修改邮箱」展开验证码行，再点一次收回（未绑邮箱的账号无需验证码，不渲染此按钮） */
  const emailEdit = host.querySelector('[data-email-edit]');
  if (emailEdit) {
    emailEdit.addEventListener('click', () => {
      const row = document.getElementById('pfCodeRow');
      if (!row) return;
      const show = row.style.display === 'none';
      row.style.display = show ? '' : 'none';
      const em = document.getElementById('pf_email');
      if (show && em) em.focus();
    });
  }

  /* 修改密码：点「修改密码」展开三个密码输入框，再点一次收回 */
  const pwdEdit = host.querySelector('[data-pwd-edit]');
  if (pwdEdit) {
    pwdEdit.addEventListener('click', () => {
      const grid = document.getElementById('pfPwdGrid');
      if (!grid) return;
      const show = grid.style.display === 'none';
      ['pfPwdGrid', 'pfPwdActs'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.style.display = show ? '' : 'none';
      });
      const oldEl = document.getElementById('pw_old');
      if (show && oldEl) oldEl.focus();
    });
  }

  /* 更换绑定邮箱 · 发验证码（60s 冷却；echo 回显 / email 真发）——发往「更换到的邮箱」 */
  const bindSend = host.querySelector('[data-bind-send]');
  if (bindSend) {
    bindSend.addEventListener('click', () => {
      const C = A.account;
      const emailEl = document.getElementById('pf_emailNew');
      const email = emailEl ? emailEl.value.trim() : '';
      const note = document.getElementById('pfBindNote');
      const showNote = (html) => {
        if (note) { note.style.display = ''; note.innerHTML = html; }
      };
      if (!email) return showNote(ICON.alert + '<span>' + escHtml(C.bindNeedEmail) + '</span>');
      if (bindSend.disabled) return;
      bindSend.disabled = true;
      bindSend.innerHTML = '<i class="spin dark"></i>';
      const revert = () => { bindSend.disabled = false; bindSend.textContent = C.sendBindCode; };
      DATA.api.sendBindCode(email).then((res) => {
        showNote(ICON.info + '<span>' + escHtml(res.channel === 'email'
          ? DATA.fmt(C.bindSentEmail, { sentTo: res.sentTo || '', seconds: res.expiresIn })
          : DATA.fmt(C.bindSent, { code: res.code, seconds: res.expiresIn })) + '</span>');
        let n = 60;
        const tick = () => {
          if (!document.getElementById('pfBindSend')) { return; }
          if (n <= 0) { revert(); return; }
          bindSend.textContent = DATA.fmt(A.forgot.resendIn, { n: n });
          n -= 1;
          setTimeout(tick, 1000);
        };
        tick();
      }).catch((err) => {
        revert();
        showNote(ICON.alert + '<span>' + escHtml((err && err.message) || String(err)) + '</span>');
      });
    });
  }

  /* 确认更换：新邮箱 + 验证码 → PATCH 档案换绑（成功后刷新用户并收起面板） */
  const bindConfirm = host.querySelector('[data-bind-confirm]');
  if (bindConfirm) {
    bindConfirm.addEventListener('click', () => {
      const C = A.account;
      const get = (id) => {
        const el = document.getElementById(id);
        return el ? el.value.trim() : '';
      };
      const note = document.getElementById('pfBindNote');
      const showNote = (html) => {
        if (note) { note.style.display = ''; note.innerHTML = html; }
      };
      const newEmail = get('pf_emailNew');
      if (!newEmail) return showNote(ICON.alert + '<span>' + escHtml(C.bindNeedEmail) + '</span>');
      const code = get('pf_emailCode');
      if (!code) {
        return showNote(ICON.alert + '<span>' + escHtml(C.bindCodeRequired) + '</span>');
      }
      bindConfirm.classList.add('is-busy');
      bindConfirm.innerHTML = '<i class="spin dark"></i>';
      DATA.api.updateProfile({ email: newEmail, emailCode: code }).then((res) => {
        AUTH.user = res.user;
        toast(DATA.fmt(C.bindOk, { email: newEmail }), 'ok');
        render();
      }).catch((err) => {
        bindConfirm.classList.remove('is-busy');
        bindConfirm.innerHTML = C.bindConfirm;
        showNote(ICON.alert + '<span>' + escHtml((err && err.message) || String(err)) + '</span>');
      });
    });
  }

  /* 账号安全 · 修改密码（旧密码 → 新密码；成功后其他设备下线） */
  const pwdSave = host.querySelector('[data-pwd-save]');
  if (pwdSave) {
    pwdSave.addEventListener('click', () => {
      const C = A.account;
      const E = A.errors;
      const get = (id) => {
        const el = document.getElementById(id);
        return el ? el.value : '';
      };
      const oldPw = get('pw_old');
      const newPw = get('pw_new');
      const newPw2 = get('pw_new2');
      const showPwdErr = (msg) => {
        const box = document.getElementById('pfBindNote');
        if (box) {
          box.style.display = '';
          box.innerHTML = ICON.alert + '<span>' + escHtml(msg) + '</span>';
        }
      };
      if (!oldPw) return showPwdErr(E.required.replace('{label}', C.pwdOldLabel));
      if (!newPw) return showPwdErr(E.required.replace('{label}', C.pwdNewLabel));
      if (newPw !== newPw2) return showPwdErr(C.pwdMismatch || E.passwordMismatch);
      pwdSave.classList.add('is-busy');
      pwdSave.innerHTML = '<i class="spin dark"></i>' + C.pwdSubmitting;
      DATA.api.changePassword({ oldPassword: oldPw, newPassword: newPw })
        .then(() => {
          toast(C.pwdOk, 'ok');
          render();
        })
        .catch((err) => {
          pwdSave.classList.remove('is-busy');
          pwdSave.textContent = C.pwdSubmit;
          showPwdErr((err && err.message) || String(err));
        });
    });
  }

  const form = document.getElementById('authForm');
  if (!form) return;

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const val = (id) => {
      const el = document.getElementById(id);
      return el ? el.value.trim() : '';
    };
    const mode = AUTH.mode === 'register' ? 'register' : 'login';
    const E = A.errors;

    const username = val('af_username');
    const password = document.getElementById('af_password')
      ? document.getElementById('af_password').value : '';

    if (!username) return fail(E.required.replace('{label}', A.fields.username.label));
    if (!password) return fail(E.required.replace('{label}', A.fields.password.label));

    let payload = { username, password };

    if (mode === 'register') {
      const displayName = val('af_displayName') || username;
      const password2 = document.getElementById('af_password2')
        ? document.getElementById('af_password2').value : '';
      if (password.length < 6 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
        return fail(E.passwordWeak);
      }
      if (password !== password2) return fail(E.passwordMismatch);
      const D = authDefaults();
      payload = Object.assign(payload, {
        displayName,
        email: val('af_email'),
        company: val('af_company'),
        industry: val('af_industry'),
        regionName: val('af_regionName'),
        regionCode: D.regionCode,
      });
    }

    const btn = document.getElementById('authSubmit');
    if (btn) {
      btn.classList.add('is-busy');
      btn.innerHTML = '<i class="spin"></i>' + A[mode].submitting;
    }
    AUTH.error = '';

    const call = mode === 'register' ? AUTH.submitRegister(payload) : AUTH.submitLogin(username, password);
    call.then((res) => {
      AUTH.lastUsername = username;
      toast(DATA.fmt(A.toast[mode === 'register' ? 'registerOk' : 'loginOk'],
        { name: AUTH.name() }), 'ok');
      /* 登录成功 → 拉一次「我的数据」，随后进入检索记录页 */
      AUTH.refreshMine().then(() => go('history'));
    }).catch((err) => {
      /* 后端在跑但 MySQL 没连上（503 / DB_UNAVAILABLE）：顺手把状态切到 offline，
         重绘后上方会出现「账号功能暂不可用」横幅和「以游客身份继续」出口，
         用户不至于卡在一个永远登不进去的表单前。 */
      const dbDown = (err && err.code === 'DB_UNAVAILABLE') || (err && err.status === 503);
      if (dbDown) {
        AUTH.serviceAvailable = false;
        AUTH.status = 'offline';
        AUTH.offlineReason = (err && err.message) || '';
      }
      const msg = dbDown ? E.dbDown
        : (err && err.status ? (err.message || E.fallback.replace('{msg}', err.message))
          : E.network.replace('{msg}', (err && err.message) || err));
      fail(msg);
      if (dbDown) render();
    });

    function fail(msg) {
      AUTH.error = msg;
      AUTH.busy = false;
      const btn2 = document.getElementById('authSubmit');
      if (btn2) {
        btn2.classList.remove('is-busy');
        /* 关键：提交时 innerHTML 已被换成「⟳ 登录中…」，失败必须换回来，
           否则错误提示出现了、按钮却永远停在转圈态（历史 bug） */
        btn2.innerHTML = A[mode].submit;
      }
      showAuthErr(msg);
      return false;
    }
  });
}

/* ============================================================
   11 · 检索记录（MySQL search_records）
   ============================================================ */
const HISTORY = {
  items: [],
  total: 0,
  limit: 20,
  offset: 0,
  keyword: '',
  loaded: false,
  loading: false,
  error: '',
  pendingDelete: null,
  busyId: null,
  /* 「对话记录」页（与检索记录同屏切换，用户反馈：想看上次的问答得先找到那条政策，太麻烦） */
  tab: 'search',
  threads: [],
  threadsLoaded: false,
  threadsLoading: false,
  threadError: '',
};

/* ---------- 「对话记录」页的卡片：按政策聚合的一问一答 ---------- */
function chatThreadCard(t) {
  const C = DATA.history.chat;
  const last = String(t.lastQuestion || t.lastAnswer || '');
  const preview = last.length > 64 ? last.slice(0, 64) + '…' : last;
  return `
  <div class="hist-card thread-card" data-thread-open="${escHtml(t.policyId)}" role="button" tabindex="0"
       title="${escHtml(C.open)}">
    <div class="hc-main">
      <div class="hc-top">
        <span class="badge badge-info">${ICON.chat}${escHtml(C.open)}</span>
        <span class="hc-time mono-sm">${escHtml(t.lastAt || '')}</span>
      </div>
      <div class="hc-q">${escHtml(t.policyName || t.policyId)}</div>
      <div class="hc-cond">${ICON.doc}<span>${escHtml(DATA.fmt(C.qa, { q: t.questions || 0, m: t.messages || 0 }))}</span></div>
      ${preview ? `<div class="hc-meta"><span>${escHtml(C.lastQ)}：${escHtml(preview)}</span></div>` : ''}
    </div>
    <div class="hc-acts">
      <button class="btn btn-sm btn-solid" data-thread-open="${escHtml(t.policyId)}">${escHtml(C.open)}</button>
    </div>
  </div>`;
}

function historyBadge(rec) {
  const B = DATA.history.badges;
  const out = [];
  out.push(rec.status === 'failed'
    ? `<span class="badge badge-danger">${B.failed}</span>`
    : (rec.status === 'canceled'
      ? `<span class="badge badge-plain">${B.canceled}</span>`
      : `<span class="badge badge-ok">${B.succeeded}</span>`));
  if (rec.degraded) out.push(`<span class="badge badge-warn">${B.degraded}</span>`);
  out.push(`<span class="badge badge-info">${/mock/i.test(rec.provider || '') ? B.local : B.remote}</span>`);
  if (!rec.hasResult) out.push('<span class="badge badge-plain">无结果快照</span>');
  return out.join('');
}

function historyCard(rec) {
  const H = DATA.history;
  const regions = (rec.regions && rec.regions.length) ? rec.regions.join(' · ') : '全国（不限）';
  const confirming = HISTORY.pendingDelete === rec.id;
  const busy = HISTORY.busyId === rec.id;
  const cond = [regions, rec.industries, rec.types, rec.deadline].filter(Boolean).join(' · ');
  /* summary 本身就是列表口径，已含条数与置信度，避免重复罗列 */
  const bits = [];
  if (rec.summary) bits.push(rec.summary);
  else {
    bits.push(rec.itemCount + ' 条政策');
    bits.push('平均置信度 ' + rec.avgConfidence);
  }
  bits.push('耗时 ' + (rec.elapsedMs / 1000).toFixed(1) + 's');

  return `
  <div class="hist-card ${confirming ? 'confirming' : ''}" data-record="${rec.id}">
    <div class="hc-main">
      <div class="hc-top">
        <span class="hc-id mono-sm">#${rec.id}</span>
        ${historyBadge(rec)}
        <span class="hc-time mono-sm">${escHtml(rec.createdAt || '')}</span>
      </div>
      <div class="hc-q">${escHtml(rec.query || '（无查询词）')}</div>
      <div class="hc-cond">${ICON.doc}<span>${escHtml(cond || '无条件')}</span></div>
      <div class="hc-meta">
        ${bits.map((b) => '<span>' + escHtml(b) + '</span>').join('<span class="dot-sep">·</span>')}
      </div>
    </div>
    <div class="hc-acts">
      ${confirming ? `
        <button class="btn btn-sm btn-danger" data-history-confirm="${rec.id}">确认删除</button>
        <button class="btn btn-sm btn-ghost" data-history-cancel="1">取消</button>` : `
        <button class="btn btn-sm btn-solid" data-history-replay="${rec.id}" ${busy || !rec.hasResult ? 'disabled' : ''}>
          ${busy ? H.card.replaying : H.card.replay}</button>
        <button class="btn btn-sm btn-outline" data-history-restore="${rec.id}">${H.card.restore}</button>
        <button class="btn btn-sm btn-ghost" data-history-delete="${rec.id}">${H.card.delete}</button>`}
    </div>
  </div>`;
}

function renderHistory() {
  const H = DATA.history;
  const tab = HISTORY.tab === 'chat' ? 'chat' : 'search';
  const T = H.tabs;
  const head = `
    <div class="list-head">
      <h2>${H.head.title}</h2>
      <span class="meta">${tab === 'chat'
        ? DATA.fmt(H.chat.meta, { n: HISTORY.threads.length })
        : (HISTORY.keyword
          ? DATA.fmt(H.head.metaFiltered, { kw: HISTORY.keyword, n: HISTORY.total })
          : DATA.fmt(H.head.meta, { n: HISTORY.total }))}</span>
      <div class="list-tools">
        <button class="btn btn-outline btn-sm" data-history-refresh="1" ${HISTORY.loading || HISTORY.threadsLoading ? 'disabled' : ''}>
          ${ICON.refresh}${(tab === 'chat' ? HISTORY.threadsLoading : HISTORY.loading) ? H.tools.refreshing : H.tools.refresh}</button>
        ${tab === 'search'
          ? `<button class="btn btn-ghost btn-sm" data-history-clear="1" ${HISTORY.items.length ? '' : 'disabled'}>
              ${H.tools.clear}</button>` : ''}
      </div>
    </div>
    <div class="hist-tabs" role="tablist" aria-label="${escHtml(H.head.title)}">
      <button class="htab ${tab === 'search' ? 'on' : ''}" data-hist-tab="search" role="tab"
        aria-selected="${tab === 'search'}">${ICON.rows}${escHtml(T.search)}</button>
      <button class="htab ${tab === 'chat' ? 'on' : ''}" data-hist-tab="chat" role="tab"
        aria-selected="${tab === 'chat'}">${ICON.chat}${escHtml(T.chat)}</button>
      ${tab === 'chat' ? `<span class="htab-hint">${escHtml(T.hint)}</span>` : ''}
    </div>`;

  /* ---------- 未登录 ---------- */
  if (!AUTH.authed()) {
    const offline = AUTH.status === 'offline';
    return `
    <div class="screen">
      ${topBar('history')}
      <div class="list-body">
        ${head}
        <div class="empty" style="margin:auto 0">
          <span class="em-ic">${ICON.user}</span>
          <h4>${offline ? DATA.auth.states.offlineTitle : H.guest.title}</h4>
          <p>${offline ? DATA.auth.states.offlineDesc : H.guest.desc}</p>
          <div class="em-acts">
            <button class="btn btn-primary btn-sm" data-go="login">${H.guest.login}</button>
            <button class="btn btn-outline btn-sm" data-go="home">${H.guest.later}</button>
          </div>
        </div>
      </div>
    </div>`;
  }

  /* ---------- 已登录 ---------- */
  const u = AUTH.user || {};
  const st = (AUTH.mine && AUTH.mine.stats) || {};

  /* 对话记录页没有「关键词搜索 / 企业档案」这两行（那是检索记录的口径） */
  const filter = HISTORY.tab !== 'chat' ? `
    <div class="filterbar">
      <div class="fb-row">
        <label class="hist-search">
          ${ICON.searchSm}
          <input id="histQ" placeholder="${H.tools.searchPlaceholder}" value="${escHtml(HISTORY.keyword)}">
        </label>
        <span class="fb-label">${H.filter.userLabel}</span>
        <span class="hist-user">${escHtml(AUTH.name())} · @${escHtml(u.username || '')}</span>
        <span class="fb-hint">${H.filter.savedNote}</span>
      </div>
      <div class="fb-row">
        <span class="fb-label">${H.filter.profileLabel}</span>
        <span class="hist-user">${escHtml([u.company, u.industry, u.regionName].filter(Boolean).join(' · ') || '未填写')}</span>
        <span class="fb-hint">${H.filter.profileFrom}</span>
      </div>
    </div>` : '';

  let body;
  if (HISTORY.tab === 'chat') {
    if (HISTORY.threadsLoading && !HISTORY.threads.length) {
      body = `<div class="empty" style="margin:auto 0">
        <span class="em-ic">${ICON.refresh}</span><h4>${H.loading.title}</h4><p>${H.loading.desc}</p></div>`;
    } else if (HISTORY.threadError) {
      body = `<div class="empty" style="margin:auto 0">
        <span class="em-ic" style="background:var(--danger-bg);color:var(--danger-fg)">${ICON.alert}</span>
        <h4>${H.chat.loadFailed}</h4><p>${escHtml(HISTORY.threadError)}</p>
        <div class="em-acts"><button class="btn btn-outline btn-sm" data-history-refresh="1">${H.error.action}</button></div></div>`;
    } else if (!HISTORY.threads.length) {
      body = `<div class="empty" style="margin:auto 0">
        <span class="em-ic">${ICON.chat}</span>
        <h4>${H.chat.emptyTitle}</h4><p>${H.chat.emptyDesc}</p>
        <div class="em-acts"><button class="btn btn-primary btn-sm" data-go="list">${H.chat.emptyAction}</button></div></div>`;
    } else {
      body = HISTORY.threads.map(chatThreadCard).join('');
    }
  } else if (HISTORY.loading && !HISTORY.items.length) {
    body = `<div class="empty" style="margin:auto 0">
      <span class="em-ic">${ICON.refresh}</span><h4>${H.loading.title}</h4><p>${H.loading.desc}</p></div>`;
  } else if (HISTORY.error) {
    body = `<div class="empty" style="margin:auto 0">
      <span class="em-ic" style="background:var(--danger-bg);color:var(--danger-fg)">${ICON.alert}</span>
      <h4>${H.error.title}</h4><p>${escHtml(HISTORY.error)}</p>
      <div class="em-acts"><button class="btn btn-outline btn-sm" data-history-refresh="1">${H.error.action}</button></div></div>`;
  } else if (!HISTORY.items.length) {
    const noMatch = !!HISTORY.keyword;
    body = `<div class="empty" style="margin:auto 0">
      <span class="em-ic">${ICON.rows}</span>
      <h4>${noMatch ? H.noMatch.title : H.empty.title}</h4>
      <p>${noMatch ? H.noMatch.desc : H.empty.desc}</p>
      <div class="em-acts">
        ${noMatch
          ? `<button class="btn btn-outline btn-sm" data-history-clearq="1">${H.noMatch.action}</button>`
          : `<button class="btn btn-primary btn-sm" data-go="home">${H.empty.action}</button>`}
      </div></div>`;
  } else {
    body = HISTORY.items.map(historyCard).join('');
  }

  return `
  <div class="screen">
    ${topBar('history')}
    <div class="list-body">
      ${head}
      ${filter}
      <div class="hist-list scroll">${body}</div>
      ${HISTORY.tab !== 'chat' ? `<div class="hist-foot">${DATA.fmt(H.foot, { keep: 200 })}
        当前账号共 ${st.searches || 0} 次检索 · 成功 ${st.succeeded || 0} · 失败 ${st.failed || 0}</div>` : ''}
    </div>
  </div>`;
}

/* ---------- 拉取列表 ---------- */
function historyLoad() {
  if (!AUTH.authed()) return Promise.resolve(null);
  HISTORY.loading = true;
  HISTORY.error = '';
  return DATA.api.history({ limit: HISTORY.limit, offset: HISTORY.offset, keyword: HISTORY.keyword })
    .then((res) => {
      HISTORY.items = res.items || [];
      HISTORY.total = res.total || 0;
      HISTORY.loaded = true;
      return res;
    })
    .catch((err) => {
      HISTORY.error = (err && err.message) || String(err);
      if (err && err.status === 401) {
        AUTH.forget();
        AUTH.status = 'guest';
      }
      HISTORY.items = [];
      return null;
    })
    .then((res) => {
      HISTORY.loading = false;
      return res;
    });
}

/* ---------- 「对话记录」：按政策聚合的会话列表 ---------- */
function threadsLoad() {
  if (!AUTH.authed()) return Promise.resolve(null);
  HISTORY.threadsLoading = true;
  HISTORY.threadError = '';
  return DATA.api.chatThreads()
    .then((res) => {
      HISTORY.threads = res.threads || [];
      HISTORY.threadsLoaded = true;
    })
    .catch((err) => {
      HISTORY.threadError = (err && err.message) || String(err);
      HISTORY.threads = [];
      if (err && err.status === 401) {
        AUTH.forget();
        AUTH.status = 'guest';
      }
    })
    .then(() => {
      HISTORY.threadsLoading = false;
      if (APP.screen === 'history') render();
    });
}

/* ---------- 把历史条件恢复到检索链路 ---------- */
function historyApplyConditions(rec) {
  APP.query = rec.query || '';
  /* 行业 / 类型 / 截止时间回到该次检索时的取值（空 = 不限） */
  if (typeof FILTER_STATE !== 'undefined' && FILTER_STATE.ensure) {
    FILTER_STATE.ensure();
    [['industry', rec.industries], ['type', rec.types], ['deadline', rec.deadline]].forEach(([g, v]) => {
      FILTER_STATE.applied[g] = new Set(FILTER_STATE.split(v));
      FILTER_STATE.draft[g] = new Set(FILTER_STATE.applied[g]);
    });
  }

  if (typeof CASCADE !== 'undefined' && CASCADE.index && (rec.regions || []).length) {
    CASCADE.applied = new Set();
    rec.regions.forEach((name) => {
      for (const node of CASCADE.index.values()) {
        if (node.name === name) { CASCADE.applied.add(node.code); break; }
      }
    });
    CASCADE.draft = new Set(CASCADE.applied);
  }
}

/* ---------- 挂载：刷新 / 回放 / 删除 / 关键词搜索 ---------- */
function mountHistory(go) {
  const host = document.querySelector('.screen');
  if (!host) return;
  const H = DATA.history;

  const reload = () => {
    if (!AUTH.authed()) { render(); return; }
    if (HISTORY.tab === 'chat') {
      HISTORY.threadsLoading = true;
      render();
      threadsLoad();
      return;
    }
    HISTORY.loading = true;
    render();
    historyLoad().then(() => { if (APP.screen === 'history') render(); });
  };

  /* 「检索记录 / 对话记录」页签切换 */
  host.querySelectorAll('[data-hist-tab]').forEach((b) => {
    b.addEventListener('click', () => {
      const t = b.dataset.histTab === 'chat' ? 'chat' : 'search';
      if (HISTORY.tab === t) return;
      HISTORY.tab = t;
      render();
      if (t === 'chat' && AUTH.authed() && !HISTORY.threadsLoaded && !HISTORY.threadsLoading) {
        HISTORY.threadsLoading = true;
        render();
        threadsLoad();
      }
    });
  });

  /* 点一张对话卡片 → 回到那条政策的详情页接着聊（对话历史就挂在右栏面板里） */
  host.querySelectorAll('[data-thread-open]').forEach((b) => {
    b.addEventListener('click', () => {
      go('detail', { policyId: b.dataset.threadOpen });
    });
  });

  host.querySelectorAll('[data-history-refresh]').forEach((b) =>
    b.addEventListener('click', () => { reload(); toast(H.toast.refreshed, 'info'); }));

  const clear = host.querySelector('[data-history-clear]');
  if (clear) {
    clear.addEventListener('click', () => {
      const n = HISTORY.total;
      DATA.api.clearHistory().then(() => {
        HISTORY.items = [];
        HISTORY.total = 0;
        toast(DATA.fmt(H.toast.cleared, { n }), 'ok');
        reload();
      }).catch((err) => toast(DATA.fmt(DATA.auth.errors.fallback, { msg: err.message }), 'warn'));
    });
  }

  host.querySelectorAll('[data-history-replay]').forEach((b) => {
    b.addEventListener('click', () => {
      const id = b.dataset.historyReplay;
      HISTORY.busyId = id;
      render();
      DATA.api.historyDetail(id).then((res) => {
        HISTORY.busyId = null;
        if (!res || !res.bootstrap) {
          toast('该记录没有可回放的结果快照', 'warn');
          render();
          return;
        }
        DATA.hydrateBackend(res.bootstrap);
        toast(DATA.fmt(H.toast.replayed, { summary: (res.record && res.record.summary) || '' }), 'ok');
        go('list');
      }).catch((err) => {
        HISTORY.busyId = null;
        toast(DATA.fmt(DATA.auth.errors.fallback, { msg: err.message }), 'warn');
        render();
      });
    });
  });

  host.querySelectorAll('[data-history-restore]').forEach((b) => {
    b.addEventListener('click', () => {
      const id = Number(b.dataset.historyRestore);
      const rec = HISTORY.items.filter((x) => x.id === id)[0];
      if (!rec) return;
      historyApplyConditions(rec);
      toast(H.toast.restored, 'info');
      go('search');
    });
  });

  host.querySelectorAll('[data-history-delete]').forEach((b) => {
    b.addEventListener('click', () => {
      HISTORY.pendingDelete = Number(b.dataset.historyDelete);
      render();
    });
  });
  host.querySelectorAll('[data-history-cancel]').forEach((b) => {
    b.addEventListener('click', () => { HISTORY.pendingDelete = null; render(); });
  });
  host.querySelectorAll('[data-history-confirm]').forEach((b) => {
    b.addEventListener('click', () => {
      const id = Number(b.dataset.historyConfirm);
      DATA.api.deleteHistory(id).then(() => {
        HISTORY.pendingDelete = null;
        HISTORY.items = HISTORY.items.filter((x) => x.id !== id);
        HISTORY.total = Math.max(0, HISTORY.total - 1);
        toast(H.toast.deleted, 'ok');
        if (AUTH.authed()) AUTH.refreshMine().then(() => render()); else render();
      }).catch((err) => {
        HISTORY.pendingDelete = null;
        toast(DATA.fmt(DATA.auth.errors.fallback, { msg: err.message }), 'warn');
        render();
      });
    });
  });

  const clearq = host.querySelector('[data-history-clearq]');
  if (clearq) {
    clearq.addEventListener('click', () => { HISTORY.keyword = ''; reload(); });
  }

  /* 关键词搜索：输入停顿 350ms 后查询。
     与筛选面板同一条规矩：**输入法组词期间不查询、也不重绘** ——
     这里查询完要整屏 render()，一样会把正在组词的输入框换掉，中文就打不进去。 */
  const q = document.getElementById('histQ');
  if (q) {
    let timer = null;
    let composing = false;
    const run = () => {
      HISTORY.keyword = q.value.trim();
      HISTORY.loading = true;
      render();
      historyLoad().then(() => {
        if (APP.screen !== 'history') return;
        render();
        const again = document.getElementById('histQ');
        if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
      });
    };
    const later = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(run, 350);
    };
    q.addEventListener('compositionstart', () => { composing = true; });
    q.addEventListener('compositionend', () => { composing = false; later(); });
    q.addEventListener('input', () => { if (!composing) later(); });
  }

  /* 首次进入自动拉取一次（对话记录页也一样） */
  if (AUTH.authed() && !HISTORY.loaded && !HISTORY.loading) {
    HISTORY.loading = true;
    historyLoad().then(() => { if (APP.screen === 'history') render(); });
  }
  if (AUTH.authed() && HISTORY.tab === 'chat' && !HISTORY.threadsLoaded && !HISTORY.threadsLoading) {
    HISTORY.threadsLoading = true;
    threadsLoad();
  }
}
