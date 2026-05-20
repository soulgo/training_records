# 冗余目录与文件清理建议

本文档记录系统按 `docs/re_optimization/` 完成优化后的冗余文件清理结论。目标是区分“可以从源码维护面删除的内容”和“只是本地生成物/运行时痕迹的内容”，避免后续维护人员误把缓存、产物或历史计划稿当成业务事实源。

## 当前结论

重构完成后，仓库里真正值得从源码维护面删除的内容不多。当前最明确的源码冗余是一个薄 CLI 包装器和一份历史重构计划稿；其余大部分可见的“多余文件”其实是构建产物、运行时状态或本地工具缓存，适合清理，但不应当作业务源码处理。

## 已建议删除

- `tools/backfill-thoughts-to-core-cli.mjs`
  - 原因：它只是给 `tools/backfill-thoughts-to-core.mjs` 做了一层薄包装；主模块本身已经带 CLI 入口，可以直接被 `node tools/backfill-thoughts-to-core.mjs` 执行。
  - 配套调整：`package.json` 的 `backfill:thoughts` 应直接指向 `tools/backfill-thoughts-to-core.mjs`。
  - 删除风险：低。需要用测试确认 `npm run backfill:thoughts` 仍能正常返回。

- `docs/re_optimization/re_optimization_prompt.md`
  - 原因：这是历史实施计划稿，不参与运行时、测试或当前维护链路。
  - 当前事实源：系统重构现状、约束和模块职责已经由 `docs/re_optimization/re_optimization.md` 承担。
  - 删除风险：低。如果团队想保留历史规划，更适合归档到 archive，而不是继续放在 active docs 目录。

## 建议清理但保留生成能力

以下内容属于缓存、站点构建产物、调试产物、运行时状态或本地工具痕迹。它们不应作为业务源码维护，需要时可以由构建、同步或调试流程重新生成。

- `db.json`
- `public/`
- `source/_data/training.json`
- `source/_data/dashboardView.json`
- `训练数据解析.md`
- `runtime/training-db-sync.ndjson`
- `runtime/telegram-sync-pending.ndjson`
- `telegram/state.json`
- `telegram/process-log.ndjson`
- `.alma-snapshots/`
- `.playwright-mcp/`
- `.claude/`
- `.tmp/`

当前 `.gitignore` 已经覆盖这些路径。后续如果某个环境重新生成这些文件，维护人员不需要提交它们。

## 不建议删除

- `telegram/inbox/`
  - 原因：它是 Telegram 运行时 inbox 的占位目录；保留 `.gitkeep` 可以让目录结构更清晰。

- `source/_posts/`
  - 原因：当前 `/thought` 仍写入这里作为 Markdown 兼容层，且页面和测试都依赖该目录中的随想文章。

- `source/images/thoughts/`
  - 原因：当前 `/thought` 图片仍保存为本地文件，数据库只保存引用，不保存图片二进制。

- `prompts/_source/`
  - 原因：这是图片识别 prompt 与 `/analysis` prompt 的结构化单一事实来源，不能删除。

- `themes/cactus` 下的大型第三方资源
  - 原因：目前没有足够证据证明这些主题资源是死资产。Hexo 主题、样式、字体、脚本和页面模板仍参与站点构建。

## 后续维护规则

- 不要把 `public/`、`source/_data/*.json`、`db.json`、`训练数据解析.md`、`runtime/*.ndjson` 当成源码改动提交。
- 如果要调整训练数据展示，优先改 `tools/generate-training-data.mjs`、`tools/dashboard-view.mjs`、主题模板或样式，再通过构建重新生成产物。
- 如果要调整 prompt 规则，优先改 `prompts/_source/`，再运行 `node tools/prompt-generator.mjs` 生成运行时 prompt。
- 如果要调整 `/thought` 行为，不能删除 `source/_posts/` 或 `source/images/thoughts/`，需要同步修改实现、文档和测试。

## 验证建议

完成清理后至少执行：

```bash
npm run backfill:thoughts
npm test
npm run build
```

预期结果：

- `npm run backfill:thoughts` 可以直接通过 `tools/backfill-thoughts-to-core.mjs` 执行。
- `npm test` 全部通过。
- `npm run build` 可以重新生成 `source/_data/training.json`、`source/_data/dashboardView.json`、`训练数据解析.md` 和 `public/`。
