# 浏览器回归

`browser-regressions.js` 使用真实 React 页面和固定 API 响应，验证对象切换、座位身份和文档响应式布局。固定凭据仅用于拦截的请求，不需要数据库或真实账号，也不会修改业务数据。

依赖环境中已有的 `playwright-cli` 和 Edge；仓库不新增依赖。请使用专用浏览器会话，不要在个人登录窗口执行。

从仓库根目录执行：

```bash
# 终端一：启动前端
pnpm --filter web dev --port 5186 --strictPort

# 终端二：执行回归，任何断言失败都会报错并返回非零状态
playwright-cli -s=regression open http://127.0.0.1:5186 --browser=msedge
playwright-cli -s=regression run-code --filename=web/test/browser-regressions.js
playwright-cli -s=regression run-code --filename=web/test/stream-diagnostics.js
playwright-cli -s=regression close
```

覆盖范围：

- 对象 A 的未发布草稿不出现在对象 B。
- 有效座位切换到无效座位，旧身份被清除。
- 五子棋黑先白后，象棋红先黑后。
- 四套主题下 375px、900px、901px 的 Agent 指南没有整页横向溢出。

`stream-diagnostics.js` 另行验证真实客户端 API：终局后按权限补读诊断、游客不读取私密诊断、摘要失败或超时仍返回公共结果、关闭后不回调，以及凭据只通过 Authorization 而非 URL 传递。

## 黑白棋表演赛

- `reversi-view.js`：开局占位、双方子数、同方连续落子记谱，以及四主题 × 三种宽度布局。
- `reversi-e2e.js`：真实 UI 创建、座位读取、60 手双端提交、独立规则逐步校验、自动跳过、终局直播、刷新回放，以及开局/逐帧/播放暂停/终局控件。

端到端脚本会创建测试账号和对局，**只能对专用临时数据库运行**。每次执行前重启内存后端并新建专用浏览器会话：邀请码为一次性，不能在上一次运行的数据库上直接重跑。下面的邀请码只用于本地测试，不得用于生产。

```bash
# 终端一：独立内存后端，重跑前结束该进程并重新启动
PORT=3118 DATABASE_PATH=:memory: ADMIN_USERNAME=reversi_test_admin \
ADMIN_PASSWORD="$(node -e "process.stdout.write(require('crypto').randomUUID())")" \
SEED_INVITE_CODE=reversi-browser-fixture \
pnpm --filter @aivsai/server exec tsx src/index.ts

# 终端二：代理到上述测试后端
VITE_BACKEND_URL=http://127.0.0.1:3118 pnpm --filter web dev --port 5188 --strictPort

# 终端三：专用浏览器，固定响应测试和真实端到端各用一个新会话
playwright-cli -s=reversi-view open http://127.0.0.1:5188 --browser=msedge
playwright-cli -s=reversi-view --raw run-code --filename=web/test/reversi-view.js
playwright-cli -s=reversi-view close
playwright-cli -s=reversi-e2e open http://127.0.0.1:5188 --browser=msedge
playwright-cli -s=reversi-e2e --raw eval '() => { window.__REVERSI_INVITE = "reversi-browser-fixture"; return true; }'
playwright-cli -s=reversi-e2e --raw run-code --filename=web/test/reversi-e2e.js
playwright-cli -s=reversi-e2e close
```

## 生产构建生命周期验收

- `reversi-lifecycle.js`：真实剪贴板的两个座位链接与观战链接、游客观战、命名、暂停恢复、非轮次拒绝、SSE 实时子数、直播中回看、刷新、解散、私密大厅隔离及累计三错判负，共 28 项检查。
- `board-polling.js`：固定网络故障，分别挂起摘要与表演赛元数据，验证两者独立更新。无需账号或邀请码，可直接重跑。
- 问题及修复记录见 [黑白棋浏览器验收记录](reversi-audit.md)。

真实生命周期和完整对局脚本均可在生产构建上运行：

```bash
pnpm build
pnpm --filter web build
# 终端一：沿用上文的内存库及环境变量，将 tsx src/index.ts 换成 node dist/index.js
# 终端二：用 preview 代替 dev，仍代理到临时后端
VITE_BACKEND_URL=http://127.0.0.1:3118 pnpm --filter web exec vite preview --host 127.0.0.1 --port 5188 --strictPort
# 终端三：每个真实用例使用新内存库及新浏览器会话，一次性邀请码同上
playwright-cli -s=reversi-audit open http://127.0.0.1:5188 --browser=msedge
playwright-cli -s=reversi-audit --raw eval '() => { window.__REVERSI_INVITE = "reversi-browser-fixture"; return true; }'
playwright-cli -s=reversi-audit --raw run-code --filename=web/test/reversi-lifecycle.js
playwright-cli -s=reversi-audit --raw run-code --filename=web/test/board-polling.js
playwright-cli -s=reversi-audit close
```

`reversi-view.js` 和 `stream-diagnostics.js` 直接导入源码模块，只在 dev 服务上运行，不要在 preview 上执行。生命周期脚本默认断言失败返回非零；仅收集问题时可临时设置 `window.__REVERSI_AUDIT_REPORT_ONLY=true`，正式验收不要启用。

这些测试是独立浏览器检查，**不包含在 `pnpm test` 中**。后端真实 SSE 权限与黑白棋规则/HTTP 回归由 server 的 Vitest 套件执行。
