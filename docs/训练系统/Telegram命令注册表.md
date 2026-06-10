# Telegram 命令注册表

这份文档说明 Telegram 命令声明式注册表的当前边界。它是内部扩展点，不改变 Telegram 协议、命令 alias、batch shape 或同步默认行为。

## 1. 默认行为

- 注册表实现：`src/telegram/command-registry.mjs`
- 路由消费方：`tools/telegram-sync-lib.mjs`
- 默认无 feature flag，始终按现有命令语义运行
- 未新增 GitHub Variables、Secrets、Cloudflare 配置或 npm scripts
- `groupTelegramUpdates(updates, options)` 的输出 batch 顶层字段保持不变

当前优先级固定为：

1. `help`
2. `move`
3. `delete`
4. `analysis`
5. `explicit_edit`
6. `edited_message`
7. `reply_edit`
8. `thought`
9. `image`

## 2. 现有 alias

| 命令组 | alias |
| --- | --- |
| `help` | `/help`、`/帮助`、`help`、`帮助`、`命令`、`指令`、`使用说明` |
| `move` | `/move`、`/移动`、`/thought`、`/随想` |
| `delete` | `/thought-delete`、`/thoughtdel`、`/delete-thought`、`/删随想`、`/随想删` |
| `analysis` | `/analysis`、`/分析` |
| `explicit_edit` | `/thought-edit`、`/thoughtedit`、`/edit-thought`、`/编随想`、`/随想编` |
| `thought` | `/thought`、`/随想` |

`edited_message`、`reply_edit` 和 `image` 不是显式文本 alias，而是保留在同一优先级队列里，方便后续新增命令时统一判断顺序。

## 3. 兼容策略

- `move` 必须排在 `thought` 前面，保证 `/随想 <id> <模块>` 继续按移动处理。
- `help` 必须最先处理，避免帮助消息被其它文本分支误消费。
- `analysis` 是不写数据的直接回复分支。
- `explicit_edit` 必须排在相册图片归组前面，保证单图 caption 的编辑命令仍可替换图片。
- `edited_message` 和 `reply_edit` 必须排在 `thought` 前面，保证已知随想的编辑不会被识别成新随想。
- 图片和相册仍由原分组逻辑处理，registry 只声明其优先级位置。

## 4. Rollback

回滚成本低：

1. 删除 `src/telegram/command-registry.mjs`
2. 将 `tools/telegram-sync-lib.mjs` 的 `groupTelegramUpdates` 恢复为原 if/else 顺序
3. 移除 registry 相关测试和文档说明

不需要数据库 migration，不需要改 GitHub Actions，不需要改 Cloudflare Worker。

## 5. 验证

最低验证命令：

```bash
node --test test/telegram-sync.test.mjs test/telegram-sync-runner.test.mjs
```

这组测试覆盖 command alias、priority、batch 顶层 shape、Telegram 同步 runner 和 fallback 行为。

风险等级：低到中。主要风险是命令优先级误调，当前由 registry 顺序断言和 batch shape 测试保护。
