"""本地规则抽取引擎（Mock Provider）。

两个用途：
  1) **免费、离线、零配置的测试通道** —— 没配 API key 也能跑通
     「前端 → 后端 → 提示词 → 模型 → 回填数据结构」的完整链路；
  2) 真实 LLM 失败时的**兜底抽取**（对应架构方案的「抽取失败回退规则抽取 + 低置信标记」）。

设计原则：**确定性**。同一组输入必得同一份结果（随机种子取自输入指纹），
便于测试复现与演示；但内容会随「地域 / 行业 / 查询语句」变化，不是写死的样例。

结果集规模：**随选中地域全层级铺开** —— 选中的省 / 市连同其下辖市、区县一并展开，
行业与类型都不限时按全部主题铺满（2 个省约 300+ 条），总量由
`config.SEARCH_RESULT_MAX` 封顶。**不再固定 10 条、也不再只认第一个地域**。
"""
from __future__ import annotations

import hashlib
import random
import re
from dataclasses import dataclass
from datetime import date, timedelta

from .. import config, query_parse, regions
from .base import ExtractionRequest, ExtractionResult

# ---------- 主题库（政策类型模板） ----------

# 归口部门类别：决定发布机构用哪一条线（经信 / 科技 / 人社 / 财政）
_HINT_INDUSTRY = "industry"
_HINT_TECH = "tech"
_HINT_SOCIAL = "social"
_HINT_FINANCE = "finance"

# 「打开原文」的落点：演示数据是虚构政策，但跳转必须落到**真实存在的官方原文**，
# 按主题对号入座到中国政府网 / 财政部网的对应政策文件（2026-10-14 用户要求直达原文页，不要搜索页）。
_REAL_SOURCE_URLS = {
    "企业技术改造补贴": "https://www.gov.cn/zhengce/zhengceku/202404/content_6944252.htm",       # 工业领域设备更新实施方案
    "失业保险稳岗返还": "https://www.gov.cn/zhengce/zhengceku/202607/content_7074139.htm",       # 失业保险支持企业稳岗扩岗的通知
    "研发费用加计扣除奖励": "https://www.gov.cn/zhengce/zhengceku/2023-03/28/content_5748747.htm",  # 完善研发费用税前加计扣除政策公告
    "小微企业场地租金减免": "https://www.gov.cn/zhengce/zhengceku/2022-06/23/content_5697233.htm",  # 阶段性减免市场主体房屋租金通知
    "中小微企业贷款贴息": "https://www.gov.cn/zhengce/zhengceku/202608/content_7078798.htm",     # 财政金融协同促内需（贷款贴息）通知
    "专精特新中小企业奖励": "https://m.mof.gov.cn/czxw/202406/t20240618_3937446.htm",           # 支持专精特新中小企业高质量发展
    "企业数字化转型补助": "https://m.mof.gov.cn/czxw/202505/t20250509_3963485.htm",             # 中小企业数字化转型城市试点
    "首台（套）装备保险补偿": "https://www.gov.cn/zhengce/zhengceku/202406/content_6956048.htm",   # 首台套首批次保险补偿政策意见
    "产业人才引进补贴": "https://www.cqspb.gov.cn/zwgk_235/zfxxgkpt/zfgb/2025/dyq/202604/t20260414_15610966.html",  # 高校毕业生就业创业行动（安家补贴）
    "绿色低碳技术改造补助": "https://www.gov.cn/zhengce/zhengceku/202601/content_7055549.htm",   # 设备更新贷款贴息（含绿色化改造）
}
_FALLBACK_URL = "https://www.gov.cn/zhengce/zhengceku/202404/content_6944252.htm"

# 「转载页」与「原文链接」分家：原文链接指向政策文件页，转载页指向官方门户的转发/报道页。
# 技改这条用用户 2026-10-14 指定的中国政府网页面（制造业新型技术改造城市试点通知的报道）。
_REPOST_URLS = {
    "企业技术改造补贴": "https://www.gov.cn/lianbo/bumen/202404/content_6945449.htm",
}

# 远端大模型吐出的政策名不会精确等于主题名（如《全国制造业企业技术改造补贴实施细则》），
# 按关键词对号入座到真实官方原文 —— 顺序即优先级：具体的排前面，宽泛的「技术改造」排最后，
# 否则「绿色低碳技术改造补助」会被宽泛词截胡。匹配不到返回 None（调用方自行兜底）。
_URL_KEYWORDS: tuple[tuple[tuple[str, ...], str], ...] = (
    (("绿色低碳", "绿色化", "节能"), _REAL_SOURCE_URLS["绿色低碳技术改造补助"]),
    (("数字化转型", "数字化", "智改数转"), _REAL_SOURCE_URLS["企业数字化转型补助"]),
    (("专精特新",), _REAL_SOURCE_URLS["专精特新中小企业奖励"]),
    (("首台", "首套"), _REAL_SOURCE_URLS["首台（套）装备保险补偿"]),
    (("稳岗", "失业保险"), _REAL_SOURCE_URLS["失业保险稳岗返还"]),
    (("加计扣除", "研发费用"), _REAL_SOURCE_URLS["研发费用加计扣除奖励"]),
    (("租金", "场地"), _REAL_SOURCE_URLS["小微企业场地租金减免"]),
    (("人才", "安家", "就业补贴"), _REAL_SOURCE_URLS["产业人才引进补贴"]),
    (("贷款贴息", "贴息"), _REAL_SOURCE_URLS["中小微企业贷款贴息"]),
    (("技术改造", "技改", "设备更新"), _REAL_SOURCE_URLS["企业技术改造补贴"]),
)


def real_source_url(name: str) -> str | None:
    """按政策名关键词匹配真实官方原文 URL；匹配不到返回 None。"""
    text = name or ""
    for needles, url in _URL_KEYWORDS:
        if any(n in text for n in needles):
            return url
    return None


@dataclass(frozen=True)
class _Theme:
    level_types: str          # → types 字段
    core: str                 # 名称核心，如「技术改造补贴」
    subsidy: str              # → subsidy 字段
    conditions: tuple[str, ...]
    conditions_full: tuple[str, ...]   # 支持 {region} / {industry}
    materials: tuple[str, ...]
    snapshot: str             # 含 <mark>，用于字段级溯源高亮
    industry: str             # 主要适用行业（"不限" 表示通用）
    hint: str                 # 归口部门


_THEMES: tuple[_Theme, ...] = (
    _Theme(
        level_types="补贴 / 技改",
        core="企业技术改造补贴",
        subsidy="按设备投资额 10% 给予补助，单户每年上限 200 万元",
        conditions=("注册满 2 年", "营收 ≥ 2000 万", "设备投入 ≥ 300 万"),
        conditions_full=(
            "在{region}依法注册登记满 2 年，具有独立法人资格且财务制度健全",
            "上年度营业收入不低于 2000 万元，其中{industry}相关业务收入占比不低于 50%",
            "当年新增技术改造设备投资额不低于 300 万元，且设备已投入实际生产使用",
        ),
        materials=("技术改造补贴申请表（加盖公章）", "设备投资发票及专项审计报告", "项目备案文件与竣工验收报告"),
        snapshot="……本细则适用于{region}内注册运营的{industry}企业。申报须同时满足以下条件："
                 "在{region}依法注册登记满 2 年，具有独立法人资格且财务制度健全；"
                 "上年度营业收入不低于 2000 万元，其中{industry}相关业务收入占比不低于 50%；"
                 "当年新增技术改造设备投资额不低于 300 万元，且设备已投入实际生产使用。"
                 "近两年内无重大安全生产事故……",
        industry="制造业",
        hint=_HINT_INDUSTRY,
    ),
    _Theme(
        level_types="稳岗 / 返还",
        core="失业保险稳岗返还",
        subsidy="按上年度实际缴纳失业保险费的 60% 返还，大型企业最高 30%",
        conditions=("参保 ≥ 12 个月", "裁员率 ≤ 5.5%", "无欠缴记录"),
        conditions_full=(
            "在{region}依法参加失业保险并足额缴纳失业保险费 12 个月以上",
            "上年度未裁员或裁员率不高于 5.5%，且参保职工人数不少于 30 人",
            "生产经营活动符合国家及{region}产业结构调整和环保政策，无严重失信记录",
        ),
        materials=("稳岗返还申请表", "参保职工名册与缴费凭证", "银行开户许可证复印件"),
        snapshot="……符合条件的参保企业可申请稳岗返还，须同时满足："
                 "在{region}依法参加失业保险并足额缴纳失业保险费 12 个月以上；"
                 "上年度未裁员或裁员率不高于 5.5%，且参保职工人数不少于 30 人；"
                 "生产经营活动符合国家及{region}产业结构调整和环保政策，无严重失信记录。"
                 "返还标准按上年度实际缴纳失业保险费的 60% 执行，裁员率不高于 5.5% 的{industry}企业优先审核……",
        industry="不限",
        hint=_HINT_SOCIAL,
    ),
    _Theme(
        level_types="税收 / 研发",
        core="研发费用加计扣除奖励",
        subsidy="研发费用按 100% 加计扣除，制造业企业可按 120% 加计",
        conditions=("有研发立项", "研发费用 ≥ 100 万", "辅助账齐全"),
        conditions_full=(
            "在{region}注册并实行查账征收，会计核算健全、能准确归集研发费用",
            "上年度研发费用总额不低于 100 万元，且已按项目设置研发费用辅助账",
            "研发活动符合《国家重点支持的高新技术领域》方向，{industry}类项目优先",
        ),
        materials=("研发项目立项决议", "研发费用辅助账与汇总表", "研发人员名单及工时分配说明"),
        snapshot="……{region}内企业申请研发费用加计扣除奖励的，须同时符合："
                 "在{region}注册并实行查账征收，会计核算健全、能准确归集研发费用；"
                 "上年度研发费用总额不低于 100 万元，且已按项目设置研发费用辅助账；"
                 "研发活动符合《国家重点支持的高新技术领域》方向，{industry}类项目优先。"
                 "研发费用未形成无形资产计入当期损益的，按实际发生额的 100% 在税前加计扣除……",
        industry="科技",
        hint=_HINT_TECH,
    ),
    _Theme(
        level_types="补贴 / 场地",
        core="小微企业场地租金减免",
        subsidy="前两年按租金 30% 减免，单户每年上限 50 万元",
        conditions=("入驻满 6 个月", "员工 ≤ 300 人", "场地自用"),
        conditions_full=(
            "在{region}依法登记注册并实际入驻办公满 6 个月，租赁场地用于自身经营",
            "企业职工人数不超过 300 人、上年度营业收入不超过 5000 万元",
            "租赁合同经备案，且未享受同类财政性租金补贴",
        ),
        materials=("场地租赁合同及备案证明", "租金支付凭证", "企业营业执照复印件"),
        snapshot="……对{region}内{industry}小微企业实行场地租金减免，申报条件为："
                 "在{region}依法登记注册并实际入驻办公满 6 个月，租赁场地用于自身经营；"
                 "企业职工人数不超过 300 人、上年度营业收入不超过 5000 万元；"
                 "租赁合同经备案，且未享受同类财政性租金补贴。"
                 "符合条件的，前两年按实际租金的 30% 给予减免，单户每年最高 50 万元……",
        industry="不限",
        hint=_HINT_FINANCE,
    ),
    _Theme(
        level_types="金融 / 贴息",
        core="中小微企业贷款贴息",
        subsidy="按贷款实际利率的 50% 贴息，单户年度上限 100 万元",
        conditions=("贷款用途合规", "无逾期记录", "营收 ≥ 500 万"),
        conditions_full=(
            "在{region}注册的中小微企业，贷款资金用于生产经营且用途合规",
            "近两年内无逾期、欠息等不良信用记录，纳税信用等级 B 级以上",
            "上年度营业收入不低于 500 万元，资产负债率不高于 70%",
        ),
        materials=("贷款合同及放款凭证", "付息明细与银行对账单", "企业征信报告"),
        snapshot="……{region}中小微企业申请贷款贴息的，应同时满足："
                 "在{region}注册的中小微企业，贷款资金用于生产经营且用途合规；"
                 "近两年内无逾期、欠息等不良信用记录，纳税信用等级 B 级以上；"
                 "上年度营业收入不低于 500 万元，资产负债率不高于 70%。"
                 "贴息按实际支付利息的 50% 给予，单户年度最高 100 万元……",
        industry="不限",
        hint=_HINT_FINANCE,
    ),
    _Theme(
        level_types="奖励 / 资质",
        core="专精特新中小企业奖励",
        subsidy="首次认定一次性奖励 50 万元，复核通过再奖 20 万元",
        conditions=("连续经营 ≥ 3 年", "研发占比 ≥ 3%", "主营业务突出"),
        conditions_full=(
            "在{region}注册并连续经营 3 年以上，主营业务收入占营业收入 70% 以上",
            "上年度研发费用占营业收入比重不低于 3%，拥有有效知识产权 2 项以上",
            "已获省级专精特新中小企业认定，且未享受同类一次性奖励",
        ),
        materials=("专精特新认定文件", "知识产权证书清单", "近两年审计报告"),
        snapshot="……对{region}内首次获得省级专精特新中小企业认定的企业给予奖励，申报条件为："
                 "在{region}注册并连续经营 3 年以上，主营业务收入占营业收入 70% 以上；"
                 "上年度研发费用占营业收入比重不低于 3%，拥有有效知识产权 2 项以上；"
                 "已获省级专精特新中小企业认定，且未享受同类一次性奖励。"
                 "符合条件的给予一次性奖励 50 万元，复核通过的再奖励 20 万元……",
        industry="科技",
        hint=_HINT_TECH,
    ),
    _Theme(
        level_types="补贴 / 数字化",
        core="企业数字化转型补助",
        subsidy="按数字化改造实际投入的 20% 补助，单户上限 150 万元",
        conditions=("投入 ≥ 50 万", "方案已备案", "系统上线运行"),
        conditions_full=(
            "在{region}注册的{industry}企业，已完成数字化改造方案备案",
            "上年度数字化改造实际投入不低于 50 万元（含软硬件、云服务与实施费）",
            "改造系统已上线稳定运行 3 个月以上，并通过第三方验收",
        ),
        materials=("数字化改造方案与备案回执", "投入明细及发票", "第三方验收报告"),
        snapshot="……支持{region}内{industry}企业实施数字化改造，申报须同时满足："
                 "在{region}注册的{industry}企业，已完成数字化改造方案备案；"
                 "上年度数字化改造实际投入不低于 50 万元（含软硬件、云服务与实施费）；"
                 "改造系统已上线稳定运行 3 个月以上，并通过第三方验收。"
                 "补助按实际投入的 20% 给予，单户最高 150 万元，重点支持智能生产线与工业互联网平台建设……",
        industry="制造业",
        hint=_HINT_INDUSTRY,
    ),
    _Theme(
        level_types="保险 / 补偿",
        core="首台（套）装备保险补偿",
        subsidy="按投保保费的 80% 补偿，单户年度上限 200 万元",
        conditions=("产品列入目录", "已投保", "首台套认定"),
        conditions_full=(
            "在{region}注册企业研制的产品已列入首台（套）重大技术装备推广应用指导目录",
            "已为投保产品购买首台（套）重大技术装备保险，且保单在有效期内",
            "产品已完成交付并实际投入运行，用户使用报告齐全",
        ),
        materials=("首台（套）认定文件", "保险合同与保费发票", "用户使用证明及运行记录"),
        snapshot="……对{region}内符合条件的首台（套）产品给予保险补偿，申报条件为："
                 "在{region}注册企业研制的产品已列入首台（套）重大技术装备推广应用指导目录；"
                 "已为投保产品购买首台（套）重大技术装备保险，且保单在有效期内；"
                 "产品已完成交付并实际投入运行，用户使用报告齐全。"
                 "补偿按投保保费的 80% 给予，同一企业年度补偿总额不超过 200 万元……",
        industry="制造业",
        hint=_HINT_INDUSTRY,
    ),
    _Theme(
        level_types="人才 / 补贴",
        core="产业人才引进补贴",
        subsidy="按人才层次给予每人 3~30 万元安家补贴，单户年度上限 300 万元",
        conditions=("签订 ≥ 3 年合同", "本科及以上", "本地参保"),
        conditions_full=(
            "引进人才与{region}内企业签订 3 年以上劳动合同并在本地连续缴纳社保",
            "人才具备本科及以上学历或中级及以上职称，属于{industry}紧缺岗位目录",
            "企业上年度引进符合条件人才不少于 3 人，且未重复享受同类补贴",
        ),
        materials=("劳动合同与社保证明", "学历学位或职称证书", "人才引进花名册"),
        # ★ 这条主题**刻意**让第 3 条条款（引进人数不少于 3 人）不出现在原文摘录里：
        #   真实场景中「摘录只是原文的一段」，总有条款来自别的小节。界面必须如实
        #   标「原文未命中」并降分，而不是编一个好看的数字糊过去 —— 保留它正是为了
        #   让这条路径在每次检索里都被走到（闸门也按它断言 unmatched 的行为）。
        snapshot="……{region}内企业引进{industry}紧缺人才可申请安家补贴，申报条件为："
                 "引进人才与{region}内企业签订 3 年以上劳动合同并在本地连续缴纳社保；"
                 "人才具备本科及以上学历或中级及以上职称，属于{industry}紧缺岗位目录。"
                 "补贴按人才层次给予每人 3 万至 30 万元，单户年度累计不超过 300 万元……",
        industry="科技",
        hint=_HINT_SOCIAL,
    ),
    _Theme(
        level_types="补贴 / 绿色",
        core="绿色低碳技术改造补助",
        subsidy="按节能改造投资额的 15% 补助，单户上限 120 万元",
        conditions=("节能量可核算", "投入 ≥ 30 万", "通过节能评审"),
        conditions_full=(
            "在{region}注册的{industry}企业实施节能降碳改造，节能量可计量、可核算",
            "项目实际投资额不低于 30 万元，且年节能量不低于 100 吨标准煤（或等效减排量）",
            "项目已通过节能评审或碳减排效果评估，未享受同类中央、省级资金",
        ),
        materials=("节能改造项目方案", "节能量核算报告", "投资发票与验收材料"),
        # ★ 第 2 条条款在摘录里**不带空格、句读也不同**（「不低于30万元且年节能量…」）：
        #   模拟「原文排版与抽取口径有细微差异」的常见情形 —— 应当被归一化后定位到，
        #   判为 normalized（0.80~0.89）而不是硬说「找不到」，也不是假装逐字命中。
        snapshot="……支持{region}内{industry}企业实施绿色低碳改造，申报须同时满足："
                 "在{region}注册的{industry}企业实施节能降碳改造，节能量可计量、可核算；"
                 "项目实际投资额不低于30万元且年节能量不低于100吨标准煤（或等效减排量）；"
                 "项目已通过节能评审或碳减排效果评估，未享受同类中央、省级资金。"
                 "补助按节能改造投资额的 15% 给予，单户最高 120 万元，优先支持年节能量超 100 吨标准煤的项目……",
        industry="制造业",
        hint=_HINT_INDUSTRY,
    ),
)

# ---------- 归口部门 ----------

_ISSUERS: dict[str, dict[str, tuple[str, ...]]] = {
    "nation": {
        _HINT_INDUSTRY: ("工业和信息化部", "国家发展和改革委员会"),
        _HINT_TECH: ("科学技术部",),
        _HINT_SOCIAL: ("人力资源和社会保障部",),
        _HINT_FINANCE: ("财政部", "国家发展和改革委员会"),
    },
    "province": {
        _HINT_INDUSTRY: ("经济和信息化厅", "发展和改革委员会"),
        _HINT_TECH: ("科学技术厅",),
        _HINT_SOCIAL: ("人力资源和社会保障厅",),
        _HINT_FINANCE: ("财政厅",),
    },
    "city": {
        _HINT_INDUSTRY: ("经济和信息化局", "发展和改革委员会"),
        _HINT_TECH: ("科学技术局",),
        _HINT_SOCIAL: ("人力资源和社会保障局",),
        _HINT_FINANCE: ("财政局",),
    },
    "county": {
        _HINT_INDUSTRY: ("经济和信息化局",),
        _HINT_TECH: ("科学技术局",),
        _HINT_SOCIAL: ("人力资源和社会保障局",),
        _HINT_FINANCE: ("财政局",),
    },
    "park": {
        _HINT_INDUSTRY: ("高新技术产业开发区管理委员会", "经济技术开发区管理委员会"),
        _HINT_FINANCE: ("高新技术产业开发区管理委员会",),
        _HINT_TECH: ("高新技术产业开发区管理委员会",),
        _HINT_SOCIAL: ("高新技术产业开发区管理委员会",),
    },
}

_LEVEL_LABEL = {"nation": "国家级", "province": "省级", "city": "市级", "county": "区县级", "park": "园区级"}

def _seed(*parts: str) -> int:
    """由输入指纹生成确定性随机种子。"""
    raw = "|".join(parts).encode("utf-8")
    return int(hashlib.sha1(raw).hexdigest()[:16], 16)


# ---------- 地域展开：选中节点 + 其下辖全层级 ----------

def _descendants(node) -> list:
    """node 下辖的全层级节点（省 → 市 → 区县），广度优先。"""
    out: list = []
    queue = list(regions.children(node))
    while queue:
        cur = queue.pop(0)
        out.append(cur)
        queue.extend(regions.children(cur))
    return out


def _scope_of(node) -> dict:
    """一个地域节点 → 四层 scope（机构名按节点自身路径拼，不再向上猜）。

    以前是「取第一个省 + 猜它的市」，所以选了两个省时第二个省压根出不来。
    现在每个节点自带完整路径（内蒙古自治区 / 包头市 / 昆都仑区），
    机构名与区划码都从它自己推，互不串味。
    """
    path = list(node.path)
    province = path[0] if len(path) > 0 else ""
    city = path[1] if len(path) > 1 else ""
    county = path[2] if len(path) > 2 else ""
    scope = {
        "nation": "全国",
        "province": province or node.name,
        "city": city or province or node.name,
        "county": county or city or province or node.name,
    }
    scope["park"] = scope["county"]
    return scope


# ---------- 主题池：按「行业 / 类型」收窄 ----------

_SPLIT_RE = re.compile(r"[/、,，;；|]+")

# 行业词 → 主题模板自带的行业标签（`_Theme.industry` 只有 制造业 / 科技 / 不限 三种取值）。
# 筛选栏枚举与本轮从问句解析出来的词都会先经这里归一 ——
# 否则「智能硬件」和模板里的「制造业」互相不认识，收窄就直接落空。
_INDUSTRY_TO_THEME: dict[str, str] = {
    "智能硬件": "制造业",
    "制造业": "制造业",
    "新能源": "制造业",
    "新材料": "制造业",
    "软件信息": "科技",
    "生物医药": "科技",
}

# 类型枚举 → 主题模板 `level_types` 里的同类词（「融资」在模板里写的是「金融 / 贴息」）。
_TYPE_TO_THEME: dict[str, tuple[str, ...]] = {
    "场地减免": ("场地", "租金"),
    "融资": ("金融", "贴息", "贷款"),
    "研发加计扣除": ("研发",),
    "税收优惠": ("税收",),
    "补贴": ("补贴",),
    "稳岗": ("稳岗",),
    "人才": ("人才",),
}


def _industry_needles(word: str) -> list[str]:
    """行业词 → 用来挑选主题的模板行业标签。

    枚举外的行业（农业 / 商贸零售 / 交通物流…）没有专属模板，返回空列表 ——
    它们只会命中「不限」主题（场地租金减免 / 贷款贴息 / 稳岗返还），这正合适：
    没有农业专属模板，就不该硬塞一条制造业技改补贴给它。
    """
    mapped = _INDUSTRY_TO_THEME.get(word)
    return [mapped] if mapped else []


def _type_needles(word: str) -> list[str]:
    return list(_TYPE_TO_THEME.get(word) or (word,))


def _tokens(text: str) -> list[str]:
    """「智能硬件 / 软件信息」→ ["智能硬件", "软件信息"]。"""
    return [t.strip() for t in _SPLIT_RE.split(text or "") if t.strip()]


def _token_match(needle: str, haystack: str) -> bool:
    """宽松匹配：任一侧包含另一侧即命中（「场地减免」↔「场地」）。"""
    return bool(needle) and bool(haystack) and (needle in haystack or haystack in needle)


def _match_themes(industries: str, types: str) -> list[_Theme]:
    """行业 / 类型设了时收窄主题池；**收窄为空则退回全部**（宁可多出，不可漏空）。

    只影响「出哪些主题、出多少条」，不改政策名与 industries 字段的口径 ——
    那两处仍是「设了什么就写什么，没设就写主题自带行业」。

    两处词表的意义：用户嘴里的词与模板里的词不是一套（「智能硬件」vs「制造业」、
    「融资」vs「金融 / 贴息」）。不收窄就会「设了等于没设」——
    以前类型「融资」正是这样悄悄落空的。
    """
    pool = list(_THEMES)
    inds = _tokens(industries)
    if inds:
        wanted = {x for i in inds for x in _industry_needles(i)}
        if wanted:
            hit = [t for t in pool if t.industry == "不限" or t.industry in wanted]
            if hit:
                pool = hit
    typs = _tokens(types)
    if typs:
        needles = [n for x in typs for n in _type_needles(x)]
        hit = [
            t for t in pool
            if any(_token_match(n, tok) for n in needles for tok in _tokens(t.level_types))
        ]
        if hit:
            pool = hit
    return pool or list(_THEMES)


# 「行业 / 类型都不限」时每个地域块的基础条数（满配额）。
# 全层级展开后一个省自带 12~21 个市、90~180 个区县，所以区县配额压到 1 条 ——
# 2 个省合计 10 + 2×10 + 25×3 + 234 ≈ 340 条，正是「数百条」的量级。
_LEVEL_QUOTA = {"nation": 10, "province": 10, "city": 3, "county": 1}
_LEVEL_BY_DEPTH = {1: "province", 2: "city", 3: "county"}
_NATION_SCOPE = {"nation": "全国", "province": "全国", "city": "全国", "county": "全国", "park": "全国"}


def _covered_branches(selected: list) -> dict[str, list]:
    """某选中节点 → 它下辖的**也被显式选中**的后代节点（用于收窄展开）。

    用户实测：筛选栏里选了「上海市 + 杨浦区」，结果列表却把上海的 16 个区
    （松江 / 崇明 / 徐汇 / 普陀 ……）全铺了出来 —— 他要的是杨浦区。
    根因是「下辖全层级展开」对选中节点无条件生效，横向把兄弟节点也铺开。

    规则：一个选中节点的下辖里只要有**被显式选中的**，就只走那几支（含其间的
    中间层级，如「浙江省 + 西湖区」要保住杭州市这一跳），其余下辖一概不收。
    没有下钻的情形（只选了省 / 只选了市）按原设计照旧铺满，不受影响。
    """
    branches: dict[str, list] = {}
    for node in selected:
        under = [
            c for c in selected
            if c.level > node.level and c.path[: len(node.path)] == node.path
        ]
        if under:
            branches[node.code] = under
    return branches


def _ancestors(node) -> list:
    """选中节点的上级链（不含自身）：市 → 省；县 → 市 → 省。

    上级政策的适用范围本来就覆盖下级 —— 用户勾「南昌市」时，「结果只含该市及上级」
    意味着江西省本级的政策也要在（2026-10-16 口径）。按 path 里的名字逐级 resolve。
    """
    out: list = []
    for name in list(node.path[:-1]):
        try:
            found = regions.resolve([name])
        except Exception:  # noqa: BLE001 - 上级解析失败只影响展示广度，不致命
            found = []
        if found:
            out.append(found[0])
    return out


def _pick_targets(req: ExtractionRequest) -> tuple[list[dict], list[_Theme]]:
    """决定本次产出覆盖「哪些地域 × 哪一层级 × 每块多少条」，并给出主题池。

    用户诉求是「把符合条件的政策都显示出来」，于是：
      · 选中的地域**全部生效**（以前只取第一个省，第二个省只进标题、不进产出）；
      · **勾省级 = 铺满全层级**：选中的省连同下辖市、区县一并展开（TC-013 口径）；
      · **勾市 / 县 = 只发该节点及其上级链**，不铺下辖 ——
        「只勾某地级市（不展开到县）→ 结果只含该市及上级」（2026-10-16 用户口径）；
      · **下钻过的省分支要收窄**（见 _covered_branches）：
        选了「上海市 + 杨浦区」就只出上海 + 杨浦，不再铺开上海其余 15 个区；
      · 行业 / 类型都不限 → 主题池 = 全部 10 类，每块按满配额产出。
    装填顺序为国家 → 省 → 市 → 区县，总量由 config.SEARCH_RESULT_MAX 封顶
    （越界时区县先被截，权威层级优先保住）。
    """
    found = regions.resolve(req.regions) if req.regions else regions.match_in_text(req.query)
    selected = [n for n in found if n.level >= 1]

    themes = _match_themes(req.industries, req.types)
    ratio = len(themes) / len(_THEMES)

    def quota(level: str) -> int:
        return max(1, round(_LEVEL_QUOTA[level] * ratio))

    blocks: list[dict] = [
        {"level": "nation", "scope": _NATION_SCOPE, "count": quota("nation"), "code": "00"}
    ]

    # 选中节点自身 + 上级链；**只有省级节点**才向下铺满全层级。按区划码去重
    # （同时选了省与省内的市不会算两遍）。
    # **收窄**：省级节点的下辖里已被显式选中的分支，只保留该分支本身及其祖先链 ——
    # 否则「上海市 + 杨浦区」会把上海 16 个区全铺出来（用户实测反馈）。
    branches = _covered_branches(selected)
    has_prov = any(n.level == 1 for n in selected)
    expanded: dict = {}
    for node in selected:
        expanded.setdefault(node.code, node)
        for anc in _ancestors(node):
            expanded.setdefault(anc.code, anc)
        under = branches.get(node.code)
        if node.level == 1:
            # 勾省级 = 铺满全层级（下钻过的分支收窄）
            for child in _descendants(node):
                # child 要留，当且仅当它是某个「被显式选中的后代」本身或它的祖先
                #（u.path 的前缀 == child.path）。反向写会把中间层级（杭州市）也筛掉。
                if under and not any(u.path[: len(child.path)] == child.path for u in under):
                    continue
                expanded.setdefault(child.code, child)
        elif has_prov:
            # 省级也在勾选里（如「浙江省 + 杭州市」）：本节点的下辖照旧铺开 ——
            # 这是 verify_scope_dedup【2】钉死的老口径，别改坏。
            for child in _descendants(node):
                expanded.setdefault(child.code, child)
        # else：市 / 县单独勾选 → 勾谁检谁（+上级链），不铺下辖（2026-10-16 口径）

    for node in sorted(expanded.values(), key=lambda n: (n.level, n.code)):
        level = _LEVEL_BY_DEPTH.get(node.level)
        if level:
            blocks.append({
                "level": level, "scope": _scope_of(node),
                "count": quota(level), "code": node.code,
            })

    # 园区级：只对**显式选中**的区县各出 1 条。市 / 省不再派生园区块 ——
    # 「只勾某市」的口径下，县级粒度不该凭空出现（2026-10-16）。
    for node in selected:
        if node.level != 3:
            continue
        blocks.append({
            "level": "park", "scope": _scope_of(node),
            "count": 1, "code": node.code + "P",
        })

    return blocks, themes


def _issuer(level: str, scope: dict, hint: str, rnd: random.Random) -> str:
    table = _ISSUERS.get(level) or _ISSUERS["county"]
    suffixes = table.get(hint) or table.get(_HINT_INDUSTRY) or ("经济和信息化局",)
    suffix = rnd.choice(suffixes)
    if level == "nation":
        return suffix
    return scope.get(level, scope["county"]) + suffix


def _region_codes(level: str, scope: dict) -> list[str]:
    """层级 → 区划码。与 test_date.js 口径一致：省 2 位 + 市 4 位（+ 县 6 位）。"""
    if level == "nation":
        return [regions.NATION_CODE]
    node = regions.lookup(scope.get("province", ""))
    if level in ("city", "county", "park"):
        node = regions.lookup(scope.get("city", "")) or node
    if level in ("county", "park"):
        node = regions.lookup(scope.get("county", "")) or node
    return node.codes_with_ancestors() if node else [regions.NATION_CODE]


class MockProvider:
    """本地规则抽取引擎。"""

    name = "mock"
    is_remote = False

    def complete(
        self, messages: list[dict[str, str]], **options: object
    ) -> str:
        """纯文本补全。

        本地规则引擎**写不出**像样的综述（它只会按模板铺清单），所以简报服务
        在 provider 非远端时根本不会调到这儿 —— 它直接用 `app/brief.py` 的规则文案。
        这里保留实现只为接口完整：真的被调到，返回一句诚实的说明而不是假装成 AI。
        """
        return "（本地规则引擎不生成综述文案，本简报的综述由规则模板生成。）"

    def parse_query(self, query: str) -> dict:
        """查询理解（本地词表版）。

        与远端 Provider 的 `parse_query()` 同一份契约，只是没有模型参与 ——
        它本身就是流水线里那条**离线兜底**路径（`app/query_parse.py`）。
        实现放在这里是为了让 Provider 端口完整：换 provider 不用改上层。
        """
        return query_parse.parse(query).as_dict()

    def extract(
        self, req: ExtractionRequest, messages: list[dict[str, str]] | None = None
    ) -> ExtractionResult:
        """按「地域 → 层级 → 主题」生成确定性政策清单。"""
        # `req.industries / types / deadline` 传进来的是**本次生效条件**
        # （筛选栏 > 查询理解，见 app/labels.py → resolve_conditions）。
        # 换句话说：用户没有勾筛选栏、但问句里说了「做冬枣销售，想找场地政策」，
        # 这里收到的就是 industries=农业 / types=场地减免 —— 产出真的是他问的那类政策。
        #
        # 留空仍是「不限」：政策名与 industries 字段改用主题自带的行业，
        # 一批结果自然覆盖多个行业 —— 这才是「不限」该有的样子。
        industry = (req.industries or "").strip()
        key = f"{req.query}|{','.join(req.regions)}|{req.industries}|{req.types}"
        blocks, themes = _pick_targets(req)
        budget = max(1, config.SEARCH_RESULT_MAX)

        try:
            today = date.fromisoformat(req.today) if req.today else date.today()
        except ValueError:
            today = date.today()

        # 主题游标全局递增 → 同一批次内相邻政策不撞主题
        cursor = _seed(key) % len(themes)

        policies: list[dict] = []
        for block in blocks:
            if len(policies) >= budget:
                break
            level = block["level"]
            scope = block["scope"]
            for index in range(block["count"]):
                if len(policies) >= budget:
                    break
                # 种子带上地域码：全层级展开后同层级有几十上百个节点，
                # 只用 index 会互相撞种子（同一天的发布日期、同一个置信度）。
                seed = _seed(key, level, block["code"], str(index))
                rnd = random.Random(seed)
                theme = themes[cursor % len(themes)]
                cursor += 1

                region_name = scope.get(level, scope["nation"])
                issuer_name = _issuer(level, scope, theme.hint, rnd)
                portal = "中国政府网" if level == "nation" else f"{region_name}人民政府网"

                publish = today - timedelta(days=rnd.randint(10, 240))
                deadline = today + timedelta(days=rnd.randint(14, 330))

                # 政策名：筛选栏行业优先，其次主题自带行业。**不用模板兜底词** ——
                # 否则「中小微」会和主题名（如「中小微企业贷款贴息」）重复读成「中小微中小微企业贷款贴息」。
                theme_industry = "" if theme.industry == "不限" else theme.industry
                name_word = industry or theme_industry
                # 条款 / 快照模板里必须要有一个具体的行业词才读得通（如「{industry}企业」）
                tpl_word = name_word or "中小微"
                industries_txt = " / ".join([x for x in (industry, theme_industry) if x]) or "不限"

                policies.append({
                    "name": f"《{region_name}{name_word}{theme.core}实施细则》",
                    "issuer": issuer_name,
                    "level": _LEVEL_LABEL[level],
                    "levelKey": level,
                    "types": theme.level_types,
                    "industries": industries_txt,
                    "publish": publish.isoformat(),
                    "valid": "有效",
                    "deadline": deadline.isoformat(),
                    "subsidy": theme.subsidy,
                    "conditions": list(theme.conditions),
                    "conditionsFull": [
                        tpl.format(region=region_name, industry=tpl_word)
                        for tpl in theme.conditions_full
                    ],
                    "materials": list(theme.materials),
                    "sources": [
                        {"name": f"{issuer_name}官网", "kind": "原文链接",
                         "url": _REAL_SOURCE_URLS.get(theme.core, _FALLBACK_URL)},
                        {"name": portal, "kind": "转载页",
                         "url": _REPOST_URLS.get(theme.core,
                                                 _REAL_SOURCE_URLS.get(theme.core, _FALLBACK_URL))},
                    ],
                    "snapshot": theme.snapshot.format(region=region_name, industry=tpl_word),
                    # 这里**不再生成 confidence**：改造前是 round(rnd.uniform(0.72, 0.96), 2)
                    # —— 纯随机数，和「原文里到底有没有这句话」毫无关系，却会被前端
                    # 印成「⚠ 待核验 · 置信度 0.72」给用户看。
                    # 现在置信度由 wrap.build() → app/ground.py 逐条回原文定位后算出。
                    "regionCodes": _region_codes(level, scope),
                })

        return ExtractionResult(
            provider=self.name,
            # 条件标签（那四行）**不由抽取层拼**：唯一口径是 app/labels.py → resolve_conditions()，
            # 由 search.py 在流水线里算一次、同时交给三处（检索屏四行、页头标题、落库）。
            # 抽取层再拼一套就会出现「抽取引擎说 A、面板说 B」的老问题。
            parsed=[],
            policies=policies,
            raw="(本地规则引擎生成，未调用远端模型)",
            degraded=False,
        )
