# AI 政策搜索智能体 · 本地后端

对应《后端架构设计方案 v1.0》的演进实现：

> **基础层**：后端按前端契约把 `test_date.js` 的数据经 `GET /api/bootstrap` 返回，
> 并同源托管前端 `dev.html`。前端**收到数据后才渲染**（`DATA.load()` 成功 → `boot()`）。
>
> **检索链路**：点「开始检索」→ 后端把用户条件（查询词 + 地域 + 行业/类型/截止）
> 组装成提示词 → 交给大模型 → 把模型返回**包装成与 `test_date.js` 同构的命名空间**
> 回传 → 前端回填并跳结果列表。检索是**后台任务**：切到别的屏不会中断，
> 跑完后若用户已经离开检索屏，就在右下角弹通知，而不是把他拽回结果列表。
>
> **账号与持久化（MySQL）**：注册写入 `users`；登录签发 Bearer Token（`sessions` 存摘要）；
> 每次检索的条件与结果写入 `search_records`。**登录后再次打开应用，直接回放上次结果，
> 不必重复检索**。打开应用有一道**闸门**：必须先登录，或点「以游客身份继续」，才能进入首页等界面。

技术栈：Python 3.12+ / FastAPI / Uvicorn / PyMySQL（与方案 D2 一致）。

---

## 目录结构

```
deliverables/backend/
├── app/
│   ├── config.py            # 路径与运行配置（全部可用环境变量覆盖，含零依赖 .env 解析）
│   ├── jsconvert.py         # test_date.js → JSON 转换（借本机 node 求值）
│   ├── bootstrap.py         # 数据提供者：加载/缓存 bootstrap 数据
│   ├── regions.py           # 行政区划索引（省/市/区县/园区，含「杭州」→「杭州市」短名解析）
│   ├── labels.py            # ★ 「已解析出条件」四行文案的唯一口径（先解析 · 再检索 · 逐项标来源）
│   ├── query_parse.py       # ★ 查询理解：把自然语言问句读成 行业 / 类型 / 时间（本地词表 + 大模型叠加）
│   ├── sources.py           # 内置政策源注册表（~40 个，按地域层级挑选）
│   ├── search.py            # 检索服务：异步任务 + 6 步流水线 + 结果落库
│   ├── chat.py              # ★ 政策对话服务：意图识别 + 真实字段引用 + 落库（右栏「问政策」面板）
│   ├── wrap.py              # 结果包装层：模型输出 → 命名空间（补全前端渲染硬约束字段）
│   ├── schema.sql           # ★ MySQL 建表脚本（users / sessions / search_records / chat_messages）
│   ├── db.py                # ★ MySQL 接入层：连接池 + 自动建库建表 + 查询封装
│   ├── security.py          # ★ 密码 PBKDF2-HMAC-SHA256 哈希 + 会话 Token 原语
│   ├── repo.py              # ★ 数据仓储：用户 / 会话 / 检索记录的读写
│   ├── accounts.py          # ★ 账号域服务：注册/登录/登出 + Bearer Token 鉴权依赖
│   ├── llm/
│   │   ├── base.py          # LLMProvider 端口（Protocol）+ 请求/结果数据类
│   │   ├── prompts.py       # 提示词组装（注入服务端日期/行政区划，模型无法臆造）
│   │   ├── mock.py          # 本地免费规则引擎（离线、确定性，默认提供者）
│   │   └── openai_compat.py # OpenAI 兼容客户端（智谱 GLM-4-Flash 等免费模型）
│   ├── main.py              # FastAPI 应用：API + 静态托管
│   ├── netutil.py           # 端口/服务探测（是否已在运行、找空闲端口）
│   └── data/
│       └── bootstrap.json   # 后端数据源（由 test_date.js 转换而来）
├── tools/
│   ├── convert_test_data.py      # 生成 bootstrap.json
│   ├── probe.py                  # 命令行版端口探测（服务是否已在运行 / 找空闲端口）
│   ├── check_db.py               # ★ MySQL 就绪探测（start_server.bat 第 3 步调用，只读）
│   ├── verify_labels.py          # ★ 「已解析出条件」+ 页头标题口径自检（纯本地、毫秒级、不调模型）
│   ├── verify_contract.mjs       # 前端契约联调验证（无需浏览器）
│   ├── verify_search_flow.mjs    # 检索链路端到端契约校验（POST→轮询→结果）
│   ├── verify_search_browser.mjs # 检索链路真实浏览器验证（系统 Edge，产出截图）
│   ├── verify_auth.mjs           # ★ 账号 + 检索记录契约校验（无需浏览器）
│   ├── verify_auth_browser.mjs   # ★ 注册/登录/历史回放 真实浏览器验证（产出截图）
│   ├── verify_home_filters.mjs   # ★ 首页四维筛选 / 游客出口 / 登录记忆（真实浏览器，产出截图）
│   ├── verify_input_ime.mjs      # ★ 全部输入框的输入行为（一次按键=一个字符 · 中英文上屏 · 地域只读回显）
│   ├── verify_list_tools.mjs     # ★ 结果列表工具条（排序真的重排 · 卡片↔表格 真的换渲染 ·「重置」已移除）
│   ├── verify_region_expand.mjs  # ★ 地域全层级产出 / 层级配额（各省·市·区县真被铺开，末页不空）
│   ├── verify_detail_chat.mjs    # ★ 详情页「看得懂 + 问得到」：自查清单 / 申报流程入口 / 快照弹层 / AI 对话 + 落库
│   ├── verify_brief_flow.mjs     # ★ 简报生成与下载契约（三格式）
│   ├── verify_brief_browser.mjs  # ★ 简报真实下载 + 空态（真实浏览器）
│   ├── verify_brief_timeout.py   # ★ 综述硬超时 + 降级（本地假模型端点，不需要联网）
│   ├── verify_scope_dedup.py     # ★ 地域收窄（下钻后不铺开兄弟区县）+ 同名去重（纯本地秒级）
│   ├── verify_grounding.py       # ★ 原文定位：偏移可回溯 / 证据强度打分 / 未命中降分
│   └── verify_catalog_expand.py  # ★ 清单补全：远端模型只出几条时用本地引擎铺满
├── start_server.bat         # Windows 双击启动
├── run.py                   # 本地启动入口（端口占用自动顺延、--open 自动开浏览器）
├── .env.example             # 配置模板（含 MySQL 段落）
└── requirements.txt
```

---

## 一键启动（Windows 推荐）

**双击 `start_server.bat`** 即可，脚本自动完成五步：

```
[1/5] 定位 Python   → 优先项目内 .venv，其次系统 python / py
[2/5] 检查依赖      → 缺失时自动创建 .venv 并安装 fastapi / uvicorn / pymysql
[3/5] 探测 MySQL    → 只读探测账号与检索记录所需数据库，连不上只提示、不阻断
[4/5] 检查数据      → bootstrap.json 不存在时自动从 test_date.js 生成
[5/5] 启动服务      → 2 秒后自动打开浏览器
```

常见情况都已处理：

| 情况 | 脚本行为 |
|---|---|
| 服务已在运行 | **不重复启动**，直接打开页面（退出码 7，避免端口冲突报错） |
| 8000 被其它程序占用 | 自动顺延 8001 / 8002…，并在窗口提示实际地址 |
| **MySQL 未启动 / 配置不对** | 显示 `[3/5] MySQL : 未连接（…）` 并列出三条排查建议；**服务照常启动**，自动以游客模式运行（检索 / 简报 / 导出可用，账号与「检索记录」暂不可用） |
| `DB_ENABLED=0` | 显示「已停用」，跳过账号体系，检索主链路照常 |
| 没装 Python / Node | 给出明确提示并停住窗口，不会一闪而过 |
| 本机配置了 http_proxy | 自动为 localhost 设置 `NO_PROXY`，避免探测被代理拦截 |

> 第 [3/5] 步由 `tools/check_db.py` 完成（只读探测，可单独运行：
> `python tools/check_db.py`；退出码 `0`=已连接、`3`=未连接、`4`=已停用）。
> 它按 `backend/.env` 的 `DB_*` 配置连接，并顺带完成「建库 + 建表（IF NOT EXISTS）」，
> 因此第一次启动即可把表准备好。

**停止服务**：在脚本窗口按 `Ctrl+C`。

---

## 手动启动（命令行）

```bash
cd deliverables/backend

# 1) 安装依赖（建议虚拟环境）
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt      # Windows
# source .venv/bin/activate && pip install -r requirements.txt   # macOS/Linux

# 2) 生成后端数据（把 test_date.js 转成 bootstrap.json，需本机 node）
python tools/convert_test_data.py

# 3) 启动
python run.py
```

浏览器打开 **http://127.0.0.1:8000/** 即可看到前端页面。
（首次启动时若 `test_date.js` 比 `bootstrap.json` 新且本机有 node，会自动重新生成。）

可选自检：

```bash
python -m uvicorn app.main:app --port 8000   # 另开一个终端起服务

node tools/verify_contract.mjs               # ① 前端能消费 GET /api/bootstrap（12 项）
node tools/verify_search_flow.mjs            # ② 检索链路端到端契约校验（POST→轮询→结果，逐字段断言，60 项）
node tools/verify_search_browser.mjs         # ③ 真实浏览器跑完整「开始检索」流程，含「切屏后台继续 + 完成弹窗」、分页口径、页头标题与条件摘要（71 项；对 mock 实例跑时另有 3 项按设计失败，见下）
node tools/verify_auth.mjs                   # ④ 账号 + 检索记录契约（注册→登录→落库→历史→隔离，72 项断言）
node tools/verify_auth_browser.mjs           # ⑤ 真实浏览器跑注册/登录/历史回放（61 项断言，产出截图）
node tools/verify_home_filters.mjs           # ⑥ 首页四维精确筛选（同构控件 / 选中全省 / 游客出口）+ 蓝条已移除 + 登录「记住但会过期」（120 项断言）
node tools/verify_input_ime.mjs              # ⑦ 全部输入框的输入行为 + 结果列表地域只读 + 筛选面板滚动位置保持（64 项断言）
node tools/verify_list_tools.mjs             # ⑧ 结果列表工具条：排序真的重排 / 卡片↔表格 真的换渲染 / 分页真的换内容 / 对比真的并排比对 /「重置」已删（69 项断言，产出 6 张截图）
node tools/verify_region_expand.mjs          # ⑨ 地域全层级产出与层级配额 + 下钻后不铺开兄弟区县（23 项断言）
node tools/verify_detail_chat.mjs            # ⑩ 详情页：申报条件逐条自查 / 申报流程与入口 / 整页滚动+sticky 对话面板 / 右栏 AI 对话（游客不落库 · 登录落库回读 · 清空作废在飞那一问 · 「对话记录」页签聚合卡片）（81 项断言，产出 6 张截图）
node tools/verify_brief_flow.mjs             # ⑪ 简报生成·下载·清空契约（三格式，71 项断言）
node tools/verify_brief_browser.mjs          # ⑫ 真实浏览器点「导出」真下载 + 未勾选时的空态（44 项断言）
python tools/verify_labels.py                # ⑬ 「已解析出条件」+ 结果列表页头标题口径：先解析再检索 · 筛选栏优先 · 逐项标来源 · 与首页四维同构（81 项断言，纯本地毫秒级）
python tools/verify_brief_timeout.py         # ⑭ 综述硬超时 + 降级（自建假模型端点，不需联网，约 12s）
python tools/verify_catalog_expand.py        # ⑮ 清单补全：远端模型只出 3 条时本地引擎铺满到 342 条（进程内锁定 Provider，不需环境变量）
python tools/verify_llm_config.py            # ⑯ 按用途分模型：缺省继承 / 按用途覆盖 / 非法值回落 / 思考开关下发规则 / 空正文自愈 / status 形状（24 项断言，纯本地毫秒级）
python tools/verify_scope_dedup.py           # ⑰ 地域收窄（下钻到区县后不再铺开兄弟区县）+ 同名去重（33 项断言，纯本地秒级）
python tools/probe_models.py [模型名…]       # ⑱ 模型选型探针：同一把 Key 横测候选模型的延迟与输出（联网，占免费额度）
```

> ③ 的最后 3 项断言（`LLM_PROVIDER` 已配置 / 用的是远端真实模型 / 模型属智谱 GLM 系）
> 在 `LLM_PROVIDER=mock` 的实例上**按设计失败** —— 那台服务的提供方真的是本地规则引擎，
> 断言如实报了 `mock` / `本地规则引擎`，不是回归。要它们转绿得对着真配了 Key 的实例跑。
> ③ 另有 3 条「四用途各自报出模型」的断言：顶层 `model` 必须等于 `purposes` 里 extract 那份。
>
> **③ 的一个竞态（2026-10-14 暴露并修掉）**：`#pipeBar` 是 `width:0%` 的 `<i>`，而
> `pct = total ? from/total*100 : 0` —— 第 0 步（查询理解）期间 `total` 还没拿到，
> 进度条宽度恒为 0%，Playwright 判定为 **hidden**。闸门原来用
> `waitForSelector('#pipeBar')`（默认 `state: visible`）等它，属于「解析够快才碰巧能过」：
> `glm-4-flash` 解析 ~1.3s 时一直没暴露，换成 `glm-4.5-flash` 后解析实测 **4.6~7.1s**，
> 10s 窗口就顶不住了。现在改为 `state: 'attached'`（断言本意就是「已进入检索屏」），
> 并新增「先等 `SEARCH_STATE.pct > 0`（解析结束、crawl 拿到 total）再采样」的等待，
> 让后面「进度条宽度在推进」那条断言量的是**真实推进**而不是解析期的恒 0。
>
> **③ 【11】的第二个坑（同批修掉）**：那一节会**再发起一次检索**（筛选栏福建省 + 问句杭州）
> 然后比对两屏标题，但等待窗只给了 36s（`120 × 300ms`）—— 真实模型一次检索要 2~6 分钟，
> 窗口一耗尽就往下走，比的是**上一次检索**留在列表屏的旧页头（旧问句里的「杭州」），
> 报错文案看着像「筛选栏地域被查询推翻」，实际是闸门自己太急（mock 秒回所以只在真模型实例上暴露）。
> 现在按前端 `search.json→timeoutMs` 同口径等 420s，**并要求真的等到 `running=false`**；
> 另加一步「等 `DATA.list.head.title` 变成福建省」（hydrate 是异步的），等不到仍会判失败。
> ⑩ 对 mock 与真配了 Key 的实例**都应全绿**：它接受「大模型回答 / 规则回答」两种来源标签。

其中 ③ ⑤ ⑥ ⑦ ⑧ 依赖 Playwright 与系统 Edge；Playwright 装在 WorkBuddy 独立工作区（不污染项目）：

```bash
cd <node-workspace> && npm install playwright     # 首次
node tools/verify_search_browser.mjs              # 截图输出到 backend/_shots/
node tools/verify_auth_browser.mjs                # 截图输出到 backend/_shots/
node tools/verify_input_ime.mjs                   # 截图输出到 backend/_shots/
node tools/verify_list_tools.mjs                  # 截图输出到 backend/_shots/
# ⑦ 也可直接对着单文件版跑（file://，此时跳过需要后端的「检索记录搜索框」一节）：
node tools/verify_input_ime.mjs "D:/.../gui-prototype/ai-policy-agent-prototype.html"
```

> ④ 会在独立的 `ai_policy_verify` 库上运行（自动建库建表、跑完即清），不会污染正式的
> `ai_policy` 库；建议搭配 `LLM_PROVIDER=mock` 起一个隔离端口的服务再跑，避免等真实模型。
>
> **② ③ ⑤ 也建议对 mock 实例跑**：`.env` 默认是 `LLM_PROVIDER=auto`，会真的调云端模型
> （glm-4-flash 一次完整抽取约 120s，免费档还容易限流）。对真模型跑时最容易出现的假失败是
> 「任务一直 `running` / 结果为空」—— 那是模型没返回，不是链路坏了。一条命令起隔离实例：
> ```bash
> LLM_PROVIDER=mock DB_NAME=ai_policy_verify .venv/Scripts/python run.py --port 8010
> node tools/verify_search_flow.mjs http://127.0.0.1:8010     # 5s 内跑完
> node tools/verify_auth.mjs       http://127.0.0.1:8010     # 67 项
> ```
> （`LLM_PROVIDER=mock` 时 ③ 的「模型接入状态」三节会按设计失败，那是环境断言，不是回归。）

前端侧另有 4 个自检脚本（在 `gui-prototype/` 下运行，无需浏览器）：

```bash
node build/data_test.js      # 数据文件可解析、真假数据分离（12 个 UI 文件 + 10 个后端命名空间）+ 筛选控件文案守卫
node build/copy_test.js      # 247 项文案金标（覆盖 11 个屏幕 + 结果列表的表格 / 末页 / 对比三种形态 + 「对话记录」页签）
node build/cascade_test.js   # 地域级联语义（31 项断言：每级独立勾选 · 无自动携带 · 无半选态）
node build/devload_test.js   # 多文件装载与渲染（11 个屏幕）+ 四维筛选控件同构性 / 选中全省矩阵 / 缺文案缺字段不崩 + 列表排序 / 卡片↔表格 / 分页（含「结果集变小后口径跟着缩」的回归）/ 对比（137 项断言）
```

前端还有一个**首屏闸门 + 导航入口**的真实浏览器验证（需系统 Edge；**在 `gui-prototype/` 下运行**）：

```bash
node build/auth_landing_test.mjs http://127.0.0.1:8000     # 40 项断言
# A 后端在线 + 无凭证 → 首屏必为「登录 / 注册」，#list 深链也被拦；游客出口可进首页，刷新不再拦
#   另验：顶部原型索引条已移除、左下角工具浮层已整块删除、导航固定 5 项且都能真跳过去、
#         已删除的四屏（任务监控 / 订阅提醒 / 异常降级 / 地域多选）没有回流、5 项在 1440 画布内不溢出
# B 离线单文件（把 API 基地址显式指到 127.0.0.1:9，确定性地造出「无后端」）→ 仍是登录闸门，
#   但给出离线横幅 + 游客出口（不会卡死）
```

> B 的「离线」是**造出来的**，不靠「本机碰巧没起后端」—— 单文件版同样走
> `data.js → resolveApiBase()` 回落到 `http://127.0.0.1:8000`，本机日常就是 8000 + 8010 双实例在跑，
> 不显式改基地址的话「离线」前提根本不成立（原来就是这么假通过的）。

---

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/bootstrap` | **前端装载入口**，返回与 `test_date.js` 的 `window.TEST_DATA` 同构的 **7 个命名空间**：`stats · policies · regions · search · list · detail · brief` |
| GET | `/api/bootstrap/namespaces` | 列出命名空间（自检用） |
| POST | `/api/v1/searches` | **发起检索**（异步，立即返回 202 + `taskId`） |
| GET | `/api/v1/searches/{id}` | **轮询进度**（步骤 / 源进度 / 抓取日志 / 已解析条件） |
| GET | `/api/v1/searches/{id}/result` | **取结果**（包装成命名空间的增量补丁） |
| DELETE | `/api/v1/searches/{id}` | 取消检索 |
| GET | `/api/v1/searches` | 任务统计（运行中 / 成功 / 失败 / 取消） |
| GET | `/api/v1/llm/status` | 当前抽取引擎（本地免费规则引擎 / 云端免费模型） |
| GET | `/api/v1/prompts/preview` | 查看服务端整合出的提示词（含行政区划上下文） |
| **POST** | **`/api/v1/auth/register`** | **注册**（写 MySQL `users`，成功即下发 Token） |
| **POST** | **`/api/v1/auth/login`** | **登录**（签发 Bearer Token，`sessions` 存摘要） |
| **POST** | **`/api/v1/auth/logout`** | **登出**（会话行立即删除） |
| **GET** | **`/api/v1/auth/me`** | **当前用户 + 我的统计 + 最近一次检索**（供首屏回放） |
| **PATCH** | **`/api/v1/auth/profile`** | **更新企业档案**（填一次即长期生效） |
| **GET** | **`/api/v1/history`** | **我的检索记录列表**（轻量，不含结果体） |
| **GET** | **`/api/v1/history/{id}`** | **单条记录 + 结果回放**（返回 `bootstrap`） |
| **DELETE** | **`/api/v1/history/{id}`** | 删除单条记录 |
| **DELETE** | **`/api/v1/history`** | 清空我的记录 |
| **GET** | **`/api/v1/chat/status`** | **对话能力状态**（是否启用 / 引擎 / 硬超时 / 上下文轮数 / 每题保留条数） |
| **GET** | **`/api/v1/chat/messages?policyId=`** | **读回某条政策的历史对话**（详情页对话面板用） |
| **GET** | **`/api/v1/chat/messages`** | **按政策聚合的会话列表**（不带 policyId；检索记录屏「对话记录」页签用，每条含政策名快照 / 问答条数 / 最后一句预览） |
| **POST** | **`/api/v1/chat/messages`** | **提问**（`{policyId, question, policy?}`；游客可问但不落库，登录才写 `chat_messages`） |
| **DELETE** | **`/api/v1/chat/messages?policyId=`** | **清空某条政策的对话**（需登录；游客前端本地清） |
| **GET** | **`/api/v1/db/status`** | 数据库接入状态（诊断用） |
| GET | `/healthz` | 存活探针 |
| GET | `/readyz` | 就绪探针（bootstrap 数据是否可用） |
| GET | `/` | 前端页面 `dev.html` |
| GET | `/src/*`、`/data/*`、`/test_date.js` | 前端静态资源 |
| GET | `/docs` | FastAPI 自动接口文档 |

所有错误统一为 `{"error": {"code": "...", "message": "..."}}`（前端 `DATA.request()` 依赖该形状）。

`/api/bootstrap` 返回的顶层键（**不得改动**）：
`stats · policies · regions · search · list · detail · brief · degrade · tasks · subscribe`

---

## 账号体系与检索记录（MySQL）

### 表结构（`app/schema.sql`）

服务启动时自动执行 **建库 + 建表**（`CREATE DATABASE/TABLE IF NOT EXISTS`，可重复运行）：

| 表 | 作用 | 关键字段 |
|---|---|---|
| `users` | 注册用户 + 企业档案（用户只需要填一次） | `username`(唯一) / `password_hash` / `company` / `industry` / `region_code` |
| `sessions` | 登录会话 | `token_hash`(主键) / `user_id` / `expires_at` / `last_seen_at` |
| `search_records` | 每次检索的条件 + 结果快照 | `user_id` / `task_id`(唯一) / `query` / `regions_json` / `item_count` / `result_json` |
| `chat_messages` | 政策详情页「问政策」的一问一答 | `user_id` / `policy_id` / `role`(`user`/`assistant`) / `content` / `provider` / `degraded` / `elapsed_ms`；索引 `idx_chat_user_policy(user_id, policy_id, id)` |

### 三条安全约定

1. **密码绝不落明文**：`pbkdf2_sha256$迭代次数$盐$哈希`（`hashlib.pbkdf2_hmac`，26 万次迭代，
   每用户独立随机盐）。迭代次数升级时，用户下次登录会**透明重哈希**，无感升级。
2. **Token 只存摘要**：登录签发 `secrets.token_urlsafe(32)`（256 bit），库里只写其 **SHA-256 摘要**；
   即使数据库被拖走也无法反推出可用凭证。登出 = 删除该行，立即失效。
3. **数据按 `user_id` 隔离**：查询历史记录一律带 `AND user_id = %s`，
   他人记录号一律返回 404（不泄露存在性）。

### 「填一次就够了」是怎么实现的

```
注册 / 登录  ──►  签发 Token（浏览器存 localStorage，请求头 Authorization: Bearer …）
                      │
「开始检索」  ──►  POST /api/v1/searches（带 Token）
                      │  任务结束后 search.py::_persist() 把
                      │  「条件 + 结果命名空间」写入 search_records
                      ▼
下次打开应用  ──►  GET /api/v1/auth/me        → 用户 + 统计 + latest（最近一条记录）
                  GET /api/v1/history/{id}    → 结果快照
                      │
                      ▼
               DATA.hydrateBackend(bootstrap) → 直接落到结果列表，**不发起任何检索**
```

- **游客模式**：不带 Token 一切照常（检索、简报、导出可用），只是不落库（`signedIn=false`、`recordId=null`）。
- **前端降级**：后端不可达 / MySQL 未就绪时，账号屏显示「数据库未连接，账号功能暂不可用」，
  应用自动以游客身份继续，主链路不受影响。
- **记录上限**：单账号默认保留最近 200 条（`HISTORY_KEEP_PER_USER`），超出自动淘汰最旧记录。

### 首屏闸门（必须登录或以游客身份进入）

```
打开应用
   │
   ├─ 闸门未开（本地无凭证，且本次会话没选过游客身份）
   │     └─► 一律停在「登录 / 注册」页 —— #list 之类的深链也不放行
   │            · 登录（或注册即自动登录） ──► 首页（库里有历史则直接落结果列表）
   │            · 「暂不登录，继续以游客身份使用」──► 首页（闸门放开，检索链路照常）
   │
   └─ 闸门已开
         ├─ URL 带 #hash（如 #list） ──► 尊重深链，直接渲染该屏
         └─ 否则                    ──► 首页（有历史记录则直接落结果列表）
```

- 闸门判断集中在 `AUTH.gateOpen()`（`AUTH.authed() || AUTH.guest()`），
  由两处统一执行：`boot()` 决定首屏、`go()` 拦截一切跳转（顶栏导航、键盘左右键、屏内按钮）。
- 游客身份存在 **`sessionStorage`**（`policy_agent_guest`）：所以**同一标签页刷新不会被反复拦**，
  而重新打开一个标签页/窗口会再问一次 —— 对应「打开应用之后必须要登录或游客登录」。
  `sessionStorage` 不可用（隐私模式等）时退化为内存标记，逻辑不变。
- 「退出登录」会**连带撤销游客身份**（`AUTH.dropGuest()`），退登后回到闸门重新二选一，
  不会出现「退登后悄悄变成游客继续用」的模糊状态。
- 账号服务不可用时闸门**依然在**，但登录卡上会给出横幅（`states.offlineTitle` / `states.networkTitle`，
  区分「MySQL 没起」与「后端没跑」）并直接把游客出口摆在横幅里，不会把人卡在门口。
- 闸门未开时**产品顶栏导航整体置灰**（`topBar()` 按 `AUTH.gateOpen()` 给 9 个导航按钮加
  `disabled` + `title` 提示，连「异常降级」的入口胶囊也摘掉 `data-to`），
  避免出现「点了没反应」的假死感。账号区不停用 —— 它就是登录入口。
- **退出游客身份的入口提前（PRD Q10）**：以前只有翻到登录页才能退出游客态，现在两处都在——
  ① 顶栏账号区常驻「**游客 · 未保存**」胶囊（`.tb-guest` 包 `.tb-user.guest`），右侧紧跟一个
  一步「**退出**」按钮（`[data-auth-drop-guest]`）；② 登录 / 注册页顶部一条 `.banner.info`
  也放同义的「退出游客身份」按钮。两条路都走 `AUTH.dropGuest()` + 清 `sessionStorage` + 回闸门，
  并弹 `auth.toast.guestLeft` 说明「条件与结果不会保存到数据库」。
  **刻意没做**「把游客按钮做大 / 抢默认焦点」那类强导流 —— 首屏仍是「登录 / 以游客身份继续」等权二选一，
  避免破坏「零门槛」的口径统一。

### 登录凭证：记住一次，但会过期

「登录一次就别再让我登」和「别一直记着」是同一件事的两面，落地口径是**记住 + 到期自动失效**：

- **存什么**：`localStorage.policy_agent_token` 放一段 JSON —— `{ "t": <token>, "at": <签发时间戳>, "d": <有效期天数> }`。
  旧的「只存纯 token 字符串」仍能读，只是签发时间未知（`at = 0`），此时前端不做过期判定，交给服务端会话状态裁决。
- **记多久**：`d` 取自服务端登录响应里的 `ttlDays`（即 `AUTH_TOKEN_TTL_DAYS`，**默认 7 天**；
  前端 `AUTH.ttlDays` 只是服务端没说时的兜底）。两端口径要一致 —— 只改一边会出现
  「前端还以为在登录态、后端已经 401」或反过来的空窗。
- **怎么判**：`AUTH.stale()` 比较 `now - at` 与 `d`。到点后 `AUTH.authed()` 直接 `forget()` 并置
  `AUTH.expired = true`，**不必等服务端 401**；启动时 `bootstrap()` 先判一次（首屏即闸门 + 一条
  「为什么又要登录」的提示），页面挂着不刷新时由 `focus` 监听补判一次。
- **提示文案**：`data/auth.json → toast.expired`（启动 / 回到页面时弹）、`rememberNote`（登录卡上常驻说明）、
  `account.sessionNote` + `account.sessionExpire`（账号区显示「保留 N 天 · 有效期至 YYYY-MM-DD」）。
- 「退出登录」照旧立即失效（`forget()` 会清掉整条记录，`issuedAt` 归零）。

### 启动链路：失败必须是可诊断的

启动链是 `数据装载 → 登录会话恢复 → 首屏渲染` 三段（`app.js` 末尾）：

```js
let BOOT_STAGE = 'load';
DATA.load()                                   // ① data/*.json 或 GET /api/bootstrap
  .then(() => { BOOT_STAGE = 'auth'; return AUTH.bootstrap(); })   // ② /api/v1/auth/me + 历史回放
  .then(() => { BOOT_STAGE = 'render'; boot(); })                  // ③ 渲染首屏
  .catch((err) => showBootError(err, BOOT_STAGE));
```

**为什么要专门写这一节**：这条链上**任何一步抛错**，用户看到的都只是一页
「数据加载失败：&lt;原始 message&gt;」，既不知道是哪一步，也不知道该改哪个文件 ——
一句 `Cannot read properties of undefined (reading 'slice')` 排查起来极其费劲。

现在 `showBootError()` 会额外打印三段信息（文案在 `data/app.json → shell`）：

```
数据加载失败：Cannot read properties of undefined (reading 'slice')

【失败阶段】首屏渲染
【调用栈（前 8 行）】
Error: Cannot read properties of undefined (reading 'slice')
    at authChip (screens-d.js:294)
    ...

怎么打开这个原型：① 单文件版双击即可；② dev.html 需在 gui-prototype 目录起 HTTP；
③ 起了本地后端就直接开 http://127.0.0.1:8000/
```

> **提示文案本身也修过一次**：原来写「在**项目目录**执行 `python -m http.server 8000`，
> 然后打开 `/dev.html`」—— 在项目根起服务的话 `/dev.html` 是 404。必须说明是
> **`gui-prototype` 目录**才是静态根；同时补上「起了本地后端就开 `http://127.0.0.1:8000/`，
> 前端与接口同源、不必另起服务」。

### ★ 渲染层不得因「缺一句文案 / 缺一个字段」而崩

上面那条 `slice` 报错的**根因**是：渲染函数直接链式读数据 + `.slice`，
只要某一项是 `undefined` 就抛 TypeError，进而把整个 boot 干掉。踩到的几个点：

| 位置 | 原来的写法 | 风险场景 | 现在的写法 |
|---|---|---|---|
| `screens-d.js::AUTH.name()` | `AUTH.user.displayName \|\| AUTH.user.username` | 服务端 `user` 只回了 `{}`（字段缺失 / 命名不符）→ 返回 `undefined` | 补 `\|\| ''`；另加 `AUTH.initial()` 统一取头像首字 |
| `screens-d.js::authChip()` | `nm.slice(0,1)` / `G.badge.slice(0,1)`；`const G = ... \|\| {}` | 游客态但 `auth.json` 没有 `guest` 段（旧数据 / 缓存旧版）→ `G.badge` 是 `undefined` | `const gBadge = G.badge \|\| '游客'`，每个键都带兜底 |
| `screens-c.js::renderRegion()` | `R.rules.items.map(...)` / `d.chips.slice(...)` | 缺 `rules` / 缺 `demoStates[].chips` | `((R.rules && R.rules.items) \|\| [])`、`const chips = d.chips \|\| []` |
| `screens-b.js` 快照高亮 | `hl.slice(...)` | `hl` 缺失 | `(hl \|\| '').slice(...)` |
| `screens-a.js` 检索日志 | `S.logs.forEach/slice` | `search.logs` 缺失 | `(S.logs \|\| [])` |

**原则**：姓名、标签、日志这类**纯展示信息**，缺了就退化成占位文案或空串，
绝不该让它拖垮首屏。真正的数据契约问题交给 `build/data_test.js` 在构建期拦。

对应的回归断言（`build/devload_test.js`，无需浏览器，共 11 项）：
已登录但 `user` 缺字段 / 游客态但缺 `guest` 文案 / `guest` 只有部分键 / `triggerTags(undefined)` /
`filterTrigger` 缺 `items` / 缺 `none` / 标签超 `max` 折叠 / 地域页 `demoStates` 缺 `chips` ——
全部要求**不抛错**且给出可用降级结果。
`build/data_test.js` 另加守卫：`shell.loadError / loadHint / loadStage / loadStack / loadStages.*`
必须齐全（缺了就没有诊断信息可用）。

### 四维筛选控件同构（地域 / 行业 / 类型 / 截止时间）

首页「条件精确筛选」的四个维度**共用同一套控件**——同一份模板函数 + 同一份 CSS 骨架，
所以以后改一处样式，四个维度同时生效，不会出现「地区长得不一样」。

```
触发器（.trigger）                          浮层面板（.fpanel）
┌─────────────────────────────────┐          ┌──────────────────────────────────────┐
│ 地域： 浙江省 ×  +2      清空 ▾ │ ─ 点击 ─►│ 行业 · 可多选    [全选]              │  ← .fpanel-head-top
└─────────────────────────────────┘          │ 搜索行业名称…                        │  ← .fp-search
   · 多选维度展示标签（超出折叠 +N）          │ 勾选即改草稿，点「确定」才生效        │  ← .fp-hint
   · 点标签里的 × 单条删除                    ├──────────────────────────────────────┤
   · 点「清空」一键清空该维度                 │ ☑ 智能硬件   ☐ 新能源 …              │  ← .frow[data-opt-val]
   · 点空白处展开面板                         ├──────────────────────────────────────┤
                                             │ 已选 2 项：智能硬件 / 软件信息       │  ← .sum
                                             │              [清空]     [确定（2）]  │  ← .fpanel-foot
                                             └──────────────────────────────────────┘
```

- **一套模板**：`screens-a.js::filterTrigger(o)` 渲染触发器，`optPanelHTML(group)` 渲染选项面板；
  地域面板（`screens-c.js::cascPanelHTML()`）也改用同一个 `.fpanel` 骨架，只是 `fpanel-body`
  内部换成三列级联（`flex-direction: row` + `.casc-col`）。
- **草稿 / 生效分离**：面板里怎么勾都只改 `FILTER_STATE.draft`，点「确定」才 `applied = new Set(draft)`
  并重渲染触发器；面板内还会实时算 `.sum`（`已选 n 项：…`）与按钮上的计数 `确定（n）`。
- **多选 vs 单选**：行业 / 类型 / 地域是**多选**（面板内有「全选」+ 搜索框）；截止时间是**单选**
  （点一行即替换，无「全选」，也无搜索框）。由 `FILTER_STATE.isSingle(group)` 一处判定。
- **空即「不限」**：某个维度一条都没勾时，触发器上显示占位词 `filterLabels.none`（「不限」），
  而不是显示空白 —— 后端点「开始检索」时该维度就是「不限」。
- **面板内的搜索是草稿，不是筛选结果**：`FILTER_STATE.q[group]` 只影响 `visible()`（哪些行显示），
  「全选」也只作用于**当前可见的行**（`toggleAll()` 遍历 `visible()`），所以在搜索态下点全选
  不会误勾到被过滤掉的行。
- **文案唯一来源**：面板公共文案（面板提示语 / 清空 / 确定 / 不限 / 全选 / 取消全选 / 无匹配）
  统一放 `data/app.json → filterLabels`。以前 `home.json → filter.panel` 与 `region.json → panel`
  各写了一份，改口径时必然漏改一处 —— `build/data_test.js` 现在有守卫，
  这两个文件里**再出现** `hint/clear/ok/none` 就直接报错。

> **踩坑记录（都是"读代码看不出来、渲染出来才现形"的）**
>
> 1. **触发器内部不能整块当删除区**。最早 `triggerTags()` 把 `data-fdrop` 挂在整个 `.tag` 上，
>    结果「点触发器中间」= 删条件，而不是展开面板；`[data-fdrop]` 分支先于 `[data-opt-trigger]`
>    分支命中，导致**没有空白的「截止时间」根本打不开面板**。
>    修法：`data-fdrop` 只挂到 `<i class="x">` 上，标签本体落回触发器分支；`+N` 折叠块改为纯展示。
> 2. **浮层的 z-index 要显式分级**。触发器抬到遮罩之上（`.filterpanel .trigger{z-index:46}`）后，
>    566px 高的级联面板根本放不到首行触发器下方（会被夹到触发器上面），于是「选中全省」/列标题
>    被触发器截住点不到。定成显式阶梯：`PANEL_Z = { casc: 47, opt: 45 }`，触发器固定 46 ——
>    级联面板压过触发器，选项面板让触发器可点（这样「再点一下收起」才有效）。
> 3. **`[hidden]` 会被作者样式盖掉**。`.x{display:inline-flex}` 这类声明优先于 UA 的
>    `[hidden]{display:none}`，必须显式补 `.x[hidden]{display:none}`。

### 「选中全省」快捷操作（PRD Q11）

地域级联的语义是「**每级独立勾选**」——勾「浙江省」就只代表「全省」这一个条件，不下探、无半选态。
在这个前提下，市级列表标题旁补了一个**纯增量**的快捷操作：

| 场景 | 按钮文案 | 点击后 |
|---|---|---|
| 省级以下有多个地级市，未全选 | **选中全省** | 勾上该省下辖**全部**地级市；顺带取消「全国」勾选 |
| 该省下辖市已全覆盖 | **取消全省** | 只熄灭该省下辖市 |
| 直辖市（下辖为区） | **选中全市** / **取消全市** | 同上，文案按「市 / 区」单位切 |

- **不动省本级勾选**：省节点自己那一格不受影响 —— 「勾省」与「点亮下辖市」是两条**并存**的表达，
  不互相改写（这正是取消级联自动携带之后该有的样子）。
- **不影响其他省份**：`CASCADE.toggleProvinceAll()` 只操作 `self.activeProvince.children`。
- 二次确认交互：`provinceAllOn()` 判断是否已全覆盖，决定按钮文案与点击方向；点完弹
  `app.toast.provinceAll`（`已勾选「浙江省」下全部 11 个下级区划`），并即时重渲染标签。
- 按钮在 `data/app.json` 无文案、在 `data/region.json → panel` 里：
  `selectAllCities / unselectAllCities / selectWholeMuni / unselectWholeMuni / selectAllCitiesHint`。


### 构建戳：一眼分辨「手里这份是不是最新」

改完源码必须 `python build/build.py` 重建，否则**单文件版与源码不一致** —— 而「我明明改好了，
页面上还是旧行为」十有八九就是拿着旧副本在看。所以构建戳做了三件事：

1. **写进产物**：`window.__BUILD__` = 构建那一刻（如 `"2026-10-13 10:08"`），
   `window.__BUILD_KIND__` = `"single" | "dev"`。控制台一敲就有。
2. **摆在页面左下角**：`.proto-tools` 那枚浮动小胶囊里常驻显示「**构建 10-13 10:08**」——
   不必开控制台。拿不到戳的老副本会显示「**构建 未知（疑似旧副本，请重开最新文件）**」，
   **旧副本自己会承认自己是旧的**。
3. **当缓存键用**：`dev.html` 引用 `src/*` 时带上 `?v=<构建戳>`，
   `data.js` 运行时 fetch `data/*.json` 也带同一个查询串。

```html
<script src="src/app.js?v=2026-10-13_1008"></script>
```

> 为什么非要第 3 条：`dev.html` 是**运行时读取** `src/*.js` 与 `data/*.json` 的，
> 一旦被浏览器（或中间层）缓存住，就会出现「源码明明改好了、页面还是旧行为」的灵异现象
> —— 而且**改一下源码就要靠人记得按 Ctrl+F5** 这件事本身就不该由人来保证。
> 带上构建戳之后，每次重建换一个值，缓存**自动**全量失效。
> 单文件版没有这个问题：数据与代码都内联在那一个文件里。

### 结果列表的地域：只读回显（不能再次选择）

列表页顶部那一行「地域」**不是筛选控件**，而是「这份结果是按什么地域检索出来的」的回显。
取值优先级（`screens-a.js → searchedRegionNames()`）：

1. **`DATA.list.regionsUsed`** —— 后端随每次检索结果一起给回的「本次实际生效地域」；
2. `SEARCH_STATE.regions` —— 检索发起时冻结的筛选栏快照（离线演示 / 本地降级时用）；
3. 当前 `CASCADE` 已选（从未检索过、深链直接进列表时，等价于「待检索的条件」）。

为什么以第 1 条为准：地域**不只看筛选栏**。筛选栏没选时，服务端会从查询文本里识别城市
（「我是杭州做智能硬件的」→ 杭州市），所以「生效地域」可能是用户没设过的那个值。
只回显筛选栏就会出现「列表说全国（不限）、检索屏却说杭州市 · 来自查询」这种自相矛盾。
好处同样明显：检索完再回首页改地域，列表页的说明**不会跟着变**，它始终回答「这份结果用了哪儿」。
（一个刻意的取舍：检索**还没落地**时，回显仍描述列表里躺着的那份旧结果，
不会提前写成刚点下的新条件 —— 否则就成了「列表还显示旧数据、说明却写着新条件」。）

- 复用同一套 `filterTrigger()`，只多一个 `readonly: true`：**不挂 `data-region-trigger`**
  （点了不会弹面板）、**没有 caret / 清空 / ×**，标签本体是纯文本，`.trigger.readonly` 连 hover
  都不响应 —— 读起来像一条说明，而不是一个控件。
- **形态上也要「不像控件」**：`.trigger.readonly` 收成一枚浅色胶囊（`height:auto`、
  `flex:0 0 auto`、虚线边），不再占满整行扮演一个 44px 高的输入框。
  注意 `.filterbar .trigger{flex:0 1 480px;min-width:320px}` 的特异性**不低于** `.trigger.readonly`，
  光在后者里改 `flex` 是压不住的，得补一条 `.filterbar .trigger.readonly`。
- **不重复维度名**：行首已经有「地域」这个表头，回显里再写一遍就成了「地域 · 地域：浙江省」。
  `regionTrigger({ label: '' })` → `filterTrigger()` 见到空 label 就把 `<span class="tv">`
  整块省略（`devload_test` 有断言守这一条）。
- 生效地域为空时显示 `list.json → filter.regionNone`（「全国（不限）」），不用地域控件的
  「请选择省 / 市 / 区县（可多选）」占位词 —— 这里没什么可选的。
- 旁边说明同步改成 `regionHint`「本次检索使用的地域条件，需调整请回首页修改后重新检索」。
- 要改条件就走首页 —— 这是唯一入口，避免在结果页悄悄改了条件、结果却不跟着刷新。
- 紧接着的第二行 `本次条件 | 地域 1 个 · 行业 2 个 · 类型 3 个 · 截止：近 90 天` 也走同一份
  「实际生效条件」（`searchedCondSummary()`：`regionsUsed` + `search.parsed`），
  分片文案与首页 `home.json → filter.parts` 共用一套 —— 详见下节。

### 「已解析出条件」严格等于实际生效的条件（先解析 · 再检索 · 逐项标来源）

检索屏那行 `已解析出条件：` 走过两轮弯路，两轮的症状正好相反：

1. **第一轮 —— 猜了却不说。** 地域由流水线第 0 步拼、行业由抽取引擎拼，两处各写各的。
   首页「条件精确筛选」里行业写着「不限」，检索中面板却显示「行业 = 智能硬件」；
   那个值是从查询文本里猜出来的，既不在筛选栏里、用户也改不了，却实实在在地影响了产出。
2. **第二轮 —— 干脆不猜。** 于是把口径收紧成「行业 / 类型只认筛选栏」。结果用户这么问：

   > 我是甘肃的公司，我们是做冬枣销售的，我想知道有没有关于场地的优惠政策

   面板上写着 `行业 = 不限 / 类型 = 不限` —— 他明明交代了行业与诉求，系统一个字没接住，
   产出自然与他说的事无关。

现在的口径是**先解析、再检索，且每一项都标来源**：

```
地域 = 广西壮族自治区 / 贺州市 等 7 项 · 来自筛选栏      ← 来源可辨
行业 = 农业 · 来自查询                                  ← 问句里读出来的（甘肃冬枣 → 农业）
类型 = 场地减免 · 来自查询                              ← 「场地」归一到筛选栏枚举值
时间 = 近 12 个月                                       ← 谁都没提 → 默认窗口，不带来源
```

规则（唯一实现：`app/labels.py → resolve_conditions()`）：

| 维度 | 取值 | 规则 |
|---|---|---|
| 地域 | 筛选栏所选 → 标 `· 来自筛选栏`；筛选栏为空时从查询文本识别 → 标 `· 来自查询`；都没有 → `全国（不限）` | `regions.match_in_text` 是老能力，保留但必须标出来源 |
| 行业 | **筛选栏 > 查询理解**（`req.industries` 非空就用它，否则用 `query_parse` 的解析结果） | 以前这里是「只认筛选栏」，用户交代的事接不住 |
| 类型 | 同上（`req.types` / `query_parse`） | 与首页四维筛选一一对应 |
| 时间 | 筛选栏单选值；没设且问句里提到「近半年」这类词就用它；都没有 → 默认窗口「近 12 个月」 | 单选维度的「不限」= 这一维没设，**两侧都判**（模型回一句「不限」等于没说） |

四行**与首页四维筛选同构**；`data_test` 有守卫：必须正好四行、顺序固定为
地域 / 行业 / 类型 / 时间、每行值非空，且**有值就必须带来源**（只剩下
`· 来自筛选栏` / `· 来自查询` 两种合法写法）。

#### 查询理解（`app/query_parse.py`）：两条来源，一份结果

| 来源 | 何时生效 | 特点 |
|---|---|---|
| 本地词表 `query_parse.parse()` | **总是先跑** | 离线、确定性（同一输入必得同一结果，便于回归与演示）；`POST /api/v1/searches` 的**首帧**就带着结果，不依赖网络 |
| 大模型 `LLMProvider.parse_query()` | `provider.is_remote` 且 `QUERY_PARSE_ENABLED=1` | 认得词表没有的长尾表述（「冬枣销售」）；流水线第 0 步调用，硬等待上限 `QUERY_PARSE_TIMEOUT`（默认 20s） |

两侧结果由 `query_parse.merge_hints(low, high)` 叠加，**大模型优先**；模型回的类型会经
`normalize_type()` 归一到筛选栏枚举（「场地」→「场地减免」），免得条件行与筛选栏各写一套词。

**解析结果真的参与检索，不是只贴在面板上好看**：

```
_understand()            # 第 0 步：问句 → 生效条件（task.resolved）
  → ex_req(industries=生效行业, types=生效类型, deadline=生效时间)
      → llm.build_messages(ex_req)      # 提示词里写「行业 = 农业 / 政策类型 = 场地减免」
      → provider.extract(...)           # 真实模型按这份条件检索
      → mock._match_themes()            # 本地引擎按同一份条件收窄主题池
      → wrap.build(resolved=...)        # 页头标题、四行、落库三处同源
```

- 主题池收窄需要一张「用户嘴里的词 ↔ 模板里的词」对照表（`mock._INDUSTRY_TO_THEME` /
  `_TYPE_TO_THEME`）：用户说「智能硬件」，模板写「制造业」；用户说「融资」，模板写「金融 / 贴息」。
  没有这张表就会出现「设了等于没设」—— 类型「融资」以前正是这样悄悄落空的。
- 解析出的行业落在筛选栏枚举之外时（农业、商贸零售…）**照实写出来**，不硬塞进一个不相关的枚举值。
- `verify_labels.py` 把上面这些规则钉死（81 项断言，纯本地、毫秒级、不调模型）；
  `verify_search_flow.mjs` 【8】在真实 HTTP 链路上跑一遍用户原话（甘肃 / 冬枣 / 场地），
  断言「行业不再是『不限』+ 标来源 + 政策名真的带这个行业」。结果：**108 条、主题族 `补贴 / 场地`**。

相关配置（`app/config.py`）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `QUERY_PARSE_ENABLED` | `1` | 关掉就只走本地词表（离线确定性，适合回归） |
| `QUERY_PARSE_TIMEOUT` | `20` | 调用大模型理解问句的**硬等待窗**（秒）；超时即放弃，沿用语词表结果 |
| `QUERY_PARSE_MAX_TOKENS` | `400` | 理解结果的输出上限（只要几个词，不需要长文本） |

> 同类口径要一起看：结果列表顶部的「地域」只读回显走的是同一份「实际生效地域」
> （`list.regionsUsed`，由 `wrap.build()` 回传），所以检索屏面板与列表回显不会再打架。
> 落库的 `industries / types / deadline` 也取 `task.resolved` —— 回放这条记录看到的才是当时的真相。

#### 结果列表的页头标题与条件摘要：同样是「本次结果集」的元数据

四行口径统一之后，结果列表上还有两处**写死的展示文案**在同一条规则下露馅了，一并收口：

| 位置 | 以前的写法 | 现在 |
|---|---|---|
| 页头 `<h2>` | `data/list.json → head.title` 写死「结果 · 「杭州 · 智能硬件 · 补贴类」」，换任何问句都不变 | `wrap._list_title()` 用 `labels.head_parts()` 的三槽位（地域 / 行业 / 类型）按**本次生效条件**渲染；模板 `_TITLE_TPL` 与 `head.meta` 的格式串同住 `wrap.py` |
| 第二条筛选行 | `list.filter.pickedHint` 写死「已选 3 项：地域 {n} 个 · 有效 · 近 90 天截止」，`{n}` 填的是首页筛选栏的勾选数 | `screens-a.js → searchedCondSummary()` 从 `list.regionsUsed` + `search.parsed` 推导，分片文案与首页共用 `home.json → filter.parts` |

第二条筛选行那个 bug 值得记一笔：用户问「我是杭州做智能硬件的」时，杭州市是**问句带出来的**、
筛选栏本来就没勾，于是 `{n}` = 0 → 同一屏上出现「地域 0 个」和上方回显的「杭州市」当场打架；
「已选 3 项」和「有效 · 近 90 天截止」两个数字/尾巴更是与本次条件毫无关系。
`verify_search_browser` 现在会对照 `CASCADE.count()` 断言：**筛选栏勾选数为 0，摘要仍写
「地域 1 个」** —— 证明它跟的是结果集。

配套的两条守卫：

- `data_test` 的**分离守卫支持 `a.b` 点号路径**（复用 `dig()`），`LEAK.list` 增列
  `head.title` / `head.meta`、`LEAK.search` 增列 `condTitle` —— 这类「随检索变的元数据」
  一旦被写回 `data/*.json` 就报错；`devload_test` 也会核对它们在文案文件里都不存在。
- `data_test` 另有推导式断言：`head.title` 必须含 `regionsUsed[0]`（空则 `全国（不限）`）
  与 `search.parsed` 的行业首项，形状必须是 `结果 · 「…」`；`search.condTitle` 与
  `head.title` 的「…」段必须**逐字相等**且不得出现用户原话。这样即使有人把样板标题改成
  一段好看的写死文案，构建期就会红。

#### 检索屏标题：与结果列表是**同一枚「条件指纹」**

检索屏那行以前印的是**用户原话**（`正在检索：「我是杭州做智能硬件的…」`），
而下面的「已解析出条件」印的是**生效条件**。用户把筛选栏设成福建省、问句里写杭州时，
同一屏就出现「标题说杭州、条件说福建」——他根本看不出这次到底按什么地域在查。

现在两屏都渲染 `app/labels.py` 里的同一枚指纹，只有前缀不同：

```
正在检索 · 「福建省 / 福州市 · 不限 · 不限」      ← 检索屏（POST 首帧就带回）
结果     · 「福建省 / 福州市 · 不限 · 不限」      ← 结果列表（head.title）
```

- 取景：`labels.head_parts()` 的三个槽位（地域不带来源后缀、行业 / 类型复用 `_brief()` 收敛）；
  前缀 `TITLE_PREFIX_SEARCH` / `TITLE_PREFIX_RESULT` 与模板 `TITLE_TPL` **都在 labels.py 一处**。
- 前端**不自己拼**：`condTitle` 随 `GET /api/v1/searches/<id>` 的**轮询首帧**下发
  （`SearchTask.set_parsed()` 里与四行条件一起落定，避免「条件已更新、标题还是旧的」这种半拍），
  结果回填时再给一次；离线演示用 `test_date.js → search.condTitle`。
- **★ 指纹还没到货的那一段不能印样板指纹**（2026-10-14 补）。条件指纹要等后端第 0 步
  查询理解算完才有 —— 真实模型下那是十几秒（免费档更久），而检索屏挂载时渲染的是
  `test_date.js` 的**演示指纹**（写死「杭州市 · 智能硬件 · 补贴」）。原实现只在
  `condTitle` 非空时才重画标题，于是这段空窗里用户筛了福建省、屏上却写杭州市 ——
  等于替用户编了一份条件。现在 `searchCondTitle()` 认这一档：**正在检索但还没有指纹**
  → 印问句回显（`<html>.running` 为假时行为不变，所以 `copy_test` 的静态渲染金标与
  离线演示态都不受影响）；`paintSearchScreen()` 也在 `running` 时重画一次，否则挂载那份
  样板指纹会一直留在屏上。
- 用户原话没有丢：收进标题的 `title` 属性（tooltip），不再占据视线。
- **★ 输入为空就按空检索，绝不静默换成演示问句**（2026-10-15 补）。原来四处在
  `APP.query || DATA.search.defaultQuery` —— 用户只勾了地域、问句框留空，系统却把
  演示问句「我是杭州做智能硬件的，能申什么补贴」当成用户的检索发出去：条件行凭空多出
  「行业 = 智能硬件 · 来自查询」「类型 = 补贴 · 来自查询」，结果集也被无关条件收窄。
  现在 `app.js`（检索按钮）与 `screens-a.js`（`SEARCH_STATE.query` / `startSearch` 载荷 /
  完成通知 / 本地地域跟随 / `renderSearch`）**空就是空**；后端 `_understand()` 对空问句
  直接跳过远端查询理解（省下最多 20s 白等）。没写问句时的待机回显 =
  `data/search.json → emptyEcho`（「未填写问句 · 按已选筛选条件检索」）。
  端到端验收：空问句 + 黑龙江省/大庆市 → 条件行「行业 = 不限 · 类型 = 不限」、
  标题「… · 不限 · 不限」、结果 34 条覆盖多行业且 0 条含「智能硬件/杭州」。
- 端到端验收 `verify_search_browser.mjs` 【11】节：真的把筛选栏设成福建省、问句写成杭州，
  在真实 DOM 上断言「检索屏标题含福建省、不含杭州」「两屏「…」段逐字相同」。
  ★ 断言前**等的是「指纹到货且已画上屏」**（state 与 DOM 逐字相等），不是「文本看起来像标题」——
  指纹未到时的问句回显同样以「正在检索」开头且含「」，按文本形状 break 会当场读到它，
  在真模型实例上误报四条假红（mock 首帧即到，所以只有真模型暴露）。

### 结果列表工具条：排序真的重排 · 卡片↔表格 真的换渲染 ·「重置」已移除

工具条上原来有三个「点得动但什么都不发生」的位置（弹一条 toast 就完事）。现在都是真的：

**① 排序（`data-sort`）** —— 点开一个四项菜单，本地对 `DATA.policies.items` 重新排序：

| 方案 | `v` | 排序键 | 取值来源 |
|---|---|---|---|
| 权威度 + 发布时间 | `authority` | 层级序 → 发布时间倒序 | `list.tools.levelOrder` |
| 发布时间（最新优先） | `publish` | `publish` 字符串倒序 | 政策字段 |
| 截止时间（最近优先） | `deadline` | `daysLeft` 升序（未知排最后） | 政策字段 |
| 置信度（高→低） | `confidence` | `confidence` 降序 | 政策字段 |

- 方案全在 `data/list.json → tools.sortOptions`（`v` / `label` / `hint`），**不在代码里写死**；
  `sortDefault` 指向其中之一，`data_test` 会校验它一定能在 `sortOptions` 里找到。
- 层级序用 `levelOrder: ['国家级','省级','市级','区县级']` 查表，不是按字符串比 —— 中文排序不可靠。
- 切换后：按钮文案 + 分页说明（`pager.textTpl` 里的 `{sort}`）**同时**跟着变，且真的重排了。
- **菜单常驻 DOM**，只用 `.sortwrap.open` 摘挂一个 class 控制显隐。这样做是为了把「点外部收起」
  的分支放进 click handler 的**最前面** —— 否则一旦后面某条分支 `return` 掉，收起就永远执行不到。
  （与「整块重绘会换掉正在点的节点」是同一类教训：能让 DOM 稳定的地方就让它稳定。）

**② 卡片 / 表格（`data-view`）** —— `LIST_STATE.view` 在 `'grid'` / `'rows'` 之间切：

- 表格由 `listTableHTML()` 渲染成真正的 `<table>`，列头取自 `list.table.cols`（7 列 + 1 勾选列 = 8 个 `<th>`），
  空态走 `table.empty`、剩余天数为空走 `table.leftUnknown`、单位模板 `table.leftUnit`（`{n} 天`）。
- **没有新增任何事件分支**：表格行复用卡片那套 `data-pick` / `data-open`，
  所以「勾选」和「点名字进详情」两种视图行为天然一致。
- **勾选状态两种视图共用**同一个 `LIST_STATE.picked` —— 表格里勾了切回卡片还在，
  切视图不会丢选择（`devload_test` 与 `verify_list_tools` 都有断言）。
- 视图选择**跨导航保持**（回列表页仍是刚才那种）。

**③ 「重置」已删除**：`list.filter.reset` 键、`app.toast.filterReset` 文案、`data-reset-filter`
分支、按钮本身，四处**一起**删。`data_test` 有守卫断言两者都不许复活 —— 否则很容易只删按钮
留下一个死键，下次有人看到又给加回来。

**④ 分页（`data-page`）** —— 页码真的换内容：

- **页码口径跟着「本次结果集」走**：`listTotal()` 直接取 `DATA.policies.items.length`，
  `list.pager.total` 只在「本地一条都没有」时兜底；每页条数 `perPage` 由后端给，
  `data/list.json → pager` 只放文案模板（`textTpl` 用 `{total}/{perPage}/{cur}/{pages}/{sort}` 插值）。
  这样「共 N 条 · 每页 20 条 · 第 1 / M 页」全是算出来的，不是抄在文案里的。
- **为什么不能沿用声明值**（用户实际报过的 bug）：静态 bootstrap 里的 `pager` 写的是
  **内置样例集**的规模（共 96 条 / 第 1 / 5 页），而一次真实检索只产出 10 条。
  页脚照抄那个 96 → **翻到第 2 页就是「本页暂无内容」**。
  修法两层：前端以实际结果集为准；后端 `wrap.build()` 也按本次结果集回一个
  `list.pager`（`total = len(items)`、`perPage` 沿用 bootstrap 口径），两端对齐。
- `data_test` 的守卫从「声明页数要填得满」升级为**必须完全相等**——多出来会翻出空页，
  少了会让后面的条目永远翻不到，两个方向都是假分页。
  `devload_test` 第 6c 组另加一条回归：把结果集缩到 10 条后页码口径必须跟着缩成 1 页、
  且越界翻页后仍有内容；`verify_search_browser` 第 6b 节在真实浏览器里逐页翻到底，断言没有空页。
- 翻页 = 换一个切片 + 重渲染 + **把列表滚回顶部**（不滚的话会停在上一页的滚动位置，看着像没反应）。
- 页码条：7 页以内全列；超过 7 页才窗口化（首、尾、当前页 ±1 + 省略号）。首页禁用「上一页」、
  末页禁用「下一页」，当前页带 `aria-current="page"`。
- **「全选」作用的是本页**（文案就是「全选（本页 n 条）」）：勾选状态按页各自累加，翻页不丢。
- 和排序的关系：**分页作用在排序结果上**（先 `sortedPolicies()` 再切片），所以换排序会重新分页。

> 样例集为什么是 96 条：为了让「分页」在**离线演示**里也有东西可翻。3 条精编样例（手写）
> + 93 条由 `test_date.js` 顶部的 `_GEN_POLICIES` 按「主题 × 层级 × 地域」**确定性生成**
> （不用 `Math.random`、不读当前时间，同一份源码每次生成完全一样）。层级配额
> 国家级 3 / 省级 8 / 市级 1 / 区县级 84 —— 这样 3 条精编样例在「权威度」序下正好都落在第 1 页，
> 既有的金标（`copy_test` 的 `list` / `list-rows`）不用改就还能命中。
> 生成区间也刻意避开了精编样例：`publish ≤ 2026-03-15`、`daysLeft ≥ 45`、`confidence ≤ 0.90`，
> 于是「发布时间 / 截止时间 / 置信度」三种排序的第 1 条仍然是精编样例，回归断言有稳定锚点。

**⑤ 对比（`data-compare`）** —— 勾选 2–5 条后弹出并排比对浮层：

- 比对项与顺序全部来自 `data/list.json → compare.rows`（12 项：层级 / 发文机关 / 政策类型 /
  适用行业 / 发布 / 截止 / 剩余天数 / 补贴标准 / 申请条件 / 数据来源 / 字段置信度 / 字段核验），
  取值口径集中在 `screens-b.js → compareValue()`，加字段只要改数据 + 那一个 `switch`。
- 每行自动判「一致 / 有差异」并给标记：值全相同标**一致**（浅灰），有出入标**有差异**（琥珀色，
  该行底色也浅黄）—— 一眼看出「这几条到底差在哪」。
- 条数不合法时**必须给原因**（`compare.needMore` / `compare.tooMany`，上限取自 `tools.maxCompare`）：
  「至少勾选 2 条」「最多同时对比 5 条」—— 而不是点了没反应。
- 三个关闭方式：`关闭对比` 按钮、点遮罩空白处、Esc。面板嵌在遮罩里，所以点面板内部不会关
  （判定写成 `el('[data-cmp-mask]') && !el('.cmp-panel')`）。
- 列的先后与列表一致（用的是同一份排序结果），勾选跨页累加，所以可以拿第 1 页和第 3 页的政策对比。

> 验收脚本 `tools/verify_list_tools.mjs`（**65 项**，产出 `_shots/36-list-sort-menu.png`、
> `37-list-table-view.png`、`38-list-page2.png`、`39-list-last-page.png`、`40-list-compare.png`、
> `41-list-compare-5.png`）；纯前端的断言在 `build/devload_test.js` 第 6b / 6c 组
> （四种排序、表格 8 个 `<th>`、分页切片与边界夹取、页码条禁用态、对比列数与 diff/same 分支等）。

#### 勾选随「结果集」归零（换个检索必须从零开始）

用户报过：再次检索后列表头仍写着「已勾选 4 条」、工具条写着「对比 (4)」，
可「全选」还是未勾状态 —— 因为那 4 条是**上一份结果**的勾选，在当前列表里一条都找不到。
数字与眼前的东西对不上，还可能被带进对比 / 简报。

修法是在**唯一的落地入口** `DATA.hydrateBackend()` 里调 `resetListForNewResult()`
（实体在 `screens-b.js`，紧挨 `LIST_STATE`）：清空勾选、页码回第 1 页、收起对比浮层。
放这里而不是各个调用点，是因为「灌进一份新结果集」有三条路 —— 发起检索（`screens-a.js`）、
历史回放与启动回放（`screens-d.js`）—— 少改一处就会从那个入口漏出旧勾选。

| 状态 | 换结果集时 | 为什么 |
|---|---|---|
| `picked` | **清空** | 勾选是「对眼前这份结果的表态」，旧的 ID 在新结果里根本不存在 |
| `page` | 回第 1 页 | 新结果只有 1 页时停在第 3 页就是空页 |
| `compareOpen` | 收起 | 否则浮层里还躺着上一份结果的政策 |
| `sort` | **保留** | 排序是用户偏好，跨检索有效 |

结果列表**启动时一条都不勾**（`app.js → boot()` 显式 `LIST_STATE.picked = new Set()`），
后端也**不下发** `list.defaultPicked` / `brief.previewIds`。以前启动会灌入后端 top2 当「演示态预选」，
于是刚进应用就显示「已勾选 2 条」、简报中心还照着它们排版 —— 用户会以为「我没勾却显示了 n 条」。
勾选只可能来自用户手点；简报预览与导出也只认这份勾选。

### 面板搜索框必须输入法友好（列表与头部拆开渲染）

面板搜索框（`#cascQ` / `#optQ`）**绝不整块重绘**。`patchCascPanel()` / `patchOptPanel()` 只替换
`fpanel-body`（列表）+ `.sum` + `确定(n)`，头部（含 `<input>`）原地不动：

```
optPanelHTML(g)  = optHeadHTML(v) + <div class="fpanel-body">optRowsHTML(v) + optFootHTML(v)
                       ↑ 里面才有 #optQ，只在「打开面板」那一刻渲染一次
cascPanelHTML()  = cascHeadHTML(v) + cascBodyHTML(v)  + cascFootHTML(v)
```

> **踩坑记录：打不了中文 + 一个字变三个**
>
> 原来每次 `input` 都 `host.innerHTML = optPanelHTML(...)`，把正在输入的 `<input>` 一起换掉了：
> ① 中文输入法**组词刚开始节点就没了** → 候选词上不了屏，中文根本打不进去；
> ② 按键的默认动作（把字符插进当前焦点元素）落在**新**输入框上，而新框已经从 `value="y"`
> 里带上了那个字符 → **按一下 y 出来三个 y**。
>
> 两层修法。**结构上**只重画列表：`patchCascPanel()` / `patchOptPanel()` 用 `livePanel()`
> 取「真正该刷新的那一块」——「地域多选」屏会**同时**存在内嵌与浮层两块 `#cascPanel`，
> `getElementById` 只会拿到前面那块内嵌的，刷新打错对象界面就纹丝不动。
> **事件上**加 `PANEL_IME` 组词态：`input` 带 `isComposing`（或 `compositionstart` 之后）时
> 连列表都不重画，`compositionend` 才过滤一次；`keydown` 里的 Esc 也要给输入法让路
> ——组词中的 Esc 是「取消候选词」，不该顺手把面板关掉。

### 屏入口统一走产品顶栏导航（顶部原型索引条已移除）

原型**不再占用页面顶部**：原先那条 `01…11` 屏索引条已删除，剩下的入口全部并进产品自己的
导航栏（`data/app.json → nav`），与应用内跳转完全一致 ——

| 导航项 | 屏 | 备注 |
|---|---|---|
| 首页检索 / 结果列表 / 简报中心 / 检索记录 / 政策详情 | home / list / brief / history / detail | **v1.4 起导航就这 5 项** |
| （不在导航里）检索中 | search | 过程态：点「开始检索」自动进入 |
| （不在导航里）登录 / 注册 | login | 顶栏右侧账号区进入 |

> 「任务监控 / 订阅提醒 / 异常降级 / 地域多选」四屏已在 v1.4 删除（地域级联面板改挂首页浮层），
> 对应命名空间同步从 `app/bootstrap.py → NAMESPACES` 移除，**别加回来** ——
> `build/data_test.js` 有防回流断言。
> 左下角那枚「构建戳 / 屏索引 / 适应窗口↔实际尺寸」浮动胶囊也已整块删除：
> 外壳不占任何画面，应用直接铺满窗口（`verify_input_ime.mjs` 有 4 条守卫盯着「外壳浮层数 = 0」）。
- `build/data_test.js` 为此加了守卫：`app.json` 不得再出现 `screens[].strip` / `_screensNote`；
  「检索中」不得作为导航项；除「检索中 / 登录注册」外**每一屏都必须能在 nav 里找到入口**。

### 前端对应关系

| 前端 | 说明 |
|---|---|
| `data/auth.json` | 第 10 屏「登录 / 注册 / 账号」文案（含档案字段、统计项、闸门提示、错误文案） |
| `data/history.json` | 第 11 屏「检索记录」文案（列表、徽标、空态、二次确认） |
| `src/screens-d.js` | `AUTH` 状态机（会话恢复 / 登录 / 注册 / 登出 / `probeService` / **闸门 `gateOpen`**）+ `renderLogin/mountLogin` + `renderHistory/mountHistory` |
| `src/data.js → DATA.api` | 统一注入 `Authorization: Bearer <token>`；账号与历史接口客户端 |
| `src/app.js → boot()` | **首屏闸门**：闸门未开 → 登录页；已开 → 深链 → 首页 / 结果列表 |
| `src/app.js → showBootError()` | **启动失败诊断页**：打印「失败阶段 + 调用栈前 8 行 + 怎么打开」三段，取代原来只甩一句原始 message |
| `src/app.js → go()` | **跳转闸门**：闸门未开时一切跳转拦回登录页 |
| `src/app.js → notice()` | 右下角通知卡片（带标题 / 说明 / 操作按钮），承载「后台检索完成」提示 |
| `src/screens-a.js → topBar()` | 9 项产品导航 + 闸门置灰 + 后台检索的「检索中 n%」胶囊 |
| `src/screens-a.js → mountSearch()` | **检索后台化**：进度与屏幕解耦，切屏不中断，重入检索屏不重启任务 |
| `src/screens-a.js → filterTrigger()` | **四个维度共用的触发器模板**（标签折叠 `+N` · 单条 `×` 删除 · 清空 · 空即「不限」）。`readonly:true` 时退化成纯展示：无 caret / 清空 / ×，`label:''` 时连维度名也不渲染 |
| `src/app.js → patchCascPanel() / patchOptPanel()` | 输入时**只重画列表与底部**，绝不换掉 `<input>` 节点（换节点 = 中文打不进去 / 一次按键出三个字） |
| `src/app.js → PANEL_IME` | 输入法组词态：组词期间连列表都不重画，`compositionend` 才过滤一次；组词中的 Esc 留给输入法 |
| `src/screens-a.js → FILTER_STATE` | 四维状态机（`applied` / `draft` / `q` 草稿与搜索词、单选多选、空即「不限」），`optTrigger()` / `optPanelHTML()` / `visible()` / `toggleAll()` 渲染 |
| `src/screens-c.js → cascPanelHTML()` | 地域级联面板，复用同一套 `.fpanel` 骨架（body 换成三列 `flex-direction:row`） |
| `src/cascade.js → toggleProvinceAll()` | 「选中全省 / 取消全省」纯增量快捷操作（只作用于当前省下辖市） |
| `src/app.js → mountFilterPanel()` | 浮层挂载统一入口（遮罩 + 定位夹取 + z-index 阶梯 `casc:47 / opt:45`）；`mountCascPanel` / `mountOptPanel` 只是薄包装 |
| `src/app.js → openCasc() / openOpt()` | 面板开合统一分支（定位、遮罩、Esc、再点收起） |
| `src/screens-d.js → AUTH.stale()` | 本地凭证保留期判定（`{t,at,d}`），到点自动 `forget()` 并置 `expired` |
| `src/screens-d.js → AUTH.name() / AUTH.initial()` | 显示名与头像首字。**永不返回 `undefined`** —— 它是纯展示信息，缺字段时退化，不许拖垮 boot |
| `src/screens-b.js → renderDetail()` | **详情页整屏**：左栏「申报条件逐条自查 / 申报流程 / 申报入口 / 申报材料 / 政策字段」+ 右栏对话面板。左栏 `.detail-main` 是**独立滚动容器**（`.screen` 定高 1440×900 + `overflow:hidden`，不加滚动的话最下面的「政策字段」会被裁掉够不着） |
| `src/screens-b.js → checkMap/checkSummary` | 自查进度（`DETAIL_STATE.checks`，按政策分别记），三档措辞来自 `data/detail.json → conditions` |
| `src/screens-b.js → DETAIL_STATE.chat / chatState(pid)` | 对话状态（`messages / loading / error / loaded / epoch`），**按 `policyId` 分开存** |
| `src/screens-b.js → chatSend()` | 发问：先本地落用户气泡 → 等后端 → 助手气泡；失败就地报错，不静默吞掉 |
| `src/screens-b.js → chatClear()` | 清空：游客只清本地，登录用户调后端真删。**同时把在飞的那一问作废**（`epoch += 1`），否则迟到的回答会在清空后把气泡又追加回来 |
| `src/screens-b.js → toggleSnap()` | 原文快照弹层开合（Esc / 遮罩 / 按钮三条路） |

---

## 政策详情：看得懂 + 问得到

详情页原来有两个「用户看不懂」的地方，对应两条反馈：

| 反馈 | 原来是什么样 | 现在 |
|---|---|---|
| 「申请的相关条例不明确，用户没法直观地看到他想申请政策」 | 条件是一段段结构化条款文本，读完不知道「我到底符不符合」 | **逐条自查清单**（每条一个勾选框 + 短句摘要做标题、完整原文退到副行、金额 / 年限 / 比例高亮），勾完给一句结论；并补上 **申报流程（5 步）+ 申报入口（线上 / 线下）** |
| 「想做成一个大模型对话框，聊天记录存到 MySQL」 | 右栏是只读的「原文快照 · 字段级溯源」 | 右栏整块换成 **AI 对话面板**；原文快照收进「查看原文」弹层，溯源能力没丢 |

### 左栏：自查清单 / 申报流程 / 申报入口

- 条件行是 `div[data-check] role="checkbox"`，**不是 `<input>`** —— 用原生 checkbox 必须配 `<label>`，
  点一下会双触发（勾上又立刻取消）。行上直接挂 `role` + `aria-checked`，Enter / Space 也能切换。
- 关键数字高亮走 `markKeyNumbers()`（`KEYNUM_RE` 认金额 / 年限 / 比例），
  摘要不替代原文：`.cshort` 是摘要、`.cfull` 是逐字原文，两条都在。
- **申报流程是模板 × 占位符**（`data/detail.json → steps`），发文人用 `{issuer}` 填。
  ⚠️ **别用 `{region}`**：`test_date.js` 与 `mock.py` 两侧对「地域」的口径不一致
  （前者填「杭州市西湖区」、后者填 `level_name` 如「市级」），会印出「登录市级政务服务网」这种错话。
- 原文没有的信息（联系电话之类）**明说「原文未收录」**，不臆造 —— 闸门盯着这一条。

### 原文快照：跟「本条政策」走 + 「打开原文」是真链接

- ★ **快照正文必须与下方「申报条件 · 逐条自查」同一条政策**。曾经 `wrap.py` 把每条结果的
  快照弹出后只留**第一条**塞进 `detail.snapshot.text` 全局共用 —— 用户打开节能政策，
  看到的却是结果集第一条技改政策的「营业收入不低于 2000 万元」（2026-10-14 用户实测踩到）。
  现在 `wrap.build()` 给**每条结果**下发自己的 `snapshot` 字段（`<mark>` 高亮跟条走），
  前端 `snapBodyHTML()` 只认 `p.snapshot`，没有（内置样例集）就退化为本条 `conditionsFull`
  原文 + 关键数字高亮。`detail.snapshot.text` 仍下发（首条）作旧契约兜底，前端已不消费。
- **「打开原文」是真 `<a target="_blank" rel="noopener noreferrer">`**，不再是死按钮：
  数据源给了 `url` 就用 `url`。**2026-10-14 起两套数据源（`test_date.js` 全部主题 + `mock.py`
  全部主题）都按主题配好了真实官方原文 URL**（中国政府网 / 财政部网的政策文件页，
  见 `mock.py → _REAL_SOURCE_URLS`）—— 点「打开原文」直达对应政策文件的官方页面，
  不再落回「搜索政策名」的兜底（兜底逻辑仍保留，仅在数据源没配 url 时使用）。
- ★ **`wrap.build()` 不得剥掉 `sources[].url`**：包装层重建 `src_list` 时曾经只拷
  `name` / `kind`，mock 配好的真链接半路全丢 —— 演示数据不走这条路（闸门
  `verify_detail_chat` 测的是 boot 演示集，拦不住），**真实检索出来的条目点「打开原文」
  依旧全部落回百度搜索页**（2026-10-14 用户二度实测踩到）。现在 url 原样带出 +
  按政策名关键词对号入座回填（`mock.real_source_url()`，远端大模型吐的条目也吃这层兜底）；
  技改主题的「转载页」单独指向中国政府网的报道页（`_REPOST_URLS`，用户指定的
  content_6945449 链接）。对大模型自造的、十主题池对不上号的政策名，回填
  **中国政府网站内检索页**（`sousuo.www.gov.cn/sousuo/search.shtml?searchWord=政策名`，
  仍官方域、直达该名的检索结果）；前端 `screens-b.js` 的最后兜底也从百度同步换成这个
  官方检索页。`verify_search_flow` 新增 2 条断言：**检索结果每条 sources
  都带真实官方 url（不见 baidu）+ 指向 gov.cn 系域名**（58 → 60 项）。
- ★ **自查勾选与渲染必须用同一把「政策 id 钥匙」**：`policyById()` 对查不到的 id 兜底回
  `items[0]`，若 `go('detail')` 不把 `APP.policyId` 归一为解析后的 id，渲染按 `items[0].id`
  读勾选、点击按旧 id 写 —— 表现就是「点申报条件永远勾不上」（从对话记录 / 历史回放
  点开旧 id 必现，2026-10-14 用户实测踩到）。现在 `go()` 进详情屏时归一 id，
  点击 / 键盘 / 重置三处再各自解析一次兜底。
- 闸门 `verify_detail_chat.mjs`【3】新增 3 条断言：快照正文含当前政策自身的快照/条件前 10 字、
  打开原文是真 `<a target=_blank>`、href 是合法外链。

### ★ 置信度 = 原文证据强度（`app/ground.py`，2026-10-14）

**起因**：用户实测截图里那条「研发费用 ≥ 100 万 … ⚠ 待核验 · 置信度 0.72  字符偏移 7821–7863」，
并追问「能不能提升置信度，有些条件在原文中都看不到」。一查，**整条链路上的两个数字都是编的**：

| 字段 | 改造前的来源 | 问题 |
|---|---|---|
| `confidence` | mock 走 `round(rnd.uniform(0.72, 0.96), 2)`；远端模型按提示词自报；取不到则 `0.75` | 与「原文里到底有没有这句话」**零相关**，纯随机/拍脑袋 |
| `offset` | `wrap.py`：`start = 1200 + index * 437 + rnd.randint(0, 90)` | 纯算术。而原文摘录实测只有 **64~104 字** → 偏移 100% 越界 |

用户看到的 `7821` 正好是 `1200 + 15×437 + 66`（`index=15`），指向的正文根本不存在。
量化「有些条件在原文中都看不到」：**10 个主题 30 条「原文条款」，能在原文摘录里找到的是 0/30**。
另一半问题在展示层：`confidence` 是**政策级**的一个数，却只在 `conditionsFull[1]` 那一行渲染，
其余条款既没分数也没偏移。

**现在**：新增 `app/ground.py`，逐条把条款回原文摘录里定位，用**可验证的证据强度**替代自报值。

```
locate(条款, 原文摘录)
  ① 归一化后精确子串命中                         → exact
  ② 否则「最长连续重合」模糊匹配（容忍标点/空格/全角半角）
  ③ 抹掉数字再比一次 → 专门判「句意中了但数字对不上」
  ④ 都没有                                        → unmatched
  回填**原文真实字符偏移** charStart/charEnd + 命中原句 evidence
  ★ 边界对齐：归一化会丢掉空白与标点（`_DROP`），若条款本体以 `）`、`，` 这类
    字符收尾，从映射反推的区间会漏掉它 —— 偏移标得很精确、高亮却少一个字符。
    所以拿原文逐字校验一遍再把首尾补回去（`_align_edges`，校验不过就不动）。
```

打分口径（单调、可测，闸门逐条断言）：

| 情形 | 置信度 | status |
|---|---|---|
| 逐字命中 + 数字一致 | 0.92 ~ 0.98 | `verified` |
| 仅标点/空格差异 | 0.80 ~ 0.89 | `normalized` |
| 命中了但**关键数字对不上**（原文写 200 万、条款写 100 万） | ×0.85，且 `factors.digitsMissing` 点名是哪个数 | `digit_mismatch` |
| 原文里找不到 | ≤ 0.35（`UNMATCHED_MAX`） | `unmatched` |

两个刻意为之的取舍：

- **「找不到」绝不给高分**。宁可如实标「原文未命中」并压到 0.35 以下，也不拿好看的数字糊弄 ——
  那正是这一层要消灭的东西。前端对 `matched=false` 的条款**不显示字符偏移**（`未在原文摘录中定位到`）。
- **命中多处要扣分**（同一句出现两次说明定位有歧义，−0.03，`factors.hits` 如实报出）。

**政策级置信度**不再是条款分的简单平均：`0.6 × 平均 + 0.4 × 最弱`。一条政策里只要有一条
条款对不上原文，整条就不该被评为高分（实测含未命中条款的政策落到 **0.41**）。

**逐条下发**（前端 `screens-b.js` 按它渲染每一条的分数、真实偏移与原文依据 tooltip）：
`policies.items[].conditionsDetail[] = {short, full, confidence, status, matched, exact,
charStart, charEnd, offset, evidence, coverage, factors}`；
`policies.items[].snapshotMarks = [[start, end], …]`（互不重叠、已去重、不越界）。

**高亮与偏移同源**：后端下发**纯文本** `snapshot` + 真实区间，由前端按区间插 `<mark>`
（`markByOffsets()`）—— 「偏移说的地方」和「高亮的地方」天然是同一处，不会再各说一套。

**没有原文摘录时**：`snapshotSynthetic = true`，前端显式提示「本条未获取到原文摘录，
以下内容由模型归纳，不作原文依据」，而不是假装它是原文。

**真实模型路径同样校验**（用户选定）：无论条款来自规则引擎还是 GLM，都过同一套 grounding。
提示词随之调整（`prompts.py`）：
- `snapshot` 必须**逐字包含** `conditionsFull` 的每一条（不再只写补贴比例）；
- 新增 `conditionsEvidence`（与 `conditionsFull` 逐条对齐），要求**逐字复制**原文原句；
- **不再要模型填 `confidence`**（服务端不采用自报值；`reportedConfidence` 字段仅留档对照）。

`conditionsEvidence` 的用法见 `ground.locate_with_evidence()`：条款本体定位不到时，退一步
按引用定位 —— 成功记 `factors.locatedVia = "evidence"` 并把分数压在引用档（≤0.85，
因为核验的是「模型引用的那句在原文里」而非「条款措辞在原文里」）；引用也不在原文里，
才在 `factors.reason` 里点名「疑似幻觉」。这样「改写 + 引用」的正常情形不会被一刀切，
纯幻觉又跑不掉。

**数据侧同步**：`mock.py` 十个主题的 `snapshot` 从「讲补贴比例」改写成**真正包含全部三条
`conditionsFull` 的原文段落**（命中率 0/30 → 100%）；其中**刻意留了两条**用于覆盖边界：
`产业人才引进补贴` 的第 3 条不在摘录里（`unmatched`）、`绿色低碳技术改造补助` 的第 2 条
在摘录里没有空格（`normalized`）。置信度不再由 mock 随机生成。

**闸门** `tools/verify_grounding.py`（35 项，纯本地秒级）：四种情形各自成立、**偏移切片切出来
必须能回溯到条款本体**（`exact=true` 的更高要求 —— **逐字相同**，连首尾标点都不许少）、
状态与分数单调、未命中必无偏移、`snapshotMarks` 与 `conditionsDetail` 同源且不重叠不越界、
政策级公式与「含未命中不判高分」、命中率 ≥ 95%、旧契约字段齐全，以及 ★ **回归守卫：任何偏移
都不得越界**（编造偏移的典型症状）。

闸门里还有一节 **【3.5】全主题横扫**：把 mock 每个主题的每条条款都拿它的原文摘录过一遍定位，
断言 30 条里 `exact` 的切片一律与条款本体逐字相同。它先断言「主题池里确实存在首/尾带标点、
归一化会丢掉的条款」，**否则这条守卫会退化成空跑**——正是这一节把上面那个「末尾 `）` 被吃掉」
的问题钉住的（收紧前只比「归一化后互相包含」，`）` 在归一化里被丢掉，所以漏判）。

### 右栏：政策对话（`app/chat.py`）

```
前端 POST /api/v1/chat/messages { policyId, question, policy }
   │                                      ↑ 客户端把本条政策的字段一起带上（含申报流程 / 入口）
   ▼
chat.respond(user_id, policy, policy_id, question)
   ├─ 意图识别（materials / deadline / money / process / conditions / overview）
   ├─ 非远端 或 远端失败 ──► rule_answer()  按意图引用**本条政策的真实字段**
   └─ 远端     ─────────► ai_answer()      thread.join(CHAT_TIMEOUT + 8) 硬截止，超时降级到 rule_answer
   ▼
登录用户 → repo.save_chat_message() 写 chat_messages（一问一答两行）
   ▼
{ question, answer, source, degraded, reason, provider, elapsedMs, saved, policyId }
```

- **意图识别用「计数最多者胜」，不是「第一个命中者胜」**：`「我这种情况能不能申？」`
  同时命中 `conditions` 的多个关键词，而「能申」也出现在别的组里；按命中数排序才不会因为
  关键词表的书写顺序而漂。判据表在 `_INTENT_RULES`，一项一组，加词只改那一张表。
- **规则回答会逐字引用本条政策的字段**（政策名 / 条件条数 / 材料清单 / 截止日期 / 补贴标准），
  所以它既是 mock 通道的答案，也是**真实模型失败时的兜底** —— 兜底不编内容。
- ⚠️ **`provider.complete(timeout=N)` 的 N 只是「socket 每次读操作」超时**，网关注入空白保活时
  永不触发（实测能拖到 178s）。真正的硬上限是 `thread.join(CHAT_TIMEOUT + 8)`，
  与简报综述那处是同一个坑。改这里必跑 `tools/verify_brief_timeout.py` 同源的逻辑。
- **落库只对登录用户**（`user_id=None` = 游客 → `saved=False`，前端气泡标「未保存」）。
  没有 Token 的请求不写库，但**照常能问答** —— 「零门槛试用」与「长期保留」不冲突。
- 对话**按 `policyId` 隔离**；单条政策最多保留 `CHAT_KEEP_PER_POLICY` 条（默认 200），
  写入后按最旧的淘汰（`repo.prune_chat_messages()`）。
- 落库整段 try/except：MySQL 挂了只是历史读不回来，**提问本身照常回答**。

### 前端：清空必须作废「在飞的那一问」

真实模型一轮要十几秒，用户等不及点了「清空」—— 如果不作废，**迟到的回答会在清空之后
把气泡又追加回来**，看起来像「清空没生效」。所以 `DETAIL_STATE.chat[pid].epoch` 是每次
`chatSend` 时捕获、`chatClear` 时 +1 的代次号，回答落地前先比一次代次，不一致就直接丢弃。
（这个 bug 只在真实模型通道上暴露得稳定：mock 秒回，竞态窗口几乎为零 ——
所以 `verify_detail_chat.mjs` 特意在页面内**同一个 tick** 里「先发再清」来复现它。）

### 整页滚动：详情页「没往下滑」的原始 bug 是 flex 压扁

用户实拍三张截图：申报条件 / 申报流程 / 申报材料**每块都被拦腰裁断**，且滚轮无效。
根因有层叠的三条：

1. **`.fieldbox` 自带 `overflow:hidden`**，而详情左栏是 `display:flex;flex-direction:column`
   —— 内容一超过可用高度，flex 会**把每个块按比例压扁**，内容就在块内被裁掉；
   更糟的是压扁后 `scrollHeight == clientHeight`，**根本无物可滚**，滚轮当然没反应。
2. 就算左栏自己能滚，**鼠标悬在右栏对话面板上时滚轮完全无效** —— 右栏不是左栏的
   子元素，滚动链传不过去。
3. 样例数据在 1440×900 下常常「刚好塞满」，内层滚动条不出现，用户也发现不了能滚。

修法（见 `src/screens.css` 4 节注释）：**滚动容器改为左右两栏的公共父级 `.detail-body`**
（左右一起滚、悬在右栏上也能滚），左栏子块 `flex:0 0 auto` 一律不许收缩，
右栏对话面板 `position:sticky` 钉在可视区内滚动时始终可见；
重绘（勾自查 / 发提问）后由 `mountDetail()` 回填滚动位置，不把用户弹回顶部。
闸门把 `#detailScroll` 压矮逼出真溢出来量这条路径（样例「正好塞满」测不出）。

### 检索屏：抓取日志一多也必须滑得动（2026-10-15）

用户实拍截图：「清洗去重中 18 / 18 个源」下面挂着很长的抓取日志，**滑不动**，
下面的日志与「取消检索」按钮直接被裁在画布外。

根因：`.screen` 是定高 `1440×900` + `overflow:hidden`，内容超出必须由**内部容器**自己滚；
而 `.search-body` 与 `.loglist` 以前都没有 `overflow` —— 日志一多就顶出画布，谁也滑不动。

修法（`src/screens.css` 第 2 节）：

- `.search-body { overflow-y:auto }` + `.search-body>*{flex:0 0 auto}`
  —— 子项**不许收缩**，否则 flex 容器会先把它们压扁，而不是撑出滚动条（给了 overflow 也白给）；
- `.loglist { max-height:300px; overflow-y:auto }` —— 日志区自己限高滚动，
  条数再多也不会把「取消检索」顶出视野；
- 自动跟滚**只在用户本来就贴着底部时**做（`screens-a.js::paintSearchScreen`）——
  他要是正往上翻历史，每来一条就被拽回底部，等于根本看不了。
  判定必须在 append **之前**读，因为追加本身就会改变 `scrollHeight`。

> 闸门 `verify_search_browser.mjs`【3b】：断言两个容器真的可滚、灌 80 条日志后
> `scrollTop` 真的能改变（不是只有 CSS 声明），并且「取消检索」落在画布可视区内。

### 「对话记录」页签：不用先找到那条政策，也能接着聊

用户反馈：对话按政策隔离后，想看上次的问答得先找到那条政策才能进对话面板。
所以「检索记录」屏加了**「检索记录 / 对话记录」两个页签**：

- 「对话记录」= `GET /api/v1/chat/messages`（**不带 policyId**）→
  `repo.list_chat_threads()` 按 `policy_id` 聚合：政策名 / 问答条数 / 最后一句提问预览 /
  最近时间，最近聊过的在前。
- **政策名是写入时的快照**（`chat_messages.policy_name` 列）——展示时才回查 bootstrap 的话，
  政策池一换（换检索条件 / 换样例集）名字就对不上了。老库补列走 `db.py::_migrate()`
  （建表全是 `IF NOT EXISTS`，改列结构老库不会自动跟上；MySQL 的 `ALTER TABLE` 又不支持
  `IF NOT EXISTS`，所以按 `information_schema` 逐列判断）。
- 点卡片 → `go('detail', { policyId })` 回到那条政策的详情页，对话历史就在右栏面板里。

> 验收脚本 `tools/verify_detail_chat.mjs`（**81 项**，产出 `_shots/chat-01-selfcheck.png` …
> `chat-06-history.png`）。对 mock 与真实模型**都应全绿**：
> 它接受「大模型回答 / 规则回答」两种来源标签。
> 判定「回答紧扣本条政策」用的是**结构化重合**（回答与本条政策字段有没有 ≥6 字连续重合），
> 不是关键词表 —— 实测真实模型答「需提交技改补贴申请表（加盖公章）…」时一个关键词都不含。

---

## 检索链路

```
前端「开始检索」
   │  POST /api/v1/searches  { query, regions[], industries, types, deadline }
   ▼
SearchService.start()  ── 立即返回 202 + taskId（不阻塞前端）
   │                        （地域解析与条件标签在提交前同步算好，首次响应即带 parsed）
   ▼
线程池执行 6 步流水线（对应前端 data/search.json 的 steps）
   0 解析查询   本地规则解析地域/行业/时间，POST 响应即回带
   1 多源抓取   按地域层级挑源，逐源推进进度与日志（真实产生，非预设动画）
   2 清洗去重   正文抽取页数 / 跨源合并条数 / 精确率召回率
   3 AI 结构化  llm.build_messages() 组装提示词 → provider.extract()
                失败自动回退本地规则抽取并标记 degraded，不阻塞主流程
   4 分类排序   类型/层级/行业三维分类，按权威度排序
   5 简报生成   组装简报与导出信息
   ▼
wrap.build() ── 包装成命名空间的**增量补丁**
   │              （policies/search/list/detail/brief/tasks/subscribe；
   │               stats 与 regions 不回传，保留前端初始值）
   ▼
GET /api/v1/searches/{id}/result → { bootstrap: {...} }
   │
   ▼
前端 DATA.hydrateBackend(bootstrap) → 重建派生视图
   ├─ 用户还在检索屏 → go('list')
   └─ 用户已切到别的屏 → 右下角弹「检索完成」通知，点「查看结果」再过去
```

**进度期间的轮询**：前端按 `data/search.json → pollMs`（默认 500ms）轮询 `GET /api/v1/searches/{id}`，
把返回的 `step / progress / logs / parsed` 实时映射到检索屏的流水线、进度条与日志列表。
接口不可用 / 任务失败 / 超时则降级为本地演示动画。

### 检索是后台任务（切屏不中断）

轮询**不依赖当前停在哪一屏** —— `SEARCH_STATE` 里存的是「进度视图模型」（百分比 / 步骤 / 条数 /
已解析条件 / 日志），轮询循环只读写它；把模型画到 DOM 的 `paintSearchScreen()` 每次现查 DOM，
不在检索屏就直接返回。于是：

```
点「开始检索」
   ├─ 停在检索屏           ──► 照旧实时看进度；出结果自动跳结果列表（finishDelayMs 后再确认一次，
   │                          这期间用户若自己切走了，就不拽他，改走下面的通知）
   └─ 切到简报中心 / 其它屏  ──► 轮询照常推进，顶栏出现「检索中 n%」胶囊（任意屏可见，
                              点它回检索屏看进度，**不会重复发起检索**）
                              ──► 跑完后**不强行改落地屏**，右下角弹通知卡片：
                                  「检索完成 · 已跑完 N 条政策」+ 按钮「查看结果」
```

- 重入检索屏由 `SEARCH_STATE.reenter` 区分「只是回来看进度」与「重新发起检索」；
  两者若同时发生（任务在跑，用户又点了「开始检索」），会先弃掉旧任务，避免两个循环同时写状态。
- 检索屏上的「取消检索」依然可用；从别的屏点胶囊回去也能取消。
- 通知卡片与 Toast 共用右下角同一条队列（`notice()` / `toast()`），不会互相遮挡。

### ★ 结果集的地域范围：下钻过的分支不横向铺开（2026-10-15）

清单口径的唯一来源是本地规则引擎（`app/llm/mock.py → _pick_targets`），按
「选中地域 × 下辖全层级 × 主题池」铺开。用户实测暴露了它的**过度铺开**：

| | 改前 | 改后 |
|---|---|---|
| 筛选栏 | 上海市 + 杨浦区 | 同左 |
| 展开的地域块 | 全国 + 上海市 + 上海 **16 个区** | 全国 + 上海市 + **杨浦区** |
| 产出 | 42 条（松江 / 崇明 / 徐汇 / 普陀 / 浦东新区 … 各来一条） | 12 条 |

用户要的是杨浦区，列表里却有一半是别的区的政策 —— 这就是「结果不准确」的缺口。

**规则**（`_covered_branches()`）：一个选中节点的下辖里只要有**被显式选中的**，
展开时只走那几支（含其间的中间层级），其余下辖一概不收：

| 选择 | 展开结果 |
|---|---|
| 上海市 + 杨浦区 | 全国 / 上海市 / 杨浦区 |
| 浙江省 + 杭州市 | 全国 / 浙江省 / 杭州市 + **杭州的各区县**（杭州市自己没被下钻 → 照旧铺满） |
| 浙江省 + 西湖区 | 全国 / 浙江省 / **杭州市** / 西湖区（中间层必须保住） |
| 浙江省 | 全省全层级照旧铺开（没下钻就不收窄） |
| 内蒙古自治区 + 黑龙江省 | 两省各自铺满，仍是「数百条」量级 |

判据是 `node.path` 前缀比较：`child` 要留，**当且仅当它是某个「被显式选中的后代」本身或它的祖先**。
这一句的**方向**写反会把中间层级也筛掉（「浙江省 + 西湖区」会丢掉杭州市）—— 闸门单独立了一项盯着它。

> 闸门：`tools/verify_scope_dedup.py`（33 项，纯本地秒级）+ `verify_region_expand.mjs`【4.5】
> （真实浏览器里走「点上海市 → 点杨浦区 → 确定 → 检索」的用户路径，并断言结果里
> **一个别的区都没有**、发文机关也都是这两个地域的）。

### ★ 同名去重：同一份政策只出现一次（2026-10-15）

用户截图里《上海市促进跨境电子商务发展专项资金管理办法》连着出现两次，
一条标「单源收录」一条标「多源合并 3 条」，点进去是同一份文件。

来源有两处：远端模型自己抽了两遍；或者模型抽的与本地清单补的撞成一条
（名字只差书名号 / 空格 —— 模型往往带 `《》`，本地模板也带，但异常路径会丢）。

- **归一化键** `wrap.name_key()`：抹掉书名号 / 各类括号 / 空白 / 中英标点，统一大小写。
  只做**逐字比较**，刻意不做模糊相似度 —— 宁可漏合并两条看着像的，
  也不要把两份真不同的政策揉成一条。
- **去重键 = 归一化名 + 发文机关**，所以「同名但确由不同机关发布」的两份文件不会误伤。
- 两处落地，职责不同：
  - `search.py::_expand_catalog` 在**合并模型条目与清单条目**时用它（省配额，不产生重复）；
  - `wrap.build()` 在 `_normalize` 之后、**排序之前**再走一遍 `wrap.dedup_by_name()`（兜底全部来源）。
    顺序即优先级：模型抽的排在清单前面，所以胜出的是更可信的那条。
- 去重后 `id` 仍唯一（id 由过滤前的下标生成，跳号但不会撞）。

### 结果包装的三个硬约束

`wrap.py` 必须补全前端渲染层直接依赖的字段，否则页面会渲染出空洞或报错：

| 约束 | 原因 |
|---|---|
| `policies.items[].matched` 含 `" · "` | 详情页三问条会 `split(' · ')` 取两段 |
| `policies.items[].conditionsFull` ≥ 2 条 | 详情页取 `[1]` 做条款溯源高亮 |
| `policies.items[].sources` 非空、`confidence` 为数字 | 列表卡片与简报页直接读取 |

### 大模型接入（默认免费）

默认 `LLM_PROVIDER=auto`：**未配置 API Key 时自动使用本地免费规则引擎**（`MockProvider`），
离线、确定性、无需联网即可完整跑通链路。要接真实模型，在 `backend/.env` 配置：

```ini
# 智谱 GLM（免费额度，OpenAI 兼容）—— 主模型用 glm-4.5-flash
LLM_PROVIDER=openai
LLM_API_KEY=你的_API_Key
LLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4
LLM_MODEL=glm-4.5-flash
LLM_THINKING=off
```

其它等价的免费选项：SiliconFlow（`https://api.siliconflow.cn/v1`，有免费模型）、
OpenRouter（`https://openrouter.ai/api/v1`，模型名带 `:free` 后缀）、
本地 Ollama（`http://127.0.0.1:11434/v1`，`LLM_API_KEY` 随便填）。

### ★ 按用途分模型（2026-10-14）

一次检索会用到模型的地方有四处，**各自可配模型 / 端点 / Key / 思考开关 / 超时 / 输出上限**，
不配就继承全局那一套（不配 = 单一模型，与改造前行为完全一致）：

| 用途 | 干什么 | 性格要求 | 可覆盖的变量 |
|---|---|---|---|
| `query` | 查询理解（先解析、再检索） | 输出几十 token，跑在 20s 硬等待窗里 → **要快** | `LLM_MODEL_QUERY` … |
| `extract` | 结构化抽取（候选政策 → JSON） | 长输出，受输出 token 上限约束 | `LLM_MODEL_EXTRACT` … |
| `chat` | 详情页右栏政策对话 | 中文口语、要稳 | `LLM_MODEL_CHAT` … |
| `brief` | 导出时的 180–300 字综述 | 短输出但要文采 | `LLM_MODEL_BRIEF` … |

每个用途都支持 6 个覆盖键：`LLM_MODEL_<用途>` / `LLM_BASE_URL_<用途>` /
`LLM_API_KEY_<用途>` / `LLM_THINKING_<用途>` / `LLM_TIMEOUT_<用途>` / `LLM_MAX_TOKENS_<用途>`
（用途名大写，如 `LLM_MODEL_CHAT`）。非法值或空白一律回落全局值。
`GET /api/v1/llm/status` 会把四个用途各自解析出的模型列出来（顶层 `model` = extract 那份，旧契约不破）。

**免费档实测选型（2026-10-14，`tools/probe_models.py`，同一把 Key）**：

| 模型 | 是否免费 | 查询理解（短） | 简报综述（长） | 结论 |
|---|---|---|---|---|
| `glm-4-flash`（原默认） | 免费 | 1.3s ✅ | 4.9s / 215 字，偏泛 | 能用，但老一代 |
| `glm-4-flash-250414` | 免费 | 1.4s ✅ | — | 同代更新版 |
| `glm-4.7-flash` | 官方免费主力 200K | **连试 3 次全 429「访问量过大」** | 空 | **当前不可依赖** |
| **`glm-4.5-flash`** | 免费 | 默认 17–24s **且正文为空**；配 `LLM_THINKING=off` → **3.0s ✅** | 关思考 5.6s / 309 字，更具体 | **推荐主模型** |
| `glm-4.7-flashx` | 付费 0.5/3 元每百万 | 1.6s ✅ | — | 极低价、不限流的兜底 |

> **★ 思考型模型的坑（必读）**：GLM-4.5 / 4.7 系列会把输出预算烧在 `reasoning_content` 上 ——
> 实测 glm-4.5-flash 思考时 17~24s 仍是**空正文**（`finish_reason=length`），
> 查询理解必然超时、简报只会退化成规则文案。所以默认 `LLM_THINKING=off`，
> 客户端下发 `thinking={"type":"disabled"}`（只在模型名含 `glm` 时下发，
> 免得 SiliconFlow / Ollama / OpenRouter 因未知字段 400）。
> 另有一层**空正文自愈**：若回包「只有推理、没有正文」，客户端自动关思考再要一次，
> 配置写错也不会空手而归（`tools/verify_llm_config.py` 有 6 条断言钉住这两条）。
> 想让简报换文采：`LLM_THINKING_BRIEF=on`（单次约 20s，仍在 60s 预算内）。
>
> **查询理解阶段的耗时（实测）**：`glm-4-flash` ~1.3s → `glm-4.5-flash`（关思考）**4.6~7.1s**。
> 这一步跑在检索流水线第 0 步、检索屏的进度条此时仍是 0%（`total` 未知），
> 所以「点开始检索后约 5~7 秒里进度条不动」是正常的 —— 顶栏胶囊会显示「检索中 0%」、
> 日志区在解析完成后打出「查询解析完成 · 地域…」。想更快：`LLM_MODEL_QUERY=glm-4-flash`。

模型调用失败会自动回退规则抽取并把结果标记为低置信（`degraded: true`），前端提示「降级」。

> **超时与吞吐（实测）**：智谱 GLM-4-Flash 免费档实测约 **20 tokens/s**，
> 输出量直接决定等待时长。2026-10-15 做过一次**输出瘦身**：
> ① 模型只出**权威头部 5~8 条**（原来按 `SEARCH_MAX_ITEMS` 要 15 条），其余由本地清单引擎
> `_expand_catalog` 补齐 —— 本来就是它在铺满全量，让模型多写只是多烧时间；
> ② `conditionsEvidence` 改为**可省略**（服务端拿条款本身回原文定位，效果等价），
> 不再要求逐条复抄；
> ③ Schema 删掉 `parsed` 字段（条件四行的唯一口径是 `labels.resolve_conditions`，
> 模型写的那份从未被采纳）。
> 三项合计把「AI 结构化」单步从 **~170s 压到 ~90s 量级**。因此
> `LLM_TIMEOUT` 默认 **300s**、`LLM_MAX_TOKENS` 默认 **4096** 仍然够用。
> ⚠️ 若把 `max_tokens` 设成 2048，输出会被截断、JSON 解析失败，反而更慢。
> 前端检索屏的等待上限（`gui-prototype/data/search.json → timeoutMs`）已同步放宽到 420s；
> 期间会持续输出 `AI 结构化中 · 已等待 Ns` 心跳日志，不会看起来像卡死。
>
> **瞬时故障重试**：免费档高峰期 429（限流）与 5xx（服务端「操作失败」）都相当常见。
> 客户端对这两类**瞬时故障**做指数退避重试（默认 1 次，`LLM_MAX_RETRIES` / `LLM_RETRY_BACKOFF` 可调）；
> 对 401/403/404 这类**语义错误**不重试，直接降级。重试次数不宜调大 ——
> 每次尝试本身就是一次完整生成（~180s），次数多了总时长压不住。
>
> **代理坑（已内置规避）**：很多桌面客户端会往环境里注入 `http_proxy` / `https_proxy`，
> 一旦那个本地代理端口失效（或无法转发 HTTPS），所有外呼都会「读超时」，而实际直连是通的。
> 客户端默认 `LLM_USE_PROXY=auto`：**直连优先**；且当直连是「读超时」时**不会**再改用代理
> （读超时说明连接已建立、只是服务端慢，换通道毫无意义，只会让总耗时翻倍）。
> 仅对「连接被拒 / DNS 失败」这类连接级错误才回退代理通道。
> 若企业内网必须先走代理，设 `LLM_USE_PROXY=1`。
>
> 快速自检命令（可绕过代理直接验证 Key 是否有效，0.9s 内即出结果）：
> ```bash
> curl --noproxy '*' -s -o /dev/null -w "%{http_code}\n" \
>   -X POST https://open.bigmodel.cn/api/paas/v4/chat/completions \
>   -H "Content-Type: application/json" -H "Authorization: Bearer $LLM_API_KEY" \
>   -d '{"model":"glm-4.5-flash","messages":[{"role":"user","content":"hi"}],"thinking":{"type":"disabled"}}'
> # 200 = Key 有效；401 = Key 无效；429 = 限流或额度用尽
> ```

---

## 数据流转

```
gui-prototype/test_date.js            （假数据源，JS 对象字面量）
        │  tools/convert_test_data.py（本机 node 沙箱求值 window.TEST_DATA）
        ▼
app/data/bootstrap.json               （后端数据文件）
        │  app/bootstrap.py 加载 + 内存缓存
        ▼
GET /api/bootstrap                    （FastAPI 返回 JSON）
        │  src/data.js → loadBackend()
        ▼
前端 DATA.load() → hydrate() → boot()  （收到数据后才渲染）
```

**前端接入点**（已改）：`gui-prototype/src/data.js` 的 `loadBackend()` 优先级为
① 单文件构建版内联 `window.TEST_DATA` → ② `fetch('/api/bootstrap')` → ③ 降级注入 `test_date.js`。
即后端不可用时仍可离线演示，不白屏。

> **样例结果集是 96 条**：`test_date.js → policies.items` 里手写 3 条精编样例（杭州 / 浙江省 / 滨江区，
> 字段最全、被详情页与简报页引用），其余 93 条由文件顶部的 `_GEN_POLICIES` 按「主题 × 层级 × 地域」
> **确定性生成**（不用 `Math.random`、不读当前时间）。规模对齐 `list.pager.total`，
> 这样「共 96 条 · 每页 20 条 · 第 1 / 5 页」才不是一句空话，分页也才有东西可翻。
> 要改规模，`test_date.js → list.pager.total/perPage` 与生成器一起改，
> `build/data_test.js` 有一条守卫会拦住「声明 5 页但数据只够 1 页」的假分页。

> **地域默认值**：`regions.defaults.applied` 为空数组 —— 产品决策是**不预选任何地区**
> （未选即「全国（不限）」）。`expandPath` 只决定级联面板默认展开到哪一级，不算选择。
> 要改这个默认，改 `test_date.js` 后重跑 `python tools/convert_test_data.py` 同步
> `app/data/bootstrap.json`；前端 `build/data_test.js` 有守卫会拦住非空的 `applied`。

> **地域勾选语义**：省 / 市 / 区县**每级独立勾选**，勾「浙江省」只代表「全省」这一个条件，
> **不会**向下点亮地级市 / 区县，也**没有半选态**（设计稿 S7 原来的「选省自动携带下辖市」已按产品要求取消）。
> 实现见 `gui-prototype/src/cascade.js` 的 `stateOf()` / `toggle()`（只有一个 `Set<code>`，不递归、不拆分支），
> 回归基线在 `gui-prototype/build/cascade_test.js`（31 项断言，含「全量状态只可能是 on / off」的兜底扫描）。
> 注意：`地域多选`屏把级联面板**内嵌**在页面里（没有浮层），所以 `app.js` 的 `refreshCasc()`
> 在没有 `#cascHost` 时会回退成整屏 `render()` —— 否则点一行只改计数、界面不动。

> **首页「条件精确筛选」是四个维度**：地域（多选，来自 `regions` 字典）+ 行业 / 类型 / 截止时间
> （多选 / 多选 / 单选，来自 `data/home.json → filter.<组>.options`）。四者共用一套「触发器 → 选项面板 →
> 点确定才生效」的骨架（`FILTER_STATE` + `optTrigger()` / `optPanelHTML()` + `app.js` 的
> `mountOptPanel()`），差异只在 `filter.deadline.single = true` 表示单选。
> 生效值随检索一起提交：`industries` / `types` 用 `filter.joinSep` 拼成字符串，`deadline` 取唯一值，
> `regions` 仍是数组 —— **后端入参契约没变**，仍是三个自由字符串 + 一个数组。
> 摘要 `home.filter.summary` 按「有值才算一项」计数：未选即「不限」，清空后该维度从摘要里退场，
> 截止时间选「不限」也不计入。`build/data_test.js` 会校验三组 `options` 非空、默认值能在 `options`
> 里点亮（否则触发器会显示一个点不亮的默认值）。

> **首页底部那条蓝色横幅（`home.offline`）已按产品要求移除**：它讲的是「无网络自动切换内置样例数据」，
> 与现在的「后端在线 + 真实检索」主链路和「异常降级」屏重复。`data/home.json` 的 `offline` 键、
> `screens.css` 的 `.offline-bar` 规则、`build/data_test.js` 的必需键与 `copy_test.js` 的金标都已同步去掉；
> 能力卡改用 `margin-top:auto` 接管底部位置，避免留出一大片空白。

> **筛选面板的触发器要浮在遮罩之上**（`screens.css`：`.filterpanel .trigger,.filterbar .trigger{z-index:46}`）。
> 浮层遮罩是 `inset:0` 的整屏层，若不抬高触发器，面板展开后点触发器只会命中遮罩 ——
> 「再点一下收起」这个最直觉的操作就点不到了（这是实测撞出来的，`verify_home_filters` 有对应断言）。

---

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `HOST` / `PORT` | `127.0.0.1` / `8000` | 监听地址与端口 |
| `GUI_DIR` | `../gui-prototype` | 前端原型目录 |
| `TEST_DATA_JS` | `<GUI_DIR>/test_date.js` | 假数据源 |
| `BOOTSTRAP_JSON` | `app/data/bootstrap.json` | 后端数据文件 |
| `BOOTSTRAP_AUTO_REFRESH` | `1` | 启动时自动从 `test_data.js` 重新生成 |
| `LLM_PROVIDER` | `auto` | `auto` / `mock` / `openai`（auto：有 Key 走云端，否则本地） |
| `LLM_API_KEY` | 空 | 云端模型 API Key（留空即用本地免费规则引擎） |
| `LLM_BASE_URL` | `https://open.bigmodel.cn/api/paas/v4` | OpenAI 兼容端点 |
| `LLM_MODEL` | `glm-4.5-flash` | 主模型名（免费档；旧值 `glm-4-flash` 仍可用） |
| `LLM_THINKING` | `off` | 思考开关：`off` 下发 `thinking={"type":"disabled"}`（GLM-4.5/4.7 是思考型，**不关会把输出预算烧在推理上、正文为空**）；`on` / `auto` 亦可 |
| `LLM_MODEL_<用途>` | 空（继承 `LLM_MODEL`） | 按用途覆盖模型名。用途：`QUERY` / `EXTRACT` / `CHAT` / `BRIEF`（同族键还有 `LLM_BASE_URL_*` / `LLM_API_KEY_*` / `LLM_THINKING_*` / `LLM_TIMEOUT_*` / `LLM_MAX_TOKENS_*`） |
| `LLM_TIMEOUT` | `300` | 单次模型调用超时（秒）。免费档一次完整抽取需 ~120s，勿设太小 |
| `LLM_MAX_TOKENS` | `4096` | 单次生成上限。10 条政策约需 2300 tokens，设太小会截断 JSON |
| `LLM_USE_PROXY` | `auto` | 代理策略：`auto` 直连优先、仅连接级错误才回退代理；`0` 强制直连；`1` 强制走代理 |
| `LLM_MAX_RETRIES` | `1` | 瞬时故障（429 / 5xx）退避重试次数；401/403/404 不重试 |
| `LLM_RETRY_BACKOFF` | `2.0` | 重试退避基数（秒），指数增长 |
| `SEARCH_WORKERS` | `4` | 检索线程池大小 |
| `SEARCH_MAX_ITEMS` | `10` | 单次检索最多产出政策条数 |
| `SEARCH_KEEP_TASKS` | `50` | 内存中保留的历史任务数（LRU 淘汰） |
| `SEARCH_MIN_DURATION_MS` | `2600` | 单次检索最短耗时（避免进度一闪而过） |
| `DB_ENABLED` | `1` | 关闭即彻底停用 MySQL（账号/历史接口返回 503，检索主链路不受影响） |
| `DB_HOST` / `DB_PORT` | `127.0.0.1` / `3306` | MySQL 地址与端口 |
| `DB_USER` / `DB_PASSWORD` | `root` / 空 | 数据库账号（本机核对后写入 `.env`） |
| `DB_NAME` | `ai_policy` | 库名，启动时若不存在自动 `CREATE DATABASE` |
| `DB_CHARSET` | `utf8mb4` | 字符集 |
| `DB_POOL_SIZE` | `5` | 连接池大小 |
| `DB_CONNECT_TIMEOUT` | `5` | 单次建连超时（秒） |
| `DB_AUTO_INIT` | `1` | 启动时自动建库、执行 `schema.sql` 建表 |
| `AUTH_TOKEN_TTL_DAYS` | `7` | 登录令牌有效期（天）。到期后服务端拒绝、前端也会主动丢弃本地凭证并要求重新登录（两端口径需一致） |
| `HISTORY_KEEP_PER_USER` | `200` | 每个用户保留的检索记录上限（超出按时间淘汰） |
| `CHAT_ENABLED` | `1` | 政策对话开关。关掉后 `POST /api/v1/chat/messages` 返回 `CHAT_DISABLED`（503） |
| `CHAT_TIMEOUT` | `60` | 对话调用大模型的**硬等待窗**（秒）。真上限是 `thread.join(CHAT_TIMEOUT + 8)`，不是 socket 读超时 |
| `CHAT_MAX_TOKENS` | `700` | 单次回答的输出上限（回答要短，250 字以内） |
| `CHAT_CONTEXT_TURNS` | `6` | 带去给模型的历史轮数（多轮追问才用得上，不无限膨胀） |
| `CHAT_KEEP_PER_POLICY` | `200` | 单条政策保留的对话条数上限（超出淘汰最旧） |
| `CHAT_MAX_QUESTION_CHARS` | `500` | 单条提问字数上限，超了返回 `CHAT_BAD_REQUEST` |

以上均可写在 `backend/.env`（零依赖解析，无需 `python-dotenv`）。

### MySQL 初始化与自检

无需手工建库建表——服务启动时（`app/db.py::init()`）会依次执行：
`连接 → CREATE DATABASE IF NOT EXISTS → 执行 app/schema.sql（4 张表，均 IF NOT EXISTS）`。

```bash
# 查看数据库连接状态（服务运行中）
curl -s http://127.0.0.1:8000/api/v1/db/status

# 直接用客户端核对表与数据（本机 MySQL 8.4）
"F:/MySQL/MySQL Server 8.4/bin/mysql.exe" -uroot -proot ai_policy \
  -e "SHOW TABLES; SELECT id,username,display_name,created_at FROM users;"
```

数据库不可用时的行为：仅账号与历史接口返回 `503`，检索主链路（含游客模式）照常工作；
`/api/v1/db/status` 会给出 `driver / connected / host / database` 等诊断字段。

---

## 与架构方案的衔接

本实现严格落在方案的「视图 A」上，且已按方案预留后续演进接口：

- 数据来源目前是**文件 + 数据库**两条线：基础政策数据（`bootstrap.json`）仍是文件，
  由 `app/bootstrap.py::load()` 加载并缓存；**用户与检索记录已落 MySQL**（`users` /
  `sessions` / `search_records`），由 `app/db.py` + `app/repo.py` 统一访问。
  换数据源只需替换 `bootstrap.py::load()` / `repo.py` 内部实现，**对外契约与前端零改动**。
- 检索任务的排队执行当前是**进程内线程池**（`app/search.py::SearchService`，即方案里的
  `TaskQueue` 端口）；换 RabbitMQ / Celery 只替换本模块内部的提交方式，API 与前端契约不变。
- 抽取引擎是 **LLMProvider 端口**（`app/llm/base.py` 的 Protocol），云端模型与本地规则引擎
  可自由替换；换模型不改任何调用方代码。
- **任务状态**仍存内存（进程重启即丢，Phase-1 可接受），但**任务结果已持久化**到
  `search_records.result_json`——这正是「用户登录后即可取回上次结果、不必重复检索」的数据基础；
  接 Redis 做任务态、接对象存储放大结果，只需替换 `SearchService._tasks` 与 `repo` 的对应实现。
- **鉴权**采用自建 Bearer Token（`sessions` 表存 SHA-256 摘要），未引入 JWT / OAuth；
  若日后接入统一身份，只需替换 `app/accounts.py` 的签发与校验，前端只依赖 `/auth/*` 契约。
- 数据层为**显式 SQL、无 ORM**（PyMySQL 裸驱动 + 轻量连接池），保证表结构与索引可审计、
  便于课程答辩逐行讲解；迁移到 SQLAlchemy / Alembic 不影响上层调用。

详见 `../backend-architecture/后端架构设计方案-v1.0.md`。
