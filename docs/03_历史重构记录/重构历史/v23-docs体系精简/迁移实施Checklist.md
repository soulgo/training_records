# 迁移实施 Checklist

## 使用规则

- 本 checklist 用于后续迁移，不要求本次审查立即执行。
- 每一步都必须先合并吸收事实，再删除旧文件。
- 不修改代码、SQL、workflow、prompt 或运行逻辑。
- 每次迁移后运行文档链接检查和 `git diff --check`。

## Phase 0：冻结边界

- [ ] 确认本次迁移只处理 `docs/`。
- [ ] 确认 `docs/归档/` 不作为当前事实源。
- [ ] 确认迁移前主文档清单。
- [ ] 确认迁移目标目录不超过 3 层。
- [ ] 确认删除前必须能指出目标吸收文档。

## Phase 1：建立目标主文档

- [ ] 创建或重命名 `docs/总览/系统导览.md`。
- [ ] 创建或重命名 `docs/核心业务/核心业务.md`。
- [ ] 创建或重命名 `docs/消息链路/消息链路.md`。
- [ ] 创建或重命名 `docs/AI识别体系/AI识别体系.md`。
- [ ] 创建或重命名 `docs/数据模型/数据模型.md`。
- [ ] 创建或重命名 `docs/数据模型/查询手册.md`。
- [ ] 创建或重命名 `docs/开发指南/开发指南.md`。
- [ ] 创建或重命名 `docs/部署运维/部署运维.md`。
- [ ] 创建或重命名 `docs/运维手册/运维手册.md`。
- [ ] 创建或重命名 `docs/故障排查/故障排查.md`。
- [ ] 创建或重命名 `docs/参考资料/参考资料.md`。
- [ ] 合并 `docs/AI-Agent/` 到单个 `README.md`。

## Phase 2：按主题合并事实

### 总览

- [ ] 吸收 `总览/系统导览.md`。
- [ ] 吸收 `总览/系统上下文.md`。
- [ ] 吸收 `总览/系统导览.md`。
- [ ] 吸收 `总览/系统导览.md`。
- [ ] 确认系统价值、当前事实源、不可破坏能力、阅读路径都存在。

### 架构

- [ ] 吸收 `架构/六边形架构.md`。
- [ ] 吸收 `架构/消息同步架构.md` 的架构摘要。
- [ ] 吸收 `架构/Markdown与静态站点.md` 的架构边界。
- [ ] 将 `架构/数据源策略.md` 移入数据模型主文档。
- [ ] 保留 ADR 文件和索引。

### 核心业务

- [ ] 吸收训练数据。
- [ ] 吸收饮食数据。
- [ ] 吸收体脂秤数据。
- [ ] 吸收睡眠数据。
- [ ] 吸收随想系统。
- [ ] 吸收分析系统。
- [ ] 确认每类业务都有输入、处理、落表、失败边界。

### 消息链路

- [ ] 吸收 Telegram 通道。
- [ ] 吸收飞书通道。
- [ ] 吸收双通道一致性。
- [ ] 吸收 Cloudflare Workers。
- [ ] 吸收调度队列与 GitHub Actions。
- [ ] 吸收失败状态与重试。
- [ ] 吸收 Markdown 备份链路。
- [ ] 确认通道差异和业务一致性没有混写。

### AI 识别体系

- [ ] 吸收图片分类。
- [ ] 吸收识别 Schema。
- [ ] 吸收 Prompt 体系。
- [ ] 吸收 Provider 与 Fallback。
- [ ] 吸收 AI 主备容灾演练。
- [ ] 吸收 AI 可观测性。
- [ ] 吸收分析 AI。
- [ ] 保留字段映射文档链接。

### 数据模型

- [ ] 吸收 Schema 总览。
- [ ] 吸收 core 层。
- [ ] 吸收 ingest 层。
- [ ] 吸收 archive 层。
- [ ] 吸收数据生命周期。
- [ ] 吸收幂等与事务。
- [ ] 吸收迁移与回滚。
- [ ] 保留图片识别字段映射。
- [ ] 将索引与查询手册改为查询手册。

### 开发、部署、运维、故障、参考

- [ ] 合并开发指南所有短文档。
- [ ] 合并部署运维所有短文档。
- [ ] 合并运维手册所有短文档。
- [ ] 合并故障排查所有短文档。
- [ ] 合并参考资料所有查表文档。

## Phase 3：删除或归档旧文件

- [ ] 删除已吸收的目录 README。
- [ ] 删除已吸收的短专题文档。
- [ ] 将需要保留原貌的迁移前文件快照放入 `docs/归档/`。
- [ ] 确认 `docs/归档/` 中不新增当前事实。
- [ ] 确认根 README 不再链接已删除文件。

## Phase 4：链接与入口修复

- [ ] 更新 `docs/README.md` 的 10 分钟路径。
- [ ] 更新根 `README.md` 中的 docs 链接。
- [ ] 更新 `AI-Agent/README.md` 任务路由。
- [ ] 更新所有相对链接。
- [ ] 检查是否仍存在指向被删除短文档的链接。

## Phase 5：验证

运行：

```bash
node <<'NODE'
const fs = require('fs');
const path = require('path');
function walk(dir){const out=[]; for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name); if(e.isDirectory()) out.push(...walk(p)); else if(e.isFile()&&p.endsWith('.md')) out.push(p);} return out;}
const files=walk('docs').filter(f=>!f.startsWith('docs/归档/'));
let bad=[];
for(const f of files){const text=fs.readFileSync(f,'utf8'); const re=/\[[^\]]*\]\(([^)]+)\)/g; let m; while((m=re.exec(text))){let target=m[1].split('#')[0]; if(!target||/^[a-z]+:/.test(target)||target.startsWith('mailto:')) continue; const resolved=path.normalize(path.join(path.dirname(f),decodeURI(target))); const candidates=[resolved,resolved+'.md',path.join(resolved,'README.md')]; if(!candidates.some(c=>fs.existsSync(c))) bad.push(`${f}: missing ${m[1]}`);}}
if(bad.length){console.log(bad.join('\n')); process.exit(1);} console.log(`checked ${files.length} markdown files; links ok`);
NODE
```

再运行：

```bash
git diff --check
```

## Phase 6：验收标准

- [ ] 主文档数量收敛到 15 到 18 个。
- [ ] 每个主题只有一个主文档。
- [ ] 每个主文档读者明确。
- [ ] 新人 30 分钟路径不超过 8 个主文档。
- [ ] AI Agent 基础路径不超过 6 个主文档。
- [ ] `core.*`、Markdown 派生、双通道一致性、AI 校验边界、pending replay、Action success 不等于业务成功等关键事实没有丢失。
- [ ] 归档目录不作为当前事实入口。
- [ ] 链接检查通过。
- [ ] `git diff --check` 通过。

