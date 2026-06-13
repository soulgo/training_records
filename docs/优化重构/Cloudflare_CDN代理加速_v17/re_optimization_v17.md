# Cloudflare CDN 代理加速方案 (v17)

> **实施状态**：已于 2026-06-13 完成。Cloudflare 代理（橙云）已开启，DNS: CNAME `@` → `soulgo.github.io`（已代理），SSL/TLS: Full (Strict)，Auto Minify / Brotli / HTTP/3 / 0-RTT / Early Hints 均已开启，Cache Rules 和 Page Rule 已配置。验证通过：`server: cloudflare`，`cf-cache-status: HIT`。

## 1. 现状分析

### 1.1 当前部署架构

| 维度 | 当前状态 |
|------|---------|
| 域名 | `soulgo.chat` |
| DNS 托管 | Cloudflare（jason/gemma NS），**DNS-only 模式（灰云）** |
| 站点托管 | GitHub Pages |
| CDN | GitHub Pages 内置 Fastly CDN（新加坡节点 `cache-sin`） |
| SSL | GitHub Pages 自动证书（Let's Encrypt） |
| 缓存策略 | `cache-control: max-age=600`（10 分钟），无分层缓存 |
| 压缩 | 依赖 Fastly 默认 gzip，未启用 Brotli |
| HTTP 协议 | HTTP/2（Fastly 支持），未启用 HTTP/3 (QUIC) |

### 1.2 诊断数据

```
HTTP/2 200
server: GitHub.com                    ← 未经 Cloudflare 代理
cache-control: max-age=600            ← 统一 10 分钟缓存，静态资源偏短
x-proxy-cache: MISS                   ← 首次访问未命中缓存
x-served-by: cache-sin-wsat1880083-SIN ← Fastly 新加坡节点
via: 1.1 varnish                      ← Fastly CDN 层
content-length: 46997                 ← HTML 约 46KB，未 Brotli 压缩
```

### 1.3 问题

- **缓存粒度粗**：所有资源统一 10 分钟 TTL，CSS/JS/字体/图片应该更长
- **无 Brotli 压缩**：文本资源（HTML/CSS/JS）传输体积偏大
- **无 HTTP/3**：移动端和高丢包网络下连接建立慢
- **无边缘缓存规则**：Cloudflare 的全球边缘网络完全未利用
- **无 Early Hints**：浏览器无法提前预加载关键资源
- **中国大陆访问慢**：Fastly 新加坡节点对大陆用户延迟较高，Cloudflare 有更优的亚洲节点覆盖

---

## 2. 方案概述

**目标**：在不改变 GitHub Pages 托管的前提下，通过 Cloudflare 代理（橙云）+ 缓存规则 + 性能优化，让 `soulgo.chat` 的页面加载速度显著提升。

**核心改动**：

1. Cloudflare DNS 开启代理（橙云）
2. 配置缓存规则（Cache Rules），按资源类型分层 TTL
3. 开启 Auto Minify、Brotli、HTTP/3、Early Hints
4. 在仓库添加 `_headers` 文件精细控制响应头
5. 配置 Page Rules 处理特殊 URL 模式

**影响范围**：仅 Cloudflare Dashboard 配置 + 仓库新增 1 个文件，不改动任何现有代码或构建流程。

**回滚方式**：Cloudflare DNS 切回灰云（DNS-only），1 分钟内生效。

---

## 3. 实施步骤

### 3.1 Cloudflare DNS 开启代理

**Dashboard 路径**：Cloudflare Dashboard → `soulgo.chat` → DNS → Records

**操作**：

1. 删除现有的 4 条 A 记录（指向 GitHub Pages IP 的 185.199.108-111.153）
2. 添加 CNAME 记录：

| 类型 | 名称 | 目标 | 代理状态 | TTL |
|------|------|------|---------|-----|
| CNAME | `@` | `soulgo.github.io` | **已代理（橙云）** | Auto |

> **为什么用 CNAME 而不是 A 记录**：CNAME 让 Cloudflare 代理后，回源时自动解析到 GitHub Pages 的当前 IP，避免 GitHub IP 变化导致回源失败。Cloudflare 代理模式下 CNAME 会被 "CNAME Flattening" 处理，对访问者透明。

3. 确认 `source/CNAME` 文件中仍然是 `soulgo.chat`（GitHub Pages 需要这个文件来识别自定义域名）

**SSL/TLS 设置**：

- 路径：SSL/TLS → Overview
- 模式选择：**Full (Strict)**
- 原因：GitHub Pages 自带 Let's Encrypt 证书，Full (Strict) 会校验回源证书有效性，既安全又兼容

### 3.2 开启核心性能开关

全部在 Cloudflare Dashboard → `soulgo.chat` 对应菜单下操作：

| 功能 | 路径 | 操作 | 说明 |
|------|------|------|------|
| Auto Minify | Speed → Optimization → Content Optimization | 开启 JavaScript、CSS、HTML | Cloudflare 边缘自动压缩文本资源，无需改动构建 |
| Brotli | Speed → Optimization → Content Optimization | 开启 | 比 gzip 压缩率高 15-20%，所有现代浏览器支持 |
| HTTP/3 (QUIC) | Network | 开启 | 0-RTT 连接复用，移动端体验显著提升 |
| 0-RTT Connection Resumption | Speed → Optimization → Protocol Optimization | 开启 | 配合 HTTP/3，回访用户几乎零延迟 |
| Early Hints | Speed → Optimization → Protocol Optimization | 开启 | 服务器预推送 Link 头，浏览器提前加载 CSS/JS |
| Always Use HTTPS | SSL/TLS → Edge Certificates | 开启 | HTTP 自动跳 HTTPS |
| Minimum TLS Version | SSL/TLS → Edge Certificates | TLS 1.2 | 安全基线 |

### 3.3 配置缓存规则（Cache Rules）

**Dashboard 路径**：Caching → Cache Rules → Create rule

按优先级从高到低创建以下规则：

#### 规则 1：字体文件长期缓存

```
名称: Font Assets Long Cache
条件: (http.request.uri.path.extension in {"woff" "woff2" "ttf" "otf"})
动作:
  - Cache eligibility: Eligible for cache
  - Edge TTL: Override origin, 1 year, ignore cache-control
  - Browser TTL: Override origin, 1 year
```

#### 规则 2：图片长期缓存

```
名称: Image Assets Long Cache
条件: (http.request.uri.path.extension in {"jpg" "jpeg" "png" "gif" "webp" "avif" "svg" "ico"})
动作:
  - Cache eligibility: Eligible for cache
  - Edge TTL: Override origin, 30 days, ignore cache-control
  - Browser TTL: Override origin, 30 days
```

#### 规则 3：CSS/JS 中期缓存

```
名称: CSS and JS Medium Cache
条件: (http.request.uri.path.extension in {"css" "js"})
动作:
  - Cache eligibility: Eligible for cache
  - Edge TTL: Override origin, 7 days, ignore cache-control
  - Browser TTL: Override origin, 7 days
```

> **关于 CSS/JS 无 hash 文件名的问题**：当前 Hexo 构建输出的 `style.css`、`main.js` 等文件名不含 content hash，更新后浏览器可能用到旧缓存。解决方案见 3.6 节。

#### 规则 4：HTML 短缓存 + stale-while-revalidate

```
名称: HTML Short Cache with SWR
条件: (http.request.uri.path.extension eq "html") or (http.request.uri.path eq "/") or (not http.request.uri.path contains ".")
动作:
  - Cache eligibility: Eligible for cache
  - Edge TTL: Respect origin TTL (10 min from GitHub Pages)
  - Browser TTL: Override origin, 5 minutes
  - 附加响应头: `Cache-Control: public, max-age=300, stale-while-revalidate=3600, stale-if-error=86400`
```

> `stale-while-revalidate=3600`：浏览器可以用过期缓存先展示页面，同时后台刷新，用户感知到的是即时加载。

#### 规则 5：排除不缓存路径

```
名称: Skip Non-Page Paths
条件: (http.request.uri.path starts_with "/api/") or (http.request.uri.path starts_with "/.well-known/")
动作:
  - Cache eligibility: Bypass cache
```

### 3.4 配置 Page Rules（可选增强）

**Dashboard 路径**：Rules → Page Rules

```
URL: soulgo.chat/*
设置:
  - Cache Level: Cache Everything
  - Edge Cache TTL: 2 hours
  - Browser Cache TTL: Respect Existing Headers
  - Always Online: On（GitHub Pages 宕机时展示缓存页面）
```

> **Always Online** 价值很高：即使 GitHub Pages 短暂不可用，访客仍能看到上次缓存的页面。

### 3.5 仓库改动：添加 `public/_headers`

在 Hexo 的 `public/` 输出目录添加 `_headers` 文件。但 GitHub Pages 不识别 Cloudflare 的 `_headers` 文件——这个文件只对 Cloudflare Pages 有效。

**所以这里有两个选择**：

**选择 A（推荐）**：不改仓库，缓存策略全部通过 Cloudflare Dashboard Cache Rules 管理（即 3.3 节的方案）。这样保持了 GitHub Pages 部署的简洁性。

**选择 B（未来如果迁移到 Cloudflare Pages）**：在构建流程中生成 `_headers` 文件到 `public/` 目录：

```
# public/_headers (Cloudflare Pages 专用)
/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: strict-origin-when-cross-origin

/*.css
  Cache-Control: public, max-age=604800

/*.js
  Cache-Control: public, max-age=604800

/fonts/*
  Cache-Control: public, max-age=31536000, immutable

/images/*
  Cache-Control: public, max-age=2592000
```

如果选 A（当前推荐），可以通过 3.3 的 Cache Rules 加上 Dashboard 里的 Transform Rules → Modify Response Header 来实现同样的安全头：

```
Transform Rule: Add Security Headers
条件: (http.host eq "soulgo.chat")
动作:
  - Set: X-Content-Type-Options = nosniff
  - Set: X-Frame-Options = DENY
  - Set: Referrer-Policy = strict-origin-when-cross-origin
  - Set: Permissions-Policy = camera=(), microphone=(), geolocation=()
```

### 3.6 CSS/JS 缓存失效问题（后续优化，非必须）

当前 Hexo 输出的静态文件名不含 content hash（如 `style.css` 而非 `style.a3f2b1.css`），这意味着如果 Edge TTL 设为 7 天，更新部署后访客可能在 7 天内仍拿到旧 CSS。

**短期缓解**（不改代码）：

- CSS/JS 的 Edge TTL 设为 7 天已经合理，因为站点更新频率不高
- 每次部署后如果需要立即生效，可以在 Cloudflare Dashboard → Caching → Purge Everything 手动清缓存
- 或者在 `deploy-pages.yml` 部署成功后，通过 Cloudflare API 自动 Purge Cache：

```yaml
# deploy-pages.yml 末尾新增 step
- name: Purge Cloudflare cache
  if: success()
  env:
    CF_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
    CF_ZONE_ID: ${{ secrets.CLOUDFLARE_ZONE_ID }}
  run: |
    curl -s -X POST "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/purge_cache" \
      -H "Authorization: Bearer ${CF_API_TOKEN}" \
      -H "Content-Type: application/json" \
      --data '{"purge_everything":true}'
```

**长期方案**（需要改 Hexo 构建配置）：

- 给 CSS/JS 文件名添加 content hash，实现精确缓存失效
- 这属于前端构建优化范畴，不在本方案 v1 范围内

### 3.7 Cloudflare Zone ID 配置

如果选择 3.6 的自动 Purge 方案，需要获取 Zone ID：

- 路径：Cloudflare Dashboard → `soulgo.chat` → Overview → 右侧 API 区域
- 将 Zone ID 添加到 GitHub Secrets: `CLOUDFLARE_ZONE_ID`
- 确保 `CLOUDFLARE_API_TOKEN` 有 Zone → Cache Purge → Purge 权限

---

## 4. 配置检查清单

按顺序操作，每步完成后打勾：

- [ ] **DNS 记录**：删除旧 A 记录，添加 CNAME `@` → `soulgo.github.io`，开启橙云代理
- [ ] **SSL/TLS 模式**：设为 Full (Strict)
- [ ] **Always Use HTTPS**：开启
- [ ] **Auto Minify**：JS + CSS + HTML 全部开启
- [ ] **Brotli**：开启
- [ ] **HTTP/3 (QUIC)**：开启
- [ ] **0-RTT**：开启
- [ ] **Early Hints**：开启
- [ ] **Cache Rule 1**：字体 1 年
- [ ] **Cache Rule 2**：图片 30 天
- [ ] **Cache Rule 3**：CSS/JS 7 天
- [ ] **Cache Rule 4**：HTML 5 分钟 + stale-while-revalidate
- [ ] **Cache Rule 5**：排除 API/well-known 路径
- [ ] **Page Rule**：Cache Everything + Always Online
- [ ] **Transform Rule**：安全响应头（可选）
- [ ] **验证**：访问 `https://soulgo.chat` 确认页面正常加载

---

## 5. 验证方法

### 5.1 确认代理生效

```bash
curl -sI https://soulgo.chat | head -20
```

**期望看到**：

```
server: cloudflare              ← 不再是 GitHub.com
cf-ray: xxxxx-xxx               ← Cloudflare 节点信息
cf-cache-status: HIT/MISS       ← Cloudflare 缓存状态
```

### 5.2 检查缓存命中

```bash
# 首次访问（MISS）
curl -sI https://soulgo.chat/css/style.css | grep cf-cache-status
# cf-cache-status: MISS

# 第二次访问（HIT）
curl -sI https://soulgo.chat/css/style.css | grep cf-cache-status
# cf-cache-status: HIT
```

### 5.3 检查压缩

```bash
curl -sI https://soulgo.chat/css/style.css \
  -H "Accept-Encoding: br,gzip" | grep content-encoding
# content-encoding: br   ← Brotli 压缩
```

### 5.4 检查 HTTP/3

```bash
curl -sI --http3 https://soulgo.chat | head -5
# HTTP/3 200
```

### 5.5 对比加载速度

使用浏览器开发者工具 Network 面板，或在线测速工具：

- 对比开启前后的 TTFB（首字节时间）
- 对比开启前后的总加载时间
- 关注 `cf-cache-status` 从 MISS 变为 HIT 后的提速

### 5.6 全球可达性测试

- [Cloudflare Speed Test](https://speed.cloudflare.com/)
- [WebPageTest](https://www.webpagetest.org/) — 选多个地区测试

---

## 6. 预期效果

| 指标 | 优化前（Fastly 直连） | 优化后（Cloudflare 代理） |
|------|---------------------|------------------------|
| TTFB（亚洲） | ~200-500ms | ~50-150ms（Cloudflare 亚太节点更近） |
| 首次加载（HTML） | ~46KB 未压缩 | ~12-15KB（Brotli） |
| CSS 传输 | ~原始大小 | ~压缩后 60-70% 体积 |
| 回访加载 | 10 分钟缓存过期后重新回源 | 7-30 天命中边缘缓存，毫秒级 |
| 连接建立 | TCP + TLS ~200ms | HTTP/3 0-RTT，回访接近 0ms |
| 可用性 | GitHub Pages 宕机 = 不可用 | Always Online 展示缓存 |
| 中国大陆 | Fastly 新加坡，可能较慢 | Cloudflare 有亚洲多节点（但免费版不含中国节点） |

> **关于中国大陆**：Cloudflare 免费版不含中国大陆节点（需企业版 + 合作 CDN）。但对于非大陆用户，Cloudflare 的亚太节点（东京、新加坡、悉尼）通常比 GitHub Pages 的 Fastly 覆盖更好。如果需要优化大陆访问速度，需要考虑接入国内 CDN 或 Cloudflare 企业版。

---

## 7. 注意事项与兼容性

### 7.1 Telegram Worker 不受影响

Cloudflare Worker (`telegram-sync-dispatch`) 部署在独立的 `workers.dev` 子域，与 `soulgo.chat` 的 DNS 代理互不干扰。开启代理后 Worker 的 webhook 功能完全不受影响。

### 7.2 GitHub Pages CNAME 文件

`source/CNAME` 中的 `soulgo.chat` 保持不变。GitHub Pages 需要这个文件来接受自定义域名请求。即使 Cloudflare 代理后回源，GitHub Pages 仍然根据 CNAME 文件识别域名。

### 7.3 SSL 证书

- Cloudflare 会自动为 `soulgo.chat` 签发边缘证书（Universal SSL）
- 回源使用 GitHub Pages 的 Let's Encrypt 证书
- Full (Strict) 模式下两层证书都会被校验，安全性最高

### 7.4 部署后缓存更新

每次 GitHub Pages 部署新版本后：

- **手动方式**：Cloudflare Dashboard → Caching → Purge Everything
- **自动方式**：在 `deploy-pages.yml` 末尾加 Cloudflare Purge API 调用（见 3.6）
- **不操作**：等 Edge TTL 自然过期（HTML 最多 10 分钟，CSS/JS 最多 7 天）

### 7.5 回滚

如果出现问题，回滚只需一步：

Cloudflare Dashboard → DNS → 将 CNAME 记录的代理状态切回 **DNS only（灰云）**

1 分钟内 DNS 生效，流量直接回 GitHub Pages Fastly CDN，与优化前完全一致。

---

## 8. 未来可选优化（不在本方案范围）

| 方向 | 说明 | 前置条件 |
|------|------|---------|
| CSS/JS content hash | 文件名含 hash，实现精确缓存失效 | 改 Hexo 构建配置 |
| 图片自动 WebP/AVIF 转换 | Cloudflare Polish/Mirage（Pro 版 $20/月） | Cloudflare 付费版 |
| 迁移到 Cloudflare Pages | 完全在 Cloudflare 边缘部署，消除回源延迟 | 改部署 workflow |
| Service Worker 离线缓存 | 浏览器端缓存策略，离线可用 | 新增 SW 代码 |
| Argo Smart Routing | 智能路由优化回源路径（$5/月起） | Cloudflare 付费功能 |
| 中国大陆加速 | 企业版 + 京东云/百度云合作 CDN | Cloudflare 企业版 |
