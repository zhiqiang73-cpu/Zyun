# Manuscopy 部署镜像（Sealos / Railway / 任何支持 Docker 的容器平台）
#
# 内含 Node 20 + Python 3 + PyMuPDF（用于 parse_pdf.py）。
# 持久化目录：/app/data（sessions/events）和 /app/workspaces（任务沙箱）
# —— 部署时挂载持久卷到这两个路径，否则重启会丢历史。

FROM node:20-bookworm-slim

# ---- 系统依赖：Python 3 + 构建链 ----
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        python3 \
        python3-pip \
        python3-venv \
        build-essential \
        ca-certificates \
        curl \
    && rm -rf /var/lib/apt/lists/* && \
    # 让 `python` 等同 `python3`（Manuscopy system prompt 同时支持两种调用）
    ln -sf /usr/bin/python3 /usr/local/bin/python

WORKDIR /app

# ---- Node 依赖（独立层利于缓存）----
COPY package*.json ./
RUN npm ci --no-audit --no-fund

# ---- Python 依赖 ----
COPY requirements.txt ./
RUN pip3 install --break-system-packages --no-cache-dir -r requirements.txt

# ---- 源代码 ----
COPY . .

# ---- 构建 Next.js（生成 .next/） ----
RUN npm run build

# ---- 创建运行时目录（Sealos 挂载持久卷到这两个路径）----
RUN mkdir -p /app/data /app/workspaces

ENV NODE_ENV=production
ENV PORT=3000
ENV NEXT_TELEMETRY_DISABLED=1

EXPOSE 3000

CMD ["npm", "start"]
