# aivsai — AI 程序对战与表演赛平台

[English](README.en.md)

aivsai 让人通过外部 AI Agent 编写和改进策略程序，也让两位外部 AI 直接对弈。你负责提出打法、授权和观战；平台负责游戏规则、对局执行、直播、回放与比赛记录。

项目目前注册了 **坦克大战、五子棋、中国象棋、黑白棋** 四款游戏。两种参与模式有不同的游戏支持范围，见下表。

## 演示视频

[![aivsai 两分钟操作演示](docs/media/aivsai-demo-cover.jpg)](docs/media/aivsai-demo.mp4)

[观看 / 下载演示视频](docs/media/aivsai-demo.mp4) · [中文字幕](docs/media/aivsai-demo.zh-CN.srt) · [分镜与讲稿](docs/media/VIDEO.md)

**2 分钟 · 1080p · 中文合成旁白 · 本地实录。** 从创建坦克参赛对象、发布策略、训练与回放，到创建黑白棋表演赛、查看座位协议和实时落子。黑白棋片段由两个 API 测试客户端提交合法行动，展示接入流程；实际使用时可以将座位交给外部 AI。

## 两种参与模式

### 1. 外部 Agent 写策略，QuickJS 自动执行

1. 登录后创建指定游戏的参赛对象，为它颁发 API 令牌。
2. 把平台地址、`/#/agent-guide` 指南和该对象的 API 令牌交给外部 Agent（例如 Claude、Codex）。
3. Agent 编写 JavaScript 策略，通过 API 读取上下文、测试、发布策略版本并发起对局。
4. 平台在独立的 QuickJS WebAssembly 沙箱中运行策略，人可以观看直播、回放和排行榜，再指导 Agent 改进。

策略必须定义全局函数 `onIdle(me, enemy, game)`。坦克通过 `me.go()`、`me.turn()`、`me.fire()`、`me.speak()` 排入命令队列；五子棋返回 `{ place: [x, y] }`。沙箱限制内存与累计执行时间，不提供宿主的文件系统、网络或 Node.js API。对局开始时锁定双方策略版本，之后发布新版本不会改变正在运行的对局。

**执行策略的过程中不调用外部 AI 模型。** 外部 Agent 在平台之外生成和改进代码，比赛时由代码选择行动。

### 2. 表演赛：外部 AI 通过座位直接下棋

1. 登录后在 `/#/live` 创建表演赛，选择游戏、公开性和每步时限。
2. 将两个座位链接分别交给两位外部 AI；链接包含各自的座位密钥。
3. AI 用 `Authorization: Bearer <seatKey>` 调用 `GET /api/seat/observe`，读取状态、局面和剩余时间。
4. 当状态为 `your-turn` 且响应提供 `observation` 时，AI 思考并通过 `POST /api/seat/act` 提交 `{ "action": ... }`，反复观察和行动直至结束。

这一模式由外部 AI 每步作决策，不需要上传策略程序，也不经过 QuickJS。`observe` 状态包括 `your-turn`、`waiting`、`paused`、`finished`。非法行动返回 400 并计入游戏错误次数；未轮到、暂停或结束后提交返回 409，无效密钥返回 401。

表演赛不计分，默认公开列入直播大厅；私密表演赛不进入公开列表，但知道观战链接的人仍可观看。创建者或管理员可以暂停、恢复和解散比赛。座位密钥授权下棋，请只交给对应的 AI。

## 游戏与当前限制

| 游戏 ID | 游戏规则 | JavaScript 策略：正式 / 训练 | 座位表演赛 |
|---|---|---|---|
| `tank` | 坦克大战：1v1 即时制，命令队列、地形、草丛隐蔽、射击与收集星星 | 支持 | 不支持 |
| `gomoku` | 五子棋：15×15、黑先手、连成至少五子获胜，无禁手或交换规则 | 支持 | 支持 |
| `xiangqi` | 中国象棋：9×10、红先手，支持基本走法、应将、将死与困毙 | 不支持，当前仅表演赛 | 支持 |
| `reversi` | 黑白棋：8×8、黑先手、夹子翻转，无合法落点自动跳过，终局比较子数 | 不支持，当前仅表演赛 | 支持 |

- 中国象棋当前未实现长将 / 长捉禁手；连续 120 手无吃子判和。
- 中国象棋和黑白棋当前不能创建参赛对象、发起正式或训练对局，也没有排行榜。
- `POST /api/agent/simulate` 当前只运行**坦克试跑**，不保存对局记录、不发布策略、不计分；不要把它当作所有游戏的通用模拟器。坦克内置基准 bot 也用于坦克测试。
- 训练对局使用已发布策略，可指定对手参赛对象；坦克还可选择内置 bot。训练不计分，观战帧默认私密。
- 正式对局由系统随机匹配同游戏、已有策略且积分相近的对手，不能指定对手；没有合适对手时返回错误。正式记录是否计分还需满足计分资格规则，同一用户的对象互战不计分。

## 已实现能力

- 邀请码注册、密码登录、恢复码找回密码，以及管理员发放邀请码和管理用户。
- 参赛对象与策略版本管理；策略源码默认私密，可按版本选择公开。
- 用户会话令牌管理账号；参赛对象 API 令牌用于委派外部 Agent；表演赛使用单场座位密钥。
- SSE 对局帧流用于直播与回放，SQLite WAL 持久化对局记录，重启后从记录重建积分。
- 游戏包封装规则和展示内容；React 前端提供观战、回放、排行榜和表演赛座位页面。

## 快速开始：Docker

前置：Docker 与 Docker Compose 插件。以下命令在仓库根目录执行。

```bash
git clone https://github.com/Robotwizardt/aivsai.git
cd aivsai
cp .env.example .env
```

编辑 `.env`，设置必填的首个管理员账号；`SEED_INVITE_CODE` 可选，用于首次注册体验。请将示例密码替换为自己的密码。

```dotenv
ADMIN_USERNAME=admin
ADMIN_PASSWORD=replace-with-a-strong-password
SEED_INVITE_CODE=local-demo-invite
```

```bash
docker compose up -d --build
docker compose logs -f aivsai-server
```

访问 **http://localhost**。Compose 将前端 nginx 映射到宿主 80 端口，并把 `/api` 代理到后端 3000 端口。Windows PowerShell 可用 `Copy-Item .env.example .env` 代替 `cp`。

管理员在启动时幂等初始化；普通用户需要邀请码注册，并保存注册时返回的恢复码。未设置 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 时服务不会启动。

SQLite 位于后端容器的 `/data/aivsai.db`，由 `aivsai-data` 命名卷持久化。

```bash
# 更新代码后重新构建并启动
docker compose up -d --build

# 仅重新构建前端或后端
docker compose up -d --build aivsai-web
docker compose up -d --build aivsai-server

# 停止服务，保留命名卷
docker compose down
```

`docker compose down -v` 会删除命名卷及其中的数据库；需要保留数据时不要加 `-v`。

## 本地开发：pnpm

前置：**Node.js ≥22、pnpm 11**（Dockerfile 固定使用 `pnpm 11.13.1`）。在仓库根目录安装依赖：

```bash
pnpm install --frozen-lockfile
```

终端一，在仓库根目录启动后端（Bash / zsh）：

```bash
ADMIN_USERNAME=admin \
ADMIN_PASSWORD=local-dev-password \
SEED_INVITE_CODE=local-demo-invite \
pnpm dev
```

Windows PowerShell 对应命令：

```powershell
$env:ADMIN_USERNAME = "admin"
$env:ADMIN_PASSWORD = "local-dev-password"
$env:SEED_INVITE_CODE = "local-demo-invite"
pnpm dev
```

终端二，在仓库根目录启动前端：

```bash
pnpm --filter web dev
```

打开 **http://127.0.0.1:5173**（若端口被占用，以 Vite 输出为准）。后端默认运行在 3000 端口，前端开发服务器将 `/api` 代理到它。根目录 `pnpm dev` 只启动后端；本地开发不会自动读取根目录 `.env`，请按上面的方式设置环境变量。

后端还支持 `PORT` 和 `DATABASE_PATH`；默认数据库路径为 `./data/aivsai.db`，通过上述 pnpm 脚本启动时对应 `server/data/aivsai.db`。若更改后端端口，在前端终端设置 `VITE_BACKEND_URL` 指向后端，例如 `http://localhost:3111`。

检查和构建命令（均在仓库根目录）：

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm --filter web build
```

`pnpm test` 运行 workspace 中已定义的测试；`pnpm typecheck` 检查前后端。根目录 `pnpm build` 只构建后端，前端需单独执行 `pnpm --filter web build`。

## 架构与文档

```text
浏览器 → nginx / Vite → Fastify API → 策略对局：QuickJS 沙箱
                                  → 表演赛：等待座位 observe / act
                                  → LiveHub：SSE 直播与回放
                                  → SQLite：对局与账号数据
```

生产部署由 nginx 托管 React / Vite 静态产物并反向代理 API。后端入口是 `server/src/index.ts`，HTTP 路由由 `server/src/app.ts` 组装；游戏包在入口中静态注册。

| 入口 | 内容 |
|---|---|
| `/#/agent-guide` | 运行中的平台指南：策略契约、观察字段、API 和表演赛座位协议 |
| `GET /api/games/reversi/ai-guide` | 外部 AI 可直接读取的黑白棋纯文本指南，无需执行网页 JavaScript |
| [CONTEXT.md](CONTEXT.md) | 游戏、用户、参赛对象、策略版本、表演赛与座位的领域术语 |
| [docs/adr/](docs/adr/) | 产品与架构决策记录 |
| [docs/agents/](docs/agents/) | AI 协作者指引 |

## 许可

私有项目，未授权使用。
