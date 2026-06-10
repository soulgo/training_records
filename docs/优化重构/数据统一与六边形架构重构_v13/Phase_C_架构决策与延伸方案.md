# Phase C：架构决策与延伸

> 本节记录当前架构决策的理由，以及未来可能的延伸方向。不为兼容性妥协，不为重构成本退缩——选择最适合目标架构的方案。

## C1. 架构决策记录：Hexo 静态生成 vs 动态站点

### 决策

**保留 Hexo 静态生成**，数据源从 `tools/generate-training-data.mjs` 查询 PostgreSQL 后生成 `_data/*.json`。

### 理由

- 当前内容量（训练记录、随想）适合静态生成
- GitHub Pages 托管成本低，无需维护服务器
- 静态页面加载速度快，SEO 友好
- `tools/generate-training-data.mjs` 已经实现从 PostgreSQL 读取数据生成 JSON

### 当前实现

```javascript
// tools/generate-training-data.mjs（当前代码）
// 从 PostgreSQL 查询数据，生成 Hexo _data/*.json
```

### 何时考虑切换到动态站点

- 内容量超过 10,000 条，静态生成时间 > 5 分钟
- 需要实时数据展示（如实时心率、运动轨迹）
- 需要用户交互功能（如评论、分享、社交登录）

## C2. 构建时间优化

### 当前问题

随着数据量增长，`npm run build:data`（即 `tools/generate-training-data.mjs`）生成时间可能变长。

### 解决方案

**增量构建**：只重新生成有变化的页面

```javascript
// tools/generate-training-data.mjs（改进后）
export async function incrementalBuild() {
  const lastBuildTime = await getLastBuildTime();

  // 只查询上次构建后变化的数据
  const changedDays = await pg.query(
    'SELECT * FROM core.training_day WHERE updated_at > $1',
    [lastBuildTime]
  );

  // 只重新生成变化的页面
  for (const day of changedDays.rows) {
    await regenerateTrainingDayPage(day);
  }

  await updateLastBuildTime();
}
```

**缓存策略**：Hexo 生成结果缓存

- 未变化的 Markdown 不重新渲染
- 静态资源（图片、CSS、JS）使用 CDN 缓存
- 数据库查询结果缓存 5 分钟（构建期间）

**数据量评估**：

- 当前训练记录：约 365 条/年
- 5 年数据量：约 1,825 条
- Hexo 生成时间估算：约 30 秒（可接受）
- 10 年数据量：约 3,650 条，生成时间约 1 分钟（仍可接受）

**结论**：短期内不需要切换动态站点，增量构建足够应对。

## C3. 按需渲染（如果数据量过大）

### 触发条件

- Hexo 生成时间 > 5 分钟
- 或内容量 > 10,000 条

### 方案

混合模式：最近 1 年静态生成，更早数据按需加载

```javascript
// 构建时只生成最近 1 年
const recentDays = await pg.query(
  'SELECT * FROM core.training_day WHERE date > NOW() - INTERVAL \'1 year\''
);

// 更早数据通过 API 按需加载
// /api/training-day?date=2023-01-15
app.get('/api/training-day', async (req, res) => {
  const day = await pg.query(
    'SELECT * FROM core.training_day WHERE date = $1',
    [req.query.date]
  );
  res.json(day.rows[0]);
});
```

### 前端实现

```javascript
// 页面加载时按需获取历史数据
async function loadHistoricalData(date) {
  const response = await fetch(`/api/training-day?date=${date}`);
  const data = await response.json();
  renderTrainingDay(data);
}
```

## C4. 架构决策记录：`src/jobs/` 的定位

### 决策

`src/jobs/` 目录中的文件（`telegram-sync-job.mjs`、`training-analysis-job.mjs`、`generate-training-data-job.mjs`）应归类为**应用层 Use Cases**。

### 理由

- Job 层负责编排领域服务和适配器，属于应用层职责
- 在六边形架构中，Use Case 层负责业务用例的编排
- `src/jobs/` 不应包含领域逻辑（领域逻辑应在 `src/core/`）

### 实施

```
src/app/
└── use-cases/
    ├── telegram-sync.use-case.mjs       # 从 telegram-sync-job.mjs 迁移
    ├── training-analysis.use-case.mjs  # 从 training-analysis-job.mjs 迁移
    └── generate-training-data.use-case.mjs  # 从 generate-training-data-job.mjs 迁移
```

**注意事项**：
- 迁移时保持 Job 调度入口（GitHub Actions cron 或本地定时任务）不变
- Use Case 只负责编排逻辑，不直接操作数据库

## C5. `src/shared/` 的定位

### 决策

`src/shared/` 中的工具函数（`format.mjs` 等）应归类为**基础设施层共享工具**。

### 实施

```
src/infra/
└── shared/
    └── format.mjs      # 从 src/shared/ 迁移
```

或保留为独立的 `src/shared/`（如果它确实不包含任何领域知识）。

## C6. 文档更新

### 部署维护文档

更新 `docs/部署维护/`：

- `日常维护手册.md`：添加数据迁移、缓存刷新、Webhook 配置说明
- `GitHub与Cloudflare配置.md`：更新 Cloudflare Worker Webhook 配置
- 新增 `数据迁移手册.md`：详细说明 SQLite → PostgreSQL 和 CSV → PostgreSQL 迁移步骤（已完成的迁移归档）

### 系统架构文档

更新 `docs/系统架构/`：

- `系统架构图.drawio`：创建六边形架构全景图
- `模块依赖图.drawio`：创建 Core / Adapters / App / Infra 四层依赖图
- `数据流图.drawio`：创建单一 PostgreSQL 数据源数据流图
- `系统总览.md`：更新架构描述，删除 MCP 相关内容
- `内部接口手册.md`：更新所有 Port 接口文档

### 其他文档

- `README.md`：更新安装和运行说明，添加六边形架构概述
- `docs/历史归档/`：保留旧方案作为历史参考，明确标记为已废弃
- 新增 `docs/系统架构/六边形架构指南.md`：详细说明架构原则、目录结构和开发规范

## 延伸方向评估

| 方向 | 价值 | 成本 | 优先级 |
| --- | --- | --- | --- |
| Telegram Webhook 模式 | 降低延迟、减少 API 调用 | 中（需要 HTTPS 端点） | 高 |
| 训练数据可视化（ECharts） | 用户体验提升 | 低（前端工作） | 中 |
| 训练计划自动编排 | 核心功能增强 | 高（AI 规划逻辑） | 中 |
| 多用户支持 | 扩展用户群体 | 极高（权限、隔离） | 低 |
| PWA 离线支持 | 移动端体验 | 中（Service Worker） | 低 |
| 训练社区分享 | 社交属性 | 高（后端 + 审核） | 低 |
