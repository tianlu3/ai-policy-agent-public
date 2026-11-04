/* ============================================================
   地域三级级联多选（Cascader × Multi-Select）
   ------------------------------------------------------------
   数据来源：DATA.regions
     · tree     —— [code, name, py首字母, children|null]，首项「全国（不限）」
     · defaults —— expandPath（默认展开）/ applied（默认已选，按名称路径）

   语义：
   · 每级独立勾选：勾省 = 「全省」这一个条件，**不下沉点亮**地级市 / 区县；
     勾市、勾区县同理，只代表它自己。三列之间没有任何联动。
     （设计稿 S7 原来的「选省自动携带下辖市 + 子级取消后父级转半选」已按产品要求取消）
   · 「全国（不限）」与任何具体地域互斥
   · 多选不限层级，多个条件按 OR 生效，与「政策层级」筛选互相独立
   · 每级独立滚动 + 名称 / 拼音首字母搜索
   · 超过 4 项折叠为「+N」
   · 未选即「全国（不限）」
   · 勾选只更新草稿与计数，点「确定」后才生效
   ============================================================ */
const CASCADE = (function () {
  const NATION = '00';
  let index = new Map();     // code -> {code,name,py,children,parent,level}
  let provinces = [];        // 一级（含「全国（不限）」）

  function walk(list, parent, level) {
    return list.map(([code, name, py, children]) => {
      const node = { code, name, py: py || '', children: null, parent, level };
      index.set(code, node);            // 先注册父级，保证遍历顺序 = 树的前序
      if (level === 1) provinces.push(node);
      node.children = children ? walk(children, node, level + 1) : null;
      return node;
    });
  }

  const self = {
    NATION,
    /* ---------- 初始化（由 app.js 在数据就绪后调用） ---------- */
    init(tree, defaults) {
      index = new Map();
      provinces = [];
      walk(tree || [], null, 1);
      self.index = index;
      self.provinces = provinces;
      /* 省级列表（去掉默认项） */
      self.provinceList = provinces.filter((p) => p.code !== NATION);

      const d = defaults || {};
      const path = d.expandPath || [];
      self.activeProvince = (path[0] && self.provinceList.find((p) => p.name === path[0])) || self.provinceList[0];
      const kids = (self.activeProvince && self.activeProvince.children) || [];
      self.activeCity = (path[1] && kids.find((c) => c.name === path[1])) || kids[0] || null;

      /* 默认已选：按「名称路径」精确解析，避免同名区县歧义 */
      self.applied = new Set();
      self.draft = new Set();
      (d.applied || []).forEach((p) => {
        const node = self.resolvePath(p);
        if (node) { self.applied.add(node.code); self.draft.add(node.code); }
      });
      return self;
    },
    /** 按名称路径逐级解析节点，如 ['浙江省','杭州市','滨江区'] */
    resolvePath(path) {
      let list = provinces;
      let node = null;
      for (const name of (path || [])) {
        node = (list || []).find((n) => n.name === name) || null;
        if (!node) return null;
        list = node.children;
      }
      return node;
    },
    /* ---------- 状态 ---------- */
    draft: new Set(),      // 草稿选择（面板内）
    applied: new Set(),    // 已生效（触发框）
    index,
    provinces,
    node: (code) => index.get(code),
    /* ---------- 基础判定 ---------- */
    isExplicit(code) { return self.draft.has(code); },
    /** 'on' | 'off' —— 每级独立，不看祖先也不看子级（已无「半选态」） */
    stateOf(code) {
      if (!index.get(code)) return 'off';
      return self.draft.has(code) ? 'on' : 'off';
    },
    /* ---------- 勾选 ---------- */
    toggle(code) {
      if (code === NATION) {
        if (self.draft.has(NATION)) self.draft.clear();
        else { self.draft.clear(); self.draft.add(NATION); }
        return;
      }
      self.draft.delete(NATION);                    // 与「全国（不限）」互斥
      /* 只切自己：不牵连子级，也不动祖先 */
      if (self.draft.has(code)) self.draft.delete(code);
      else self.draft.add(code);
    },
    /** 全选 / 取消全选本级（某列的所有可见兄弟） */
    toggleAll(list) {
      const allOn = list.every((n2) => self.draft.has(n2.code));
      if (allOn) list.forEach((n2) => self.draft.delete(n2.code));
      else { self.draft.delete(NATION); list.forEach((n2) => self.draft.add(n2.code)); }
    },
    /**
     * 「选中全省」快捷操作（市级列标题旁）：一键勾上**当前展开省**下全部地级市。
     *
     *   为什么不直接点省名？点省名 = 「全省」这一个条件（语义等价，但只占 1 行、无法回看下辖有谁）；
     *   本操作是替用户把下辖市逐个点亮，省名自身是否勾选**不受影响** —— 纯增量，
     *   不会悄悄改掉用户已经做过的选择。全部已勾时再点即整体取消。
     * @returns {{allOn:boolean, n:number}} 操作前的状态与受影响的市级数量
     */
    toggleProvinceAll() {
      const p = self.activeProvince;
      const kids = (p && p.children) || [];
      if (!kids.length) return { allOn: false, n: 0 };
      const allOn = kids.every((c) => self.draft.has(c.code));
      if (allOn) kids.forEach((c) => self.draft.delete(c.code));
      else { self.draft.delete(NATION); kids.forEach((c) => self.draft.add(c.code)); }
      return { allOn, n: kids.length };
    },
    /** 当前展开省下辖市是否已全部在草稿里（驱动「选中全省 / 取消全省」文案） */
    provinceAllOn() {
      const kids = (self.activeProvince && self.activeProvince.children) || [];
      return !!kids.length && kids.every((c) => self.draft.has(c.code));
    },
    clear() { self.draft.clear(); },
    /** 草稿 → 生效 */
    commit() { self.applied = new Set(self.draft); return self.applied; },
    resetFromApplied() { self.draft = new Set(self.applied); },
    /* ---------- 已选（芯片 & 计数） ---------- */
    selectedNodes(draft) {
      const src = draft ? self.draft : self.applied;
      const out = [];
      index.forEach((n) => {
        if (n.code === NATION) return;
        if (src.has(n.code)) out.push(n);
      });
      return out;
    },
    count(draft) { return self.selectedNodes(draft).length; },
    summaryText(draft) {
      const list = self.selectedNodes(draft);
      if (!list.length) return '全国（不限）';
      return list.map((n) => n.name).join(' / ');
    },
    /* ---------- 搜索 ---------- */
    match(node, q) {
      if (!q) return true;
      const s = q.trim();
      if (!s) return true;
      if (node.name.indexOf(s) >= 0) return true;
      if (/^[a-zA-Z]+$/.test(s)) return node.py.toUpperCase().indexOf(s.toUpperCase()) === 0;
      return false;
    },
    /** 在当前列表里过滤；同时返回命中的相邻层级 */
    filterLevel(list, q) { return q ? list.filter((n) => self.match(n, q)) : list; },
  };

  return self;
})();
