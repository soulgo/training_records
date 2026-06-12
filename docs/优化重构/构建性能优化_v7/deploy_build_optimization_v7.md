# Deploy Pages Workflow 构建性能优化方案（V7）

> 文档定位：本文档面向开发者和架构师，针对 `deploy-pages.yml` 工作流的 **GitHub Actions 运行时长过长** 问题进行根因分析，并给出可执行的优化方案。
>
> 适用范围：`.github/workflows/deploy-pages.yml`、`.github/actions/site-build/action.yml`、数据库回填脚本、Hexo 构建流程、相关测试文件。
>
> 重要约束：**不改功能、不改用户可见行为、不改变数据口径**。所有优化应满足可回滚、可验证、可逐步实施。

---

## 1. 现状基线

### 1.1 数据来源

本轮分析基于 `logs/build.txt`（2026-06-01 07:37 UTC 触发的一次完整 deploy-pages 运行日志），结合相关源码交叉验证。

### 1.2 总耗时

| 指标 | 数值 |
| --- | --- |
| 总运行时间 | **9 分 15 秒**（07:37:34 → 07:46:49） |
| Runner | ubuntu-24.04 (GitHub Actions) |
| 触发方式 | push to main |

### 1.3 各步骤耗时明细

| 步骤 | 起止时间 (UTC) | 耗时 | 占比 | 说明 |
| --- | --- | --- | --- | --- |
| Checkout + Setup Node.js + npm ci | 07:37:34 → 07:37:45 | ~11s | 2% | npm cache 命中，正常 |
| **backfill:core** | 07:37:45 → 07:40:38 | **2 分 53 秒** | **31%** | 回填 51 天归档数据到 PostgreSQL |
| **reconcile:markdown** | 07:40:38 → 07:43:37 | **2 分 59 秒** | **32%** | 解析 `训练记录.md` 并同步 51 天到数据库 |
| backfill:thoughts | 07:43:37 → 07:43:43 | ~6s | 1% | 仅 16 条记录，正常 |
| test:fast | 07:43:43 → 07:45:16 | 1 分 33 秒 | 17% | 273 tests pass，含一个 92 秒的 Hexo 测试 |
| build (build:data + build:site) | 07:45:17 → 07:46:40 | 1 分 24 秒 | 15% | Hexo init 占 ~80s，实际 generate 仅 68ms |
| Deploy (upload + deploy pages) | 07:46:40 → 07:46:49 | ~9s | 2% | 正常 |

---

## 2. 根因分析

### 2.1 数据库回填操作重复且串行（~6 分钟，占 65%）

**根因**：每次 push 到 main 都会触发以下三个步骤，它们各自连接数据库并执行写操作：

1. `backfill:core` — 读取 `core.archive_snapshot` → 对比 `core.training_day` → 逐天 INSERT 缺失的日期（51 天 × N 条 SQL）
2. `reconcile:markdown` — 解析 `训练记录.md` → 调用 `persistTrainingSnapshotToCore` 写入数据库，合并已有数据
3. `backfill:thoughts` — 扫描 `source/_posts` → 导入 thought markdown 到 `core.thought`

参考 [`src/db/training/write.mjs:158-240`](../../src/db/training/write.mjs:158)：

```js
// backfillCoreFromLatestArchiveSnapshot 的关键路径：
// 1. 读取 archive snapshot（一次数据库查询）
// 2. 读取 core.training_day 全部已有日期（一次全表扫描）
// 3. for (const day of missingDays) { await replaceCoreDay(...) }  ← 逐天串行写入
```

问题：
- 三个步骤各自 `new Client()` → `connect()` → `end()`，每次建连都有 TCP 握手开销
- `reconcile:markdown` 与 `backfill:core` 操作的是同一批数据（51 天），但分两次独立事务
- 绝大多数情况下没有新数据，但仍需走完整读-比对-判断路径
- 数据库 URL 指向远程 PostgreSQL，网络延迟叠加串行写入放大了耗时

**量化**：

| 步骤 | 写入天数 | 平均单天耗时 | 说明 |
| --- | --- | --- | --- |
| backfill:core | 51 | ~3.4s | 包含读 archive + 读 core + 逐天 INSERT |
| reconcile:markdown | 51 | ~3.5s | 包含解析 markdown + persistSnapshot + merge |

### 2.2 Hexo 初始化在 CI 中被重复执行两次（~80s × 2 ≈ 2 分 40 秒）

**根因**：Hexo 的 `init()` 阶段需要加载全部源文件、主题、插件、标签等，是 CPU 密集型操作。

在本次运行中 Hexo init 被执行了至少两次：

1. **test:fast 步骤中的测试**：`test/thoughts-page.test.mjs` 和 `test/run-hexo-command.test.mjs` 中有多个测试通过 `execFileSync` 启动子进程运行 `run-hexo-command.mjs generate`，每次都会执行 `new Hexo() → hexo.init()`。
2. **build:site 步骤**：`npm run build:site` 同样调用 `run-hexo-command.mjs generate`，再次执行 `hexo.init()`。

从日志看：
- `build:data` 在 07:45:17 开始，07:45:20 输出最后一行
- `build:site` 在 07:46:40 才出现 Hexo 输出 `Validating config`
- 中间 ~80 秒为 `hexo.init()` 静默执行时间
- 实际 `hexo.call('generate')` 仅耗时 **68ms**（6 files generated in 68ms），因为 Hexo 缓存生效

**关键发现**：CI 中 Hexo 缓存（`.hexo_cache`）未能在多次 Hexo 进程中复用。查看 `_config.yml:70-71`：

```yaml
cache:
  enable: true
```

缓存虽然在 CI build 步骤中生效（generate 仅 68ms），但 **hexo init 本身不受缓存加速** — 它仍然需要加载所有 source 文件、初始化内部 database、解析 front matter 等。

### 2.3 测试 #215 单测耗时 92 秒

**根因**：`test/thoughts-page.test.mjs:86` 的测试 `"thought module pages split thought posts by thought_module"` 中修改了 3 个 markdown 文件后通过 `execFileSync` 启动完整 Hexo generate 子进程，耗时 92061ms（见 log line 1569）。

```js
// test/thoughts-page.test.mjs:86-178
test('thought module pages split thought posts by thought_module', () => {
  withSharedSiteFixture(() => {
    // 修改 3 个 markdown 文件 ...
    writeFileSync(workoutPostPath, ...);
    writeFileSync(miscPostPath, ...);
    writeFileSync(bodyFeedbackPostPath, ...);

    // 每次都 fork 一个全新 Node 进程，重新 init Hexo
    execFileSync(process.execPath, ['tools/run-hexo-command.mjs', 'generate'], ...);
    // ↑ 这一行耗时 ~92s
  });
});
```

对比其他 Hexo 测试：在 `test:fast` 中跳过了页面渲染类测试（`--test-skip-pattern "dashboard renders|dashboard defaults|..."`），但这个测试没有匹配到 skip pattern，所以被执行了。

### 2.4 Hexo 缓存未在 GitHub Actions Cache 中持久化

在 [`site-build/action.yml:27-32`](../../.github/actions/site-build/action.yml:27) 中定义了 Hexo 缓存步骤：

```yaml
- name: Cache Hexo
  uses: actions/cache@v4
  with:
    path: .hexo_cache
    key: hexo-${{ runner.os }}-${{ hashFiles('训练记录.md', 'source/_posts/**', 'themes/**') }}
```

但日志 line 179 显示：
```
Cache not found for input keys: hexo-Linux-af9f06884eef2edc635074feb6f26b6e9ebb246aa7199bcc82f74851134e406b
```

且日志末尾 line 2170 有警告：
```
Path Validation Error: Path(s) specified in the action for caching do(es) not exist, hence no cache is being saved.
```

`.hexo_cache` 目录在 hexo init 后可能不存在（或路径不对），导致每次都无法读写缓存。

---

## 3. 优化方案

### P0（高收益、低风险，已实施）

#### P0-1：合并数据库回填步骤，减少建连和全量扫描

**目标**：将 `backfill:core` + `reconcile:markdown` 两次数据库操作合并为一次。

**实施结果**：

1. 新增 `tools/sync-training-core.mjs`，统一执行：
   - archive 回填：通过数据库反连接判断是否存在 archive 有、core 无的日期。
   - Markdown 对账：解析 `训练记录.md` 后读取目标日期 core 快照，规范化签名一致时直接返回 `unchanged`。
   - thought 回填：保持独立事务和现有 `core.thought` 写入语义。
2. archive 回填与 Markdown 对账在 CI 默认路径复用**同一个数据库连接**；thought 回填独立执行，避免和训练日整日替换事务耦合。
3. 数据库不可用或单段失败时返回 `deferred`/`partial`，不阻断 Pages 构建部署。
4. 将 `site-build/action.yml` 中三个 backfill 步骤替换为一步：

```yaml
- name: Sync archive and markdown to database
  if: ${{ inputs.run_backfill == 'true' }}
  shell: bash
  run: npm run sync:db
```

**预期收益**：减少 ~2-3 分钟（消除重复建连、重复全表扫描、重复事务开销）。

**风险**：低。合并的是两个独立操作的串联逻辑，不改变数据写入语义。

---

#### P0-2：测试中跳过需要完整 Hexo generate 的测试，或改用 mock

**目标**：消除 92 秒的单测耗时。

**方案 A（推荐）**：将 `"thought module pages split thought posts by thought_module"` 加入 `test:fast` 的 skip pattern。

修改 `package.json` 中 `test:fast` 脚本：

```json
"test:fast": "node --test --test-skip-pattern \"dashboard renders|dashboard defaults|dashboard chart script|dashboard embeds|dashboard explains|dashboard fallback view|homepage|thoughts page|thought detail page|thought module pages\""
```

**方案 B**：将该测试中的 Hexo generate 替换为直接调用 Hexo 的 generator/helper 的单元测试，避免完整 init。

**预期收益**：测试阶段从 ~93s 降到 ~30s，减少 ~1 分钟。

**风险**：方案 A 零风险，只是跳过 CI 中的慢测试（本地仍可单独跑）。方案 B 需要一定重构工作。

---

### P1（中等收益，已实施）

#### P1-1：修复 Hexo 缓存持久化

**目标**：让 Hexo database cache 在 GitHub Actions Cache 中生效，加速 hexo init。

**实施结果**：

Hexo 实际缓存文件是根目录 `db.json`，不是 `.hexo_cache`。`site-build/action.yml` 已改为缓存 `db.json`，并让 cache key 覆盖会影响 Hexo database 的输入：

```yaml
- name: Cache Hexo
  uses: actions/cache@v4
  with:
    path: |
      db.json
    key: hexo-${{ runner.os }}-${{ hashFiles('package-lock.json', '_config.yml', 'source/**', 'themes/**') }}
```

**预期收益**：Hexo init 时间可能从 ~80s 降到 ~20-30s（首次缓存填充后）。

**风险**：低。Hexo 缓存 key 基于源文件 hash，内容变化时会自动失效。

---

#### P1-2：backfill 步骤增加"快速跳过"路径

**目标**：当没有新数据时，快速跳过数据库写入。

**方案**：在 `backfillCoreFromLatestArchiveSnapshot` 和 `importTrainingMarkdownToDatabase` 前增加轻量级检查（例如对比 archive snapshot 的最新日期与 core 的最新日期），如果一致则直接返回 `skipped`，无需完整读取和比对。

**实施结果**：

- archive 回填使用 `archive.training_day` 到 `core.training_day` 的反连接判断缺失日期，无缺失时返回 `unchanged`。
- Markdown 对账解析目标日期集合后读取 core 快照并比较规范化签名，完全一致时返回 `unchanged` 且不写入。

**预期收益**：大多数 push（没有新训练数据时）可节省 ~5-6 分钟。

**风险**：低。快速跳过逻辑本质上是提前执行现有的"对比后判断 unchanged"逻辑。

---

#### P1-3：数据库写入支持批量 upsert

**目标**：减少逐天串行写入的数据库往返次数。

**方案**：将 `backfillCoreFromLatestArchiveSnapshot` 中的 `for (const day of missingDays) { await replaceCoreDay(...) }` 替换为批量 upsert（单条 SQL 的多行 INSERT ... ON CONFLICT）。

**实施结果**：

训练日写入改为批量“按日期删除子表 -> upsert 父表 -> 批量插入子表”，保留当前整日替换语义，并保持 `source_channel`、`source_batch_id` 写入口径。

**预期收益**：当缺失天数较多时，可减少 ~30-60 秒。

**风险**：中。需要仔细处理 merge 逻辑（当前 `replaceCoreDay` 做了较复杂的合并操作，批量版本需要等价实现）。

---

### P2（长期优化，视需要排期）

#### P2-1：升级 GitHub Actions 到 Node.js 24

**现状**：日志 line 2188 显示所有 action 都运行在 Node.js 20 上，已有弃用警告：

```
Node.js 20 actions are deprecated. Actions will be forced to run with Node.js 24
by default starting June 16th, 2026. Node.js 20 will be removed from the runner
on September 16th, 2026.
```

**方案**：检查各 action 是否有支持 Node.js 24 的新版本，逐步升级。

**预期收益**：避免 2026-09-16 后 workflow 失效，对性能可能有小幅提升。

---

#### P2-2：考虑将 Hexo 测试从 CI 中独立为 nightly job

**方案**：创建独立的 `test-site-render.yml` workflow，仅在 schedule 或手动触发时运行包含 Hexo generate 的完整测试。日常 push 的 CI 只跑快速测试。

---

## 4. 收益预估

| 优化项 | 优先级 | 预计节省 | 实施难度 |
| --- | --- | --- | --- |
| P0-1 合并数据库回填 | P0 | 2-3 分钟 | 中 |
| P0-2 跳过慢测试 | P0 | 1 分钟 | 低 |
| P1-1 修复 Hexo 缓存 | P1 | 0.5-1 分钟 | 低 |
| P1-2 快速跳过路径 | P1 | 0-5 分钟（视数据有无） | 低 |
| P1-3 批量 upsert | P1 | 0.5-1 分钟 | 中 |
| **合计（P0+P1）** | — | **4-6 分钟** | — |

全部 P0+P1 落地后，deploy-pages workflow 预计从 **~9 分 15 秒降到 ~3-5 分钟**。

---

## 5. 实施 Checklist

- [x] **P0-1**：创建 `tools/sync-training-core.mjs` 统一同步脚本
- [x] **P0-1**：更新 `site-build/action.yml`，替换三个 backfill 步骤为一步
- [x] **P0-1**：更新 `telegram-sync.yml`，非 `repository_dispatch` 维护步骤也改为 `npm run sync:db`
- [x] **P0-1**：更新 `package.json` 添加 `sync:db` 脚本
- [x] **P0-2**：在 `package.json` 的 `test:fast` skip pattern 中增加 `thought module pages`
- [x] **P0-2**：运行 `npm run test:fast` 确认跳过且其他测试正常
- [x] **P1-1**：确认 Hexo 实际缓存文件为 `db.json`
- [x] **P1-1**：在 `site-build/action.yml` 中缓存 `db.json`，cache key 覆盖 Hexo database 输入
- [x] **P1-2**：实现 archive 和 Markdown 快速跳过检查逻辑
- [x] **P1-2**：添加相关测试
- [x] **P1-3**：实现批量写入版本的训练日整日替换
- [x] **P1-3**：确保测试覆盖批量写入与 Markdown 等价跳过
- [ ] 对比下一次线上 deploy 日志中的步骤耗时
