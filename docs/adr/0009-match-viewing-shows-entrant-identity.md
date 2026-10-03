# 观战与回放显示参赛对象真实名字与外观颜色

对局摘要（matchSummary）本已下发每个参赛方的 `name`（bot 解析为「名字（内置基准）」），但直播观战页与回放组件硬编码了「参赛方 0/参赛方 1」占位名、坦克颜色也写死蓝/红，用户看不出谁是谁。我们决定：观战/回放/试跑统一显示参赛对象真实名字，并用其 `appearance.color` 作为战场颜色；内置 bot 没有外观，回退固定中性色（灰）；两个真实参赛对象撞色时不做额外处理（HP 条与名字已足以区分）。同时发起对局成功后直接跳转直播观战页（`#/match/:id`），而不是留在工作台只给一串 matchId 链接。

## Consequences

- 后端 `matchSummary` 的 `entrants` 条目需补 `appearance`（color/preset），`GET/POST /api/matches*` 响应体积略增；`web/src/types.ts` 的 `MatchSummary` 同步。
- 渲染器不再用 `TANK_SIDE_COLORS` 固定色，改读 entrants 的 `appearance.color`，缺失时回退 bot 灰。
- 颜色取自用户自选值，敌我撞色时不加描边等修正逻辑——这是有意的简化。
