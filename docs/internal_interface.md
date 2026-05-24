# 内部接口手册

本文档记录当前训练记录系统中适合被内部复用、自动化调用或后续开放的稳定接口。内容以当前仓库实现为准，不承诺语义化版本兼容；如果代码行为发生变化，应同步更新本文档。

## 1. 接口分级与约定

### 1.1 稳定性标记

| 标记 | 含义 | 调用建议 |
| --- | --- | --- |
| `可对外` | 适合被外部自动化、Webhook 或后续开放服务调用 | 可作为集成入口，调用方仍需按本文档处理失败 |
| `内部稳定` | 仓库内跨模块复用的主要接口 | 可被工具脚本、测试和内部模块依赖 |
| `内部实现` | 为当前实现服务的细分函数、运行时文件或持久化细节 | 不建议外部直接依赖，变更成本较低 |

### 1.2 通用约定

- Node.js 代码使用 ESM，导入路径以仓库根目录为基准，例如 `import { buildTrainingSnapshot } from './tools/training-snapshot.mjs'`。
- 日期字段优先使用 `YYYY-MM-DD`；Telegram 原始时间使用 Unix 秒；生成时间和数据库更新时间使用 ISO 字符串或 PostgreSQL `timestamptz`。
- 训练数据的 canonical 结构是 `TrainingSnapshot`。Markdown、PostgreSQL、Telegram 识别结果最终都应归一到该结构或其日级子结构。
- 数据库开关由 `TRAINING_DB_ENABLED` 和 `TRAINING_DB_URL` 控制。未启用或缺少 URL 时，多数数据库读写接口返回空快照或 `skipped`，不会自动创建数据库。
- 文档中的示例不包含真实 token、真实数据库 URL 或真实 Chat ID。

## 2. CLI / npm scripts

### 2.1 数据生成与站点构建

| 命令 | 稳定性 | 实现入口 | 作用 | 主要输入 | 主要输出 |
| --- | --- | --- | --- | --- | --- |
| `npm run build:data` | `可对外` | `tools/generate-training-data.mjs` | 从 Markdown 或数据库构建训练快照和看板数据 | `训练记录.md`、`TRAINING_SNAPSHOT_SOURCE`、数据库环境变量 | `source/_data/training.json`、`source/_data/dashboardView.json`、`训练数据解析.md` |
| `npm run build:site` | `可对外` | `tools/run-hexo-command.mjs generate` | 调用 Hexo 生成静态站点 | `source/`、`themes/`、`source/_data/` | `public/` |
| `npm run build` | `可对外` | `package.json` | 先生成数据，再生成站点 | 同上 | `source/_data/*`、`训练数据解析.md`、`public/` |
| `npm run server` | `内部稳定` | `tools/run-hexo-command.mjs server` | 生成数据并启动 Hexo 本地服务 | 同 `build:data` | 本地 Hexo server |
| `npm run clean` | `内部稳定` | `tools/run-hexo-command.mjs clean` | 调用 Hexo clean | 无特殊输入 | 清理 Hexo 生成产物 |

`build:data` 的数据源选择：

- 默认 `TRAINING_SNAPSHOT_SOURCE=markdown`，读取 `训练记录.md`。
- 设置 `TRAINING_SNAPSHOT_SOURCE=database` 时读取 PostgreSQL `core.*`。
- 如果数据库源不可用或缺少可渲染数据，并且数据库配置存在，`generateTrainingData` 会回退到 Markdown 并向 `stderr` 写提示。
- 每次生成数据后会尝试写入 `archive.*` 归档；归档失败时不会中断主输出，会写入 `runtime/training-db-sync.ndjson`。

### 2.2 Telegram 同步与补偿

| 命令 | 稳定性 | 实现入口 | 作用 | 主要输入 | 主要输出 |
| --- | --- | --- | --- | --- | --- |
| `npm run sync:telegram` | `可对外` | `tools/telegram-sync.mjs` | 拉取或处理 Telegram updates，识别图片，写数据库/Markdown，处理随想和分析命令 | Telegram、AI、数据库环境变量；可选 GitHub repository_dispatch payload | JSON 同步报告、数据库记录、`训练记录.md`、`source/_posts/*`、`runtime/telegram-sync-pending.ndjson` |
| `npm run telegram:sync` | `可对外` | `package.json` | `sync:telegram` 别名 | 同上 | 同上 |
| `npm run backfill:core` | `内部稳定` | `tools/backfill-training-core-from-archive.mjs` | 从最新 `archive.*` 快照补齐缺失的 `core.*` 日期 | 数据库环境变量 | JSON 结果，状态为 `stored`、`unchanged`、`skipped` 或 `deferred` |
| `npm run backfill:thoughts` | `内部稳定` | `tools/backfill-thoughts-to-core.mjs` | 将历史 Telegram 随想 Markdown 镜像回 `core.thought` | `source/_posts/*-telegram-thought-*.md`、数据库环境变量 | JSON 结果，包含导入、跳过和扫描数量 |

`sync:telegram` 必填环境变量：

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ALLOWED_CHAT_IDS`
- `AI_API_KEY`
- `AI_BASE_URL`
- `AI_MODEL`
- `TRAINING_DB_ENABLED`
- `TRAINING_DB_URL`

即使只处理 `/thought`，当前入口也会统一校验 AI 相关变量。`TELEGRAM_SYNC_TRANSPORT=webhook` 时，入口优先读取 GitHub `repository_dispatch` 事件中的 update；否则通过 Telegram `getUpdates` 轮询。

### 2.3 Markdown 与数据库互导

| 命令 | 稳定性 | 实现入口 | 作用 | 主要输入 | 主要输出 |
| --- | --- | --- | --- | --- | --- |
| `npm run import:markdown` | `内部稳定` | `tools/import-training-markdown.mjs` | 解析 `训练记录.md` 并覆盖写入 `core.*` | Markdown、数据库环境变量 | `{ status, days }` 或 `skipped` |
| `npm run reconcile:markdown` | `内部稳定` | `tools/reconcile-training-markdown-to-core.mjs` | CI 中把已提交 Markdown 回写 `core.*`；失败时返回 `deferred` | Markdown、数据库环境变量 | JSON 结果 |
| `npm run export:markdown` | `内部稳定` | `tools/export-training-markdown.mjs` | 从 `TrainingSnapshot` 派生 `训练记录.md` | 默认数据库；存在待重放队列时优先 Markdown | 覆盖 `训练记录.md` |

注意：

- `import:markdown` / `reconcile:markdown` 以 Markdown 解析结果为准，会按日期重写 `core.training_day`、`core.measurement`、`core.activity`、`core.meal`。
- `export:markdown` 默认从数据库导出；如果 `runtime/telegram-sync-pending.ndjson` 非空，会改用 Markdown 源，避免数据库未补偿时覆盖回退内容。

### 2.4 Targeted Tests

v2 第一阶段 H7 已补充一组迁移保护测试，后续 H1-H6 每次迁移前后建议先跑：

```bash
node --test test/telegram-sync.test.mjs test/training-analysis.test.mjs test/training-db-core.test.mjs test/dashboard-view.test.mjs
```

这组测试锁定：

- Telegram command alias 和 batch 顶层 shape
- `/analysis` intent 与时间窗优先级
- `persistNormalizedBatch` 事务 rollback 和 `payload_hash` unchanged 行为
- dashboard view model 的 overview card、chart window 与顶层字段契约

## 3. HTTP Webhook

### 3.1 Cloudflare Worker Telegram Webhook

| 项 | 内容 |
| --- | --- |
| 稳定性 | `可对外` |
| 实现入口 | `cloudflare/telegram-sync-dispatch-worker.mjs` |
| 部署入口 | `wrangler.toml` 的 `main = "cloudflare/telegram-sync-dispatch-worker.mjs"` |
| 方法 | `POST` |
| 请求体 | Telegram Bot API Update JSON |
| 必填 Header | `X-Telegram-Bot-Api-Secret-Token: <TELEGRAM_SECRET_TOKEN>` |
| 成功响应 | `202` JSON |

Worker 不直接识别图片或写训练数据。它只校验 Telegram secret，然后把 update 转发为 GitHub `repository_dispatch`，由 GitHub Actions 执行 `npm run sync:telegram`。

GitHub dispatch 请求：

```json
{
  "event_type": "telegram_update",
  "client_payload": {
    "telegram_updates": [
      { "update_id": 123, "message": {} }
    ]
  }
}
```

Worker 环境变量：

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `GITHUB_TOKEN` | 是 | 无 | 调用 GitHub repository dispatch 的 token |
| `TELEGRAM_SECRET_TOKEN` | 是 | 无 | 与 Telegram webhook secret header 对比 |
| `GITHUB_OWNER` | 否 | `soulgo` | GitHub 仓库 owner |
| `GITHUB_REPO` | 否 | `training_records` | GitHub 仓库名 |
| `GITHUB_API_BASE_URL` | 否 | `https://api.github.com` | GitHub API base URL |
| `TELEGRAM_ALBUM_BUFFER` | 否 | 无 | Durable Object binding，用于相册聚合 |

响应约定：

| HTTP 状态 | 响应示例 | 触发条件 |
| --- | --- | --- |
| `202` | `{ "ok": true, "dispatched": true, "updateId": 123 }` | 单条 update 已 dispatch |
| `202` | `{ "ok": true, "buffered": true, "updateId": 123, "albumKey": "42:album" }` | 相册 update 已进入 Durable Object 缓冲 |
| `400` | `{ "ok": false, "error": "invalid_json" }` | 请求体不是合法 JSON |
| `401` | `{ "ok": false, "error": "unauthorized" }` | secret header 不匹配 |
| `405` | `{ "ok": false, "error": "method_not_allowed" }` | 非 `POST` 请求 |
| `500` | `{ "ok": false, "error": "missing_github_token" }` | Worker 缺少必填配置 |
| `502` | `{ "ok": false, "error": "github_dispatch_failed", "status": 500, "body": "..." }` | GitHub dispatch 失败 |

### 3.2 Telegram 相册聚合 Durable Object

| 项 | 内容 |
| --- | --- |
| 稳定性 | `内部稳定` |
| 实现类 | `TelegramAlbumBuffer` |
| Binding 名称 | `TELEGRAM_ALBUM_BUFFER` |
| 聚合键 | `${chat.id}:${media_group_id}` |
| 延迟 | 约 `3000ms` |

行为：

- 只处理 `POST`。
- 内部请求体为 `{ "update": <Telegram Update> }`。
- 相同 `update_id` 在同一缓冲批次内去重。
- 派发前按 `update_id` 升序排序。
- alarm 触发后统一发送 `client_payload.telegram_updates`，随后删除缓冲的 `updates`。
- 如果未配置该 binding，Worker 会退回逐条 dispatch，相册不会聚合。

## 4. Telegram 命令接口

### 4.1 授权与分组

| 项 | 内容 |
| --- | --- |
| 稳定性 | `可对外` |
| 分组入口 | `groupTelegramUpdates(updates, options)` |
| 运行入口 | `runTelegramSync(options)` |
| 授权 | 仅处理 `TELEGRAM_ALLOWED_CHAT_IDS` 中的 chat |

系统只处理 Telegram `message` 和 `edited_message`。未授权 chat 会生成 `status: "ignored"`、`reason: "unauthorized chat"`，不会识别图片、写文件或写数据库。

普通图片消息会被归为 `kind: "image"`：

- 相册按 `media_group_id` 合并为一个 batch。
- 单张图片 batchId 为 `single-<message_id>`。
- 图片可以来自 `photo`，也可以来自 image 类型的 `document`。

### 4.2 图片识别批次

| 项 | 内容 |
| --- | --- |
| 稳定性 | `可对外` |
| 输入 | Telegram 图片消息或相册 |
| AI schema | `buildRecognitionSchema()` |
| 归档目标 | PostgreSQL `core.*`，失败时回退 `训练记录.md` |

批次分析结果主要字段：

```json
{
  "status": "ready",
  "kind": "image",
  "batchId": "single-123",
  "archivedDate": "2026-05-23",
  "measurement": {},
  "activities": [],
  "workoutDailySummary": null,
  "nutrition": { "meals": [], "totalCalories": null, "details": [] },
  "warnings": [],
  "issues": [],
  "confidence": 0.95
}
```

失败和跳过：

- 识别置信度低于 `0.75` 时记录 issue。
- 同一批次识别出多个不同截图日期时返回 `skipped`。
- 无可靠截图日期或文件名日期时返回 `skipped`。
- 数据库写入失败时，图片批次会写入 `训练记录.md`，并将批次追加到 `runtime/telegram-sync-pending.ndjson` 等待重放。

### 4.3 随想命令

| 命令 | 稳定性 | 作用 | 说明 |
| --- | --- | --- | --- |
| `/thought <正文>` | `可对外` | 新增随想 | 默认模块 `workout` |
| `/随想 <正文>` | `可对外` | 新增随想 | `/thought` 中文别名 |
| `/thought 锻炼 <正文>` / `/随想 锻炼 <正文>` | `可对外` | 新增锻炼随想 | 模块为 `workout`，tags 为 `训练`、`随想`、`Telegram` |
| `/thought 杂七杂八 <正文>` / `/随想 杂七杂八 <正文>` | `可对外` | 新增杂项随想 | 模块为 `misc`，tags 为 `杂七杂八`、`随想`、`Telegram` |
| `/thought-edit <id> <正文>` | `可对外` | 显式按 Telegram message id 编辑随想 | 中文别名见下方 |
| `/thoughtedit <id> <正文>` | `可对外` | 编辑随想 | `/thought-edit` 兼容别名 |
| `/edit-thought <id> <正文>` | `可对外` | 编辑随想 | `/thought-edit` 兼容别名 |
| `/编随想 <id> <正文>` | `可对外` | 编辑随想 | `/thought-edit` 中文别名 |
| `/随想编 <id> <正文>` | `可对外` | 编辑随想 | 同 `thought-edit` |
| `/thought-delete <id>` | `可对外` | 删除随想 | 可回复目标消息，也可显式传 id |
| `/thoughtdel <id>` | `可对外` | 删除随想 | `/thought-delete` 兼容别名 |
| `/delete-thought <id>` | `可对外` | 删除随想 | `/thought-delete` 兼容别名 |
| `/删随想 <id>` | `可对外` | 删除随想 | `/thought-delete` 中文别名 |
| `/随想删 <id>` | `可对外` | 删除随想 | 同 `thought-delete` |
| `/move <id> 杂七杂八` | `可对外` | 移动随想到目标模块 | 中文别名 `/移动` |
| `/移动 <id> 杂七杂八` | `可对外` | 移动随想到目标模块 | `/move` 中文别名 |
| `/随想 <id> 锻炼` | `可对外` | 兼容旧习惯的移动写法 | 等价于 `/移动 <id> 锻炼` |

随想文件契约：

- Markdown 写入 `source/_posts/YYYY-MM-DD-telegram-thought-<message_id>.md`。
- 图片写入 `source/images/thoughts/YYYY/MM/`，front matter 的 `photos` 保存 `/images/thoughts/...` 公共路径。
- front matter 必含 `date`、`tags`、`thought_module`、`telegram_message_id`、`telegram_chat_id`。
- `thought_module` 只支持 `workout` 和 `misc`，历史缺省按 `workout` 兼容。
- 数据库镜像表是 `core.thought`，删除命令在数据库中保存 `status: "deleted"`。

### 4.4 训练分析命令

| 命令 | 稳定性 | 作用 |
| --- | --- | --- |
| `/analysis <问题>` | `可对外` | 基于当前 `TrainingSnapshot` 生成 Telegram 训练建议 |
| `/分析 <问题>` | `可对外` | `/analysis` 中文别名 |

行为：

- 不写 Markdown、docs 或训练数据库。
- 读取 `TrainingSnapshot`，默认问题为“请根据最近训练、体脂、饮食数据给出今天/明天的训练建议”。
- 默认长期目标为“增肌减腹”，可通过 `TRAINING_ANALYSIS_GOAL` 覆盖。
- 回复过长时用 `splitTelegramMessage(text, 3900)` 分段发送。
- 生成失败时会回发“训练分析暂时生成失败：...”。

## 5. 核心数据契约

### 5.1 `TrainingSnapshot`

| 项 | 内容 |
| --- | --- |
| 稳定性 | `可对外` |
| 生成入口 | `parseTrainingRecord(markdown)`、`buildTrainingSnapshot(options)` |
| 输出文件 | `source/_data/training.json` |

结构：

```json
{
  "generatedAt": "2026-05-23T00:00:00.000Z",
  "latest": {
    "measurement": null,
    "daily": null
  },
  "daily": [],
  "charts": {
    "weightKg": [],
    "bodyFatPct": [],
    "skeletalMuscleKg": [],
    "basalMetabolism": [],
    "visceralFatLevel": [],
    "intakeCalories": [],
    "trainingCalories": [],
    "cyclingDistanceKm": []
  }
}
```

字段说明：

- `generatedAt`：快照生成时间，ISO 字符串。
- `latest.measurement`：按 daily 顺序收集到的最后一次体脂测量。
- `latest.daily`：最新一天的训练记录。
- `daily`：按日期升序排列的 `TrainingDay[]`。
- `charts.*`：看板图表序列，元素为 `{ "date": "YYYY-MM-DD", "value": number | null }`。

### 5.2 `TrainingDay`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `date` | `string` | 归档日期，`YYYY-MM-DD` |
| `measurement` | `Measurement \| null` | 当日最后一次体脂测量 |
| `measurements` | `Measurement[]` | 当日所有体脂测量 |
| `activities` | `Activity[]` | 当日运动明细 |
| `workoutSummary` | `WorkoutSummary` | 运动汇总 |
| `nutrition` | `Nutrition` | 饮食汇总 |

`WorkoutSummary`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `totalActivities` | `number` | 活动数量 |
| `totalDurationSeconds` | `number` | 活动明细时长合计 |
| `trainingCalories` | `number` | 训练消耗，优先使用截图总览的活动热量 |
| `workoutDurationMinutes` | `number \| null` | 截图总览锻炼时长 |
| `activeHours` | `number \| null` | 截图总览活动小时数 |
| `cyclingDistanceKm` | `number` | 骑行距离合计 |
| `countsByType` | `Record<string, number>` | 按活动类型计数 |

### 5.3 `Measurement`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `archivedDate` | `string` | 归档日期 |
| `measuredAt` | `string \| null` | 测量时间，可能是完整日期时间、日期或 `HH:mm` 归一后的文本 |
| `bodyScore` | `number \| null` | 身体得分 |
| `weightKg` | `number \| null` | 体重 kg |
| `bmi` | `number \| null` | BMI |
| `bodyFatPct` | `number \| null` | 体脂率 |
| `skeletalMuscleKg` | `number \| null` | 骨骼肌 kg |
| `visceralFatLevel` | `number \| null` | 内脏脂肪等级 |
| `basalMetabolismKcal` | `number \| null` | 基础代谢 kcal |
| `bodyWaterPct` | `number \| null` | 水分率 |
| `proteinPct` | `number \| null` | 蛋白质率 |
| `boneMassKg` | `number \| null` | 骨盐量 kg |
| `fatFreeMassKg` | `number \| null` | 去脂体重 kg |
| `bodyAge` | `number \| null` | 身体年龄 |
| `bodyType` | `string \| null` | 身体类型 |

### 5.4 `Activity`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `time` | `string \| null` | 活动时间，通常为 `HH:mm` |
| `type` | `string` | 归一后的活动类型 |
| `rawType` | `string \| null` | 原始类型 |
| `detail` | `string \| null` | 原始明细文本 |
| `durationText` | `string \| null` | 时长文本，如 `00:30:00` 或 `30分0秒` |
| `durationSeconds` | `number` | 时长秒数 |
| `calories` | `number \| null` | 消耗 kcal |
| `distanceKm` | `number \| null` | 距离 km |
| `avgSpeedKmh` | `number \| null` | 均速 km/h |
| `heartRate` | `number \| null` | 心率 |

活动类型归一规则：

- `outdoor_cycling` -> `户外骑行`
- `stair_climbing` -> `爬楼`
- `traditional_strength_training` -> `力量训练`
- `mixed_cardio`、`自由训练`、`燃脂训练*` -> `燃脂训练`

### 5.5 `Nutrition`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `meals` | `Meal[]` | 餐次汇总，顺序为早餐、午餐、晚餐、加餐 |
| `totalCalories` | `number \| null` | 当日截图内已记录总热量 |
| `details` | `string[]` | 餐次明细或补充说明 |

`Meal`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `name` | `string` | `早餐`、`午餐`、`晚餐`、`加餐` |
| `calories` | `number \| null` | 餐次热量 |
| `recommendedMin` | `number \| null` | 建议热量下限 |
| `recommendedMax` | `number \| null` | 建议热量上限 |

### 5.6 `Thought`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `telegramMessageId` / `telegram_message_id` | `number` | Telegram message id，稳定定位 ID |
| `telegramChatId` / `telegram_chat_id` | `number \| null` | Telegram chat id |
| `command` | `string` | 触发命令，如 `/thought`、`/随想编` |
| `body` | `string` | 随想正文 |
| `thoughtModule` / `thought_module` | `workout \| misc` | 随想模块 |
| `tags` / `tags_json` | `string[]` | Hexo tags |
| `messageDateUnix` / `message_date_unix` | `number \| null` | 原 Telegram 消息时间 |
| `markdownPath` / `markdown_path` | `string \| null` | Markdown 文件路径 |
| `imageRefs` / `image_refs_json` | `string[]` | 图片公共路径 |
| `status` | `active \| deleted` | 数据库镜像状态 |

## 6. AI 接口契约

### 6.1 图片识别 JSON Schema

| 项 | 内容 |
| --- | --- |
| 稳定性 | `可对外` |
| 入口 | `buildRecognitionSchema()` |
| 使用位置 | `tools/telegram-sync.mjs` 调用 `${AI_BASE_URL}/chat/completions` |
| prompt | 默认 `prompts/telegram-training-image-recognition.md`，可用 `TELEGRAM_RECOGNITION_PROMPT_PATH` 覆盖 |

AI 返回内容必须是符合 schema 的 JSON 字符串。顶层字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `imageType` | `measurement \| workout \| nutrition \| unknown` | 图片类型 |
| `detectedDate` | `string \| null` | 截图画面内可靠日期，格式 `YYYY-MM-DD` |
| `dateEvidence` | `string` | 日期证据说明 |
| `records.measurement` | `object \| null` | 体脂测量 |
| `records.activities` | `Activity[]` | 活动明细 |
| `records.meals` | `Meal[]` | 餐次汇总 |
| `records.totalCalories` | `number \| null` | 当日总热量 |
| `records.details` | `string[]` | 餐次明细 |
| `records.dailyWorkoutSummary` | `object \| null` | 当日活动总览 |
| `confidence` | `number` | 识别置信度 |
| `warnings` | `string[]` | 风险提示 |

调用注意：

- `detectedDate` 只能来自截图画面内日期；caption、普通文本或文件名不应伪装为截图日期。
- 系统相册、文件详情、分享预览页里可见的文件名/标题/路径日期，以及活动总览顶部的大号日期，都属于截图画面内日期。
- Telegram 消息年份只允许用于补全截图里可见的月日，不能单独产生 `detectedDate`。
- `dateEvidence` 如果只说明来自 filename/caption/text，运行时不会把它作为截图日期。
- 识别请求遇到 HTTP `429`、`500`、`502`、`503`、`504` 会最多尝试 3 次。

### 6.2 训练分析接口

| 项 | 内容 |
| --- | --- |
| 稳定性 | `可对外` |
| 入口 | `generateTrainingAnalysisReply(options)` |
| 使用位置 | Telegram `/analysis`、`/分析` |
| prompt | 默认 `prompts/training-analysis.md`，可用 `TRAINING_ANALYSIS_PROMPT_PATH` 覆盖 |

主要入参：

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `question` | `string` | 默认训练建议问题 | 用户问题 |
| `trainingGoal` | `string` | `TRAINING_ANALYSIS_GOAL` 或默认增肌减腹目标 | 长期目标 |
| `snapshot` | `TrainingSnapshot` | 自动读取 | 可注入快照，便于测试 |
| `now` | `Date` | 当前时间 | 摘要生成时间 |
| `fetchImpl` | `function` | 全局 `fetch` | 便于测试替换 |

输出：

- 返回适合 Telegram 发送的纯文本。
- 空内容会抛出 `Training analysis returned empty content`。
- AI HTTP 非 2xx 会抛出 `Training analysis failed with HTTP <status>`。

摘要结构由 `buildTrainingAnalysisSummary(snapshot, now)` 生成，包含：

- `dataSource`
- `coverage`
- `latestMeasurement`
- `recent7`
- `recent30`
- `measurementTrend7`
- `measurementTrend30`
- `trainingLoad`
- `strengthCardioBalance`
- `bodyCompositionRisk`
- `nutritionSignal`
- `recoverySignal`
- 最近 5 天 `latestDays`

## 7. JS 模块导入接口

### 7.1 快照与解析

#### `parseTrainingRecord(markdown)`

| 项 | 内容 |
| --- | --- |
| 稳定性 | `内部稳定` |
| 文件 | `tools/training-parser.mjs` |
| 入参 | Markdown 字符串 |
| 返回 | `TrainingSnapshot` |

识别 Markdown 中的 `### YYYY-MM-DD` 日期区块，并解析包含“体脂秤”“运动截图记录”“饮食截图记录”的四级标题区块。

#### `buildTrainingSnapshot(options = {})`

| 项 | 内容 |
| --- | --- |
| 稳定性 | `内部稳定` |
| 文件 | `tools/training-snapshot.mjs` |
| 入参 | `{ rootDir, source, env, now, createClient }` |
| 返回 | `Promise<TrainingSnapshot>` |

行为：

- `source` 为 `database` 时读取 PostgreSQL `core.*`。
- `source` 为 `markdown` 或未指定时读取 `训练记录.md`。
- 数据库源为空或缺少 measurement 时抛出 `database snapshot is empty or missing measurements`。
- 数据库连接或查询失败时包装为 `database snapshot unavailable: ...`。

#### `generateTrainingData(options = {})`

| 项 | 内容 |
| --- | --- |
| 稳定性 | `内部稳定` |
| 文件 | `tools/generate-training-data.mjs` |
| 返回 | `{ rootDir, recordPath, outputPath, dashboardViewPath, debugOutputPath, parsed }` |

会写文件和归档数据库，因此测试中应注入 `rootDir`、`persistArchive`、`appendArchiveFailureLog` 或使用临时目录。

### 7.2 Telegram 同步

#### `runTelegramSync(options = {})`

| 项 | 内容 |
| --- | --- |
| 稳定性 | `内部稳定` |
| 文件 | `tools/telegram-sync.mjs` |
| 返回 | `Promise<TelegramSyncResult>` |

主要可注入依赖：

- `env`
- `rootDir`
- `now`
- `fetchTelegramUpdates`
- `recognizeBatch`
- `persistNormalizedBatch`
- `buildTrainingSnapshot`
- `exportTrainingMarkdown`
- `writeThoughtPost`
- `fetchTelegramFile`
- `generateTrainingAnalysisReply`
- `sendTelegramMessage`
- `repositoryDispatchEvent`

返回结构：

```json
{
  "changed": true,
  "fallbackUsed": false,
  "updatesFetched": 1,
  "lastProcessedUpdateId": 123,
  "readyBatches": 1,
  "batchResults": []
}
```

#### `buildTelegramSyncReport(result)`

| 项 | 内容 |
| --- | --- |
| 稳定性 | `可对外` |
| 文件 | `tools/telegram-sync.mjs` |
| 入参 | `runTelegramSync` 返回值 |
| 返回 | 适合 CLI stdout 输出的精简 JSON |

精简 batch 字段包括 `kind`、`batchId`、`status`、`archivedDate`、`postPath`、`thoughtWriteStatus`、`persistenceStatus`、`warnings`、`issues`、`reason`；分析批次额外包含 `analysisReplyStatus`、`analysisReplyError`、`analysisReplyParts`。

#### `groupTelegramUpdates(updates, options = {})`

| 项 | 内容 |
| --- | --- |
| 稳定性 | `内部稳定` |
| 文件 | `tools/telegram-sync-lib.mjs` |
| 入参 | Telegram Update 数组；可选 `knownThoughtMessageKeys` |
| 返回 | Telegram batch 数组 |

会把图片相册、单图、随想新增、编辑、删除、移动和分析命令归为不同 `kind`。

#### `analyzeTelegramBatch(batch, recognitions, options = {})`

| 项 | 内容 |
| --- | --- |
| 稳定性 | `内部稳定` |
| 文件 | `tools/telegram-sync-lib.mjs` |
| 入参 | batch、AI recognitions、可选 `minConfidence` |
| 返回 | `ready` / `skipped` 批次结果 |

图片批次会归一出 `measurement`、`activities`、`workoutDailySummary`、`nutrition` 和 `fingerprints`；随想和分析批次不依赖 AI recognitions。

#### `applyTelegramSyncToMarkdown(markdown, batchResult)`

| 项 | 内容 |
| --- | --- |
| 稳定性 | `内部稳定` |
| 文件 | `tools/telegram-sync-lib.mjs` |
| 入参 | 原 Markdown、`ready` 图片批次结果 |
| 返回 | `{ changed, markdown }` |

写入或合并指定日期区块，使用 `<!-- telegram-fingerprint: ... -->` 避免重复写入同一条 Telegram 数据。

### 7.3 数据库 facade

`tools/training-db-core.mjs` 是数据库读写的主要 facade，稳定性为 `内部稳定`。

| 导出 | 作用 | 返回/行为 |
| --- | --- | --- |
| `resolveTrainingCoreConfig(env)` | 解析数据库配置 | `{ enabled, url, timeoutMs, appName }` |
| `readTrainingSnapshotFromDatabase(options)` | 从 `core.*` 读取 `TrainingSnapshot` | 未启用数据库时返回空快照 |
| `getLastProcessedTelegramUpdateId(options)` | 读取 `ingest.telegram_message` 最大 `update_id` | 未启用数据库时返回 `0` |
| `readTrainingSnapshotFromDatabaseClient(client, now)` | 使用已有 client 读取 `core.*` | 便于事务内或测试复用 |
| `readArchiveTrainingSnapshotFromDatabaseClient(client, now)` | 使用已有 client 读取 `archive.*` | 返回 `TrainingSnapshot` |
| `persistNormalizedBatch(options)` | 写入 Telegram batch 到 `ingest.*`，并按需更新 `core.*` | `stored`、`unchanged`、`skipped` |
| `persistTrainingSnapshotToCore(options)` | 将完整快照写入 `core.*` | 按日期替换训练日数据 |
| `backfillCoreFromLatestArchiveSnapshot(options)` | 从 `archive.*` 补齐缺失 `core.*` 日期 | `stored`、`unchanged`、`skipped` |
| `importTrainingMarkdownToDatabase(options)` | 解析 Markdown 并写入 `core.*` | 调用 `persistTrainingSnapshotToCore` |
| `exportTrainingMarkdown(snapshot)` | 将快照渲染为 `训练记录.md` 格式 | 返回 Markdown 字符串 |

### 7.4 前端视图模型

#### `buildDashboardViewModel(snapshot)`

| 项 | 内容 |
| --- | --- |
| 稳定性 | `内部稳定` |
| 文件 | `tools/dashboard-view.mjs` |
| 入参 | `TrainingSnapshot` |
| 返回 | Dashboard view model |
| 输出文件 | `source/_data/dashboardView.json` |

主要字段：

- `generatedAt`
- `latestMeasurement`
- `latestDay`
- `previousDay`
- `latestDashboardDate`
- `chartWindowDays`
- `dailyOverviewEntries`
- `recentDays`
- `trainedDays`
- `totalArchivedDays`
- `chartPayload.charts`

## 8. PostgreSQL 接口

### 8.1 Schema 文件

| 文件 | 稳定性 | 说明 |
| --- | --- | --- |
| `sql/pgsql17.sql` | `可对外` | 当前完整 PostgreSQL 17 初始化脚本，包含 schema、权限和 `core.thought.thought_module` |
| `sql/training_records/core.sql` | `内部实现` | 历史拆分导出，记录 `core.*` 表 |
| `sql/training_records/ingest.sql` | `内部实现` | 历史拆分导出，记录 `ingest.*` 表 |
| `sql/training_records/archive.sql` | `内部实现` | 历史拆分导出，记录 `archive.*` 表 |

对新环境初始化时，优先参考 `sql/pgsql17.sql`。

### 8.2 `core.*`

| 表 | 稳定性 | 主键 | 职责 |
| --- | --- | --- | --- |
| `core.training_day` | `可对外` | `archived_date` | 每日训练、饮食、活动汇总 |
| `core.measurement` | `可对外` | `measurement_key` | 体脂秤测量明细 |
| `core.activity` | `可对外` | `activity_key` | 运动活动明细 |
| `core.meal` | `可对外` | `meal_key` | 餐次热量明细 |
| `core.thought` | `可对外` | `telegram_message_id` | Telegram 随想正文、模块、图片引用和删除状态镜像 |

写入约定：

- `core.training_day` 是父表，`measurement`、`activity`、`meal` 通过 `archived_date` 外键关联，删除训练日会级联删除明细。
- Telegram 图片批次更新某一天时，会先读取现有 day，再只替换该批次包含的 measurement、activities 或 nutrition 部分。
- Markdown 导入会按日期替换 `core.training_day`、`core.measurement`、`core.activity`、`core.meal`。
- `core.thought` 独立于训练日表，以 Telegram message id 定位；删除为软删除。

### 8.3 `ingest.*`

| 表 | 稳定性 | 主键 | 职责 |
| --- | --- | --- | --- |
| `ingest.telegram_batch` | `内部稳定` | `batch_id` | Telegram 批次分析结果、状态、hash 和完整 payload |
| `ingest.telegram_message` | `内部稳定` | `message_id` | Telegram 原始消息摘要和图片 file id |
| `ingest.telegram_recognition` | `内部稳定` | `message_id` | AI 图片识别原始 JSON |

写入约定：

- `persistNormalizedBatch` 以 batch JSON 的 SHA-256 作为 `payload_hash`。
- 已存在且 hash 相同的 batch 返回 `unchanged`。
- 写入过程包在事务中，core 写入失败时会执行 `ROLLBACK`，不会提交半批次。
- `telegram_message` 和 `telegram_recognition` 通过 `batch_id` 级联关联 batch。
- `getLastProcessedTelegramUpdateId` 读取 `telegram_message.update_id` 最大值，作为轮询 offset 的依据。

### 8.4 `archive.*`

| 表 | 稳定性 | 主键 | 职责 |
| --- | --- | --- | --- |
| `archive.training_parse_snapshot` | `内部稳定` | `source_hash` | Markdown 原文 hash 去重后的完整解析快照 |
| `archive.training_parse_run` | `内部稳定` | `run_id` | 每次数据生成的运行留痕 |
| `archive.training_day` | `内部稳定` | `archived_date` | 归档日汇总 |
| `archive.training_measurement` | `内部稳定` | `measurement_hash` | 归档体脂明细 |
| `archive.training_activity` | `内部稳定` | `activity_hash` | 归档运动明细 |
| `archive.training_meal` | `内部稳定` | `meal_hash` | 归档餐次明细 |

归档失败不影响 `build:data` 的主输出；失败信息会追加到 `runtime/training-db-sync.ndjson`。

## 9. 生成文件与运行时文件

| 路径 | 稳定性 | 写入入口 | 说明 |
| --- | --- | --- | --- |
| `source/_data/training.json` | `可对外` | `generateTrainingData` | `TrainingSnapshot` JSON，供站点和外部读取 |
| `source/_data/dashboardView.json` | `可对外` | `generateTrainingData` | 首页看板视图模型 |
| `训练数据解析.md` | `内部稳定` | `generateTrainingData` | 解析排查用 Markdown |
| `训练记录.md` | `可对外` | 人工编辑、Telegram fallback、`export:markdown` | 人工可读训练记录和数据库失败回退层 |
| `source/_posts/*-telegram-thought-*.md` | `可对外` | Telegram 随想命令 | 随想内容 Markdown |
| `source/images/thoughts/YYYY/MM/*` | `可对外` | Telegram 随想图片 | 随想图片本地资源 |
| `runtime/telegram-sync-pending.ndjson` | `内部稳定` | `runTelegramSync` | 数据库失败后待重放 batch 队列 |
| `runtime/training-db-sync.ndjson` | `内部实现` | `appendTrainingArchiveFailureLog` | archive 归档失败日志 |

运行时队列说明：

- `telegram-sync-pending.ndjson` 每行是 `{ batch, failedAt, error }`。
- 同一个 `batchId` 再次失败会去重保留最新记录。
- 队列最多保留 1000 条。
- 下次 `sync:telegram` 启动时会先尝试重放，成功后从队列移除。

## 10. 环境变量索引

### 10.1 Telegram / AI

| 变量 | 稳定性 | 默认 | 使用位置 | 说明 |
| --- | --- | --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | `可对外` | 无 | `sync:telegram`、Telegram transport | Bot token |
| `TELEGRAM_ALLOWED_CHAT_IDS` | `可对外` | 无 | `sync:telegram` | 逗号分隔的允许 chat id |
| `TELEGRAM_POLL_LIMIT` | `可对外` | `20` | `fetchTelegramUpdates` | getUpdates limit |
| `TELEGRAM_SYNC_TRANSPORT` | `可对外` | `poll` | `sync:telegram` | `webhook` 时使用 repository_dispatch updates |
| `TELEGRAM_SYNC_NOTIFY` | `内部稳定` | CI webhook 默认通知 | `sync:telegram` | 控制是否回发同步结果 |
| `TELEGRAM_RECOGNITION_PROMPT_PATH` | `内部稳定` | `prompts/telegram-training-image-recognition.md` | 图片识别 | 覆盖识别 prompt |
| `AI_API_KEY` | `可对外` | 无 | 图片识别、训练分析 | AI API key |
| `AI_BASE_URL` | `可对外` | 无 | 图片识别、训练分析 | Chat Completions base URL，例如 `https://api.openai.com/v1` |
| `AI_MODEL` | `可对外` | 无 | 图片识别、训练分析 | 模型名 |
| `AI_CONCURRENCY` | `内部稳定` | `3` | 图片识别 | 并发识别图片数 |

### 10.2 训练分析

| 变量 | 稳定性 | 默认 | 使用位置 | 说明 |
| --- | --- | --- | --- | --- |
| `TRAINING_ANALYSIS_GOAL` | `可对外` | 默认增肌减腹目标 | `/analysis` | 覆盖长期训练目标 |
| `TRAINING_ANALYSIS_PROMPT_PATH` | `内部稳定` | `prompts/training-analysis.md` | `/analysis` | 覆盖训练分析 prompt |

### 10.3 数据库与快照

| 变量 | 稳定性 | 默认 | 使用位置 | 说明 |
| --- | --- | --- | --- | --- |
| `TRAINING_DB_ENABLED` | `可对外` | `false` | 所有 DB 读写 | 是否启用 PostgreSQL |
| `TRAINING_DB_URL` | `可对外` | 空 | 所有 DB 读写 | PostgreSQL connection string |
| `TRAINING_DB_TIMEOUT_MS` | `内部稳定` | `3000` | pg Client | 连接超时 |
| `TRAINING_DB_APP_NAME` | `内部稳定` | `training-records-dashboard` | pg Client | PostgreSQL application_name |
| `TRAINING_DB_LOG_PATH` | `内部实现` | `runtime/training-db-sync.ndjson` | archive failure log | 归档失败日志路径 |
| `TRAINING_SNAPSHOT_SOURCE` | `可对外` | `markdown` | `buildTrainingSnapshot`、`build:data`、`/analysis` | `markdown` 或 `database` |

### 10.4 GitHub / Cloudflare

| 变量 | 稳定性 | 默认 | 使用位置 | 说明 |
| --- | --- | --- | --- | --- |
| `GITHUB_TOKEN` | `可对外` | 无 | Cloudflare Worker | GitHub dispatch token |
| `TELEGRAM_SECRET_TOKEN` | `可对外` | 无 | Cloudflare Worker | Telegram webhook secret |
| `GITHUB_OWNER` | `可对外` | `soulgo` | Cloudflare Worker | 目标仓库 owner |
| `GITHUB_REPO` | `可对外` | `training_records` | Cloudflare Worker | 目标仓库名 |
| `GITHUB_API_BASE_URL` | `内部稳定` | `https://api.github.com` | Cloudflare Worker | GitHub API base URL |
| `CLOUDFLARE_API_TOKEN` | `可对外` | 无 | deploy workflow | 部署 Worker |
| `CLOUDFLARE_ACCOUNT_ID` | `可对外` | 无 | deploy workflow | Cloudflare account |
| `TELEGRAM_ALBUM_BUFFER` | `内部稳定` | 无 | Cloudflare Worker | Durable Object binding，不是普通字符串变量 |
| `GITHUB_EVENT_NAME` | `内部实现` | 空 | GitHub Actions | 判断 repository_dispatch |
| `GITHUB_EVENT_PATH` | `内部实现` | 空 | GitHub Actions | 读取 dispatch payload |
| `GITHUB_ACTIONS` | `内部实现` | 空 | 运行上下文识别 | CI 中为 `true` |
| `GITHUB_ACTOR` | `内部实现` | 空 | archive runtime context | 归档运行人 |

## 11. 常见失败模式

| 场景 | 表现 | 处理 |
| --- | --- | --- |
| Telegram secret 不匹配 | Worker 返回 `401 unauthorized` | 检查 Telegram webhook secret 与 Cloudflare `TELEGRAM_SECRET_TOKEN` |
| Worker 缺少 GitHub token | Worker 返回 `500 missing_github_token` | 配置 Cloudflare secret `GITHUB_TOKEN` |
| GitHub dispatch 失败 | Worker 返回 `502 github_dispatch_failed` | 检查 token 权限、仓库 owner/repo、GitHub API 状态 |
| AI 识别失败 | `sync:telegram` stderr 出现 image recognition failed | 检查 `AI_*`、图片 URL、模型 schema 支持 |
| 图片无可靠日期 | batch `status: "skipped"` | 以 document 方式发送带日期文件名的图片，或保证截图画面有日期 |
| 数据库未启用 | DB 接口返回 `skipped: disabled` 或空快照 | 设置 `TRAINING_DB_ENABLED=true` 并配置 `TRAINING_DB_URL` |
| 数据库暂时不可用 | 图片批次 `persistenceStatus: fallback_markdown` | 等数据库恢复后再次运行 `sync:telegram` 重放队列 |
| 数据库快照不可渲染 | 抛出 `database snapshot is empty or missing measurements` | 检查 `core.*` 是否已有训练日和体脂数据，或使用 Markdown 源 |
| `/analysis` 无法生成 | Telegram 回发失败原因 | 检查 `AI_*`、`TRAINING_SNAPSHOT_SOURCE` 和数据库/Markdown 数据 |

## 12. 维护检查清单

变更接口后请同步检查：

- 修改高风险边界时，先补或更新 targeted tests，并记录到 `docs/re_optimization_v2.md`。
- 新增或修改 npm script：更新第 2 节。
- 修改 Worker 请求、响应或环境变量：更新第 3 节和第 10 节。
- 修改 Telegram 命令解析：更新第 4 节。
- 修改 `TrainingSnapshot`、AI schema 或 dashboard view model：更新第 5、6、7、9 节。
- 修改 PostgreSQL schema：更新第 8 节，并优先保持 `sql/pgsql17.sql` 与运行时代码一致。
- 修改运行时文件路径或队列格式：更新第 9 节。
