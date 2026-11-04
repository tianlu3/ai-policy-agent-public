"""内置政策源清单（Phase-1）。

架构方案里权威源应由数据库 `policy_source` 表管理（配置化管理、新增源不改代码）；
当前无数据库，先用内置清单，接口形状与表结构对齐，后续替换实现即可。

用途：生成「多源抓取」阶段的真实日志与进度（本次触达 N 个源），
不参与政策内容生成（内容由 LLM / 规则引擎产出）。
"""
from __future__ import annotations

from dataclasses import dataclass

from .regions import RegionNode


@dataclass(frozen=True)
class Source:
    name: str
    level: str          # nation / province / city / park / platform
    province: str = ""  # 所属省（用于按地域匹配）
    city: str = ""
    domain: str = ""
    weight: int = 5     # 权威度权重（国家 > 省 > 市 > 园区）


SOURCES: tuple[Source, ...] = (
    # ---- 国家部委 ----
    Source("中国政府网", "nation", domain="www.gov.cn", weight=10),
    Source("工业和信息化部", "nation", domain="www.miit.gov.cn", weight=10),
    Source("国家发展改革委", "nation", domain="www.ndrc.gov.cn", weight=10),
    Source("财政部", "nation", domain="www.mof.gov.cn", weight=10),
    Source("科学技术部", "nation", domain="www.most.gov.cn", weight=9),
    Source("人力资源和社会保障部", "nation", domain="www.mohrss.gov.cn", weight=9),
    Source("商务部", "nation", domain="www.mofcom.gov.cn", weight=8),
    Source("国家税务总局", "nation", domain="www.chinatax.gov.cn", weight=8),
    Source("国家市场监督管理总局", "nation", domain="www.samr.gov.cn", weight=8),
    Source("国家知识产权局", "nation", domain="www.cnipa.gov.cn", weight=7),
    Source("国家政务服务平台", "platform", domain="gjzwfw.www.gov.cn", weight=7),

    # ---- 省级（样例省份，按地域匹配） ----
    Source("浙江省经济和信息化厅", "province", province="浙江省", domain="jxt.zj.gov.cn", weight=7),
    Source("浙江省财政厅", "province", province="浙江省", domain="czt.zj.gov.cn", weight=7),
    Source("浙江政务服务网", "platform", province="浙江省", domain="www.zjzwfw.gov.cn", weight=6),
    Source("江苏省工业和信息化厅", "province", province="江苏省", domain="gxt.jiangsu.gov.cn", weight=7),
    Source("广东省工业和信息化厅", "province", province="广东省", domain="gdii.gd.gov.cn", weight=7),
    Source("广东省科学技术厅", "province", province="广东省", domain="gdstc.gd.gov.cn", weight=6),
    Source("山东省工业和信息化厅", "province", province="山东省", domain="gxt.shandong.gov.cn", weight=6),
    Source("四川省经济和信息化厅", "province", province="四川省", domain="jxt.sc.gov.cn", weight=6),
    Source("上海市经济和信息化委员会", "province", province="上海市", domain="sheitc.sh.gov.cn", weight=7),
    Source("北京市经济和信息化局", "province", province="北京市", domain="jxj.beijing.gov.cn", weight=7),

    # ---- 地市（样例城市） ----
    Source("杭州市经济和信息化局", "city", province="浙江省", city="杭州市", domain="jxj.hangzhou.gov.cn", weight=6),
    Source("杭州市科学技术局", "city", province="浙江省", city="杭州市", domain="kj.hangzhou.gov.cn", weight=5),
    Source("宁波市经济和信息化局", "city", province="浙江省", city="宁波市", domain="jxj.ningbo.gov.cn", weight=5),
    Source("深圳市工业和信息化局", "city", province="广东省", city="深圳市", domain="gxj.sz.gov.cn", weight=6),
    Source("广州市工业和信息化局", "city", province="广东省", city="广州市", domain="gxj.gz.gov.cn", weight=5),
    Source("苏州市工业和信息化局", "city", province="江苏省", city="苏州市", domain="gxj.suzhou.gov.cn", weight=5),
    Source("南京市工业和信息化局", "city", province="江苏省", city="南京市", domain="gxj.nanjing.gov.cn", weight=5),
    Source("成都市经济和信息化局", "city", province="四川省", city="成都市", domain="cdjx.chengdu.gov.cn", weight=5),
    Source("上海市浦东新区科技和经济委员会", "city", province="上海市", city="上海市", domain="www.pudong.gov.cn", weight=5),

    # ---- 园区 ----
    Source("杭州高新技术产业开发区", "park", province="浙江省", city="杭州市", domain="www.hhtz.gov.cn", weight=5),
    Source("苏州工业园区经济发展委员会", "park", province="江苏省", city="苏州市", domain="www.sipac.gov.cn", weight=5),
    Source("深圳高新技术产业园区", "park", province="广东省", city="深圳市", domain="www.sz.gov.cn", weight=5),
    Source("中关村科技园区管理委员会", "park", province="北京市", city="北京市", domain="zgcgw.beijing.gov.cn", weight=5),
    Source("成都高新技术产业开发区", "park", province="四川省", city="成都市", domain="www.cdht.gov.cn", weight=4),
    Source("武汉东湖新技术开发区", "park", province="湖北省", city="武汉市", domain="www.wehdz.gov.cn", weight=4),

    # ---- 综合/兜底 ----
    Source("全国中小企业服务网", "platform", domain="www.ismexpo.com", weight=4),
    Source("中国中小企业信息网", "platform", domain="www.sme.gov.cn", weight=4),
    Source("各地市政务公开平台", "platform", domain="", weight=3),
    Source("省级惠企政策兑现平台", "platform", domain="", weight=3),
    Source("区县级政府门户网站", "platform", domain="", weight=2),
)


def pick_for(nodes: list[RegionNode], limit: int = 36) -> list[Source]:
    """按用户地域挑源：本地源优先，其次国家部委，最后补齐通用源。"""
    province = ""
    city = ""
    for node in nodes or []:
        if node.level == 1 and not province:
            province = node.name
        elif node.level == 2 and not city:
            city = node.name
            if not province and len(node.path) >= 1:
                province = node.path[0]
        elif node.level == 3:
            if not city and len(node.path) >= 2:
                city = node.path[-2]
            if not province and len(node.path) >= 1:
                province = node.path[0]

    local: list[Source] = []
    national: list[Source] = []
    rest: list[Source] = []

    for src in SOURCES:
        if city and src.city == city:
            local.append(src)
        elif province and src.province == province:
            local.append(src)
        elif src.level == "nation":
            national.append(src)
        elif not src.province:
            rest.append(src)

    ordered = local + national + rest
    return ordered[:limit] if limit and limit > 0 else ordered
