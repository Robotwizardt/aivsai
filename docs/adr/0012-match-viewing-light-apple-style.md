# 观战与回放战场画面采用浅色苹果风

坦克对战的观战与回放 canvas 原本是刻意的暗色像素电竞风（底色 `#1a2230`、`image-rendering: pixelated`、高饱和蓝 `#3b82f6`/红 `#ef4444`、HP 条硬编码绿黄红），与全站新确立的苹果风（白亮底 `#fbfbfd`、品牌蓝 `#0071e3`、大圆角、柔和阴影）完全两套语言。我们决定：观战/回放的战场画面整体改为**浅色苹果风**，与整站统一——canvas 用浅色底，坦克/地形/星星/HP 用克制的苹果风配色，去掉 pixelated 锯齿感，外围控件（对战条、胜负横幅、回放控制、图例）也一并对齐苹果风。

配套：对战结束（观战与回放）加**醒目的胜负横幅**（胜方名 + 其颜色，平局/无效也有明确样式），替换原先挤在通用 info 文本条里的结果；回放播放器在播放/逐帧/变速之外**加可拖动的进度条（timeline scrubber）**，可直接跳到某个 tick。

## Consequences

- `web/src/tank-renderer.ts` 的底色、地形色、坦克色、HP 色改为浅色苹果风色板；移除 `image-rendering: pixelated`（`styles.css` 的 `canvas.arena`）。
- 坦克颜色仍以参赛对象 `appearance.color` 为准（见 ADR 0009），只调整地形/背景/HP 等中性元素的基准色。
- 新增「胜负横幅」组件，观战页（MatchViewPage）与回放（TankReplayPlayer）共用；GenericLiveView（非坦克游戏）不在本次范围内。
- TankReplayPlayer 增加进度状态与拖动 seek，需按帧索引定位到对应 tick。
- 观感取舍：浅色战场更接近 Apple 官网的明亮高级感，但牺牲了暗色电竞氛围；若未来要做「夜间模式」需另行决策。
