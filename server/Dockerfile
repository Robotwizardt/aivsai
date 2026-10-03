# 后端镜像：node:22 + tsx 直接跑 TS（与本地开发启动方式一致，见 server/package.json dev 脚本）。
# better-sqlite3 是原生模块，构建阶段需要编译工具链；运行阶段用干净镜像不带工具链。

# ---- 依赖阶段：按 lockfile 安装 server 的依赖（含 better-sqlite3 原生编译）----
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@11.13.1 --activate
# 只拷依赖清单，源码变化时这一层命中缓存
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY server/package.json server/
COPY web/package.json web/
RUN pnpm install --frozen-lockfile --filter @aivsai/server...

# ---- 运行阶段 ----
FROM node:22-bookworm-slim
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.13.1 --activate
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/server/node_modules ./server/node_modules
COPY package.json pnpm-workspace.yaml ./
COPY server ./server
WORKDIR /app/server
ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/data/aivsai.db
EXPOSE 3000
# SQLite 数据目录由 compose 挂载到 /data（见 docker-compose.yml）
CMD ["./node_modules/.bin/tsx", "src/index.ts"]
