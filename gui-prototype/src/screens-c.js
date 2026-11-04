/* ============================================================
   地域级联面板（首页「条件精确筛选 → 地域」浮层的骨架与文案）
   —— 全部文案与字段取自 DATA.region / DATA.app.filterLabels

   说明：原「地域多选」独立演示屏已删除 —— 它与本屏这块面板
   是同一套组件（cascPanelHTML），属重复入口；本文件只保留
   面板本身，供 screens-a.js 的 mountFilterPanel('casc', …) 使用。
   ============================================================ */

function cascColHTML(title, list, opts, showAll) {
  const o = opts || {};
  const rows = list.length
    ? list.map((node) => cascRow(node, showAll && !DATA.regions.hasPolicies(node))).join('')
    : `<div class="fpanel-empty">${o.emptyText || ''}</div>`;
  return `
      <div class="casc-col">
        <div class="col-ttl"><span class="ct-t">${title}</span>${o.act || ''}</div>
        <div class="casc-list scroll">${rows}</div>
        ${o.note ? `<div class="casc-note">${o.note}</div>` : ''}
      </div>`;
}

function cascView() {
  const P = DATA.region.panel;
  const L = filterLabels();
  const q = CASC_STATE.query || '';
  const showAll = CASC_STATE.onlyWithData;

  const provTitle = DATA.fmt(P.provTitle, { n: CASCADE.provinceList.length });
  let provList = CASCADE.provinceList;
  let provNote = P.provNote;
  let cityList = [];
  let cityTitle = P.cityTitle;
  let cityNote = P.emptyCityDefault;
  let cityAct = '';
  let countyList = [];
  let countyTitle = P.countyTitle;
  let countyNote = P.emptyCountyDefault;
  let countyEmptyHtml = '';

  if (q) {
    /* 搜索态：三列各自跨全量匹配（此时列里不是「某省的下辖市」，故不给「选中全省」） */
    provList = CASCADE.filterLevel(CASCADE.provinceList, q);
    CASCADE.provinceList.forEach((p) => (p.children || []).forEach((c) => { if (CASCADE.match(c, q)) cityList.push(c); }));
    CASCADE.provinceList.forEach((p) => (p.children || []).forEach((c) => (c.children || []).forEach((d) => { if (CASCADE.match(d, q)) countyList.push(d); })));
    provNote = DATA.fmt(P.searchProvNote, { n: provList.length });
    cityTitle = P.searchCityTitle;
    countyTitle = P.searchCountyTitle;
    cityNote = DATA.fmt(P.searchCityNote, { n: cityList.length });
    countyNote = DATA.fmt(P.searchCountyNote, { n: countyList.length });
    if (!countyList.length) countyEmptyHtml = P.emptyCountyQ;
  } else {
    /* 级联态：按当前展开路径逐级列出 */
    const prov = CASCADE.activeProvince || { name: '', children: [] };
    const city = CASCADE.activeCity;
    const cn = prov.children || [];
    const isMuni = (DATA.region.municipalities || []).indexOf(prov.name) >= 0;
    const unit = isMuni ? P.unitCounty : P.unitCity;

    cityList = cn;
    cityTitle = DATA.fmt(P.titleTpl, { name: prov.name, n: cn.length, unit });
    cityNote = DATA.fmt(P.cityNote, { name: prov.name, n: cn.length, unit });

    /* 「选中全省」快捷操作：勾省 = 「全省」一个条件已经够用，这里给的是
       「把该省下辖市逐个点亮」的省事路径（纯增量，不动省名自身的勾选状态）。 */
    if (cn.length) {
      const allOn = CASCADE.provinceAllOn();
      const label = isMuni
        ? (allOn ? P.unselectWholeMuni : P.selectWholeMuni)
        : (allOn ? P.unselectAllCities : P.selectAllCities);
      cityAct = `<button class="col-act ${allOn ? 'on' : ''}" data-casc-prov-all="1" title="${
        escHtml(DATA.fmt(P.selectAllCitiesHint, { name: prov.name, n: cn.length, unit }))}">${label}</button>`;
    }

    if (city && city.children) {
      countyList = city.children;
      countyTitle = DATA.fmt(P.titleTpl, { name: city.name, n: countyList.length, unit: P.unitCounty });
      countyNote = DATA.fmt(P.countyNote, { name: city.name, n: countyList.length });
    } else if (city) {
      countyEmptyHtml = DATA.fmt(P.noCountyData, { name: city.name });
    }
  }

  if (!countyList.length && !countyEmptyHtml) {
    countyEmptyHtml = q ? P.emptyCountyQ : P.emptyCountyDefault;
  }

  const sel = CASCADE.selectedNodes(true) || [];
  const names = sel.slice(0, P.sumMax).map((x) => x.name).join(' / ') + (sel.length > P.sumMax ? P.sumMore : '');

  /* 每列一个「内容身份」键。整列重画会把滚动条弹回顶部，app.js → swapPanelBody()
     只在身份没变时才把滚动位置放回去 —— 换了展开的省 / 市，那一列的名单整体换了人，
     停在旧位置没有意义；只是勾一下复选框时身份不变，用户就不该被弹回顶部。 */
  const stamp = `${q}|${showAll ? 1 : 0}`;
  const nameOf = (n) => (n && n.name) || '';

  return {
    P,
    L,
    q,
    showAll,
    keys: [
      `prov|${stamp}`,
      `city|${nameOf(CASCADE.activeProvince)}|${stamp}`,
      `county|${nameOf(CASCADE.activeCity)}|${stamp}`,
    ],
    provTitle,
    provList,
    provNote,
    cityTitle,
    cityList,
    cityNote,
    cityAct,
    cityEmptyText: q ? P.emptyCity : P.emptyCityDefault,
    countyTitle,
    countyList,
    countyNote,
    countyEmptyHtml,
    sel,
    sum: sel.length ? DATA.fmt(P.sumHas, { n: sel.length, names }) : P.sumNone,
  };
}

function cascHeadHTML(v) {
  return `
    <div class="fpanel-head">
      <div class="fpanel-head-top">
        <span class="fp-ttl">${v.P.title}</span>
        <span class="fp-spacer"></span>
        <span class="casc-switch ${v.showAll ? 'on' : ''}" data-only-data="1"><i class="sw"></i>${v.P.onlyWithData}</span>
      </div>
      <div class="fpanel-head-bar">
        <label class="fp-search">
          ${ICON.searchSm}
          <input id="cascQ" placeholder="${escHtml(v.P.searchPlaceholder)}" value="${escHtml(v.q)}">
        </label>
        <span class="fp-hint">${v.L.panelHint}</span>
      </div>
    </div>`;
}

function cascBodyHTML(v) {
  return `
    <div class="fpanel-body">
      ${cascColHTML(v.provTitle, v.provList, { note: v.provNote, emptyText: v.P.emptyProv }, v.showAll)}
      ${cascColHTML(v.cityTitle, v.cityList, { note: v.cityNote, emptyText: v.cityEmptyText, act: v.cityAct }, v.showAll)}
      ${cascColHTML(v.countyTitle, v.countyList, { note: v.countyNote, emptyText: v.countyEmptyHtml }, v.showAll)}
    </div>`;
}

function cascFootHTML(v) {
  return `
    <div class="fpanel-foot">
      <span class="sum">${escHtml(v.sum)}</span>
      <button class="btn btn-outline btn-sm" data-casc-clear="1">${v.L.clear}</button>
      <button class="btn btn-solid btn-sm" data-casc-ok="1">${DATA.fmt(v.L.ok, { n: v.sel.length })}</button>
    </div>`;
}

function cascPanelHTML(view) {
  /* 只认真正的视图对象：`.map(cascPanelHTML)` 这类写法会把数组下标当第二个参数传进来。 */
  const v = (view && typeof view === 'object') ? view : cascView();
  return `<div class="fpanel casc-panel" id="cascPanel">${cascHeadHTML(v)}${cascBodyHTML(v)}${cascFootHTML(v)}</div>`;
}

function cascRow(node, dim) {
  const st = CASCADE.stateOf(node.code);
  const cls = st === 'on' ? 'on' : '';
  const isNation = node.code === CASCADE.NATION;
  return `
    <div class="frow ${cls} ${isNation ? 'all' : ''}" data-casc-node="${node.code}" style="${dim ? 'opacity:.35' : ''}">
      <span class="box">${st === 'on' ? ICON.check : ''}</span>
      <span class="rn">${node.name}</span>
    </div>`;
}

const CASC_STATE = { query: '', onlyWithData: false };
