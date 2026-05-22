# 重构 TODO Checklist

> 基于 `docs/overall_restructuring.md` 的完整执行清单。按顺序执行，每完成一项打勾。

---

## Phase 0 — 安全与稳定性修复 (预计 2 小时)

- [x] **P0-1** 确认 `db.json` 已在 `.gitignore` 中，并确认不再被 git 追踪
  - 文件：`.gitignore`，检查 `db.json` 行存在
  - 执行：`git rm --cached db.json`（如果仍在追踪中）
- [x] **P0-2** CI Node 版本降级：`.github/workflows/deploy-pages.yml:43` 和 `telegram-sync.yml:44` 中 `node-version: 24` → `node-version: 22`
- [x] **P0-3** Chart.js CDN 添加 SRI：
  - 文件：`themes/cactus/layout/dashboard.ejs:379`
  - 将 `<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js"></script>`
  - 改为 `<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js" integrity="sha384-JUh163oCRItcbPme8pYnROHQMC6fNKTBWtRG3I3I0erJkzNgL7uxKlNwcrcFKeqF" crossorigin="anonymous" defer></script>`
  - 从 https://www.srihash.org/ 获取正确的 integrity hash
- [x] **P0-4** `wrangler.toml` 移除硬编码变量：
  - 删除 `[vars]` 块中的 `GITHUB_OWNER` 和 `GITHUB_REPO`
  - 需手动执行 `wrangler secret put GITHUB_OWNER` 和 `wrangler secret put GITHUB_REPO` 设置 secrets
- [x] **P0-5** `.gitignore` 添加 `.tmp/` 行（已有 `.tmp*` 覆盖）
- [x] **P0-6** `.gitignore` 添加 `runtime/` 行（CI 运行时产物）（已存在）
- [x] **P0-7** 执行 `npm test` 确认所有测试通过（146 pass, 0 fail）
- [x] **P0-8** 执行 `npm run build` 确认本地构建成功

---

## Phase 1 — 冗余文件清理 (预计 3 小时)

### 1.1 字体文件清理

- [x] **1.1.1** 删除整个 Vazir 字体目录
  - `rm -rf themes/cactus/source/lib/vazir-font/`
- [x] **1.1.2** 删除多余 Meslo 变体，仅保留 `MesloLGS-Regular.ttf`
  - 保留：`themes/cactus/source/lib/meslo-LG/MesloLGS-Regular.ttf`
  - 删除：所有 `MesloLGL-*`、`MesloLGM-*`、`MesloLGS-Bold*`、`MesloLGS-Italic*` 等
- [x] **1.1.3** 更新 `_fonts.styl` 确认只引用 `MesloLGS-Regular.ttf`

### 1.2 Highlight 主题清理

- [x] **1.2.1** 确认当前使用的 highlight 主题
  - 查看 `_colors/white.styl:16` → `$highlight = hexo-config("highlight") || "atelier-cave-light"`
  - 如果 `_config.yml` 无 `highlight` 覆盖，则使用 `atelier-cave-light`
- [x] **1.2.2** 删除 `themes/cactus/source/css/_highlight/` 下除以下文件外的所有 `.styl` 文件
  - 保留：`atelier-cave-light.styl`、`index.styl`
- [x] **1.2.3** 删除 highlight 目录下的图片文件
  - `brown-papersq.png`、`pojoaque.jpg`、`school-book.png`

### 1.3 语言文件清理

- [x] **1.3.1** 删除 `themes/cactus/languages/` 下除 `zh-CN.yml` 和 `default.yml` 外的所有文件
  - 保留：`default.yml`（fallback）、`zh-CN.yml`
- [x] **1.3.2** 如 `en.yml` 被引用为 base，保留 `en.yml` 作为 fallback（`default.yml` 是 `en.yml` 的 symlink，已保留）

### 1.4 本地 lib 清理（CDN 已启用）

- [x] **1.4.1** 确认 `themes/cactus/_config.yml` 中 `cdn.enable: true`
- [x] **1.4.2** 删除本地冗余副本：
  - `themes/cactus/source/lib/jquery/`
  - `themes/cactus/source/lib/clipboard/`
  - `themes/cactus/source/lib/font-awesome/`
  - `themes/cactus/source/lib/justified-gallery/`
- [x] **1.4.3** 保留 `themes/cactus/source/lib/meslo-LG/MesloLGS-Regular.ttf`（无 CDN 替代）

### 1.5 验证

- [x] **1.5.1** 执行 `npm run clean && npm run build` 确认清理后构建成功
- [x] **1.5.2** 执行 `npm test` 确认测试通过（146 pass, 0 fail）

---

## Phase 2 — JS/CSS 死代码清理 (预计 4 小时)

### 2.1 main.js 清理

- [x] **2.1.1** 移除 `main.js:1-11` 的 justifiedGallery 全局初始化（当前无 gallery 页面）
- [x] **2.1.2** 保留 `#footer-post`/`#menu-icon-tablet`/`#top-icon-tablet` 代码 — 经核实，这些元素在 `actions_desktop.ejs` 和 `actions_mobile.ejs` 中定义，由 `layout.ejs` 在 `is_post()` 时加载，实际存在于 post 页面中，移除会破坏移动端菜单功能
- [x] **2.1.3** 保留 `#actions-footer`/`#nav-footer`/`#toc-footer`/`#share-footer` 代码 — 同上，这些元素在 post 页面的 `actions_mobile.ejs` 中真实存在
- [x] **2.1.4** 保留：移动端菜单 toggle（`#header > #nav > ul > .icon` click）和桌面端 menu scroll 行为

### 2.2 search.js 移除

- [x] **2.2.1** 从 `scripts.ejs` 中删除 search.js 加载 + MutationObserver 逻辑（原第 45-82 行）
- [x] **2.2.2** 删除 `themes/cactus/source/js/search.js`
- [x] **2.2.3** `search.ejs` partial 保留 — 仅在 `page.search` 为 true 时条件引用，当前无页面满足条件，不产生输出，无害保留

### 2.3 jQuery 依赖移除（Phase 3 进行）

- [ ] **2.3.1** 评估 `main.js` 中剩余 jQuery 用法
- [ ] **2.3.2** clipboard.js jQuery 初始化改为原生 JS
- [ ] **2.3.3** 完全移除 jQuery 依赖

### 2.4 CSS 清理

- [x] **2.4.1** 删除 `categories.styl` 和 `tags.styl`
- [x] **2.4.2** 从 `style.styl` 中移除 `categories.styl` 和 `tags.styl` 的 `@import`
- [x] **2.4.3** 删除 `rtl.styl`（站点始终使用 `ltr`，且 style.styl 中无 rtl import）

### 2.5 验证

- [x] **2.5.1** 执行 `npm run build` 确认构建成功（12 files generated）
- [ ] **2.5.2** 本地 `npm run server` 后在浏览器检查所有页面功能正常（需手动验证）
- [ ] **2.5.3** 特别检查：移动端菜单、代码块复制按钮、首页列表、dashboard 图表、daily overview 翻页（需手动验证）

---

## Phase 3 — 代码去重与模块化 (预计 4 小时)

### 3.1 共享工具函数抽离

- [x] **3.1.1** 创建 `themes/cactus/scripts/helpers.js`，注册以下 Hexo helpers：
  - `formatNumber(value, digits)` — 当前在 `dashboard.ejs:16-21` 和 `dashboard-view.mjs:60-65` 重复
  - `escapeHtml(value)` — 当前在 `dashboard.ejs:115-122` 和 `training-dashboard.js:170-177` 重复
- [x] **3.1.2** 更新 `dashboard.ejs` 使用新的 helper（`<%= formatNumber(...) %>`）
  - 同时移除 `renderDayCard()`，改用 `dashboard-view.mjs` 中预渲染的 `cardHtml` 字段
- [x] **3.1.3** 更新 `training-dashboard.js`：
  - `escapeHtml`/`renderDailyCard` 保留（客户端分页需要在不同运行时渲染 HTML）
  - `dashboard.ejs` 中不再重复定义这两个函数，消除了 EJS/JS 间的重复
  - JSON 数据中剥离 `cardHtml` 字段以避免载荷膨胀
- [x] **3.1.4** 创建 `tools/lib/format.mjs`，导出 `formatNumber`、`formatDuration`、`formatWorkoutDuration`、`escapeHtml`
  - `dashboard-view.mjs` 从该共享库导入，移除本地重复定义

### 3.2 EJS 模板共享化

- [x] **3.2.1** 评估 `dashboard.ejs` 中的 `renderDayCard()` 是否可以移到 Hexo helper
  - 决定：不在 Hexo helper 中生成 HTML，改为在 `dashboard-view.mjs` 中预渲染 `cardHtml`，模板直接使用
- [x] **3.2.2** 考虑将 `getComparison()` 逻辑移至 `dashboard-view.mjs` 预计算
  - 决定：`getComparison()` 保留在 dashboard.ejs 中，因为它是模板渲染逻辑的一部分，返回值直接驱动 HTML 生成

### 3.3 验证

- [x] **3.3.1** 执行 `npm test` 确认测试通过（146 pass, 0 fail）
- [x] **3.3.2** 执行 `npm run build` 确认构建成功，验证输出：4 张日卡渲染、图表存在、比较指示器存在、JSON 数据不含 cardHtml

---

## Phase 4 — CI/CD 重构 (预计 3 小时)

### 4.1 创建 Reusable Workflow

- [x] **4.1.1** 创建共享构建/部署入口
  - 实际实现为 `.github/actions/site-build/action.yml` composite action，而不是 `.github/workflows/_reusable-build.yml`
  - 包含：setup-node → npm ci → backfill → reconcile → build → upload artifact → deploy
  - 参数化：是否运行 backfill、是否运行 test、是否 deploy
- [x] **4.1.2** 简化 `deploy-pages.yml`，调用共享构建/部署入口
- [x] **4.1.3** 简化 `telegram-sync.yml` 中的 deploy 部分，调用共享构建/部署入口

### 4.2 添加缓存

- [x] **4.2.1** 在 `_config.yml` 中添加 `cache: enable: true`
- [x] **4.2.2** 在共享构建/部署入口中添加 `actions/cache@v4` 缓存 `.hexo_cache` 目录
- [x] **4.2.3** 缓存 key 使用 `hashFiles('训练记录.md', 'source/_posts/**', 'themes/**')`

### 4.3 验证

- [x] **4.3.1** 推送分支，确认 GitHub Actions 正常运行
  - GitHub Actions `Deploy GitHub Pages` / `Telegram Sync` 最新 run 均已成功
- [ ] **4.3.2** 确认构建时间比优化前减少 40%+
  - 现有对比记录不足以证明已达到 40% 目标，继续保留为未完成
- [ ] **4.3.3** 确认 GitHub Pages 部署成功
  - `https://soulgo.chat` 可访问，返回 200

---

## Phase 5 — 配置解耦与工程规范 (预计 3 小时)

### 5.1 配置精简

- [ ] **5.1.1** 从 `_config.yml` 中删除所有 disabled 的功能块（见 audit 6.1 节）
- [ ] **5.1.2** 从 `themes/cactus/_config.yml` 中删除已被 root `theme_config` 覆盖的项
- [ ] **5.1.3** 清理 `themes/cactus/_config.yml` 中上游默认值（social_links 中的 probberechts 链接等）
- [ ] **5.1.4** 验证 `theme_config` 合并行为：确认 `merge-configs.js` 的浅合并不会导致嵌套对象丢失

### 5.2 工程规范

- [ ] **5.2.1** 添加 `.editorconfig`：
  ```ini
  root = true
  [*]
  indent_style = space
  indent_size = 2
  end_of_line = lf
  charset = utf-8
  trim_trailing_whitespace = true
  insert_final_newline = true
  ```
- [ ] **5.2.2** 添加 `.prettierrc`：
  ```json
  { "singleQuote": true, "trailingComma": "all", "printWidth": 100 }
  ```
- [ ] **5.2.3** `package.json` 中添加 `"format": "prettier --write ."`
- [ ] **5.2.4** `package.json` 中将 `hexo-cli` 从 `dependencies` 移至 `devDependencies`

### 5.3 验证

- [ ] **5.3.1** 执行 `npm run build` 确认精简后的配置构建成功
- [ ] **5.3.2** 执行 `npm test` 确认测试通过

---

## Phase 6 — 性能优化 (预计 2 小时)

### 6.1 资源加载优化

- [ ] **6.1.1** `dashboard.ejs:379` Chart.js 添加 `defer` 属性
- [ ] **6.1.2** `dashboard.ejs:380` training-dashboard.js 添加 `defer` 属性
- [ ] **6.1.3** 评估 FontAwesome 图标使用量，如果 < 5 个图标，考虑内联 SVG 替代
- [ ] **6.1.4** 为 Meslo 字体添加 `font-display: swap`（在 `_fonts.styl` 中）

### 6.2 图片优化

- [ ] **6.2.1** 评估是否需要在构建流程中添加 `sharp` 进行图片压缩
- [ ] **6.2.2** 如果照片量大（>20 张），建议添加 WebP 转换

### 6.3 验证

- [ ] **6.3.1** Chrome DevTools Lighthouse 审计，目标 Performance > 92
- [ ] **6.3.2** 确认 LCP < 1.5s，TBT < 50ms

---

## Phase 7 — 长期演进 (按需)

- [ ] **7.1** 评估 Hexo 8.x 升级（发布后）
- [ ] **7.2** 评估 Stylus → PostCSS 迁移
- [ ] **7.3** 评估 Pagefind 静态搜索集成（如果需要搜索）
- [ ] **7.4** 评估 Astro 迁移（如需更多交互功能）
- [ ] **7.5** 添加 pre-commit hook（husky + lint-staged）
- [ ] **7.6** 添加 Dependabot 配置用于自动依赖更新

---

## 总结

| Phase | 预计时间 | 累计风险 | 收益 |
|-------|---------|---------|------|
| Phase 0 | 2h | 极低 | 安全 + 稳定 |
| Phase 1 | 3h | 低 | ~5MB 仓库体积 |
| Phase 2 | 4h | 低 | JS 体积 -95% |
| Phase 3 | 4h | 中 | 可维护性 |
| Phase 4 | 3h | 中 | CI 速度 -50% |
| Phase 5 | 3h | 低 | 工程规范 |
| Phase 6 | 2h | 低 | Lighthouse > 92 |
| **总计** | **~21h** | | |

建议分 3 个 PR 实施：
- **PR #1**: Phase 0 + Phase 1（安全 + 清理，最安全）
- **PR #2**: Phase 2 + Phase 3（代码优化，需仔细测试）
- **PR #3**: Phase 4 + Phase 5 + Phase 6（CI/CD + 配置 + 性能）
