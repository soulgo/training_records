# Changelog

本项目所有显著变更都会记录在此文件中。

格式基于 [Keep a Changelog 1.1.0](https://keepachangelog.com/zh-CN/1.1.0/)，本项目遵循 [Semantic Versioning](https://semver.org/spec/v2.0.0.html)。

维护约定：

- 最新正式版本是第一个形如 `## [x.y.z] - YYYY-MM-DD` 的发布条目；站点页脚版本号从这里自动读取。
- 保留 `## [Unreleased]` 记录尚未发布的显著变更，发布时移动到新的版本条目。
- 版本按时间倒序排列，发布日期使用 `YYYY-MM-DD`。
- 变更类型按需使用 `Added`、`Changed`、`Deprecated`、`Removed`、`Fixed`、`Security`；没有内容的分类不保留。

## [Unreleased]

### Added

- dev 新增独立 `/action-monitor/` 的 `action 监控` 模块：`build:data` 会从 PostgreSQL `monitor.github_action_runs/jobs/steps/failures` 生成 `actionMonitorView.json`，页面展示最近 GitHub Actions 的状态、workflow、run 编号、commit、触发人、分支、耗时和失败摘要；本地无监控数据库时自动降级为空视图。
- `action 监控` 独立模块新增“最近 2 天 / 更早 Action”分区：最近 2 天运行直接展示，更早记录进入分页列表，避免历史 run 把当前状态挤出当前状态区。

### Changed

- 将 dev 页面里的 Action 日志监控从首页拆出为独立页面模块 `/action-monitor/`，新增导航入口、独立 layout、样式与历史分页脚本，首页不再嵌入该监控模块。

### Fixed

- 修复 `action 监控` 独立页面已生成但 dev 站点导航不显示入口的问题；根 `_config.yml` 的 `theme_config.nav` 现在显式加入 `/action-monitor/`，避免只修改主题默认配置却被站点配置覆盖。
- 修复 `action 监控` 数据暂为空时整个模块被隐藏的问题；现在即使暂未读到 run 记录，也会显示模块标题、环境和空状态，避免误判功能未上线。
- 修复 dev Action 监控读取旧版 PostgreSQL 表结构时因缺少 `monitor_environment` 列生成空视图的问题；读取最近 run 失败时会自动回退到按 `branch=dev` 查询，并继续展示 job、step 与失败计数。
- 修复 dev/main Actions 依赖外部 report URL 才能写入监控库的问题；所有 workflow 的 `Report Action Status` 会优先按当前分支选择 `DEV_TRAINING_DB_URL` / `TRAINING_DB_URL` 和对应 app name，使用本地 runner 脚本直接写入对应 PostgreSQL，URL 仅作为兜底路径，并兼容旧版监控表缺少 `monitor_environment` 列的写入路径。
- 修复当前 workflow 在最终 `Report Action Status` 步骤中上报时 GitHub API 仍返回 `in_progress`，导致页面把已成功执行的 Action 显示为“运行中”、成功率为 0% 的问题；本地 reporter 现在会使用 `${{ job.status }}` 补齐当前 run 的最终结论。

## [1.3.2] - 2026-07-05

### Added

- 新增 GitHub Actions 全量运行监控能力：提供 `POST /api/github/actions/report` 接收 `run_id`，通过 GitHub API 拉取 run、jobs、steps，生成失败摘要并幂等写入 PostgreSQL；新增 `monitor.github_action_runs/jobs/steps/failures` SQL 设计与中文注释，支持成功率、失败率、耗时、commit/branch/workflow 关联和后续 AI 失败归因。
- GitHub Actions workflow 全面接入 `Report Action Status`：使用 `if: always()` 和最小 payload，只传 `github.run_id`；dev/main 分支分别优先使用 `GITHUB_ACTION_MONITOR_REPORT_URL_DEV` / `GITHUB_ACTION_MONITOR_REPORT_URL_MAIN`，非 dev/main 分支跳过上报。
- Action 监控服务新增 dev/main 分支隔离保护：监控实例可通过 `GITHUB_ACTION_MONITOR_ALLOWED_BRANCH` 限定只写入 dev 或 main，分支不匹配时返回 `skipped=true` 且不拉取 jobs、不写数据库；SQL 同步增加 `monitor_environment` 字段，并说明 dev/main 数据库分别手动建表和配置。
- 新增图片识别脱敏 fixture 评测集与 `npm run eval:recognition`，覆盖 measurement、workout、nutrition、sleep 四类样本，输出 schema 失败数、静默异常入库数、语义 warning 和字段准确率，作为后续识别 prompt/schema 调整的回归基线。
- 新增 `/monitor/` 健身监控总览页：基于现有 PostgreSQL snapshot 生成 `monitorView.json`，汇总展示体重、体脂率、睡眠评分、热量平衡、近 30 天跨域趋势、连续性和预警信息，并在导航中新增“监控”入口。
- 新增 `docs/02_系统核心逻辑/训练监控逻辑.md` 维护文档：覆盖监控页从快照到前端 Chart.js 渲染的端到端链路、视图模型结构（指标卡片、趋势图、连续性与预警）、配置参数、空数据降级和维护要点，并补全 `查询展示逻辑.md` 页面模块表与核心逻辑目录阅读顺序索引。
- 新增显式数据库 migration 边界：`sql/training_records/migrations/` 承接历史运行时 schema preflight DDL，`maintenance:migrate --dry-run/--confirm` 支持列出 migration、读取 `maintenance.schema_migration` 历史、校验 checksum，并要求确认模式显式配置 `TRAINING_DB_MIGRATION_URL`。

### Changed

- 同步项目包版本号到 `1.3.2`。
- 图片识别 schema 升级到 v3：`records.sleep` 成为必填字段，睡眠和非睡眠图片都必须显式输出 sleep 对象或 `null` 字段；prompt metadata 与 App Profile 记忆源同步升级，并增加 measurement/sleep 字段级语义 warning，避免明显异常值静默入库。
- 收敛应用层入口边界：`src` 内部不再反向依赖 `tools` 兼容入口，训练分析、prompt 生成、随想 artifact、Markdown 渲染、快照 fallback 和训练数据生成逻辑迁移到 `src` canonical 模块，`tools` 仅保留薄 CLI/兼容包装；`sync:feishu` 统一指向 `src/app/use-cases/feishu-sync.use-case.mjs`。
- 扩展 `/monitor/` 健身监控总览页：在原有体重、体脂、睡眠、热量、趋势和预警基础上，新增身体成分、恢复监控、训练结构、饮食维护、数据完整性与 7/30 天汇总模块；趋势图从 4 张扩展为 6 张，补充身体成分趋势、恢复监控趋势和骑行里程序列，并重写监控页专用 UI 样式，使桌面与移动端监控信息更完整、排版更协调。
- 重构当前 docs 目录为 `01_系统配置`、`02_系统核心逻辑`、`03_历史重构记录`、`04_问题与排查`、`05_日常规则` 五类入口：重写 dev/main 环境配置文档，在开头直接列出 GitHub Settings 与 Cloudflare 必填参数；新增 dev/main 分支合并数据隔离规则和后续规划落地后的当前文档同步规则，明确 `dev` 与 `main` 运行数据互相独立、历史规划不能替代当前系统文档。
- 重构并校准 docs 长期文档入口：将当前系统事实收敛到 `docs/01_系统配置/`、`docs/02_系统核心逻辑/`、`docs/04_问题与排查/` 和 `docs/05_日常规则/`，删除旧 `docs/归档/` 与临时 superpowers spec，保留 `docs/03_历史重构记录/` 作为非当前事实资料；同步修正 main/dev 配置、Cloudflare Worker secrets、Durable Object 绑定名、图片日期归档和随想命令合同。
- 按后续规划落地文档同步规则完成数据库优化与 20260701 优化规划归档：将已实现的数据库权限收敛与运行时 DDL 下线方案移入 `docs/03_历史重构记录/重构历史/数据库优化/`，将 20260701 优化高/中优先级规划移入 `docs/03_历史重构记录/重构历史/20260701_优化高中优先级落地/`；未实现规划目录只保留数据库连接池/Markdown 治理和 20260701 低优先级剩余项，并把当前事实写回数据库模型、数据入库、图片识别、Action 日志、系统总览和 PostgreSQL 排查文档。
- 完成 action 日志排查优化文档第三轮审计：通过 GitHub API 拉取实际运行日志（Sync #112/#117、Deploy #350/#233、Markdown Backup #20、CI Tests #285、Refresh Webhook #130）与 `main`/`dev` 两分支源码交叉验证，发现前两轮文档以 dev 工作树为"当前源码"导致生产 main 分支的 dispatch payload 泄漏被误判为"不成立问题"。新增 `07_第三轮审计_实际日志复核.md`，并修订 01-06 全部文档：dispatch payload 泄漏回退为 P0 安全阻塞项（实测 main 仍写 `SYNC_DISPATCH_PAYLOAD` 原文到 `$GITHUB_ENV`，dev 修复未合并）；Markdown snapshot 泄漏范围从"仅 backup"扩大到两个 deploy workflow（实测 Deploy #350 含 399 处、#233 含 223 处健康字段）；测试 fixture 噪声归属从 CI 修正为 deploy（site-build `run_tests:'true'`）；补全飞书 `oc_` chat_id 在 sync stdout 的脱敏规则；05 实施顺序前置 main 合并项；06 阻塞项从 1 个增至 2 个。
- 落地 action 日志排查优化高收益项：新增统一 `[action-log]` JSON logger 与 `tools/action-sync-summary.mjs`，`sync.yml` / `sync-dev.yml` 共用 Telegram/飞书 summary formatter，summary 补齐 traceId、queueTaskId、AI provider/model/promptVersion/token、DB transaction/rowCounts/slowQueries、deploy duration 等排障字段，并删除重复 inline Node summary。
- 按后续规划落地文档同步规则完成 action 日志排查优化归档：将已实现规划从 `docs/03_历史重构记录/后续规划_未实现/` 移入 `docs/03_历史重构记录/重构历史/action日志排查优化/`，并把当前日志链路、summary 字段、失败补偿、排查步骤和脱敏规则写回 `docs/02_系统核心逻辑/Action日志与失败补偿.md` 与 `docs/04_问题与排查/Action日志.md`。
- `export:markdown` 默认 stdout 改为 compact summary，完整导出 payload 仅允许本地显式 `--debug-json` 查看。
- 下线业务路径默认运行时 DDL：`persistNormalizedBatch()` 与 `export:markdown` 默认不再执行 schema preflight，只有显式开启 `TRAINING_DB_SCHEMA_PREFLIGHT_ENABLED=true` 时才保留过渡期 preflight。
- 拆分数据库读取配置：快照读取、Markdown 导出、`maintenance:inspect`、单批次审计、pending summary、AI monitoring 和 `check:data-consistency` 优先使用 `TRAINING_DB_READONLY_URL`，未配置时再回退 `TRAINING_DB_URL`；main/dev workflow 同步注入只读连接串 Secret。
- 优化 Telegram/飞书 webhook 同步后的 Pages 刷新耗时：`sync.yml` / `sync-dev.yml` 自动触发部署时传入 `sync_db_mode=never` 与 `run_tests=false`，跳过已由同步链路完成后的维护型全量 DB 修复和部署前测试；手动部署与 push 部署仍默认保留 `sync_db_mode=auto` 和 `run_tests=true` 完整校验。

### Removed

- 下线旧 `TELEGRAM_SYNC_REPLAY_LEGACY_NDJSON_PENDING` 同步重放开关，pending 失败恢复统一以数据库队列为准，避免 NDJSON 文件和数据库状态形成双来源。

### Security

- Telegram/飞书同步命令行 stdout 改为只输出脱敏 safe report；完整同步结果仍写入 result file 供 summary/通知使用。同步 workflow 中 AI base URL、fallback base URL、chat id、COS bucket/domain/path prefix 等配置改为从 secrets 注入，并保留最小必要 workflow 权限说明。
- 修复 `sync.yml` / `sync-dev.yml` 在 `workflow_dispatch` 队列任务中把完整 Telegram/飞书 `dispatch_payload` 注入 GitHub Actions step env 和 `$GITHUB_ENV` 的问题，避免 `chat_id`、用户名、消息正文、图片 `file_id` 等 webhook payload 内容出现在 Action 日志；同步和失败通知改为通过 runner 临时事件文件读取队列 payload。
- 同步 summary 与 action logger 默认 hash 飞书 `oc_`、chat id、file/image key、COS bucket/pathPrefix 等敏感字段；GitHub Actions 中禁止 `--debug-json`，避免 snapshot/健康明细进入 Action 日志。
- 收敛 PostgreSQL 角色权限：初始化脚本拆分 `training_migrator`、`training_app`、`training_maintenance` 和 `training_readonly`，schema owner、default privileges 与 migration history 由迁移账号管理，日常业务账号不再持有 DDL 或 `maintenance.schema_migration` 权限。
- `maintenance:inspect` 新增只读权限审计摘要，输出当前 DB 用户、superuser/migrator-like 标记、各 schema `CREATE` 权限和危险原因，同时继续避免 DB URL、SQL 参数和 Secret 进入日志。

### Fixed

- 修复 main 飞书随想入库成功后仍收到“GitHub Action 执行失败：站点部署/页面刷新”的假失败回执：`deploy-pages.yml` 现在先强校验本次生成的 `public/<module>/index.html` 产物，确认目标随想是否出现在正确模块；生产域名 `soulgo.chat` 因 GitHub Pages / Cloudflare 传播延迟短暂读到旧 HTML 时只记 warning，不再把已成功入库和已生成产物的同步 run 标红。
- 修复 Telegram 纯随想 `/移动` 等数据库内操作在 Actions 缺少 AI Provider 配置时提前失败的问题：AI Provider 改为仅在图片识别或 `/analysis` 实际需要时懒加载，纯随想同步不再强依赖 `AI_BASE_URL`。
- 修复图片同步后 `sleepBackfill` 对全部历史 ingest/archive 做全量扫描的问题：同步链路只把本次新入库或 pending replay 中实际含 sleep 的归档日期传给 backfill，非睡眠图片默认不触发 sleep backfill，睡眠图片只修复目标日期。
- 修复监控页趋势图图例排版不协调的问题：图表副标题改用专用 class，避免标题区 `span` 样式污染图例色点和标签；图例改为紧凑胶囊标签并支持移动端自然换行。
- 修复 Telegram 随想 `/移动 id 模块` 移动带图随想时图片引用丢失的问题：DB-only 移动/编辑现在会保留 `photoPaths: null` 的“不改原图片”语义，不再误转为空数组清空 `core.thought.image_refs_json`；同步补充移动带图随想和落库参数回归测试。
- 修复华为运动健康睡眠详情图在 AI 识别时误把阶段图/趋势小卡片推算值当作睡眠总时长的问题：睡眠 prompt 现在明确以 `夜间睡眠 X小时Y分钟` 文字行为权威来源，单独缺少 `总睡眠` 标签时只写 `nightSleepMinutes` 并由程序侧回退展示；同步 bump recognition prompt version 以避开旧识别缓存，并更新 Telegram 睡眠截图回归用例。
- 修复睡眠图片重发后旧错误时长仍污染 dev 页面的问题：`core.sleep` 现在按归档日期、睡眠类型、入睡时间和醒来时间 canonicalize，同一段睡眠跨 Telegram/飞书或分钟数修正时会替换旧行；sleep backfill 会重放已有 ingest 睡眠批次修复旧数据，Pages 构建也改为先执行安全数据库修复再导出 Markdown。
- 修复 Telegram 睡眠截图归档日期被多减一天的问题：当 AI 已根据睡眠时间轴识别出入睡日期，但 `bedtime` / `wakeTime` 只包含时分时，程序不再把该日期当作醒来日期再次前移，避免睡眠数据写入前一天、导致目标日页面显示为空。
- 修复 docs 体系重构后 CI 文档契约测试仍读取 `docs/系统核心.md`、`docs/系统配置.md` 和缺失的 `docs/README.md` 导致 `test:fast` 失败的问题；新增当前 `docs/README.md`，同步根 README 链接、维护/排障文档和相关测试到新的分层 docs 入口。
- 修复日志泄露修复引入的 Telegram/飞书队列回归：`workflow_dispatch` 不能通过 `$GITHUB_ENV` 覆盖受保护的 `GITHUB_EVENT_PATH`，导致同步 step 读回原始 workflow 事件、实际消费 0 条 webhook update；现在 workflow 通过 `SYNC_DISPATCH_EVENT_PATH` 传递 runner 临时事件文件路径，保留 payload 不落日志的同时恢复 Telegram 图片随想处理、结果通知和页面部署触发。
- 增强 Telegram/飞书同步的 COS 上传失败诊断：同步 workflow 现在会在失败时提取高信号日志摘要并回传到 Telegram 失败通知；COS SDK 普通对象错误会输出 `Code`、`statusCode`、`RequestId` 等字段，不再显示 `[object Object]`，便于定位 CAM 权限、bucket/region 或签名问题。
- 修复 Telegram/飞书随想图片通过 COS 上传时，下载层返回 `Uint8Array` 被腾讯云 COS SDK 拒绝为 `params Body format error` 的问题；COS provider 现在会在上传前转换为 Node `Buffer`，保持本地图片写入路径不变。

## [1.3.1] - 2026-06-26

### Added

- 随想图片存储新增腾讯云 COS 支持：默认仍使用本地 `source/images/thoughts`，启用 `COS_ENABLED=true` 后，Telegram/飞书随想图片会上传到 COS，并把完整公有读 URL 写入 `core.thought.image_refs_json`，Markdown 备份和站点页面继续从数据库引用原始 URL。
- `sync.yml` 与 `sync-dev.yml` 新增 COS 运行时配置注入和 `## Image storage` summary，展示 provider、bucket、pathPrefix、上传/跳过/失败数量、上传耗时和首个 URL host；dev 环境会校验 bucket/domain 不得与 main 相同。

### Changed

- 同步项目包版本号到 `1.3.1`。
- 系统长期文档补齐 COS 图片存储当前事实，明确 Cloudflare Worker 不接触 COS 凭据、Markdown backup 和 Pages 构建不上传图片、历史 `/images/thoughts/...` 路径不迁移且继续可访问。
- 将 `docs/后续规划_未实现/图片oss存储/` 标记为已实现方案文档，保留实施报告用于追溯；`docs/后续规划_未实现/` 其它目录仍为未实现规划或审计资料。

### Fixed

- 修复随想详情页中带图内容的排版不协调问题：详情页现在先显示正文、再显示图片；图片会按容器自适应，桌面端限制最大宽高，手机端限制为容器宽度和 72vh 高度，避免原图过大导致正文显得过小或页面比例失衡。
- 加固 COS 图片上传失败路径：上传失败时不写入错误 URL、不调用随想持久化，避免污染数据库图片引用。

## [1.3.0] - 2026-06-23

### Added

- 新增 dev 统一同步入口 v19：`sync-dispatch-dev` 同时接收 Telegram webhook 和飞书事件回调，统一派发到 `.github/workflows/sync-dev.yml`，并由 `deploy-cloudflare-worker-dev.yml` 部署单一 dev Worker 和刷新 dev Telegram webhook。
- 新增 `tools/feishu-action-monitor.mjs`，当 `Feishu Sync` / `Feishu Sync (Dev)` 的 `repository_dispatch` workflow 失败时，会读取原始 `feishu_update(s)` payload 并向对应飞书 chat 回发失败阶段和 GitHub Actions run URL。
- 新增文档优化删除 v22 执行记录，沉淀 README 与 docs 收敛目标、删除清单、迁移规则和验证命令。
- 新增 v23 文档体系精简与系统行为校准文档，补齐 `docs/总览/系统行为手册.md`、AI Agent 入口、文档盘点、重复冗余分析、合并方案、可删除清单和迁移 checklist，把图片输入、随想输入、分析输入、Markdown 输入收敛为四类用户行为事实源。

### Changed

- 收敛 GitHub/Cloudflare、飞书通道、系统总览、数据流转与日常维护文档为当前 main/dev 入口口径，补齐生产 Pages 缓存刷新、统一 Worker、GitHub Actions 参数和 dev Cloudflare Pages 验证说明，降低飞书/Telegram 同步部署排查时的配置歧义。
- 精简 README 与 docs 推荐阅读路径，只保留当前维护入口，并统一 Telegram/飞书共用 Worker、`sync.yml`、`sync-dev.yml` 与当前部署 workflow 口径。
- 将 AI 备用方案、AI 返回 schema 校验、Telegram 命令优先级等仍有维护价值的信息合并进长期维护文档，避免小文档分散维护。
- 统一 main 和 dev 部署 workflow 的随想页面验证 base URL 配置方式：main `deploy-pages.yml` 从硬编码 `https://soulgo.chat` 改为读取 GitHub 变量 `CLOUDFLARE_PAGES_BASE_URL`，dev 继续使用独立的 `CLOUDFLARE_PAGES_DEV_BASE_URL`；两个环境各有专属变量，配置文档同步补齐说明。
- 重构长期 docs 目录为总览、架构、核心业务、消息链路、AI 识别体系、数据模型、部署运维、开发指南、运维手册、故障排查、参考资料和 AI-Agent，并将 README 与维护测试指向新的长期事实文档。

### Removed

- 删除旧 dev 双入口配置：`wrangler.feishu-dev.toml`、`telegram-sync-dev.yml`、`feishu-sync-dev.yml` 和 `deploy-cloudflare-feishu-worker-dev.yml`，dev Telegram 与飞书改为共用 `sync-dispatch-dev`。
- 删除历史归档目录、v5-v12/v14-v17 旧阶段优化方案，以及已合并的 dev 配置清单、AI 备用方案、AI schema 校验和 Telegram 命令注册表等过时文档。
- 删除已迁移或被新主文档覆盖的旧 docs 路径，包括 `dev_env`、旧 `系统架构`、`数据流转`、`训练系统`、`部署维护`、`问题排查` 和旧 `优化重构` 目录，避免同一事实在主文档体系中保留多份入口。

### Fixed

- 修复 main 分支生产 Pages 部署后随想模块页校验因 Cloudflare/GitHub Pages 自定义域名传播延迟短暂读到旧 HTML 而误报失败的问题；`deploy-pages.yml` 现在会对目标随想页做最多 12 次、每 10 秒一次的有限轮询，命中 `data-thought-id` 后立即通过，超过上限才失败。
- 修复随想列表页直接暴露 Telegram/飞书长 ID 导致页面信息噪音较高的问题；随想 ID 现在隐藏在可点击的 `ID` 按钮后，通过 `data-thought-id` 保留部署校验能力，并支持点击复制真实 ID 供后续编辑、移动或删除命令使用。
- 修复 README、docs 索引和维护测试仍引用旧文档路径的问题，统一改为 `docs/部署运维/部署运维.md`、`docs/运维手册/运维手册.md`、`docs/故障排查/故障排查.md`、`docs/参考资料/参考资料.md` 等新入口。
- 修复 Telegram/飞书跨通道 `/随想编`、`/随想删`、`/移动` 已存在随想时错误使用命令消息来源覆盖目标随想来源的问题：DB-only 写回现在优先沿用目标行原有 `source_channel`、`source_chat_id` 和 `source_message_id`，避免飞书显式 ID 编辑进入 `source_message_id` 为空的 `pending_replay`，以及 Telegram 删除飞书随想时触发 `thought_pkey` 主键冲突。
- 修复 Telegram/飞书纯文本随想已入库但不触发页面刷新的问题：新建随想即使没有图片附件也会标记为 `thought_database_only` 数据库内容变更，并在结果中保留持久化后的随想 ID，确保同步 workflow 能触发后续部署校验。
- 修复生产/开发站点部署在严格数据库导出已成功后仍二次读取数据库、偶发 `database snapshot unavailable: timeout expired` 导致页面刷新失败的问题：site-build action 在 `export:markdown` 成功后切换为已导出的 Markdown 快照供后续测试和构建复用。
- 修复 Telegram 饮食图片识别偶发 schema 校验失败的问题：AI 返回 `"510 kcal"`、`"约360"` 等带单位热量时会在校验前归一化为数字，无法确认热量的餐次会跳过；同时允许建议热量范围为 `null` 并收紧 prompt，避免 `records.meals[].calories` 因非数字触发重试。
- 修复飞书单条文本随想也不触发 GitHub Actions 的问题：飞书 `text` 消息现在绕过 `FEISHU_IMAGE_BUFFER`，直接进入全局同步队列；图片消息仍保留 3 秒 burst 缓冲。同步队列在 `workflow_dispatch` 后长期找不到对应 run 时会 dead-letter 当前任务并继续处理后续消息，且在配置 Worker 级 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` 时会向飞书回发“GitHub Action 未能启动”。
- 修复飞书连续随想队列在 GitHub Actions run title 被截断后卡死的问题：`SyncDispatchQueue` 现在使用短稳定 `queue_task_id`（`channel:sortKey:eventType:hash`），避免把完整飞书 payload 写入 run 标题；同时兼容旧的超长队列 ID 前缀匹配，让已卡在 `wait_for_run` 的任务可以继续 drain 后续消息。
- 修复飞书连续发送多条文本随想/随想编时只处理第一条的问题：飞书文本消息进入全局同步队列按 `create_time` 顺序处理，图片消息继续按 chat 进入 3 秒 burst buffer 并聚合为 `feishu_updates`；同时补齐 buffer 重试保护、结构化日志和 Cloudflare Workers observability，便于后续排查历史回调链路。
- 补充 dev 环境连续发送多条随想的实测验证记录：当前已确认连续多条随想可以按队列顺序完成同步，不再复现中间消息丢失或被取消的问题。
- 修复 `repository_dispatch` 总是读取默认分支 workflow、导致 dev 上的连续消息队列修复未生效的问题；Cloudflare `SyncDispatchQueue` 现在改用 `workflow_dispatch` 并按环境传入 `GITHUB_SYNC_REF`（dev/main 分别触发各自分支），workflow 通过 `queue_task_id` 精确匹配 run，避免连续随想消息中间 run 被旧默认分支并发组取消或误关联。
- 修复 `SyncDispatchQueue` 使用异步 KV 数组读改写导致连续 Telegram/飞书 webhook 并发入队时可能覆盖中间任务的问题；生产 Durable Object 改用 SQLite 表保存 FIFO 队列和 processing 状态，测试环境也串行化 KV fallback，确保三连发不会丢第二条。
- 修复 dev Worker 推送后没有自动部署的问题；`deploy-cloudflare-worker-dev.yml` 现在在 `dev` 分支相关 Worker/workflow 配置变更时自动部署并刷新 dev Telegram webhook，避免测试仍命中旧 Worker 代码。
- 修复 Telegram/飞书连续发送多条随想或图片时 GitHub Actions 固定 `concurrency.group` 只能保留一个 pending run、导致中间消息被取消的问题；新增 `SyncDispatchQueue` Durable Object 作为真正的 FIFO 队列，统一承接 Telegram/飞书文本和图片 burst，按顺序触发并轮询同步 workflow，前一个 run 失败或取消后仍继续处理后续任务。
- 修复随想页面部署校验用 `grep -F "#ID"` 前缀匹配导致短 ID 误命中长 ID（如 `#3` 命中 `#300`）的问题；部署 workflow 现在只检查精确 `data-thought-id="ID"`，随想列表页也为 Telegram 和飞书随想统一输出 `data-thought-id`。
- 修复 `/随想编 id 模块`（仅修改模块、不带正文）被误拒为"empty thought body"的问题：`analyzeThoughtEditBatch` 现在在指定了有效模块时允许空正文；`persistMirror` 的 `thought_edit` 分支改为传递 `null`（而非空字符串）作为 body，使 SQL `coalesce` 保留原有正文，与 `thought_move` 行为一致。
- 修复 dev 部署工作流验证步骤因 Cloudflare CDN 传播延迟而报错的问题：`deploy-cloudflare-pages-dev.yml` 现在会从 wrangler 输出中捕获部署专属 URL（如 `https://xxx.training-records-dev.pages.dev`），用该 URL 进行随想页面验证（部署专属 URL 立即可用，不受 CDN 传播延迟影响）；验证通过后还会等待生产别名 URL 传播并尝试确认。
- 修复随想 `/移动` 或 `/随想编` 切换模块后部署页面仍显示在旧模块的问题：site-build action 现在先从数据库导出新鲜 Markdown（清理旧文件）再执行 `sync:db` 回填，避免 `backfillThoughtsToCore` 从旧磁盘文件读到过时的 `thought_module` 并覆盖数据库中已正确更新的值。
- 修复飞书/Telegram `/随想编 id 模块 内容` 和 `/移动 id 模块` 后同一随想 ID 可能同时出现在新旧模块页的问题；数据库快照与 Markdown 导出现在会按 `telegramMessageId` 去重，只保留最新有效记录，并在导出前清理带随想 front matter 的旧派生 Markdown。
- 加强随想 DB-only 变更后的部署验收：生产和 dev 部署 workflow 现在会检查 `/thoughts/`、`/misc/`、`/body-feedback/` 三个模块页，确保目标 ID 只出现在目标模块，删除时从所有模块消失；同步 workflow 也会把部署等待失败识别为“站点部署/页面刷新”，不再回传 `Unknown workflow stage`。
- 修复生产 Pages 手动或 push 触发 deploy 默认跳过数据库 Markdown 导出、导致 DB-only 随想从页面消失的问题：`deploy-pages.yml` 和 dev Cloudflare Pages deploy 现在默认使用严格数据库快照，只有显式选择关闭时才允许回退。
- 修复飞书误输入 `/随便编 id 模块 内容` 时被当普通文本静默忽略、没有回执也不触发 deploy 的问题；该常见错字现在按 `/随想编` 解析为随想编辑/移动命令。
- 增强飞书/Telegram `/随想编`、`/移动` 等 DB-only 随想变更后的生产 Pages 成功语义：`sync.yml` / `sync-dev.yml` 会把已入库的目标随想 id、模块和目标页路径传给部署 workflow，并等待下游 deploy 完成；目标页面校验失败、下游部署失败或超时都会让同步 Action 失败，避免只看到“更新成功”但页面仍未刷新。
- 修复飞书 `/随想删` 删除已入库但页面仍显示的问题：`sync.yml` 和 `sync-dev.yml` 现在会把 `thought_edit`、`thought_delete`、`thought_move` 的 `ready + stored` 批次视为 DB-only 内容变化并异步触发严格数据库快照部署。
- 修复飞书回复原 `/随想` 消息后发送 `/随想删` 无法定位目标的问题：飞书同步现在读取 `parent_id` / `root_id` 并转换为稳定数字代理 ID；无 id 且无回复目标时会返回失败原因，不再误报删除成功。
- 修复 DB -> Markdown 导出只清理 `*-telegram-thought-*.md` 的问题；导出前会同时清理 `*-feishu-thought-*.md`，避免飞书旧随想备份残留在页面。
- 加固飞书图片 burst 缓冲：`FEISHU_IMAGE_BUFFER` 在 GitHub `repository_dispatch` 失败时不再清空已缓冲图片事件，会保留事件、记录安全诊断日志并按有限退避重新设置 alarm，方便在 Cloudflare tail 中定位 `feishu_update` / `feishu_update_dev` 是否成功派发。
- 飞书同步 workflow 新增失败通知步骤，确保同步失败时飞书侧能收到 Action 失败回执；成功通知仍保持在同步/提交/推送之后、异步页面部署之前。
- 修复飞书图片识别成功后因 `oc_...` 字符串 chat id 写入 PostgreSQL `bigint` 字段失败而进入 `pending_replay`、页面无更新的问题；旧 Telegram 兼容字段现在只写数字或 `null`，真实飞书 chat id 继续保留在 source 元数据和 Action summary 中，同时保留飞书图片批次的 `source_channel='feishu'`。
- 修复飞书图片批次已成功入库但异步 Pages deploy 在严格数据库导出阶段因 PostgreSQL schema preflight 连接超时而失败、页面不更新的问题；`export:markdown` 现在会对瞬时 DB preflight 连接错误做有限重试，schema preflight 也只在 SQL 成功后标记为已执行，避免失败后跳过后续重试。
- 修复 GitHub Pages 已部署新训练数据但 `soulgo.chat` 仍命中 Cloudflare 旧 HTML 缓存、导致飞书入库数据短时间不显示的问题；生产 Pages 部署成功后会在配置 `CLOUDFLARE_ZONE_ID` 和 `CLOUDFLARE_API_TOKEN` 时自动清理 Cloudflare 缓存。
- 修复 Cloudflare purge API 缺失或权限不足时生产 Pages deploy 仍显示成功的问题；清缓存步骤现在会以 error 失败，避免站点已发布但 Cloudflare 仍命中旧 HTML 缓存时被误判为页面已刷新。
- 修复飞书随想列表页只显示“飞书”而不显示可操作 ID 的问题；飞书随想现在和 Telegram 随想一样显示 `#ID`，并保留 `data-thought-id` 供部署校验使用，方便继续按 ID 编辑、移动和删除。
- 修复飞书/Telegram `/随想编` 或 `/移动` 指向不存在目标 id 时仍通过 PostgreSQL upsert 创建新 `core.thought` 并误报成功的问题；同步现在会先校验目标随想存在，缺失时返回 `not_found`、发送失败通知，且不会触发 DB-only 页面部署。
- 修复飞书/Telegram 误把 `/随想 id 模块 正文` 当作新随想写入并回成功的问题；该歧义输入现在会跳过入库并提示使用 `/随想编 id 模块 内容`，同时飞书 DB-only 随想编辑/移动会保留飞书标签。
- 修复手动触发 `deploy-pages.yml` 或 `deploy-cloudflare-pages-dev.yml` 时即使选择修复分支也仍固定 checkout `main`/`dev`、导致无法在分支上验证 deploy 修复的问题；手动 deploy 现在会使用触发时选择的 ref。

## [1.2.9] - 2026-06-14

### Added

- 新增飞书消息通道 v18：飞书事件经独立 Cloudflare Worker 验签、3 秒图片 burst 缓冲和 `repository_dispatch: feishu_update` 进入 `Feishu Sync` workflow，再通过 `npm run sync:feishu` 复用现有 Telegram 同步主编排、AI 图片识别、随想入库、`/分析` 和 PostgreSQL 增量写入链路；飞书图片以内联 data URL 发送给 AI，core 子表写入 `source_channel='feishu'`。
- 新增飞书部署文档 `docs/部署维护/飞书通道部署.md`，覆盖飞书开放平台权限/事件订阅、GitHub `FEISHU_*` 配置、Cloudflare `feishu-sync-dispatch` Worker Secret/Durable Object、部署命令和验收排查步骤。
- 新增 Cloudflare CDN 代理加速方案 v17 并标记为已实施：`soulgo.chat` 通过 Cloudflare 橙云代理加速 GitHub Pages 访问，配置 CNAME → `soulgo.github.io`、SSL/TLS Full (Strict)、Auto Minify、Brotli、HTTP/3、分层缓存规则（字体 1 年、图片 30 天、CSS/JS 7 天、HTML 5 分钟 + stale-while-revalidate）和 Always Online。同步更新系统总览、GitHub 与 Cloudflare 配置、日常维护手册、常见问题排查和三份 drawio 架构图，移除所有 DNS/CDN「待人工确认」标记。
- 新增 Dev 合并 Main 操作手册，明确 `dev` 合入 `main` 时的允许合并范围、生产数据保护路径、`source/_data/**` 派生数据边界、严格恢复脚本、测试清理和推送后 Actions 验证流程，方便后续快速执行”只合代码、不合 dev 数据”的发布合并。

### Changed

- 系统文档从 Telegram 单通道口径更新为 Telegram/飞书双消息通道口径，明确飞书只新增通道适配层和部署入口，不新增独立 ingest 表、不复制同步主流程；`core.thought.telegram_message_id` 仍是兼容字段名，飞书随想使用稳定数字代理 ID 并保留 source 元数据。
- 同步项目包版本号到 `1.2.9`。

### Fixed

- 补充 Telegram 连续图片 burst dispatch 的回执回归测试，覆盖同一次 `repository_dispatch` 中包含多个图片业务 batch 时，`telegram-sync-notify` 必须按业务 batch 逐条发送 Telegram 回执，并分别回复到对应批次首条消息，防止再次出现 3 批图片只收到 2 条回执的退化。
- 修复 Telegram 连续快速发送多批图片时，中间批次的 GitHub Actions run 可能因固定 `concurrency.group` 在进入 runner 前被自动取消，导致第二批图片看起来被跳过的问题；生产和 dev Telegram Sync workflow 现在仅对 `repository_dispatch` 使用包含 `github.run_id` 的唯一并发组，保留手动/push 同步的固定并发保护。
- 修复 Telegram 连续发送多批图片时，相册和单图批次被拆成多个独立 GitHub `repository_dispatch`、顺序依赖外部排队的问题；Cloudflare Worker 现在按 chat 对连续图片 update 进行 3 秒突发缓冲，photo 与图片文件都会按 `update_id` 合并派发，确保一轮连续发送按 Telegram 顺序进入同步解析。
- 修复 Telegram 连续发送图片时，单图批次因 AI 将 `detectedDate` 留空但 `warnings` 已说明截图内可见月日而被误判为无可靠日期，导致该批次不入库、首页无更新的问题；日期归档现在会从图片证据 warning 中提取单一月日并结合 Telegram 消息年份补全，同时继续跳过冲突或多日期 warning。

## [1.2.8] - 2026-06-13

### Added

- Telegram 图片识别新增自适应健康 APP 字段映射 v15：schema 升级到 `v2`，顶层增加 `detectedApp`，并新增 `prompts/_source/app-profiles.json` 作为 APP 别名、页面特征、字段别名、单位换算和时间优先级的可维护记忆源。
- 新增 Apple Health 睡眠识别 fixture 与回归测试，覆盖非华为 APP 的 `detectedApp` 保留、可见核心睡眠字段提取，以及截图不可见字段保持 `null`。
- 随想模块列表页新增长内容自动摘要：正文超过摘要阈值时只显示开头内容，并提供“查看全文”链接跳转到对应随想详情页，避免长 Markdown 附件随想撑满模块首页。
- 锻炼随想、杂七杂八和身体反馈三个随想模块新增分页能力：每页最多展示 15 条随想，超过后自动生成 `page/2/` 等分页页，并显示上一页/下一页按钮。
- Telegram `/随想` / `/thought` 新增 Markdown 文档附件正文能力：发送 `.md` 或 `.markdown` 文档并在 caption 写命令后，系统下载附件、按 UTF-8 去 BOM/trim，并把正文写入 `core.thought.body`；caption 仅用于命令和模块识别，附件正文优先，单个附件大小上限为 5MB。
- Telegram `/随想编 <id>` 新增 Markdown 文档附件编辑能力：发送新的 `.md` 或 `.markdown` 文档并在 caption 写 `/随想编 id` 或 `/随想编 id 模块` 后，附件内容会作为新的完整正文写入 `thoughtEdit.body` 并整体替换原随想正文；caption 正文不与附件拼接。
- Telegram `/help` / `/帮助` 命令清单新增 Markdown 附件发送和 Markdown 附件编辑用法说明，提示通过 Telegram“文件”发送 `.md/.markdown` 并在 caption 写随想或编辑命令。
- 补充 Markdown 附件随想的分组、运行链路和页面渲染测试，覆盖模块-only caption、非 Markdown 文档跳过、空文件、下载失败、5MB 超限和大于 1MB 但不超过 5MB 的成功路径。
- 补充 Markdown 附件编辑随想的分组和运行链路测试，覆盖 id-only caption、模块-only caption、附件正文优先、空文件和 5MB 超限。

### Changed

- 图片识别 prompt 改为 APP 无关的自适应提取口径：移除华为「自由训练」专属提示，要求 AI 只提取截图真实可见数据，并通过 App Profile 将不同 APP 的字段别名映射到现有 schema 字段；batch 结果同步输出第一个非空 `detectedApp` 作为审计信息。
- 调整首页趋势分析卡片图例样式：图例固定在每张图表卡片右上角，多指标竖向排列且不再使用底色/边框，避免横向图例挤压左上角标题与副标题。
- 将 Telegram 图片识别备用 AI 方案文档从仓库根目录移动到 `docs/训练系统/AI_BACKUP_SOLUTION.md`，使训练系统文档集中维护。

### Removed

- 删除 v15 文档中的 v15-B / extraMetrics / `extra_metrics_json` 路线说明，明确当前自适应图片解析只落地现有字段映射，不扩展 core 表结构或页面展示。

### Fixed

- 修复 Telegram 连续分批发送图片时，Telegram 回执显示 partial failure 但 GitHub Action summary 仍显示 `ready + stored` 的审计不一致问题：生产和 dev workflow 的 summary 现在会用 `buildTelegramSyncReport()` 规范化原始同步结果，正确展示 `taskStatus=partialFailure`、`failureDisposition=auto_retry`、图片计数和失败 message id；同步结果文件仍保留原始 `batchResults`，保证 after-action Telegram 通知可继续回复到原消息。
- 修复睡眠看板在 Telegram 睡眠截图已解析并入库后仍显示“待比较”的问题：页面读取数据库快照时优先使用 `core.sleep` 明细作为睡眠卡片来源，只在缺少明细时才回退到 `core.training_day` 睡眠汇总，避免把 `totalSleepMinutes` 与 `nightSleepMinutes` 或日汇总重复聚合；同时加固图片识别 prompt，明确总睡眠和夜间睡眠是同一条 `records.sleep` 的两个字段、不可相加，睡眠阶段和健康指标也必须写入同一条睡眠记录。
- 修复睡眠截图识别已拿到夜间睡眠时长但遗漏总睡眠时长时，页面总睡眠和日期卡片仍显示 `—` 的问题：Telegram 睡眠归一化会从 `nightSleepMinutes` 补齐 `totalSleepMinutes`，看板展示也兼容已入库的同类半残数据。
- 修复 Markdown Backup 定时任务在生产库缺少新增睡眠汇总列时导出失败的问题：`export:markdown` 在严格读取数据库快照前会先执行幂等 schema preflight，只补齐缺失列，不回填或推断业务数据；preflight 或快照读取失败时仍直接失败且不会覆盖现有 Markdown 备份，避免数据丢失和不准确备份。
- 补全 v1.2.7 修复的遗漏范围：`core-row-writer.pg.mjs` 中 `buildSleepRows` 的 14 个 `int4` 字段（`nightSleepMinutes`、`totalSleepMinutes`、`deepSleepMinutes`、`lightSleepMinutes`、`remSleepMinutes`、`awakeMinutes`、`napMinutes`、`sleepScore`、`sleepScorePercentile`、`deepSleepContinuityScore`、`wakeCount`、`breathingQualityScore`、`averageHeartRateBpm`、`hrvMs`）以及 `insertCoreMeasurements`/`insertCoreActivities`/`insertCoreMeals` 的整型字段，`incremental-write.pg.mjs` 的 nutrition 和 workout summary 参数，`archive-repository.pg.mjs` 的 sleep/activity/meal 整型字段，均补加 `Math.round(Number(...))` 取整保护，防止 AI 识别返回浮点值（如 `143.1`）触发 `invalid input syntax for type integer` 导致数据库写入失败和首页无数据显示。
- 修复 `core.sleep` 和 `core.training_day` 表缺少新增列（`total_sleep_minutes`、`sleep_score`、`average_heart_rate_bpm`、`hrv_ms` 等）导致 `column does not exist` 写入失败。新增 `schema-preflight.pg.mjs` 在每次进程首次连接数据库时自动执行 `ALTER TABLE ADD COLUMN IF NOT EXISTS`，确保 schema 演进无需手动迁移。

## [1.2.7] - 2026-06-10

### Fixed

- 修复 AI 识别返回浮点卡路里值（如 `143.1`）导致 PostgreSQL `integer[]` 列写入失败（`invalid input syntax for type integer`）的问题。涉及 `normalizeNutrition` 中 `calories`/`recommendedMin`/`recommendedMax`、`sumMealCalories`、`summarizeActivities.trainingCalories` 以及 `normalizeBatchActivity.calories` 的取整处理。

## [1.2.6] - 2026-06-10

### Changed

- 六边形架构重构 v13.1 全面落地：B3/B4/B9/B10/B11/B12 全部完成，374 测试通过。
- B3 Step 2 SQL 提取全部完成（`writeCoreDays` / `readCoreDay` / `upsertArchiveParseSnapshot` 已迁移到 `src/adapters/postgres/core-day-repository.pg.mjs`）。
- B4 read.mjs 内联 SQL 已委托到适配器（`getLastProcessedTelegramUpdateId` 迁移至 `src/adapters/postgres/telegram-batch-repository.pg.mjs`）。
- B9 tools/ 目录对齐：4 对重复模块 diff 完成并薄化为 re-export（training-domain/parser/snapshot/dashboard-view），`tools/training-db-core.mjs` 改为从 `src/adapters/postgres/` 导入，`src/domain/training/training-snapshot.mjs` 移除对 tools/ 的反向引用，`tools/lib/fs-walk.mjs` 复制到 `src/shared/`。
- B11 遗留代码清理：15 项全部完成——旧文件薄化为 re-export 或确立 canonical 位置，逻辑已迁移到 adapters/use-cases。
- B12 测试验证：领域实体 5 tests、领域服务 6 tests、适配器 2 tests、Telegram Mock 4 tests，CI 已配置。
- `src/jobs/telegram-sync-job.mjs` 与 `src/app/use-cases/telegram-sync.use-case.mjs` 导出对齐。
- DI 容器 `src/infra/app-factory.mjs` 验证通过，无循环依赖；`src/infra/config.mjs` 统一配置校验就绪。
- 文档目录中文重命名：`re_v5`→`系统优化重构_v5`、`deploy_build_v7`→`构建性能优化_v7`、`telegram_sync_v6`→`图片识别优化_v6`。
- `docs/系统架构/系统总览.md` 新增六边形架构章节，内部接口手册 CLI 入口更新为新 use-case 路径。
- `docs/优化重构/数据统一与六边形架构重构_v13/实施checklist.md` 里程碑全部 ✅。

### Fixed

- 修复 `src/jobs/telegram-sync-job.mjs` 导入不存在的导出导致 `pending-store.test.mjs` 和 `src-boundary.test.mjs` 失败。
- 修复多个文件尾部 null 字节引发的语法错误。

### Added

- `src/adapters/postgres/telegram-batch-repository.pg.mjs` 新增 `getLastProcessedTelegramUpdateId` 实例方法和独立函数。
- `src/shared/fs-walk.mjs` 从 `tools/lib/` 迁移至 shared 层。

## [1.2.5] - 2026-06-08

### Removed

- 删除 MCP stdio server、`src/mcp/**` tool 层、`mcp:server` npm 脚本、MCP 当前使用文档和 MCP 测试。
- 删除 Telegram `/ai` / `/智能助手` 独立 Agent 入口、`tools/telegram-ai-agent.mjs`、`ai_agent` 命令注册/解析/运行/report/help 文案和相关测试。

### Changed

- V11 优化 Telegram 同步与构建链路：部署构建通过 `TRAINING_BUILD_ARCHIVE_WRITE=false` 跳过 archive 写库，archive 写入支持相同 `source_hash` 早停和批量 upsert，Telegram sleep backfill 只在真实 sleep 入库或显式开关时运行。
- Telegram Sync main/dev workflow 显式透传 `AI_PROVIDER`、`AI_TIMEOUT_MS`、`TELEGRAM_RECOGNITION_MODEL`、`TELEGRAM_RECOGNITION_CACHE_ENABLED`，便于在 GitHub Settings 中切换 OpenAI-compatible 服务。
- Telegram 图片增量入库刷新 `core.training_day` 汇总时改为单条 CTE upsert，减少远程 PostgreSQL 往返并保留未覆盖模块。
- 统一 README、系统接口、睡眠入库、部署配置和 Dev 环境文档中的事实源口径：PostgreSQL `core.*` 为当前唯一事实源，Markdown 仅作为备份或显式人工维护输入；V9 及更早 fallback 口径降级为历史背景。
- README、长期 docs、Telegram 命令说明和排障文档移除 MCP 与 `/ai` Agent 当前能力口径，保留 Telegram 图片识别、随想入库和 `/analysis` 主链路。
- `sql/training_records/` 明确为当前数据库结构基准，`sql/pgsql17.sql` 调整为向拆分 schema 对齐的总初始化脚本。
- Telegram `/ai` / `/智能助手` 消息不再进入同步 batch，也不会触发 AI Agent 回复或文件/数据库写入。
- `package.json` 版本号更新为 `1.2.5`。

### Fixed

- 修正 `sql/pgsql17.sql` 中 `archive.training_sleep.sleep_stage_detail` 类型为 `jsonb`，与 `sql/training_records/` 最终结构一致。
- 修复 Windows 环境下派生数据 merge 相关测试的 file URL 与路径分隔符问题，避免本地验证因平台差异失败。

## [1.2.4] - 2026-06-08

### Added

- 新增 `markdown-backup.yml`，用固定 cron 唤醒并通过 `MARKDOWN_BACKUP_ENABLED`、`MARKDOWN_BACKUP_FREQUENCY`、`MARKDOWN_BACKUP_BRANCH`、`MARKDOWN_BACKUP_COMMIT` 控制 DB -> Markdown 备份。
- 新增 `docs/优化重构/数据库唯一事实源与Markdown备份方案.md`，记录 PostgreSQL canonical、Markdown 备份边界、GitHub Variables 和验收标准。
- 新增 `deploy-cloudflare-pages-dev.yml`，将 `dev` 分支构建产物发布到 Cloudflare Pages 预览环境，默认地址为 `https://training-records-dev.pages.dev`。
- Telegram 同步报告新增阶段耗时 `timingsMs`，并在 GitHub Actions summary 与日志中输出 `resolveUpdates`、`recognition`、`persist`、`sleepBackfill`、`markdownRewrite`、`notify` 等耗时，便于下次直接定位同步慢点。
- 新增 `TELEGRAM_RECOGNITION_IMAGE_INPUT_MODE=auto|url|inline`，支持先下载 Telegram 图片并以内联 data URL 发送给 AI；GitHub Actions 默认使用 `inline`。
- 新增 `TELEGRAM_RECOGNITION_MODEL`，可只覆盖 Telegram 图片识别模型，未配置时继续使用 `AI_MODEL`。
- Deploy Pages 与 Dev Cloudflare Pages workflow 新增 `strict_database_snapshot` 手动输入，并映射为 `TRAINING_SNAPSHOT_STRICT_DATABASE`。
- 新增 `merge:dev-to-main` 与 `check:derived-data-merge` 命令，dev 合并 main 时保留 main 的生产数据备份，并在 PR 到 main 时阻断派生数据误合并。

### Changed

- PostgreSQL `core.*` 成为训练、饮食、体脂、睡眠、随想和身体反馈的唯一事实源；Markdown 调整为数据库派生备份和显式人工维护输入。
- `sync:db` 默认只执行 archive 回填、ingest 睡眠修复和 thoughts 同步，不再自动执行 Markdown -> DB 对账；`import:markdown` / `reconcile:markdown` 仅保留为显式人工维护入口。
- Telegram 图片成功路径改为只增量 upsert 本批次 `core.measurement`、`core.activity`、`core.meal`、`core.sleep` 并刷新 `core.training_day`，不再即时改写 `训练记录.md`。
- Telegram 随想和身体反馈以 `core.thought` 为准；Markdown 文章由 DB -> Markdown 备份任务导出，带图随想只即时保存图片 artifact。
- `export:markdown` 改为严格从数据库导出 `训练记录.md` 和随想 Markdown，数据库快照不可用或不完整时直接失败，不再回退旧 Markdown。
- Telegram Sync main/dev workflow 移除同步 action 内联站点构建与 Pages 部署，改为在 commit/push 后立即发送 Telegram “已入库/解析完成”通知，再异步触发独立站点部署 workflow。
- Telegram Sync 失败监控不再把站点构建或 Pages 部署状态归为同步失败原因；站点部署失败改由独立部署 workflow 暴露，不影响 Telegram 入库回执。
- Dev 环境文档改为包含 Cloudflare Pages 在线预览流程，保留本地 `npm run server` 作为快速调试入口。
- Telegram Sync 在 `repository_dispatch` 入库成功后，只要仓库文件或数据库内容发生变化，都会异步 dispatch 独立部署 workflow，并启用严格数据库快照模式。
- 页面构建读取 PostgreSQL 快照时保留多连接并发读取，遇到连接或查询失败后会重试一次单连接读取，降低构建阶段因连接抖动回退 Markdown 的概率。
- Telegram Sync workflow 权限收敛为 `contents: write` 与 `actions: write`，不再为同步 workflow 申请 Pages/id-token 权限。
- `package.json` 版本号更新为 `1.2.4`。

### Fixed

- 修复部署或维护默认同步可能把旧 Markdown 回灌到数据库、导致页面 DB 数据在版本更新后丢失的问题。
- 修复 `sync:db` 经维护入口调用时默认 phase 被解析为 `all` 的问题，现在默认与底层 safe 同步保持一致。
- 修复 Dev Telegram webhook URL 误填 Cloudflare Account ID 导致 `setWebhook` 失败的问题，明确应使用 Workers 子域名。
- 修复 Dev Telegram Sync 由 `GITHUB_TOKEN` 推送内容后不会触发 Dev Pages 自动部署的问题：repo 或 DB 内容变化都会异步 dispatch `deploy-cloudflare-pages-dev.yml`。
- 修复 Telegram Sync 在 `repository_dispatch` 下仍等待站点 build/deploy 导致单次图片同步耗时过长的问题；现在 Action 只等待解析与入库，页面展示由独立 deploy workflow 异步完成。
- 修复 Telegram 睡眠图片批次成功识别并存储后未触发 `core.sleep` 回填的问题，避免日志无报错但睡眠表和页面仍没有睡眠数据。
- 修复 DB-only 入库后页面构建读库失败时可能静默回退并发布旧 Markdown 页面的问题；Telegram Sync 异步部署会启用严格数据库模式，读库失败将直接暴露为部署失败。
- 修复 Telegram 训练图片识别未向 AI 传递消息日期导致 `6月6日` 这类截图内月日补全年份不稳定的问题，并兼容 AI 返回字符串 `"null"` 的日期字段；低置信度但截图内日期可见的图片现在会保留日期证据并进入 AI 识别重试队列，不再误报为“没有可靠日期”。

## [1.2.3] - 2026-06-07

### Changed

- Telegram 图片正常成功路径改为按本批次增量 upsert `core.measurement`、`core.activity`、`core.meal` 与 `core.sleep`，并刷新目标日期 `core.training_day` 汇总，避免同日补发截图删除其它模块数据。
- Telegram `ready + stored` 图片批次不再默认用数据库全量快照覆盖 `训练记录.md`，改为仅对目标日期做 Markdown 增量合并；数据库写入失败时仍保留 fallback Markdown 与 pending 队列。
- `src/db/training/write.mjs` 拆出 Telegram 图片增量写入与 core/archive 子表 upsert 职责，保留原对外入口兼容。
- `tools/telegram-sync-lib.mjs` 拆出日期归档与 Markdown section 合并渲染职责，`analyzeTelegramBatch()` 与 `applyTelegramSyncToMarkdown()` 等既有入口保持兼容。
- `tools/telegram-sync.mjs` 拆出图片识别/pending replay、fallback Markdown 队列、通知与结果报告职责，`runTelegramSync()` 与 CLI 行为保持兼容。
- `src/mcp/tools.mjs` 拆出 MCP tool catalog、训练记录、分析、运行时/config 与通用支撑模块，保留 `listMcpTools()`、`callMcpTool()` 与 `resolveMcpConfig()` 入口兼容。
- `src/db/training/read.mjs` 拆出 SQL 查询、client 并发读取与 row-to-snapshot 映射职责，保留 core/archive 读库入口兼容。
- `tools/training-analysis.mjs` 拆出分析意图/时间窗解析、训练摘要构造与 AI 请求/Telegram 分段回复职责，保留 `/分析` 生成链路和导出入口兼容。
- `test/telegram-sync-runner.test.mjs`、`test/telegram-sync.test.mjs` 与 `test/training-db-core.test.mjs` 抽出共享 fixture/helper，降低大测试文件中的重复样板，保留原测试语义和 targeted 覆盖。
- 新增 V9 真实 Telegram 场景验收 runbook，明确 dev Bot / dev workflow 上单张 sleep、1-4 张相册、partial failure replay 和数据库 fallback 的人工验收步骤与证据模板。
- 评估 Telegram `ingest` 审计增强后，继续沿用现有 JSON 审计与 pending/report 字段，本轮不新增强制 SQL。
- Telegram Sync workflow 新增 GitHub Actions summary，并将成功通知 step 改为中性的 result 命名；shared `site-build` 支持跳过重复 `npm ci`，dev Pages 部署固定 Wrangler 版本并补齐 Pages 输出目录配置。
- `package.json` 版本号更新为 `1.2.3`。

### Fixed

- 补齐 `exportTrainingMarkdown()` 的睡眠段落与饮食 `##### 餐次明细` 导出，并让 `parseTrainingRecord()` 能读回 sleep health metrics、睡眠阶段明细和 nutrition details，避免全量导出造成可见字段丢失。

## [1.2.2] - 2026-06-05

### Added

- 新增睡眠截图支持：Telegram 图片识别、训练解析和数据库归档现在可记录睡眠时长、入睡/起床时间、睡眠阶段摘要以及睡眠健康指标，并写入 `archive.training_sleep`。
- 新增睡眠健康指标增量 SQL `sql/training_records/sleep_health_metrics.sql`，并同步补齐 `core.sleep` 与 `archive.training_sleep` 的主 schema 字段。
- 新增睡眠维护文档 `docs/训练系统/Telegram睡眠识别与入库说明.md`，补充识别字段、归档日期口径、数据库落表和排障步骤，便于后期维护与查找问题。
- 新增睡眠 Prompt 维护说明 `docs/训练系统/Telegram图片识别Prompt维护.md`，同步记录睡眠截图字段提取范围与日期归档规则，便于后续维护。
- 系统文档同步补齐 Telegram 锻炼、体脂秤、饮食、睡眠图片解析的使用说明、数据流、接口契约、部署验收和排障路径。

### Changed

- 睡眠图片归档口径改为以醒来时间的前一天为准，避免跨午夜睡眠被记到错误日期。
- 训练快照与 Telegram 同步链路开始汇总睡眠数据，便于首页与分析模块读取恢复相关指标。
- Telegram Sync 的 main/dev workflow 现在会识别 DB-only 的 `ready + stored` 训练批次，并在仓库文件无变化时继续构建和发布站点。
- `训练数据解析.md` 调试输出新增睡眠段落，展示总睡眠、睡眠评分、平均心率、HRV、血氧和呼吸率等排查字段。
- 页面生成在数据库快照不完整或不可用时会自动回退到 Markdown，避免站点停留在“等待数据库重放”的空状态。
- `package.json` 版本号更新为 `1.2.2`。

### Fixed

- 修复 Telegram 训练图片识别对上游返回内容的 JSON 容错不足问题：现在会自动提取代码块、`data:` 前缀和夹杂杂质文本中的有效 JSON，减少 `telegram_training_image returned invalid JSON` 导致的识别失败与重试队列堆积。
- 修复 Telegram 睡眠同步在归档后未自动补写 `core.sleep` 的问题：同步结束后会补跑睡眠回填，避免出现 `archive.training_sleep` 有数据但 `core.sleep` 为空的情况。
- 修复 Markdown/archive 快照归档旧路径没有写入睡眠健康指标的问题，避免构建归档时丢失睡眠评分、心率、HRV、血氧和建议文本。
- 修复 Telegram 训练同步在第二次更新后只能写入 Markdown、却没有同步触发站点重建与部署的问题；现在数据库回填失败或超时时会降级为 Markdown 重建，并继续发布最新静态站点，避免页面停留在旧数据。
- 修正 AI schema 校验回归测试的字段定义与用例，避免把可选的 `records.sleep` 误判为必填字段，确保 schema 验证与实际识别契约保持一致。
- 修复睡眠图片在归档时因纯时间床头信息被误前移到前一天的问题，并补齐 `core.sleep` 的归档回填范围，避免睡眠数据“已归档但页面不显示”。
- 修复 archive-only 睡眠记录回填 `core.sleep` 时缺少 `nutrition` 字段导致 `sleep backfill failed` 的问题，确保只发送睡眠截图也能补写 core 表并触发页面构建。
- 修复首页睡眠卡片会把只有深睡/浅睡/评分、但没有总睡眠或夜间睡眠时长的半截记录当成最新睡眠日的问题，避免完整睡眠数据被覆盖成 `—`。

## [1.2.1] - 2026-06-03

### Added

- 新增 `tools/training-maintenance.mjs` 统一维护入口，提供 `maintenance:inspect`、`maintenance:sync`、`maintenance:migrate` 三类命令，并保留旧 `backfill/reconcile/import/export/sync:db` npm scripts 的兼容转发。
- `site-build` 公共 action 新增 `sync_db_mode` 输入（`auto`/`always`/`never`）与数据库同步输入变更检测，无数据相关文件变更时可跳过 `sync:db`。
- `ci-tests.yml` 新增 `full-test` job，仅在 `schedule` 或 `workflow_dispatch` 时运行完整 `npm test`，常规 CI 与部署继续使用 `test:fast`。
- Telegram 同步报告新增 `taskStatus`、`taskId`、`sourceType`、`sourceId`、`retryCount`、`messageIds`、`updateIds`、`failureDisposition` 等任务审计字段，统一 queued / processing / ready / stored / skipped / deferred / partialFailure / resolved / failed 九种状态语义。
- 新增 `maintenance_scripts.md` 与 v8 checklist，记录维护脚本边界、安全规则与第八轮优化验收状态。
- 新增维护脚本与 Telegram 报告审计字段回归测试。

### Changed

- `syncTrainingCore` 复用同一数据库 client 处理 archive 与 markdown 阶段，减少远程 PostgreSQL 连接与事务开销。
- Telegram 首次图片处理与 pending recognition replay 共用 `buildImageProcessingBatch()` 与规范化 runtime env。
- main/dev Pages 部署 workflow 统一通过 `site-build` 的 `sync_db_mode: auto` 按需执行数据库同步。
- 同步项目包版本号到 `1.2.1`。

## [1.2.0] - 2026-06-02

### Added

- 新增统一数据库同步命令 `npm run sync:db`，顺序执行 archive 回填、训练 Markdown 对账和随想回填，并输出 `archive`、`markdown`、`thoughts` 三段 JSON 结果。
- 新增 `tools/sync-training-core.mjs`，在数据库不可用或单段失败时返回 `deferred`/`partial`，保持 Pages 构建部署的降级行为。
- 新增训练核心数据库写入回归测试，覆盖单 client archive/core 读取、多日批量替换、Markdown 等价快跳过和统一同步脚本聚合结果。
- Telegram 图片同步报告新增 `sourceImageCount`、`recognizedImageCount`、`failedImageCount` 字段，支持 1-4 张可变批次的可观测性。
- Telegram 图片同步报告新增 `dateSources` 数组，每条含 `messageId`/`detectedDate`/`dateEvidence`/`source`，支持按图片定位日期来源。
- Telegram 同步回执新增 `已识别 N/M` 格式的图片计数，partial failure 路径附带"失败图片已加入重试队列"提示。
- 图片识别 Prompt 新增"批次规则"和"常见截图类型职责分工"章节，明确每次只识别一张图、1-4 张可变批次、总消耗图/训练图/饮食图/体脂秤图的职责分离。
- 图片识别 Prompt `dateEvidence` 规则强化：区分 `visible filename in image`（允许）和 `filename`（禁止）。
- 新增 14 项回归测试覆盖：图片计数、日期来源、截图类型职责、photo/document 单图处理、斤-kg 单位转换、partial failure pending 队列等场景。

### Changed

- Deploy Pages 与 Telegram Sync 的数据库维护步骤改为统一调用 `npm run sync:db`，避免三段脚本重复建连和重复扫描。
- 训练核心写入改为批量“按日期删除子表 -> upsert 父表 -> 批量插入子表”，保留整日替换语义并减少远程 PostgreSQL 往返。
- archive 回填新增反连接快跳过；Markdown 回写新增规范化签名比较，core 与 Markdown 等价时直接返回 `unchanged`。
- Hexo GitHub Actions cache 改为缓存实际 `db.json`，cache key 覆盖 `package-lock.json`、`_config.yml`、`source/**` 和 `themes/**`。
- `test:fast` skip pattern 增加 `thought module pages`，将完整 Hexo generate 慢测试移出快速 CI 路径。
- 同步项目包版本号到 `1.2.0`。
- `analyzeTelegramBatch()` 新增 `sourceImageCount`、`recognizedImageCount`、`failedImageCount`、`dateSources` 返回字段。
- `shouldQueueRecognitionFailure()` 支持 ready 状态 + partialFailure 的批次进入 pending recognition 队列。
- `hasPartialRecognitionFailure()` 增加 `failedImageCount > 0` 和 `recognizedImageCount < sourceImageCount` 的计数检测。
- `buildTelegramSyncReport()` 输出新增的计数和日期来源字段。
- `formatTelegramSyncNotification()` 增加 `formatImageCountText()` 输出已识别/失败计数。
- Prompt 结构化源版本更新为 `2026-06-01`，`prompt-generator.mjs` 新增 batchRules/screenshotTypeRules 章节渲染。
- 同步更新 `src/db/training/pending-recognition.mjs` 中的 `shouldQueueRecognitionFailure` 以保持一致。

### Fixed

- 修复 Hexo cache 在 GitHub Actions 中因缓存路径不存在而无法保存的问题，改为缓存 Hexo 实际生成的 `db.json`。
- 统一数据库同步脚本在共享 DB client 关闭失败时也会记录错误并降级返回，避免部署脚本被连接清理阶段中断。
- Telegram AI 图片识别失败写入 pending 后，下次 sync 会立即重放一次，并在仍失败时继续更新待重试队列，避免刚入队的图片因为默认重试窗口而看起来“成功但没更新”。
- Telegram Sync 的 Actions 日志现在输出 `recognitionPendingStatus`、`recognitionPendingError` 与 `pendingReplay`，可以直接看出图片是否已进入重试队列、是否来自 pending 重放、以及排队是否失败。
- 修复 Telegram 饮食图片在 AI 识别返回无效 JSON 后被一次性丢弃的问题：识别失败的图片批次现在会写入数据库待重试队列，后续同步会先重放 pending 批次，成功后再入库并标记 resolved，避免首页饮食热量长期显示为空。
- Telegram 图片识别在 message content 不是合法 JSON 时会追加一次严格 JSON 修复重试，仍失败才进入待重试队列，减少上游偶发非 JSON 响应导致的整批跳过。
- Telegram 同步回执新增“AI 识别失败，已加入重试队列”状态，区分已排队可重试和真正无法入库的失败。
- 修复 Telegram 训练相册中饮食图 AI 返回无效 JSON 时“部分成功被误报为全部成功”的问题：schema/JSON 解析失败会改用同一图片的 inline base64 再试一次，5 月 31 日饮食截图可正确入库午餐 754 千卡、晚餐 114 千卡、总热量 868 千卡。
- Telegram 训练相册仍允许已识别的运动数据先入库，但只要同批存在识别失败或缺失图片，报告与 Telegram 回执都会标记 `partialFailure` 并显示“部分解析失败”、失败消息号和安全截断原因，不再回“解析成功”。
- AI 识别无效 JSON 错误现在附带安全排查摘要（内容类型、解析阶段、前 200 字符截断），避免日志只有笼统失败原因。
- 修复 Telegram 训练图片识别对饮食截图总热量与餐次汇总的兼容解析，避免因为标题措辞、冒号格式或 `kcal` / `千卡` 表达差异导致 `totalCalories` 为空。
- 修复 Telegram 训练图片识别对 AI 流式前缀、代码块包裹和非纯 JSON 输出的容错解析，避免 `data:` 前缀或残留标记导致整批截图识别失败。
- 修复 Telegram 训练图片识别的结果规范化，确保 `measurement`、`activities`、`meals`、`totalCalories`、`details` 与 `dailyWorkoutSummary` 等字段始终补齐，减少 schema 校验失败。
- 修复体脂秤截图被识别为 `measurement` 但缺少体脂数据时仍以高置信通过的问题，现在会降置信并记录 warning，避免空体脂结果静默入库。
- 修复 Telegram 训练截图同日重复写入时的覆盖策略，改为按模块保留历史内容、按条目去重覆盖，避免补发截图时误删旧的有效运动或饮食记录。
- 修复 Telegram 训练图片识别对体脂秤截图中“斤”单位的换算与归一逻辑，避免 `weightKg`、`skeletalMuscleKg`、`boneMassKg`、`fatFreeMassKg` 被误写为原始斤数。
- 补充相关识别提示词与回归测试，确保体重类字段统一按 kg 口径入库，并保留必要的小数精度。

## [1.1.9] - 2026-05-28

### Changed

- 完成 V5 重构收尾验收：补齐 `src/` 分层边界、Dashboard view model、DB facade、jobs、shared 工具和对应回归测试。
- GitHub Pages 部署流程恢复部署前测试，并补充 `src/**`、`prompts/**` 等重构相关路径触发。
- 同步项目包版本号到 `1.1.9`。

### Fixed

- Telegram 同步的成功回执现在改为在 GitHub Action 最后阶段统一发送，不再在 `sync:telegram` 步骤完成时提前回发。
- 修复训练数据回写在合并既有训练日时误触发 `core.thought` 读取而报 `Unexpected SQL` 的问题，避免 2026-05-26 这类训练截图数据卡在回退链路里。
- 修复 Dashboard 构建时模板调用 JSON 中不可序列化函数导致 `public/index.html` 为空的问题。
- 修复 `src/db/training/*` facade 的相对路径错误，避免新分层入口导入失败。
- Hexo 构建后新增首页非空校验，避免静态站点构建日志失败但流程仍误判成功。

## [1.1.8] - 2026-05-27

### Added

- Telegram 随想新增、编辑、删除和移动成功后会回发同步反馈，让随想写入和训练图片解析入库保持一致的成功确认体验。
- 新增 GitHub Action 失败监控脚本：`repository_dispatch` 触发的 Telegram 同步失败时，会回 Telegram 显示失败阶段、失败分类和 GitHub run 排查入口。

### Changed

- `buildTelegramSyncReport()` 增加 `failureCategory`、`failureReason`、`recognitionErrors` 可观测字段，便于区分用户输入、AI 服务、Telegram API、数据库、GitHub Action 和系统代码异常。
- `pending_replay` 通知明确说明“Markdown 已写入，数据库待补偿”，不再伪装成数据库写入成功。
- 同步项目包版本号到 `1.1.8`。

### Fixed

- Worker 在缺少 GitHub Token、GitHub dispatch 失败或相册缓冲 dispatch 失败时，会尽量直接回 Telegram 说明“GitHub Action 未能启动”，避免误判为业务代码写入失败。
- 图片识别、`/分析` 和 `/ai` 失败通知保留 AI、网络、schema/JSON 等具体失败原因，不再只返回笼统的 `missing recognition`。
- Telegram 帮助命令现在同时支持 `/帮助` 和裸 `help`；即使帮助消息已经进入 `Telegram Sync`，也会直接回发命令清单，不写数据库、Markdown 或图片识别结果。

## [1.1.7] - 2026-05-26

### Added

- 新增 Telegram `/ai` / `/智能助手` Agent 入口：会按问题调用 MCP 工具查询历史记录、同步状态、配置、身体反馈或训练分析，并直接回发 Telegram。
- Cloudflare webhook 现在会直接响应 `/help`、`帮助`、`命令` 等帮助消息，返回当前可用命令清单，不再为帮助请求触发 GitHub Actions。
- Telegram 帮助清单覆盖截图识别、随想创建、编辑、删除、移动、`/分析` 和 `/ai` 等日常入口。

### Changed

- 同步项目包版本号到 `1.1.7`。

## [1.1.6] - 2026-05-26

### Added

- 新增 Telegram webhook 自动刷新脚本与 GitHub Actions 工作流：Worker 部署后会自动调用 `setWebhook`，并支持手动或每 6 小时定时刷新，减少更换 Bot Token 后漏设 webhook 的风险。
- `/分析` 现在会读取身体反馈记录，并在训练、饮食、恢复和疼痛/不适建议中结合反馈发生日期、时间点与近期训练负荷。
- 新增 MCP v1 stdio Server：通过 `npm run mcp:server` 暴露训练快照、每日记录、体脂、活动、饮食、身体反馈、图表、分析摘要、配置和运行状态等只读 Tool。
- 新增 `training.generate_analysis` MCP Tool，复用现有训练分析链路并返回结构化 `reply`、`summary` 和 `focus`，不会写 Telegram、Markdown 或数据库。
- 新增 MCP 架构方案与使用文档，说明 Tool 边界、配置方式、返回结构和当前不开放的高副作用能力。

### Fixed

- 修复身体反馈 Markdown 日期在 UTC CI 环境中被二次时区转换，导致 `/分析` 快照日期偏移一天的问题。

### Changed

- 同步项目包版本号到 `1.1.6`。

## [1.1.5] - 2026-05-25

### Added

- 新增“身体反馈”随想模块：支持站点 `/body-feedback/` 页面，并通过 Telegram `/随想 身体反馈 内容`、`/thought 身体反馈 内容` 归档锻炼过程中的不适、疼痛、疲劳和恢复异常。
- 支持按既有 ID 方式编辑、删除和移动身体反馈随想，`/移动 <id> 身体反馈` 与 `/随想 <id> 身体反馈` 会同步更新模块和标签。

### Fixed

- 修复 Telegram 训练图片识别在上游返回 `records.details: null` 时整张运动明细图被 schema 校验丢弃的问题，避免 HIIT 等活动明细缺失导致活动次数为 0。
- 修复 Telegram 饮食截图仅识别到餐次热量、未识别到 `totalCalories` 时页面饮食热量显示为空的问题：同步后处理会用餐次热量合计作为兜底总热量。
- 修复 Telegram 训练图片识别在上游返回 `records.details` 为对象或字符串时被本地 schema 校验整体拒绝的问题：识别服务会先归一为字符串数组，再执行严格校验，避免 `missing recognition` 导致图片批次无法入库。
- 修复 Telegram 训练图片识别在 OpenAI 兼容接口不支持 `json_schema` structured output 时被 400 拒绝的问题：保留严格 schema 优先策略，并在兼容性错误时自动降级到 `json_object` 重试，避免 `missing recognition` 导致图片批次无法入库。
- 补充 Telegram 图片识别 `json_object` 降级请求中的小写 `json` 明确提示，兼容要求消息正文必须包含 `json` 关键字的上游接口。

### Changed

- 同步项目包版本号到 `1.1.5`。

## [1.1.4] - 2026-05-25

### Fixed

- 修复 Telegram 训练图片识别在上游 AI 拒绝 Telegram 文件直链时的回退路径：会下载图片并以内联图片数据重试，不影响 `/analysis` 与 `/thought` 的独立分支处理。
- 补充 Telegram 图片识别失败时的上游错误摘要，便于直接从日志定位 400 类识别失败原因。

### Changed

- 同步项目包版本号到 `1.1.4`。

## [1.1.3] - 2026-05-24

### Changed

- 完成中优先级的 M1/M2/M4/M6：统一 AI provider 调用入口，补齐 prompt/schema 版本化，加入默认关闭的图片识别缓存设计，并为数据库读取增加可选时间窗口。
- 生成的识别与分析 prompt 现在会写入版本 metadata，运行时会自动剥离，避免污染模型输入。
- Telegram 识别结果缓存 key 已与 prompt/schema/model 绑定，保证版本变化自动 miss。
- `readTrainingSnapshotFromDatabase` 现在支持 `dateFrom` / `dateTo`，默认行为保持全量兼容。
- 同步项目包版本号到 `1.1.3`。

## [1.1.2] - 2026-05-24

### Changed

- 补充高风险 targeted tests，先锁定 Telegram 命令路由、训练分析意图、数据库事务回滚和 dashboard view model 契约。
- 同步项目包版本号到 `1.1.2`。

## [1.1.1] - 2026-05-24

### Changed

- 优化训练看板指标卡片的数据变化提示样式，使用更明显的底色、边框与状态色提升变化感知。
- 提升首页顶部导航的字号、字重和颜色对比度，增强中文菜单可读性。
- 同步项目包版本号到 `1.1.1`。

## [1.1.0] - 2026-05-24

### Added

- 建立 Keep a Changelog 1.1.0 风格的版本更新日志规范。
- 在页脚展示由 `CHANGELOG.md` 最新发布条目控制的网站版本号，便于后续维护与审计。

## [1.0.0] - 2026-05-24

### Added

- 初始版本：发布训练记录看板、锻炼随想、杂七杂八与关于页面。
- 支持从训练数据生成静态看板和日常记录概览。

[Unreleased]: https://github.com/soulgo/training_records/compare/v1.3.1...HEAD
[1.3.1]: https://github.com/soulgo/training_records/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/soulgo/training_records/compare/v1.2.9...v1.3.0
[1.2.9]: https://github.com/soulgo/training_records/compare/v1.2.8...v1.2.9
[1.2.8]: https://github.com/soulgo/training_records/compare/v1.2.7...v1.2.8
[1.2.7]: https://github.com/soulgo/training_records/compare/v1.2.6...v1.2.7
[1.2.6]: https://github.com/soulgo/training_records/compare/v1.2.5...v1.2.6
[1.2.5]: https://github.com/soulgo/training_records/compare/v1.2.4...v1.2.5
[1.2.4]: https://github.com/soulgo/training_records/compare/v1.2.3...v1.2.4
[1.2.3]: https://github.com/soulgo/training_records/compare/v1.2.2...v1.2.3
[1.2.2]: https://github.com/soulgo/training_records/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/soulgo/training_records/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/soulgo/training_records/compare/v1.1.9...v1.2.0
[1.1.9]: https://github.com/soulgo/training_records/compare/v1.1.8...v1.1.9
[1.1.8]: https://github.com/soulgo/training_records/compare/v1.1.7...v1.1.8
[1.1.7]: https://github.com/soulgo/training_records/compare/v1.1.6...v1.1.7
[1.1.6]: https://github.com/soulgo/training_records/compare/v1.1.5...v1.1.6
[1.1.5]: https://github.com/soulgo/training_records/compare/v1.1.4...v1.1.5
[1.1.4]: https://github.com/soulgo/training_records/compare/v1.1.3...v1.1.4
[1.1.3]: https://github.com/soulgo/training_records/compare/v1.1.2...v1.1.3
[1.1.2]: https://github.com/soulgo/training_records/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/soulgo/training_records/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/soulgo/training_records/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/soulgo/training_records/releases/tag/v1.0.0
