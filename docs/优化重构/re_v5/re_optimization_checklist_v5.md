# 系统优化重构验收清单（V5）

> 最后更新：2026-05-28
>
> 本清单用于对照 `docs/优化重构/re_optimization_v5.md` 做最终验收。状态以当前代码和本次修复后的验证结果为准，不再把“已有基础 / 部分完成”误写成“完全完成”。

---

## 1. 本次最终修复验收

- [x] Dashboard 构建不再依赖 JSON 中不可序列化的函数
- [x] `src/site/dashboard-view.mjs` 已生成 `comparisonHtml` 展示字段
- [x] `themes/cactus/layout/dashboard.ejs` 只消费 view model 的 `comparisonHtml`
- [x] `src/db/training/{config,read,write,archive}.mjs` 的 re-export 路径均可正常解析
- [x] `tools/run-hexo-command.mjs` 已导出 `validateGeneratedSiteOutput`
- [x] `npm run build:site` 在 `generate` 后会校验 `public/index.html` 非空
- [x] `.github/actions/site-build/action.yml` 已增加 Pages 产物非空校验
- [x] `.github/workflows/deploy-pages.yml` 已覆盖 `src/**`、`prompts/**` 变更
- [x] `.github/workflows/deploy-pages.yml` 部署前已恢复执行测试
- [x] `.github/workflows/ci-tests.yml` 已覆盖 `src/**`、`cloudflare/**`、`docs/**`、`prompts/**`、`sql/**`

---

## 2. 已执行验证

- [x] `node --test test/dashboard-view.test.mjs test/github-workflows.test.mjs test/src-boundary.test.mjs test/run-hexo-command.test.mjs`
- [x] `npm run test:fast`
- [x] `npm test`
- [x] `npm run build`
- [x] 构建后 `public/index.html` 已确认非空

---

## 3. P0：结构与边界

### P0-1 建立 `src/` 分层骨架

- [x] `src/ai`、`src/mcp`、`src/telegram`、`src/domain`、`src/db`、`src/site`、`src/jobs`、`src/shared` 均已存在
- [x] `test/src-boundary.test.mjs` 已覆盖主要 `src/**` 边界入口
- [x] 旧 CLI / npm scripts 仍保持兼容

当前状态：已完成。

### P0-2 迁移训练领域逻辑

- [x] `src/domain/training/` 已承接训练领域纯逻辑
- [x] `tools/training-domain.mjs`、`tools/training-parser.mjs`、`tools/training-snapshot.mjs` 作为兼容入口继续 re-export
- [x] parser / snapshot 相关测试通过

当前状态：已完成，兼容层保留。

### P0-3 收敛 DB 读写归档边界

- [x] `src/db/training/` 已建立 config / read / write / archive facade
- [x] 本次已修复 facade 到 `tools/training-db-*` 的相对路径错误
- [x] `src/db/index.mjs` 可统一导出训练 DB 能力
- [ ] SQL 实现仍主要位于 `tools/training-db-*.mjs`
- [ ] `tools/backfill-thoughts-to-core.mjs` 仍直接使用 `pg`

当前状态：可运行，边界可用；完整 repository 迁移仍未完成。

### P0-4 收敛 Telegram 同步流程边界

- [x] `src/telegram/` 已承接命令、同步批次等基础边界
- [x] `src/domain/telegram/` 已作为 Telegram 领域逻辑落点
- [x] Telegram 相关测试通过
- [ ] `tools/telegram-sync.mjs` 仍保留较多历史编排与兼容逻辑

当前状态：部分完成；功能可用，长期仍建议继续瘦身 CLI。

### P0-5 收敛 Dashboard view model

- [x] `src/site/dashboard-view.mjs` 已作为 Dashboard view model 主实现
- [x] `tools/dashboard-view.mjs` 作为兼容入口 re-export
- [x] comparison 渲染已前移为 JSON-safe 的 `comparisonHtml`
- [x] Dashboard 页面渲染与构建测试通过

当前状态：已完成。

### P0-6 补齐关键测试

- [x] Dashboard view model 回归测试已覆盖 comparison 展示契约
- [x] GitHub workflow 测试已覆盖构建、部署、触发路径和产物校验
- [x] Hexo 命令包装器测试已覆盖空首页失败与非空首页通过
- [x] `src/**` 边界入口测试已覆盖

当前状态：已完成本轮关键回归覆盖。

---

## 4. P1：性能与抽象

### P1-1 AI provider 契约加固

- [x] provider 抽象、错误分类与相关测试已存在并通过
- [x] 图片识别、训练分析使用统一 provider 路径

当前状态：已完成。

### P1-2 Prompt / schema 版本策略补齐

- [x] prompt 元数据与生成链路已存在
- [x] schema / prompt 版本参与识别缓存相关测试
- [ ] 版本升级、兼容、旧缓存清理策略仍需进一步文档化

当前状态：已有基础，待补强文档策略。

### P1-3 识别缓存加固

- [x] cache key 已包含 file id、prompt version、schema version、model
- [x] 缓存默认关闭
- [x] 命中、未命中、版本变化相关测试通过

当前状态：已完成基础加固。

### P1-4 DB 读取窗口使用策略

- [x] DB 读取接口支持 `dateFrom` / `dateTo`
- [x] 读取窗口相关测试通过
- [ ] dashboard / analysis 是否默认使用窗口仍需按数据口径继续业务确认

当前状态：能力已完成，默认使用策略仍需确认。

### P1-5 Dashboard 模板瘦身

- [x] comparison HTML 已从模板迁入 view model
- [x] 模板不再调用不可序列化函数
- [x] `npm run build` 已验证首页可正常生成

当前状态：已完成本轮阻塞问题修复；后续可继续减少模板展示分支。

### P1-6 DB Repository 化

- [x] `src/db/**` facade 已可作为统一入口
- [x] DB 写入、幂等、transaction 相关测试通过
- [ ] SQL 仍散落在 `tools/training-db-*.mjs` 与少量 job / AI 缓存相关模块
- [ ] 完整迁入 `src/db/**` 后才能关闭该项

当前状态：部分完成；不阻塞运行，但仍是长期维护风险。

---

## 5. P2：迁移准备

### P2-1 pending store 设计

- [x] file pending store 仍是默认实现
- [x] 可注入 database pending store
- [x] pending store 测试通过

当前状态：已完成基础能力。

### P2-2 database 事实源评估

- [x] 当前仍保持 Markdown fallback，不改变事实源语义
- [ ] 是否切换数据库为默认事实源仍属于后续架构决策
- [ ] 切换前仍需补齐对账、回滚和迁移演练文档

当前状态：未切换；仅完成保守评估与兼容维持。

### P2-3 jobs 分层预留

- [x] `src/jobs/telegram-sync-job.mjs` 已存在
- [x] `src/jobs/generate-training-data-job.mjs` 已存在
- [x] `src/jobs/training-analysis-job.mjs` 已存在
- [x] `src/jobs/index.mjs` 已统一导出 job 边界

当前状态：已完成基础预留。

### P2-4 服务化迁移接口预留

- [x] `src/jobs/service-adapter-contract.mjs` 已存在
- [x] 当前 GitHub Actions / Worker / CLI 协议未被破坏
- [ ] 迁移到常驻服务或队列仍需单独设计和演练

当前状态：已完成接口基础，未进入真实服务化迁移。

---

## 6. 功能回归清单

### 6.1 Telegram 同步

- [x] Telegram webhook / sync 相关测试通过
- [x] 命令帮助、相册聚合、未授权 chat、dispatch 失败通知测试通过
- [x] `/analysis` 相关训练分析测试通过

### 6.2 数据库行为

- [x] `ingest` / `core` / `archive` 写入相关测试通过
- [x] payload hash 幂等测试通过
- [x] transaction rollback 测试通过
- [x] DB 不可用时 fallback / defer 行为测试通过

### 6.3 站点构建

- [x] `source/_data/training.json` 可正常生成
- [x] `source/_data/dashboardView.json` 可正常生成
- [x] Hexo 构建成功
- [x] `public/index.html` 已确认非空

### 6.4 GitHub Pages / CI

- [x] shared site build action 已统一安装、测试、构建、部署步骤
- [x] 部署前执行测试
- [x] 部署前校验 `public/index.html`
- [x] site-relevant paths 已覆盖 `src/**` 与 prompt 变更

---

## 7. 当前剩余风险

- [ ] `tools/training-db-*.mjs` 仍承载 DB 实现，`src/db/**` 目前主要是 facade
- [ ] `tools/telegram-sync.mjs` 仍偏大，后续维护时仍可能继续膨胀
- [ ] database 事实源切换尚未执行，Markdown 与 DB 并存策略仍需长期对账
- [ ] deploy-pages 恢复全量测试后，部署耗时会增加，但稳定性更高

---

## 8. 最终结论

- [x] 当前代码可以正常运行
- [x] 当前测试套件全部通过
- [x] 当前构建链路可以生成非空 GitHub Pages 产物
- [x] 本次发现的上线阻塞项已修复
- [x] 可以进入下一轮迭代或上线前人工验收
- [ ] 不建议把 DB repository 全量迁移、Telegram CLI 瘦身、数据库事实源切换视为已彻底完成

结论：本轮修复已达到“可运行、可构建、可部署前校验”的验收标准；长期维护层面仍建议继续推进 DB 实现迁入 `src/db/**` 与 `tools/telegram-sync.mjs` 进一步瘦身。
