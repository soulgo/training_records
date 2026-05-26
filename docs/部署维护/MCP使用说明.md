# MCP 使用说明

本文说明如何把当前训练记录系统作为本地 MCP Server 接入 AI Agent。当前 MCP v1 只开放只读查询和训练分析能力，不会写 `训练记录.md`、PostgreSQL、Telegram 或 GitHub Pages。

## 启动方式

在项目根目录运行：

```bash
npm run mcp:server
```

该命令会启动 `src/mcp/server.mjs`，通过 stdio 接收 JSON-RPC 请求。它适合被支持 MCP stdio 的 Agent 客户端直接拉起，而不是作为 HTTP 服务长期监听端口。

## 客户端配置示例

将 MCP 客户端的 command 指向 Node，args 指向本项目的 server 文件：

```json
{
  "mcpServers": {
    "training-records": {
      "command": "node",
      "args": [
        "C:/Users/ljq90/Desktop/project_test/健身锻炼/src/mcp/server.mjs"
      ],
      "env": {
        "TRAINING_SNAPSHOT_SOURCE": "markdown"
      }
    }
  }
}
```

如果需要从 PostgreSQL 读取，需要在客户端环境变量中配置现有数据库变量：

```json
{
  "TRAINING_SNAPSHOT_SOURCE": "database",
  "TRAINING_DB_ENABLED": "true",
  "TRAINING_DB_URL": "<postgres-connection-string>",
  "TRAINING_DB_TIMEOUT_MS": "3000"
}
```

不要把 `TRAINING_DB_URL`、`AI_API_KEY`、`TELEGRAM_BOT_TOKEN` 写入会提交到仓库的配置文件。

## 可用 Tool

| Tool | 用途 |
| --- | --- |
| `training.get_snapshot` | 获取统一 `TrainingSnapshot`，支持日期窗口 |
| `training.get_daily_records` | 获取每日记录，可按 `measurement`、`activities`、`nutrition` 等类型投影 |
| `training.get_latest_status` | 获取最新体脂、最新训练日和最近身体反馈 |
| `training.get_measurements` | 获取体重、体脂、骨骼肌等体脂秤记录 |
| `training.get_activities` | 获取训练活动，可按活动类型过滤 |
| `training.get_nutrition` | 获取饮食和热量记录 |
| `training.get_body_feedback` | 获取身体反馈随想，可按关键词过滤 |
| `training.get_dashboard_view` | 获取首页 dashboard view model |
| `training.get_chart_data` | 获取图表序列 |
| `training.get_analysis_summary` | 获取训练分析结构化摘要 |
| `training.generate_analysis` | 调用 AI 生成训练建议，并返回 `reply`、`summary`、`focus` |
| `training.search_records` | 搜索训练 Markdown 和 Telegram 随想 |
| `training.get_markdown_record` | 获取从快照派生的只读 Markdown |
| `training.get_config` | 获取脱敏后的运行配置 |
| `training.get_prompt_metadata` | 获取识别或分析 prompt metadata |
| `runtime.get_sync_status` | 获取待补偿队列和归档失败计数 |
| `telegram.get_command_registry` | 获取 Telegram 命令 alias 和优先级 |

## 常用调用参数

通用参数：

```json
{
  "source": "markdown",
  "date_from": "2026-05-01",
  "date_to": "2026-05-26",
  "limit": 20
}
```

说明：

- `source` 可选 `auto`、`markdown`、`database`，默认 `auto`。
- 日期格式必须是 `YYYY-MM-DD`。
- 默认最大日期范围为 366 天，可用 `MCP_MAX_DATE_RANGE_DAYS` 调整。
- `training.generate_analysis` 需要配置 `AI_API_KEY`、`AI_BASE_URL`、`AI_MODEL`。

## 返回结构

所有 Tool 返回统一 envelope：

```json
{
  "success": true,
  "trace_id": "mcp_20260526_abcd1234",
  "data": {},
  "error": null,
  "meta": {
    "source": "markdown",
    "generated_at": "2026-05-26T00:00:00.000Z",
    "cache": "miss",
    "duration_ms": 32
  }
}
```

失败时：

```json
{
  "success": false,
  "trace_id": "mcp_20260526_abcd1234",
  "data": null,
  "error": {
    "code": "INVALID_ARGUMENT",
    "message": "date_from must be YYYY-MM-DD",
    "retryable": false,
    "details": {}
  },
  "meta": {
    "duration_ms": 1
  }
}
```

## 限制 Tool 范围

可以用 `MCP_ALLOWED_TOOLS` 限制可调用工具：

```bash
MCP_ALLOWED_TOOLS=training.get_snapshot,training.get_config npm run mcp:server
```

当前 v1 没有实现写入类 Tool。以下能力仍应通过现有命令或 GitHub Actions 使用：

- Telegram 同步：`npm run sync:telegram`
- Markdown 导入数据库：`npm run import:markdown`
- 数据生成和站点构建：`npm run build`
- GitHub Pages 部署：`.github/actions/site-build/action.yml`

## 本地调试

可以直接向 stdio server 发送 JSON-RPC 行：

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"training.get_latest_status","arguments":{"source":"markdown"}}}
```

推荐验证命令：

```bash
node --test test/mcp-tools.test.mjs test/mcp-server.test.mjs
npm test
```
