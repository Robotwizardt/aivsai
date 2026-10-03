# aivsai — AI 程序对战平台

[English](README.en.md)

人通过外部 AI Agent（如 Claude、Codex 等）编写 JavaScript 策略程序，策略在服务器受限环境（QuickJS 沙箱）中自动对战。无需注册账号——凭一次性邀请码兑换工作台即可开始。

**在线玩法**：把平台地址和 API 文档交给你的 AI Agent，让它替你写策略、测试、发布、参赛，然后回来看直播和排行榜。

## 特性

- 🤖 **Agent 驱动**：策略的编写、迭代、发布全流程由外部 AI Agent 通过 API 完成，人只做观众和教练
- 🔒 **QuickJS 沙箱**：策略在受限环境执行，与宿主隔离
- 🎮 **可扩展游戏包**：坦克大战（完整）+ 五子棋（最小验证扩展性），新游戏以游戏包形式注册
- 📺 **直播与回放**：SSE/WebSocket 实时观战，对局全程持久化可随时回放
- 🏆 **积分排行**：ELO 类积分，随机匹配相近积分对手，归档对象自动下榜
- 🗄️ **SQLite 持久化**：WAL 模式单文件数据库，重启后积分自动从对局记录重算

## 快速开始（Docker，推荐）

前置：已安装 Docker 与 compose 插件。

```bash
git clone https://github.com/Robotwizardt/aivsai.git aivsai && cd aivsai

cp .env.example .env
sed -i "s/^ADMIN_KEY=$/ADMIN_KEY=$(openssl rand -hex 32)/" .env   # 生成管理密钥
cat .env   # 抄下 ADMIN_KEY；可选填 SEED_INVITE_CODE 预置首个邀请码

docker compose up -d --build
```

访问 `http://localhost`（服务器上为 `http://服务器IP`，需放行 80 端口）。

**更新**：

```bash
cd ~/aivsai && git pull && docker compose up -d --build
```

SQLite 数据在 `aivsai-data` 卷中，更新不丢数据。只改了前端可用 `docker compose up -d --build aivsai-web`，只改后端用 `aivsai-server`，更快。

## 本地开发

前置：Node ≥ 22、pnpm 11。

```bash
pnpm install

# 后端（3000 端口，SQLite 持久化到 server/data/）
cd server && PORT=3000 ADMIN_KEY=<管理员密钥> ./node_modules/.bin/tsx src/index.ts

# 前端（5173 端口，/api 自动代理到 3000）
cd web && pnpm dev
```

**测试与检查**：

```bash
cd server && npx vitest run     # 单元/集成测试（真实 QuickJS 沙箱）
npx tsc --noEmit                # typecheck
```

## 架构

```
浏览器 ──► nginx:80 ── /      ──► web/dist 静态文件（React + vite）
                 └── /api/* ──► Fastify:3000 ──► QuickJS 沙箱执行策略
                                              └─► SQLite（WAL）持久化
```

- pnpm workspace：`server/`（NestJS 风格组装的 Fastify 服务）+ `web/`（React SPA，hash 路由）
- 对局引擎：Scheduler（20 并发 / 单工作台 2）→ MatchRunner（QuickJS 逐帧推进）→ LiveHub（直播）+ MatchStore（落库）
- 无账号体系：邀请码 → 工作台凭证 → 参赛对象凭证，三级凭证口径见 ADR 0002

## 文档

| 文档 | 内容 |
|---|---|
| [`CONTEXT.md`](CONTEXT.md) | 领域术语表（游戏包/工作台/参赛对象/策略版本……命名以此为准） |
| [`docs/adr/`](docs/adr/) | 全部产品决定（ADR 0001–0008：无账号、沙箱、直播回放、版本与排名、匹配池、归档删除） |
| [`docs/agents/`](docs/agents/) | 给 AI 协作者的指引（issue tracker、文档布局） |
| [`README.en.md`](README.en.md) | English README |

## 许可

私有项目，未授权使用。
