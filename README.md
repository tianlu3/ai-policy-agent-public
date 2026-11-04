# AI 政策搜索智能体（AI Policy Search Agent）

面向**国家 / 省 / 市 / 区县四级政策文件**的智能检索与问答系统：输入一句自然语言（如「杭州市智能硬件企业有哪些补贴政策」），自动完成「查询理解 → 政策源抓取 → 清洗 → 结构化 → 分类打标 → 简报综述」六步流水线，产出可直接阅读的结构化政策清单与简报文件。

单人独立完成：后端服务、前端原型、PRD、测试用例设计与交付文档。

## 核心特性

- **自然语言查询理解**：本地词表 + 大模型叠加解析，把口语化问句读成「地域 / 行业 / 类型 / 时间」四维条件，逐项标注解析来源（先解析 · 再检索）
- **LLM 双提供者架构**：`LLM_PROVIDER=auto` —— 无 Key 时自动切本地免费规则引擎（离线、确定性），配置 Key 后无缝升级为真实大模型（智谱 GLM 等 OpenAI 兼容端点）
- **按用途分模型**：查询理解 / 结构化抽取 / 政策对话 / 简报综述四类任务可分别配置模型、超时与思考开关（`LLM_MODEL_QUERY` 等）
- **账号与持久化**：注册 / 登录（PBKDF2 密码哈希 + Bearer Token）/ 企业档案 / 检索记录落 MySQL，登录后直接回放上次结果；支持 SQLite 兜底与游客模式
- **前端契约稳定**：`GET /api/bootstrap` 一次返回 10 个命名空间全量配置；前端「收到数据才渲染」，并内置多级降级
- **工程化交付**：Docker 部署、端口守护、回归验证脚本、真实浏览器端到端校验一应俱全

## 技术栈

| 层 | 技术 |
|---|---|
| 后端 | Python 3.12+ · FastAPI · Uvicorn · PyMySQL（无 ORM） |
| 大模型 | OpenAI 兼容协议（智谱 GLM-4.5-Flash 等免费档）· 本地规则引擎兜底 |
| 数据 | MySQL 8.4（可切 SQLite）· 前端数据源 `test_date.js → bootstrap.json` |
| 前端 | 原生 HTML/JS 原型（FastAPI 同源托管） |
| 工程化 | Dockerfile · docker-compose · 验证脚本（Node/.mjs）· 真实浏览器 E2E |

## 快速开始

```bash
# 1. 配置（最小化启动可完全零 Key、离线运行）
cd backend
cp .env.example .env        # 按需填写 LLM_API_KEY / MySQL 连接

# 2. 安装依赖
pip install -r requirements.txt

# 3. 启动
python run.py               # 默认 http://127.0.0.1:8000，同源托管前端
```

Docker 方式与完整部署说明见 [`deploy/部署指南.md`](deploy/部署指南.md)。

## 目录结构

```
├── backend/            # FastAPI 后端（含 1466 行架构级 README，建议从它读起）
│   ├── app/            # 业务源码：检索流水线 / LLM 端口 / 账号域 / 数据层
│   └── tools/          # 诊断与端到端验证脚本
├── gui-prototype/      # 前端原型（src + 构建产物 + 数据源）
├── deploy/             # Dockerfile / docker-compose / 部署指南
└── docs/               # PRD · 路线图 · 功能测试用例集
```

## 文档

- [`backend/README.md`](backend/README.md) —— 后端架构与模块详解（推荐从这里开始）
- [`docs/PRD-产品需求文档.md`](docs/PRD-产品需求文档.md) —— 完整 PRD（v1.5，含修订记录）
- [`docs/功能测试用例集.xlsx`](docs/功能测试用例集.xlsx) —— 功能测试用例

## 安全说明

仓库不含任何真实密钥与数据库文件：所有凭据通过 `.env` 注入（模板见 `.env.example`），运行时数据库文件已被 `.gitignore` 排除。
