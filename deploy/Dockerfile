# AI 政策搜索智能体 · 后端镜像
# 构建上下文 = deliverables/（compose 里指定），本文件位于 deploy/Dockerfile
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    TZ=Asia/Shanghai

WORKDIR /opt/app

# 先装依赖（利用层缓存：代码改动不会重装依赖）
COPY backend/requirements.txt .
# cryptography：PyMySQL 走 caching_sha2_password 认证（MySQL 8 默认）必需
RUN pip install --no-cache-dir -r requirements.txt cryptography

# 后端代码 + 数据（bootstrap.json 已随包带出，镜像内不需要 node）
COPY backend/app ./app
COPY backend/run.py ./

# 前端原型（后端同源托管 dev.html）
COPY gui-prototype /opt/gui

ENV HOST=0.0.0.0 \
    PORT=8000 \
    GUI_DIR=/opt/gui \
    BOOTSTRAP_AUTO_REFRESH=0

EXPOSE 8000

# ★ 必须单 worker：检索任务存在进程内存里，多 worker 会导致轮询跨进程取不到任务
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
