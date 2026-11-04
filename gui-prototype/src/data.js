/* ============================================================
   数据装配层 —— 逻辑与数据分离的唯一入口
   ------------------------------------------------------------
   真 / 假数据分离：

   ① 前端自己的数据 → ../data/*.json
      界面文案与展示配置（标题、按钮、提示、占位符、规则说明、
      能力卡、口径文案、演示态配置、动画时序…）。
      多文件开发版下改完 JSON 刷新即见，不必重新构建。

   ② 后端应返回的数据 → ../test_date.js（【临时】假数据）
      政策实体、行政区划字典、检索过程、
      原文快照、样例数据、统计口径。
      ★ 后端就绪后：删掉 test_date.js，只改下面 loadBackend() 的实现。

   装载方式
   · 单文件构建版：构建期把 data/*.json 内联为 window.__DATA__、
     把 test_date.js 内联为 window.TEST_DATA，两者都在，同步装配，
     file:// 双击即开。
   · 多文件开发版：UI 走 fetch ./data/*.json，后端数据动态注入
     test_date.js（需用本地 HTTP 服务打开）。
   ============================================================ */
window.DATA = (function () {
  /* ① 前端文案与展示配置（data/<键名>.json，同时也是命名空间名） */
  const UI_FILES = [
    'app', 'home', 'search', 'list', 'detail', 'brief',
    'region',
    'auth', 'history',
  ];

  /* ② 后端数据命名空间（test_date.js → window.TEST_DATA） */
  const BACKEND_NS = [
    'stats', 'policies', 'regions', 'search', 'list',
    'detail', 'brief',
  ];

  const DATA = { FILES: UI_FILES, NS: UI_FILES.concat(BACKEND_NS) };

  /* ---------- 模板插值：fmt('已选 {n} 项', {n: 3}) ---------- */
  DATA.fmt = function (tpl, vars) {
    if (typeof tpl !== 'string') return tpl;
    return tpl.replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] !== undefined && vars[k] !== null ? vars[k] : m));
  };

  /* ---------- 深合并：把后端数据并入同名命名空间 ---------- */
  const isPlain = (o) => o && typeof o === 'object' && !Array.isArray(o);
  function deepMerge(base, patch) {
    if (!isPlain(patch)) return patch === undefined ? base : patch;
    const out = isPlain(base) ? Object.assign({}, base) : {};
    Object.keys(patch).forEach((k) => {
      const pv = patch[k];
      out[k] = isPlain(pv) && isPlain(out[k]) ? deepMerge(out[k], pv) : pv;
    });
    return out;
  }

  /* ---------- 便捷视图（派生量，随数据自动变化） ---------- */
  function rebuildViews() {
    DATA.policies = DATA.policies || {};
    DATA.regions = DATA.regions || {};
    DATA.brief = DATA.brief || {};

    const items = (DATA.policies.items || []);
    DATA.policyById = (id) => items.find((p) => p.id === id) || items[0];
    DATA.pickedPolicies = (ids) => (ids || []).map((id) => DATA.policyById(id));
    /* 简报预览与导出的清单由 screens-b.js → briefScopedPolicies() 决定：
       只取「已勾选」或「当前筛选结果」，**没有演示兜底** —— 一条都没有时预览显示空态。 */
    /* 某地域是否已有收录政策：以 policies[].regionCodes 为唯一数据源，驱动「仅显示已收录政策的地域」开关 */
    const cover = new Set();
    items.forEach((p) => (p.regionCodes || []).forEach((c) => cover.add(c)));
    DATA.regions.coverageCodes = cover;
    DATA.regions.hasPolicies = (node) => cover.has(node.code);
    return DATA;
  }

  /* ---------- 装配：UI 文案打底，后端数据按命名空间覆盖/补充 ---------- */
  function hydrate(ui, backend) {
    ui = ui || {};
    backend = backend || {};
    UI_FILES.forEach((k) => { DATA[k] = ui[k] || {}; });
    BACKEND_NS.forEach((k) => { DATA[k] = deepMerge(DATA[k] || {}, backend[k] || {}); });
    return rebuildViews();
  }

  /* ============================================================
     ★ 检索完成后回填：只并入新的后端数据，并重建派生视图。
       不动 UI 文案，也不需要重新拉取 data/*.json。
       入参 = 后端 /api/v1/searches/{id}/result 返回的 bootstrap（十命名空间子集）。
     ============================================================ */
  DATA.hydrateBackend = function (backend) {
    backend = backend || {};
    BACKEND_NS.forEach((k) => { DATA[k] = deepMerge(DATA[k] || {}, backend[k] || {}); });
    /* 灌进来的是一份新结果集 ⇒ 结果列表的勾选 / 页码 / 对比浮层归零。
       放在这里而不是各个调用点：发起检索、历史回放、启动回放三条路都走这个函数，
       少改一处就会出现「换个入口进来勾选数还留着」。函数实体在 screens-b.js。 */
    if (typeof resetListForNewResult === 'function') resetListForNewResult();
    return rebuildViews();
  };

  /* ---------- ① 装载前端文案与展示配置 ---------- */
  /* 用构建戳当缓存键：dev.html 是运行时 fetch data/*.json 的，浏览器/中间层
     一旦缓存住旧的 JSON，「改了文案刷新却看不到」就会反复出现。
     window.__BUILD__ 由 build.py 写进 dev.html，重建一次换一个值，缓存自然失效。 */
  function cacheBust() {
    const b = (typeof window !== 'undefined') && window.__BUILD__;
    return b ? '?v=' + encodeURIComponent(b) : '';
  }
  function loadUI() {
    if (window.__DATA__) return Promise.resolve(window.__DATA__);
    const q = cacheBust();
    return Promise.all(UI_FILES.map((k) => fetch('data/' + k + '.json' + q).then((r) => {
      if (!r.ok) throw new Error('数据文件读取失败（HTTP ' + r.status + '）：data/' + k + '.json');
      return r.json();
    }))).then((list) => {
      const raw = {};
      UI_FILES.forEach((k, i) => { raw[k] = list[i]; });
      return raw;
    });
  }

  /* ============================================================
     检索服务「基地址」解析
     ------------------------------------------------------------
     被后端 serve（http/https 同源）时，相对路径最自然；但**单文件双击（file://）
     或另起静态服务器**打开时，同源根本没有后端 —— 于是点「开始检索」就
     「检索接口不可用（Failed to fetch）」降级到本地演示。这里一次性探好基地址：
       ① window.POLICY_AGENT_API_BASE / ?api=http://host:port（显式指定，最高优先）
       ② 同源 ''（后端 serve 时命中）
       ③ http://127.0.0.1:8000（本机默认后端端口，file:// 打开时命中）
     选中第一个能拿到 /api/bootstrap 的基地址并缓存，之后所有 API 都带上它。
     ============================================================ */
  function candidateBases() {
    let explicit = '';
    try { explicit = String((window.POLICY_AGENT_API_BASE || '')).trim(); } catch (e) { /* ignore */ }
    try {
      if (!explicit && typeof location !== 'undefined' && location.search) {
        const q = new URLSearchParams(location.search).get('api');
        if (q) explicit = String(q).trim();
      }
    } catch (e) { /* ignore */ }
    if (explicit) return [explicit.replace(/\/+$/, '')];
    const out = [];
    let proto = '';
    try { proto = (typeof location !== 'undefined' && location.protocol) || ''; } catch (e) { /* ignore */ }
    if (proto === 'http:' || proto === 'https:') out.push('');
    out.push('http://127.0.0.1:8000');
    return out;
  }

  let _apiBase = null;
  function resolveApiBase() {
    if (_apiBase !== null) return Promise.resolve(_apiBase);
    if (typeof fetch !== 'function') { _apiBase = ''; return Promise.resolve(''); }
    const bases = candidateBases();
    let chain = Promise.resolve(null);
    bases.forEach((base) => {
      chain = chain.then((found) => {
        if (found !== null) return found;
        return fetch(base + '/api/bootstrap', { headers: { Accept: 'application/json' } })
          .then((r) => (r && r.ok ? base : null))
          .catch(() => null);
      });
    });
    return chain.then((base) => { _apiBase = (base === null ? '' : base); return _apiBase; });
  }

  /* ============================================================
     ★ 后端数据接入点
     ------------------------------------------------------------
     优先级：
       ① 单文件构建版：window.TEST_DATA 已内联 → 直接可用（同步装配）；
       ② 后端在线：GET /api/bootstrap（本地 FastAPI 后端，见 deliverables/backend）；
       ③ 后端不可用：降级动态注入 test_date.js —— 保证离线/未起后端时也不白屏。
     ②的返回值与 TEST_DATA 的十个命名空间同构，故渲染层无需改动。
     ============================================================ */
  function loadBackend() {
    /* ① 单文件构建版：内联数据直接可用 */
    if (window.TEST_DATA) return Promise.resolve(window.TEST_DATA);

    /* ③ 降级：注入 test_date.js（后端不可用 / 无 fetch 环境） */
    const injectTestData = (cause) => new Promise((resolve, reject) => {
      if (window.console && console.warn) {
        console.warn('[data.js] 后端不可用，降级使用 test_date.js：', cause && cause.message);
      }
      const s = document.createElement('script');
      s.src = 'test_date.js';
      s.onload = () => (window.TEST_DATA
        ? resolve(window.TEST_DATA)
        : reject(new Error('test_date.js 未提供 window.TEST_DATA')));
      s.onerror = () => reject(new Error(
        '后端不可用，且降级数据 test_date.js 亦缺失：' + (cause && cause.message ? cause.message : cause)));
      document.head.appendChild(s);
    });

    /* ② 后端在线：请求本地后端 GET /api/bootstrap（基地址可能是同源，也可能是本机默认端口） */
    if (typeof fetch !== 'function') return injectTestData(new Error('当前环境不支持 fetch'));
    return resolveApiBase()
      .then((base) => fetch(base + '/api/bootstrap'))
      .then((r) => {
        if (!r.ok) throw new Error('bootstrap 接口返回 HTTP ' + r.status);
        return r.json();
      })
      .then((data) => {
        if (!data || typeof data !== 'object') throw new Error('bootstrap 返回体非法');
        return data;
      })
      .catch((err) => injectTestData(err));
  }

  /* ---------- 装载 ---------- */
  DATA.load = function () {
    /* 内联双数据（单文件版）→ 同步装配，首屏无需等待微任务 */
    if (window.__DATA__ && window.TEST_DATA) {
      return Promise.resolve(hydrate(window.__DATA__, window.TEST_DATA));
    }
    return Promise.all([loadUI(), loadBackend()]).then(([ui, be]) => hydrate(ui, be));
  };

  /* ============================================================
     检索接口客户端 —— 前端唯一与「检索服务」对话的入口
     （对应后端 deliverables/backend/app/search.py）
     ============================================================ */
  function request(url, opts) {
    if (typeof fetch !== 'function') {
      return Promise.reject(new Error('当前环境不支持 fetch'));
    }
    return resolveApiBase()
      .then((base) => fetch(base + url, opts))
      .then((r) => r.json().catch(() => null).then((body) => {
        if (!r.ok) {
          const detail = (body && body.error) || {};
          const err = new Error(detail.message || ('HTTP ' + r.status));
          err.status = r.status;
          err.code = detail.code;
          throw err;
        }
        return body;
      }));
  }

  /* ============================================================
     登录凭证：登录/注册拿到 Bearer Token 后由 AUTH 统一注入请求头。
     （Token 明文只存在于浏览器本地；服务端库里只存 SHA-256 摘要）
     ============================================================ */
  let _token = null;

  function authHeaders(extra) {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, extra || {});
    if (_token) headers.Authorization = 'Bearer ' + _token;
    return headers;
  }

  const json = (payload) => JSON.stringify(payload || {});

  DATA.api = {
    /* ---------- 登录凭证 ---------- */
    setToken(t) { _token = t || null; return _token; },
    getToken() { return _token; },
    isSignedIn() { return !!_token; },

    /* ---------- 账号体系（MySQL users / sessions） ---------- */
    register(payload) {
      return request('/api/v1/auth/register', {
        method: 'POST', headers: authHeaders(), body: json(payload),
      });
    },
    login(payload) {
      return request('/api/v1/auth/login', {
        method: 'POST', headers: authHeaders(), body: json(payload),
      });
    },
    logout() {
      return request('/api/v1/auth/logout', { method: 'POST', headers: authHeaders() });
    },
    me() {
      return request('/api/v1/auth/me', { headers: authHeaders() });
    },
    updateProfile(patch) {
      return request('/api/v1/auth/profile', {
        method: 'PATCH', headers: authHeaders(), body: json(patch),
      });
    },
    sendBindCode(email) {
      return request('/api/v1/auth/profile/email-code', {
        method: 'POST', headers: authHeaders(), body: json({ email }),
      });
    },
    changePassword(body) {
      return request('/api/v1/auth/password', {
        method: 'POST', headers: authHeaders(), body: json(body),
      });
    },
    /* 忘记密码：下发验证码（原型直接返回 code）→ 验证码重置 */
    forgotPassword(account) {
      return request('/api/v1/auth/forgot', {
        method: 'POST', headers: authHeaders(), body: json({ account: account }),
      });
    },
    resetPassword(payload) {
      return request('/api/v1/auth/reset', {
        method: 'POST', headers: authHeaders(), body: json(payload),
      });
    },
    dbStatus() {
      return request('/api/v1/db/status');
    },

    /* ---------- 检索记录（MySQL search_records） ---------- */
    history(opts) {
      const o = opts || {};
      const q = [];
      if (o.limit != null) q.push('limit=' + encodeURIComponent(o.limit));
      if (o.offset != null) q.push('offset=' + encodeURIComponent(o.offset));
      if (o.keyword) q.push('keyword=' + encodeURIComponent(o.keyword));
      return request('/api/v1/history' + (q.length ? '?' + q.join('&') : ''),
        { headers: authHeaders() });
    },
    historyDetail(id) {
      return request('/api/v1/history/' + encodeURIComponent(id), { headers: authHeaders() });
    },
    deleteHistory(id) {
      return request('/api/v1/history/' + encodeURIComponent(id),
        { method: 'DELETE', headers: authHeaders() });
    },
    clearHistory() {
      return request('/api/v1/history', { method: 'DELETE', headers: authHeaders() });
    },

    /* ---------- 检索链路 ---------- */
    /* 发起检索：{ query, regions[], industries, types, deadline } → { taskId, status, ... }
       带凭证时后端会把条件与结果落库，下次登录可直接回放。 */
    startSearch(payload) {
      return request('/api/v1/searches', {
        method: 'POST',
        headers: authHeaders(),
        body: json(payload),
      });
    },
    /* 轮询进度：步骤 / 源进度 / 抓取日志 / 已解析条件 */
    searchStatus(taskId) {
      return request('/api/v1/searches/' + encodeURIComponent(taskId), { headers: authHeaders() });
    },
    /* 取结果：{ bootstrap: { 十命名空间 } } */
    searchResult(taskId) {
      return request('/api/v1/searches/' + encodeURIComponent(taskId) + '/result',
        { headers: authHeaders() });
    },
    /* 取消检索 */
    cancelSearch(taskId) {
      return request('/api/v1/searches/' + encodeURIComponent(taskId),
        { method: 'DELETE', headers: authHeaders() });
    },
    /* 当前大模型接入状态（本地免费引擎 / 云端模型） */
    llmStatus() {
      return request('/api/v1/llm/status');
    },

    /* ---------- 政策简报（真实文件：XLSX / DOCX / PDF） ----------
       清单由前端把「已勾选 / 当前结果集」的结构化政策原样交给后端拼装
       （不经模型改写、不会漏条目）；综述由后端调大模型写，超时自动降级。
       返回 { briefId, fileName, downloadUrl, mediaType, bytes, count, summary, … }。 */
    createBrief(payload) {
      return request('/api/v1/briefs', {
        method: 'POST', headers: authHeaders(), body: json(payload),
      });
    },
    /* 下载成 Blob 交给浏览器另存（走 resolveApiBase，单文件/静态服务打开也能下载） */
    downloadBrief(info) {
      const id = (info && info.briefId) || '';
      const path = (info && info.downloadUrl) || ('/api/v1/briefs/' + encodeURIComponent(id) + '/download');
      if (typeof fetch !== 'function') {
        return Promise.reject(new Error('当前环境不支持 fetch'));
      }
      return resolveApiBase()
        .then((base) => fetch(base + path))
        .then(async (r) => {
          if (!r.ok) {
            /* 404 = 简报文件已被清理。后端的可读文案（BRIEF_MISSING）必须透传给 UI，
               不能吞成「HTTP 404」—— 以前就是这么吞的，用户不知道该重新生成（2026-10-16）。 */
            const body = await r.json().catch(() => null);
            const detail = (body && body.error) || {};
            const err = new Error(detail.message || ('HTTP ' + r.status));
            err.status = r.status;
            err.code = detail.code;
            throw err;
          }
          return r.blob();
        });
    },
    /* 在系统文件管理器里定位刚生成的简报 */
    revealBrief(briefId) {
      return request('/api/v1/briefs/' + encodeURIComponent(briefId) + '/reveal',
        { method: 'POST', headers: authHeaders() });
    },
    /* 能力探测（PDF 是否可用 / 输出目录） */
    briefStatus() {
      return request('/api/v1/briefs/status');
    },

    /* ---------- 政策对话（MySQL chat_messages） ----------
       详情页右栏「问政策」：把当前这条政策作为事实底座交给后端，
       后端调大模型（不可用/超时就改用规则回答）并落库。
       带上 Bearer 时后端会把一问一答写进 chat_messages，下次打开这条政策接着聊；
       游客没有凭证 → 后端不落库，响应里的 saved 会是 false（前端据此给提示）。 */
    chatSend(payload) {
      return request('/api/v1/chat/messages', {
        method: 'POST', headers: authHeaders(), body: json(payload),
      });
    },
    chatHistory(policyId, limit) {
      const q = ['policyId=' + encodeURIComponent(policyId || '')];
      if (limit != null) q.push('limit=' + encodeURIComponent(limit));
      return request('/api/v1/chat/messages?' + q.join('&'), { headers: authHeaders() });
    },
    /* 不带 policyId → 按政策聚合的会话列表（检索记录屏「对话记录」页用） */
    chatThreads() {
      return request('/api/v1/chat/messages', { headers: authHeaders() });
    },
    chatClear(policyId) {
      return request('/api/v1/chat/messages?policyId=' + encodeURIComponent(policyId || ''),
        { method: 'DELETE', headers: authHeaders() });
    },
    chatStatus() {
      return request('/api/v1/chat/status');
    },
  };

  DATA.loadUI = loadUI;
  DATA.loadBackend = loadBackend;
  DATA.deepMerge = deepMerge;
  DATA.request = request;
  /* 简报下载要自己拼绝对地址（走 Blob 另存），所以把基地址解析也暴露出去 */
  DATA.resolveApiBase = resolveApiBase;
  DATA.apiUrl = (path) => resolveApiBase().then((base) => base + path);

  return DATA;
})();
