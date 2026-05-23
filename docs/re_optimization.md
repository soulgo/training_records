# re_optimization

## 目标

本轮采用保守首轮策略，在不改变业务逻辑、接口协议、数据库结构、环境变量、数据来源和现有部署方式的前提下，做渐进式重构优化。

## 原则

- 不做大规模推翻式重构
- 每次修改都保持可运行
- 优先处理高收益、低风险问题
- 不删除公开导出和现有 npm scripts
- 兼容现有部署方式

## 基线

- 重构前已验证：`npm test` 全量 173 个测试通过
- 本轮重构过程中持续用针对性测试和全量测试回归验证

## 重构前后目录结构

### 重构前

```text
docs/
tools/
  telegram-sync.mjs
  telegram-sync-lib.mjs
  telegram-thoughts.mjs
  training-analysis.mjs
  training-db-write.mjs
  backfill-thoughts-to-core.mjs
  lib/
    format.mjs
test/
```

### 重构后

```text
docs/
  re_optimization.md
tools/
  telegram-sync.mjs
  telegram-sync-lib.mjs
  telegram-thoughts.mjs
  training-analysis.mjs
  training-db-write.mjs
  backfill-thoughts-to-core.mjs
  lib/
    format.mjs
    thought-modules.mjs
    http-retry.mjs
test/
```

## 本轮修改

### 1. 抽取随想模块规则

涉及文件：`tools/lib/thought-modules.mjs`，`tools/telegram-sync-lib.mjs`，`tools/telegram-thoughts.mjs`，`tools/training-db-write.mjs`，`tools/backfill-thoughts-to-core.mjs`，`tools/telegram-sync.mjs`

原因：`workout / misc` 的归一化、标签和中文标签解析在多个模块中重复，容易出现分叉。

风险：低。只抽取纯函数，不改协议和存储格式。

验证：`node --test test/telegram-sync.test.mjs test/telegram-sync-runner.test.mjs`，`node --test test/thoughts-page.test.mjs test/backfill-thoughts-to-core.test.mjs`。

### 2. 抽取 HTTP retry

涉及文件：`tools/lib/http-retry.mjs`，`tools/training-analysis.mjs`，`tools/telegram-sync.mjs`

原因：AI/HTTP 重试逻辑重复，统一后更容易维护重试次数、状态码和错误语义。

风险：低。保留了原有重试次数、退避节奏和最终报错行为。

验证：`node --test test/training-analysis.test.mjs`。

### 3. 收敛 Telegram thought 持久化分支

涉及文件：`tools/telegram-sync.mjs`

原因：`thought / thought_edit / thought_delete / thought_move` 的写文件、入库和失败入队逻辑原本分散，合并后减少重复分支。

风险：中。触碰 thought 主流程，但没有改协议和数据结构。

验证：`node --test test/telegram-sync.test.mjs test/telegram-sync-runner.test.mjs`。

### 4. 优化 thought 文件查找

涉及文件：`tools/telegram-thoughts.mjs`

原因：按 message id 查找随想文件时，先走直接后缀命中，再回退全量扫描，减少无命中时的重复遍历。

风险：低。只改变查找路径的执行顺序，不改变结果。

验证：thought 相关测试覆盖 duplicate、edit、delete、move 场景。

### 5. 删除私有 dead code / 冗余包装

涉及文件：`tools/telegram-sync-lib.mjs`，`tools/telegram-thoughts.mjs`

已删除：

- `telegram-sync-lib.mjs` 中未使用的 `hasRecognizableImage`
- `telegram-thoughts.mjs` 中不再需要的 `readThoughtPhotoPathsFromPost`
- 若干只做单行转发、没有额外价值的本地包装

风险：低。仅删私有或可由共享 helper 直接替代的逻辑。

验证：全量测试通过。

## Dead code 扫描结果

### 本轮删除

- `tools/telegram-sync-lib.mjs` 中私有且无引用的 `hasRecognizableImage`
- `tools/telegram-thoughts.mjs` 中私有且无引用的 `readThoughtPhotoPathsFromPost`

### 本轮保留并标记

以下函数/导出未删除，原因是可能被外部脚本、CLI、测试或内部入口继续依赖：

- `processTelegramBatch`
- `buildTelegramSyncReport`
- `runTelegramSync`
- `persistNormalizedBatch`
- `backfillCoreFromLatestArchiveSnapshot`
- `writeThoughtPostFile` / `editThoughtPost` / `deleteThoughtPost` / `moveThoughtPost`

## 重复逻辑扫描结果

### 本轮已处理

- 随想模块规则
- HTTP retry
- `roundTo` 的共享使用
- Telegram thought 持久化分支

### 后续候选

- 已完成：Markdown 渲染中的 `appendMetric`
- 已完成：目录递归读取
- 已完成：fallback 判断与 markdown 重建的部分条件
- 已完成：更进一步的 Telegram thought 文件扫描策略

## 验证结果

- 针对性测试通过
- 全量 `npm test` 通过：173 / 173

## 说明

本轮保持了现有公开导出、SQL、环境变量、Telegram 命令协议、AI schema、Markdown 格式和部署方式不变，只做可回退的内部重构。
