# Hexo + GitHub Pages 训练记录看板 — 深度审计与架构优化方案

> 审计日期：2026-05-20
> 审计范围：全项目代码、配置、CI/CD、前端资源

---

## 一、项目概况

本项目并非传统 Hexo 博客，而是一个**以 Hexo 为静态站点生成器的训练数据看板**。核心数据流：

```
训练记录.md → training-parser.mjs → training.json → dashboard-view.mjs → dashboardView.json → Hexo EJS 模板 → 静态 HTML
                                                                                              ↓
                                                              Telegram Bot → Cloudflare Worker → GitHub Actions → 自动更新
```

当前规模：~6 篇 post、1 个 page、1 个 dashboard、1 个 thoughts 页。

---

## 二、当前系统问题清单（按严重程度排序）

### 2.1 严重问题（影响性能/安全/稳定性）

| # | 问题 | 文件/位置 | 影响 |
|---|------|----------|------|
| 1 | **db.json (158KB) 暴露在仓库根目录** | `db.json` | 可能包含数据库连接信息或缓存数据；每次构建上传；Git 可追踪 |
| 2 | **Node 24 用于 CI** | `.github/workflows/deploy-pages.yml:43`, `telegram-sync.yml:44` | Node 24 非 LTS，GitHub Actions `setup-node` 可能不支持，导致构建失败 |
| 3 | **Chart.js CDN 无 SRI 校验** | `themes/cactus/layout/dashboard.ejs:379` | 供应链攻击风险。CDN 资源被篡改会导致 XSS |
| 4 | **wranger.toml 中的硬编码 GitHub 信息** | `wrangler.toml:6-7` | `GITHUB_OWNER`/`GITHUB_REPO` 硬编码；应通过 Cloudflare secrets 注入 |
| 5 | **shared-site-fixture.mjs 使用 Atomics.wait** | `test/shared-site-fixture.mjs:52` | `SharedArrayBuffer` + `Atomics.wait` 在非安全上下文中会失败；这是文件级别的锁实现，脆弱且不可移植 |

### 2.2 中等问题（代码冗余/可维护性差）

| # | 问题 | 文件/位置 | 影响 |
|---|------|----------|------|
| 6 | **formatNumber/escapeHtml/renderDailyCard/renderDailyRange 在 EJS 模板和 JS 文件中重复定义** | `dashboard.ejs:16-170` vs `training-dashboard.js:159-198` | 修改需同步两处，极易出现不一致 |
| 7 | **main.js 60% 的代码是死代码** | `themes/cactus/source/js/main.js` | 引用 `#footer-post`、`#menu-icon-tablet`、`#actions-footer` 等布局中不存在的元素；justifiedGallery 顶部初始化在无 gallery 页面也执行 |
| 8 | **search.js 始终加载但从未启用** | `_config.yml:62 local_search.enable: false` + `scripts.ejs:45-82` | 每次页面加载一个 159 行、依赖 jQuery 的搜索脚本和对应的 MutationObserver 逻辑 |
| 9 | **jQuery 在所有页面同步加载但仅用于极少量交互** | `scripts.ejs:1-6` | ~87KB min+gzip 只为：clipboard copy 按钮、移动端菜单切换、未使用的 justifiedGallery。可完全用原生 JS 替代 |
| 10 | **60 个 highlight 主题文件，仅 1 个被使用** | `themes/cactus/source/css/_highlight/*.styl` (~60 files) | 构建时只编译 `$highlight` 变量指定的那个，但所有文件仍在源码中 |
| 11 | **20 个语言文件，仅 zh-CN 被使用** | `themes/cactus/languages/*.yml` (20 files) | 冗余，且包含上游仓库的翻译文本 |
| 12 | **12 个 Meslo 字体变体 + 6 个 Vazir 字体变体，仅 1-2 个被使用** | `themes/cactus/source/lib/meslo-LG/*.ttf` (12 files, ~3MB), `vazir-font/*` (24 files, ~2MB) | Vazir 是波斯语字体，zh-CN 站点完全不需要；Meslo 仅需 Regular 一个变体 |

### 2.3 一般问题（配置/工程规范）

| # | 问题 | 文件/位置 | 影响 |
|---|------|----------|------|
| 13 | **主题配置与根配置大量重复** | `_config.yml theme_config` vs `themes/cactus/_config.yml` | 两处维护 analytics ID、nav、social_links 等；merge-configs.js 用浅层 Object.assign 合并 |
| 14 | **analytics 配置（Google/Baidu/Cloudflare/Umami）全部 disabled 但保留完整模板代码** | `_config.yml:50-58`, `scripts.ejs:83-98`, `head.ejs:52-53` | 四个 analytics partial 每次构建都处理 |
| 15 | **评论系统（Disqus/Utterances）全部 disabled 但保留完整模板** | `_config.yml`, `scripts.ejs:99-134` | 同上 |
| 16 | **theme_config 中 nav 使用 `records` key，但语言文件中没有这个 key 的翻译** | `_config.yml:36-38` vs `languages/zh-CN.yml` | `records` 在 `__('nav.records')` 会 fallback 到 `records` 原文 |
| 17 | **Gulp 构建系统与 Hexo 构建系统完全独立** | `themes/cactus/gulpfile.js` | 下载字体的 gulp 任务（lib:download_mesloFont）依赖外部 GitHub URL，离线或网络差时失败 |
| 18 | **3 个 GitHub Actions workflow 有大量重复步骤** | `deploy-pages.yml`, `telegram-sync.yml` | checkout/setup-node/npm ci/backfill/reconcile 在多个 workflow 中重复 |
| 19 | **telegram-sync workflow 中 build+deploy 是 deploy-pages 的拷贝** | `telegram-sync.yml:112-133` | 维护两套部署逻辑，易漂移 |
| 20 | **.tmp 目录在仓库中** | `.tmp/` | 运行时临时文件不应提交到仓库 |
| 21 | **CDN enable: true 但本地 lib 仍保留** | `themes/cactus/source/lib/` (jQuery, clipboard, font-awesome, justified-gallery) | 双重维护；CDN 开启时本地文件根本不会被引用 |
| 22 | **package.json 中 hexo-cli 声明为 dependency 而非 devDependency** | `package.json:23` | hexo-cli 仅用于本地开发，不应打包到生产依赖 |
| 23 | **theme package.json 中依赖使用 `*` 版本号** | `themes/cactus/package.json:42-46` | `"del": "*"`, `"gulp": "^4.0.0"` 等 — 非确定性构建，且这些仅用于 gulp 主题构建，hexo 构建不依赖 |

---

## 三、架构分析

### 3.1 当前架构分层

```
┌─────────────────────────────────────────┐
│  Data Sources                            │
│  训练记录.md  │  PostgreSQL DB  │  Telegram│
├─────────────────────────────────────────┤
│  Data Pipeline (tools/)                  │
│  training-parser  training-snapshot      │
│  training-db-*   dashboard-view          │
│  telegram-sync   generate-training-data  │
├─────────────────────────────────────────┤
│  Hexo Static Generator                   │
│  + cactus theme (EJS + Stylus)           │
├─────────────────────────────────────────┤
│  Deployment                              │
│  GitHub Pages  │  Cloudflare Worker       │
└─────────────────────────────────────────┘
```

### 3.2 架构评级

| 维度 | 评级 | 说明 |
|------|------|------|
| 数据管道 | B+ | 模块化合理、有 DI 支持（options 参数）、有 fallback 机制 |
| 前端模板 | C | EJS 模板与 JS 重复逻辑、死代码多、无组件化 |
| CSS 架构 | B- | Stylus 组织合理但存在大量未使用文件 |
| CI/CD | C+ | 多 workflow 冗余、无缓存优化、Node 版本过新 |
| 工程规范 | C | 无 linter、无 formatter、无 pre-commit hook、版本号使用 `*` |

---

## 四、重构优先级列表

### P0 — 立即修复（1-2 天，零风险）

| 优先级 | 行动 | 收益 | 风险 |
|--------|------|------|------|
| **P0-1** | 从 `.gitignore` 添加 `db.json`（已确认已在 gitignore 中，但文件仍存在需确认） | 安全 | 无 |
| **P0-2** | CI 中 Node 24 → Node 22 LTS | 稳定性 | 低（需验证 pg 兼容性） |
| **P0-3** | Chart.js CDN 添加 SRI `integrity` 属性 | 安全 | 无 |
| **P0-4** | wrangler.toml 移除 `GITHUB_OWNER`/`GITHUB_REPO`，改用 secrets | 安全 | 低 |
| **P0-5** | `.tmp/` 加入 `.gitignore` | 整洁 | 无 |

### P1 — 高收益低风险（1-2 周）

| 优先级 | 行动 | 收益 | 风险 |
|--------|------|------|------|
| **P1-1** | 删除未使用文件：60 个 highlight 主题、19 个语言文件、Vazir 字体、多余 Meslo 变体 | 减少 ~5MB 仓库体积 | 低（确认 $highlight 变量值即可） |
| **P1-2** | 清理 main.js 死代码：移除 `#footer-post`、`#menu-icon-tablet` 等不存在元素的引用 | 减少 JS 体积 ~3KB、消除困惑 | 低 |
| **P1-3** | 移除 search.js 加载（`local_search.enable: false`） | 减少 JS 体积 ~4KB | 低 |
| **P1-4** | 用原生 JS 替代 jQuery：clipboard JS API 是原生 JS、菜单切换用 `classList.toggle` | 移除 ~87KB jQuery + 依赖 | 中（需仔细测试移动端菜单） |
| **P1-5** | 合并 `deploy-pages.yml` 和 `telegram-sync.yml` 的重复部署步骤为 reusable workflow | 减少维护负担 | 低 |
| **P1-6** | EJS 和 JS 中的重复工具函数（formatNumber/escapeHtml 等）抽到 Hexo helper | 单一事实来源 | 低 |
| **P1-7** | 删除 CDN 开启后的冗余本地 lib 文件 | 减少仓库体积 | 低 |

### P2 — 中长期优化（2-4 周）

| 优先级 | 行动 | 收益 | 风险 |
|--------|------|------|------|
| **P2-1** | CSS：删除未使用的 `_partial/categories.styl`、`_partial/tags.styl`（站点未使用分类/标签页） | 减少 CSS 体积 | 低 |
| **P2-2** | 添加 Hexo 构建缓存（`cache: enable: true`） | 构建加速 30-50% | 低 |
| **P2-3** | CI 添加 npm 缓存 + Hexo cache 持久化 | CI 构建加速 40-60% | 低 |
| **P2-4** | 主题配置去重：删除 `themes/cactus/_config.yml` 中已被 root `theme_config` 覆盖的项 | 减少配置混淆 | 中（需确认 merge 行为） |
| **P2-5** | 添加 `.editorconfig` + `eslint` + `prettier` | 统一代码风格 | 低 |
| **P2-6** | `package.json` 中 `hexo-cli` 移至 devDependencies | 语义正确 | 低 |
| **P2-7** | 图片优化：为 Telegram 照片添加构建时压缩（sharp/imagemin） | 页面加载更快 | 中 |

---

## 五、推荐新目录结构

```
健身锻炼/
├── .github/
│   └── workflows/
│       ├── deploy-pages.yml          # 主部署（复用 steps）
│       ├── telegram-sync.yml         # Telegram 同步（复用 deploy job）
│       ├── deploy-cloudflare-worker.yml
│       └── _reusable-build.yml       # [新增] 可复用的 build job
├── source/
│   ├── _data/                        # 构建生成的 JSON（gitignore）
│   ├── _posts/                       # Markdown 文章
│   ├── images/
│   │   └── thoughts/                 # Telegram 照片
│   ├── about/
│   │   └── index.md
│   ├── thoughts/
│   │   └── index.md
│   ├── index.md                      # 首页（dashboard layout）
│   └── CNAME
├── themes/
│   └── cactus/                       # 精简后的主题
│       ├── layout/                   # EJS 模板
│       ├── source/
│       │   ├── css/                  # 精简后的 Stylus
│       │   ├── js/                   # 精简后的 JS
│       │   └── images/               # favicon + logo
│       ├── scripts/                  # Hexo 辅助脚本
│       ├── languages/
│       │   └── zh-CN.yml            # 仅保留使用的语言
│       └── _config.yml              # 精简后的配置
├── tools/                            # 数据管道工具
│   ├── lib/                          # [新增] 共享工具库
│   │   ├── format.mjs               # formatNumber, escapeHtml 等
│   │   └── date.mjs                 # normalizeDateValue 等
│   ├── generate-training-data.mjs
│   ├── dashboard-view.mjs
│   ├── training-parser.mjs
│   ├── training-domain.mjs
│   ├── training-db-*.mjs
│   ├── training-snapshot.mjs
│   ├── training-analysis.mjs
│   ├── telegram-sync.mjs
│   ├── telegram-*.mjs
│   └── run-hexo-command.mjs
├── cloudflare/
│   └── telegram-sync-dispatch-worker.mjs
├── test/
├── docs/
├── sql/
├── prompts/
├── _config.yml
├── package.json
├── .gitignore
├── .editorconfig                    # [新增]
├── .eslintrc.json                   # [新增]
└── .prettierrc                      # [新增]
```

---

## 六、详细优化方案

### 6.1 Hexo 配置优化

#### _config.yml 精简建议

**可删除的配置块：**
```yaml
# 所有 theme_config 下 disabled 的功能可完全移除：
# - google_analytics (enabled: false)
# - baidu_analytics (enabled: false)
# - cloudflare_analytics (enabled: false)
# - umami_analytics (enabled: false)
# - mathjax (enabled: false)
# - local_search (enable: false)
# - rss: false
```

**优化后的 _config.yml：**
```yaml
title: 健身训练记录看板
subtitle: ''
description: >
  用 Hexo 与 GitHub Pages 展示训练、体脂和饮食记录的静态看板。
keywords:
  - 健身
  - 训练记录
  - 体脂
  - 饮食
author: soulgo
language: zh-CN
timezone: Asia/Shanghai

url: https://soulgo.chat
root: /
permalink: thoughts/:year/:month/:day/:title/
pretty_urls:
  trailing_index: true
  trailing_html: true

theme: cactus

theme_config:
  colorscheme: white
  nav:
    records: /
    thoughts: /thoughts/
    about: /about/
  posts_overview:
    show_all_posts: false
    post_count: 0
  social_links:
    - icon: github
      label: GitHub 仓库
      link: https://github.com/soulgo/training_records
  copyright:
    start_year: 2026
  # CDN 配置保留（实际使用中）
  cdn:
    enable: true
    jquery: https://cdnjs.cloudflare.com/ajax/libs/jquery/3.6.0/jquery.min.js
    clipboard: https://cdnjs.cloudflare.com/ajax/libs/clipboard.js/2.0.7/clipboard.min.js
    font_awesome: https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css

marked:
  prependRoot: true
  postAsset: false

# 新增构建缓存
cache:
  enable: true
```

#### themes/cactus/_config.yml 精简建议

当前 220 行的主题配置可以精简到 ~40 行。删除：
- 上游作者的默认 social_links（github.com/probberechts）
- 默认 analytics ID 值
- gravatar 配置（未使用）
- Disqus/Utterances 默认值
- `projects_url: http://github.com/probberechts`（上游默认）
- `nav` 块中的上游默认值（root `theme_config` 已覆盖）
- `post.show_updated: false`（默认值）
- `archive.sort_updated: false`（默认值）
- `error_404` 块（使用默认值）

### 6.2 前端性能优化方案

#### JS 体积削减路线

| 文件 | 当前大小 | 目标大小 | 手段 |
|------|---------|---------|------|
| main.js | ~4.2KB | ~1.2KB | 删死代码，原生重写 |
| search.js | ~3.8KB | 0KB | 删除（未启用） |
| jquery.min.js | 87KB | 0KB | 原生替代 |
| clipboard.min.js | 10KB | 0KB | 内联 20 行原生 copy 逻辑 |
| training-dashboard.js | ~6.5KB | ~4.5KB | 去重，共享工具函数 |
| **总计** | **~111KB** | **~5.7KB** | **减少 95%** |

**原生 clipboard 替代方案（~15 行）：**
```javascript
// 替代 clipboard.js + jQuery
document.querySelectorAll('.btn-copy').forEach(btn => {
  btn.addEventListener('click', () => {
    const code = btn.nextElementSibling.querySelector('.code')?.innerText || '';
    navigator.clipboard.writeText(code).then(() => {
      btn.setAttribute('aria-label', 'Copied!');
    });
  });
});
```

**原生移动端菜单替代方案（~10 行）：**
```javascript
// 替代 jQuery mobile menu toggle
document.querySelector('#header .icon a')?.addEventListener('click', (e) => {
  e.preventDefault();
  document.querySelector('#header > #nav > ul').classList.toggle('responsive');
});
```

#### CSS 体积削减路线

| 类别 | 当前文件数 | 目标文件数 | 节省 |
|------|-----------|-----------|------|
| highlight 主题 | 60+ | 1（white 使用的 atelier-cave-light） | ~500KB |
| 语言 RTL | 1 (rtl.styl) | 0 | ~2KB |
| 未使用 partial | 2 (categories.styl, tags.styl) | 0 | ~3KB |
| 字体文件 | 36+ | 1-2 | ~5MB |

#### 首屏优化方案

1. **Chart.js 加 `defer`**：`dashboard.ejs:379` 把 `<script src="...chart.js">` 改为 `<script defer src="...chart.js">`
2. **training-dashboard.js 加 `defer`**：`dashboard.ejs:380` 加 `defer`
3. **font-awesome CSS 已是 async 加载**（`styles.ejs` 中 `onload` 模式）- 正确
4. **移除 `<link rel="preload">` 中未使用的 justifiedGallery CSS**（当前站点无 post 有 photos gallery）
5. **FontAwesome 子集化**：当前使用图标极少（fa-bars, fa-github, fa-clone），可考虑内联 SVG 替代整个 FA 库

### 6.3 Dashboard 组件重复问题修复

**当前问题：** `dashboard.ejs` 和 `training-dashboard.js` 分别定义了完全相同的函数：
- `formatNumber()`
- `escapeHtml()`
- `renderDailyCard()`
- `renderDailyRange()`

**解决方案：** 将服务端工具函数注册为 Hexo helper，客户端通过 `<script>` JSON 数据 + 纯渲染实现。

```javascript
// themes/cactus/scripts/helpers.js (新增)
hexo.extend.helper.register('formatNumber', function(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return Number(value).toFixed(digits).replace(/\.00$/, '');
});
```

### 6.4 CI/CD 重构方案

#### 当前问题
- `deploy-pages.yml` 和 `telegram-sync.yml` 共享 ~80% 的步骤
- 无构建缓存
- 每次构建都重新安装依赖

#### 推荐方案

**创建 reusable workflow `_reusable-build.yml`：**

```yaml
name: Reusable Build & Deploy

on:
  workflow_call:
    inputs:
      run_tests:
        type: boolean
        default: true
      deploy:
        type: boolean
        default: true

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22  # LTS
          cache: npm
      - run: npm ci
      # ... cache Hexo .hexo_cache
      - run: npm run build
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: ./public
      - uses: actions/deploy-pages@v4
```

**deploy-pages.yml 简化为：**
```yaml
jobs:
  deploy:
    uses: ./.github/workflows/_reusable-build.yml
    with:
      run_tests: true
    secrets: inherit
```

**添加 Hexo 缓存：**
```yaml
- name: Cache Hexo
  uses: actions/cache@v4
  with:
    path: |
      .hexo_cache
      db.json
    key: hexo-${{ runner.os }}-${{ hashFiles('训练记录.md') }}
```

### 6.5 图片优化方案

当前 Telegram 照片直接保存到 `source/images/thoughts/`，未经任何处理。建议：

1. **添加构建时图片压缩脚本**（使用 `sharp`）：
   - 自动转换 JPEG 为 WebP（减少 30-50%）
   - 限制最大宽度 1200px
   - 生成缩略图用于列表页

2. **HTML 中生成 `<picture>` 元素**替代 `<img>`：
   ```html
   <picture>
     <source srcset="photo.webp" type="image/webp">
     <img src="photo.jpg" loading="lazy" alt="">
   </picture>
   ```

---

## 七、推荐新增工具列表

| 工具 | 用途 | 优先级 |
|------|------|--------|
| `sharp` | 构建时图片压缩/格式转换 | P2 |
| `eslint` + `@eslint/js` | JS 代码检查 | P2 |
| `prettier` | 代码格式化 | P2 |
| `husky` + `lint-staged` | pre-commit hook | P3 |
| `hexo-cache` | 构建缓存（Hexo 内置 `cache: enable: true` 即可） | P2 |
| `actions/cache@v4` | CI 中的依赖/构建缓存 | P1 |

---

## 八、推荐删除文件列表

### 高优先级（确认无引用后立即删除）

```
# 字体 - 未使用的变体和语言
themes/cactus/source/lib/vazir-font/          # 波斯语字体，整个目录
themes/cactus/source/lib/meslo-LG/MesloLGL-* # 仅保留 MesloLGS-Regular.ttf
themes/cactus/source/lib/meslo-LG/MesloLGM-*

# Highlight 主题 - 保留 1 个
themes/cactus/source/css/_highlight/agate.styl
themes/cactus/source/css/_highlight/androidstudio.styl
# ... (保留 white 配色使用的 atelier-cave-light.styl，其余全部删除)
themes/cactus/source/css/_highlight/zenburn.styl
# 同时删除 highlight 目录下的图片文件
themes/cactus/source/css/_highlight/brown-papersq.png
themes/cactus/source/css/_highlight/pojoaque.jpg
themes/cactus/source/css/_highlight/school-book.png

# 语言文件 - 保留 zh-CN.yml
themes/cactus/languages/ar.yml through vi.yml  # 删除除 zh-CN.yml 外的所有

# 未使用的 CSS partial
themes/cactus/source/css/_partial/categories.styl
themes/cactus/source/css/_partial/tags.styl
themes/cactus/source/css/rtl.styl

# CDN 启用后的冗余本地文件
themes/cactus/source/lib/jquery/
themes/cactus/source/lib/clipboard/
themes/cactus/source/lib/font-awesome/
themes/cactus/source/lib/justified-gallery/

# 主题 package.json 的 gulp + lint 依赖（hexo 构建不需要）
# (保留 gulpfile.js 但标记为仅主题开发用)
```

### 中优先级

```
# 不可达模板代码
themes/cactus/layout/_partial/google_analytics.ejs
themes/cactus/layout/_partial/umami_analytics.ejs
themes/cactus/layout/_partial/comments.ejs      # 评论系统未启用
themes/cactus/layout/_partial/search.ejs        # 搜索未启用

# 空目录/文件
telegram/inbox/.gitkeep                         # 如果 CI 中不存在该目录可删除
prompts/_source/                                # 如果仅用于参考可移到 docs/
```

---

## 九、技术栈升级路线

### 短期（当前 Hexo 架构内优化）

```
Hexo 7.x + EJS + Stylus → Hexo 7.x (优化配置) + EJS (精简) + Stylus (精简)
Node 24 → Node 22 LTS
npm → npm (保持) + npm ci (CI)
```

### 中期（1-3 个月，如需更多功能）

**方案 A：留在 Hexo 生态**（推荐，低迁移成本）
- 升级到 Hexo 8.x（发布后）
- 替换 Stylus → PostCSS + CSS Nesting（Stylus 维护活跃度下降）
- EJS → Nunjucks（Hexo 原生支持，更强模板功能）

**方案 B：迁移到 Astro**（适合需要更多交互的场景）
- Astro 原生支持 Markdown + 数据文件 + 组件化
- 可以保留现有 `tools/` 数据管道
- 天然支持部分水合（partial hydration），dashboard 图表可以按需加载

**方案 C：迁移到 VitePress**（适合文档型站点）
- 配置简单，但灵活性不如 Astro/Hexo
- 适合纯 Markdown 内容，不适合自定义数据管道

### 长期（6 个月+）

- 如果 AI 内容生成需求增强，考虑 Astro + MDX + AI pipeline
- 如果搜索需求增强，考虑集成 Pagefind（静态搜索，零 JS 运行时）
- 向量数据库集成仅在需要语义搜索 + RAG 时考虑

---

## 十、可量化性能优化

| 指标 | 当前估算 | 优化后目标 | 手段 |
|------|---------|-----------|------|
| 首屏 JS | ~111KB | ~6KB | 去 jQuery + 死代码清理 |
| 首屏 CSS | ~35KB（含 highlight） | ~18KB | 删未使用文件 |
| 字体文件 | ~5MB（36+ 文件） | ~300KB（2 文件） | 删多余变体 |
| 构建时间（CI） | ~90-120s | ~40-60s | 缓存 + 并行 |
| Lighthouse Performance | ~75-85 | ~92-98 | JS/CSS 体积削减 |
| LCP | ~2-3s | <1.5s | 字体/JS 优化 |
| CLS | 低 | 保持 | - |
| TBT | ~200-400ms | <50ms | 移除 jQuery + search.js |

---

## 十一、风险评估

| 风险 | 可能性 | 影响 | 缓解措施 |
|------|--------|------|---------|
| CDN 故障导致图标/字体丢失 | 低 | 中 | 保留本地 fallback 路径（或使用内联 SVG） |
| Node 22 与 pg 8.x 不兼容 | 低 | 中 | CI 中先验证 |
| 删除 highlight 主题后编译失败 | 低 | 低 | 确认 `_colors/white.styl` 中 `$highlight` 变量值 |
| jQuery 移除后 clipboard 功能异常 | 中 | 低 | 充分测试 post 页面 |
| reusable workflow 引入后环境变量传递失败 | 低 | 中 | 先在分支上验证 |
| 字体删除后页面显示异常 | 低 | 中 | 确认仅使用 MesloLGS-Regular 和 FA woff2 |

---

## 十二、实施顺序

```
Week 1 (P0):  安全修复 + Node 22 + SRI + .gitignore
Week 2 (P1):  文件清理（字体/语言/highlight）+ JS 死代码移除
Week 3 (P1):  jQuery 去除 + CI 重构（reusable workflow）
Week 4 (P2):  CSS 精简 + 构建缓存 + lint/format 工具
Week 5+:      长期演进（按需）
```

---

## 十三、可执行 TODO Checklist

见独立文件 `docs/restructuring-checklist.md`

---

*本文档基于 2026-05-20 项目状态生成，建议每季度或每次重大变更后更新。*
