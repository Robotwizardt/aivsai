# 前端镜像：vite 构建出静态文件后塞进 nginx，由 nginx 托管并反代 /api 到后端容器。

# ---- 构建阶段 ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.13.1 --activate
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY web/package.json web/
RUN pnpm install --frozen-lockfile --filter web
COPY web ./web
RUN pnpm --filter web build

# ---- 运行阶段：nginx 托管 dist + 反代 /api ----
FROM nginx:alpine
COPY --from=build /app/web/dist /usr/share/nginx/html
# conf.d 下所有 .conf 都会被主配置 include；ws-map.conf 提供 WebSocket 升级用的 $connection_upgrade
COPY deploy/ws-map.conf /etc/nginx/conf.d/00-ws-map.conf
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
