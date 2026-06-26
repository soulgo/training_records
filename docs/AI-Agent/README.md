# AI Agent 入口

本文是 AI Agent 接手项目时的事实边界、任务路由、安全边界和验证命令入口。


## AI Agent 入口

本目录面向接手项目维护的 AI Agent。它只描述任务路由、事实边界和验证方式，不替代架构、业务、部署或故障排查文档。

## 先读顺序

1. [事实与不变量](#事实与不变量)
2. [任务路由](#任务路由)
3. [安全改动边界](#安全改动边界)
4. [验证命令](#验证命令)

## 使用规则

- 当前事实以代码、SQL、workflow、prompt source 和正式 docs 为准。
- `归档/` 只用于追溯历史，不作为当前行为依据。
- 文档整理不得修改运行逻辑。
- 修改代码、SQL、workflow 或 prompt 时，必须同步更新对应正式文档。


## 事实与不变量

## 当前事实源

- PostgreSQL `core.*` 是训练、饮食、体脂、睡眠、随想和分析读取的事实源。
- Markdown 和 `source/_posts` 是数据库派生备份或静态站点内容。
- Telegram 和飞书是消息通道，不是业务边界。
- Cloudflare Worker 只做入口校验、帮助回复和 GitHub dispatch。
- GitHub Actions 负责同步、构建、备份和部署。
- 随想图片引用保存在 `core.thought.image_refs_json`；启用 COS 时为腾讯云 COS 公有读 URL，未启用时为本地 `/images/thoughts/...`。
- 图片识别 schema 位于 `src/core/ai/telegram-recognition-schema.mjs`。
- Prompt 生成结果是 `prompts/telegram-training-image-recognition.md` 和 `prompts/training-analysis.md`。

## 不变量

- AI 输出必须经过 schema、置信度、日期和业务规则校验后才可入库。
- 数据库写入失败时应进入 pending 队列，等待恢复后重放。
- `/分析` 只读取数据并回发建议，不写入训练事实。
- `训练记录.md` 不应被当作正常图片同步成功路径的即时写入目标。
- `归档/` 不维护当前事实。
- Cloudflare Worker 不接触 COS Secret；COS 上传只发生在 GitHub Actions 同步 workflow 的图片存储边界。
- Telegram 和飞书核心业务语义必须一致；平台差异只能停留在 webhook、附件、消息格式、文件下载和回执层。


## 任务路由

## 文档任务

- docs 体系、入口、命名、归档规则：先读 [文档总览](../README.md)。
- 架构事实：读 [系统架构](../架构/系统架构.md) 和 [架构决策记录](../架构/架构决策记录/README.md)。
- 业务规则：读 [核心业务](../核心业务/核心业务.md)。

## 代码任务

- 先读 [项目结构](../开发指南/开发指南.md#项目结构) 和 [核心模块](../开发指南/开发指南.md#核心模块)。
- 涉及消息同步时读 [消息链路](../消息链路/消息链路.md)。
- 涉及 Telegram/飞书一致性时读 [双通道一致性](../消息链路/消息链路.md#双通道一致性)。
- 涉及 AI 识别时读 [AI 识别体系](../AI识别体系/AI识别体系.md)。
- 涉及 AI fallback 时读 [AI 主备容灾演练](../AI识别体系/AI识别体系.md#ai-主备容灾演练)。
- 涉及数据库时读 [数据模型](../数据模型/数据模型.md) 和 [图片识别字段映射](../数据模型/图片识别字段映射.md)。
- 涉及随想图片存储时读 [系统行为手册](../总览/系统行为手册.md#图片附件)、[部署运维](../部署运维/部署运维.md#腾讯云-cos-图片存储) 和 [故障排查](../故障排查/故障排查.md#图片存储异常)。
- 涉及验收时读 [端到端验收标准](../开发指南/开发指南.md#端到端验收标准)。

## 运维任务

- 部署配置读 [部署运维](../部署运维/部署运维.md)。
- 日常处理读 [运维手册](../运维手册/运维手册.md)。
- 异常处理读 [故障排查](../故障排查/故障排查.md)。
- 数据恢复读 [数据恢复](../运维手册/运维手册.md#数据恢复) 和 [索引与查询手册](../数据模型/查询手册.md)。


## 安全改动边界

## 允许直接整理

- 修正文档链接、目录索引和过期入口。
- 归档历史方案，并在正式文档中保留当前事实。
- 补充只描述现状的开发、运维、排障说明。

## 需要验证后修改

- SQL schema、迁移和回滚路径。
- Telegram、飞书、Cloudflare、GitHub Actions 链路。
- AI prompt、schema、provider fallback 和置信度规则。
- Markdown 导入导出和 pending replay。

## 不应顺手修改

- 生产 secret、平台控制台配置和线上数据库状态。
- 与当前任务无关的运行逻辑。
- `归档/` 中的历史文档内容。


## 验证命令

## 文档链接

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

## 常规检查

```bash
git diff --check
npm test
npm run build:data
npm run build
```
