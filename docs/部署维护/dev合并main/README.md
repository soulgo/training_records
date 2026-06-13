# Dev 合并 Main 操作手册

本文用于把 `dev` 分支的代码合并到 `main`，同时保持 `main` 作为生产环境代码分支的洁净状态。核心原则是：合代码与配套维护文件，不合并 dev 环境产生的数据、备份和站点派生产物。

## 1. 合并目标

允许从 `dev` 合入 `main` 的内容：

- 源码：`src/**`、`tools/**`、站点模板、前端脚本、运行时代码。
- 配置：`package.json`、`package-lock.json`、`_config.yml`、Wrangler、Hexo、Node 配置。
- GitHub Actions：`.github/workflows/**`、`.github/actions/**`。
- 数据库结构与迁移脚本：`sql/**`。
- Prompt 与 AI schema：`prompts/**` 及相关测试。
- 测试：`test/**`。
- 必要文档：`docs/**`、`CHANGELOG.md`、README 类维护说明。

禁止从 `dev` 合入 `main` 的内容：

- `训练记录.md`
- `source/_data/**`
- `source/_posts/*-telegram-thought-*.md`
- `source/images/thoughts/**`

这些路径属于生产数据、Hexo 构建数据或 Telegram 备份产物。它们应由生产数据库、生产同步或生产构建流程生成，不能被 dev 分支覆盖。

## 2. 关键背景

`source/_data/**` 是 Hexo 站点构建读取的派生 JSON 数据，不是手写代码。常见文件包括：

- `source/_data/training.json`
- `source/_data/dashboardView.json`
- `source/_data/body-metrics.json`

这些文件会由数据库快照或构建脚本生成。`npm test`、`npm run build` 等命令可能只改动其中的 `generatedAt` 或派生内容。合并后如果这些文件变脏，一般应恢复，不应提交到 `main`。

当前 `npm run merge:dev-to-main` 会保护部分派生数据路径，但截至本文记录，它不会自动保护 `source/_data/**`。因此合并后必须额外执行本文的严格数据保护校验。

## 3. 合并前检查

确认本地没有未提交改动：

```bash
git status --short --branch
```

同步远端 `main` 和 `dev`：

```bash
git fetch origin main dev
```

切到 `main` 并对齐远端：

```bash
git switch main
git merge --ff-only origin/main
```

如果 `--ff-only` 失败，说明远端或本地历史不满足快速前进条件。此时不要继续合并，先确认分支状态。

## 4. 执行合并

使用仓库内置工具合并：

```bash
npm run merge:dev-to-main -- --source origin/dev --target main --message "合并 dev 到 main，保留 main 生产数据"
```

合并完成后确认 merge commit 是双父提交：

```bash
git show --no-patch --format='%H%n%P%n%s' HEAD
```

输出第二行应包含两个父提交：第一个是合并前 `main`，第二个是 `dev`。

## 5. 严格恢复受保护数据

合并工具完成后，立刻把受保护数据路径恢复到 merge 前 `main` 的内容，并删除 dev 新增的受保护数据文件：

```bash
node --input-type=module <<'NODE'
import { execFileSync } from 'node:child_process';

const mainParent = execFileSync('git', ['rev-parse', 'HEAD^1'], { encoding: 'utf8' }).trim();
const gitLines = (args) => {
  const out = execFileSync('git', ['-c', 'core.quotePath=false', ...args], { encoding: 'utf8' }).trim();
  return out ? out.split(/\r?\n/u).filter(Boolean) : [];
};

const mainFiles = new Set(
  gitLines(['ls-tree', '-r', '--name-only', mainParent, '--', '训练记录.md', 'source/_posts', 'source/images/thoughts', 'source/_data']),
);
const currentFiles = new Set(
  gitLines(['ls-files', '--', '训练记录.md', 'source/_posts', 'source/images/thoughts', 'source/_data']),
);

const telegramThoughtPostRe = /^source\/_posts\/[^/]*-telegram-thought-\d+\.md$/u;
const isProtectedDataPath = (filePath) =>
  filePath === '训练记录.md' ||
  filePath.startsWith('source/_data/') ||
  filePath.startsWith('source/images/thoughts/') ||
  telegramThoughtPostRe.test(filePath);

const restore = [...mainFiles].filter(isProtectedDataPath).sort();
const remove = [...currentFiles].filter((filePath) => isProtectedDataPath(filePath) && !mainFiles.has(filePath)).sort();

if (restore.length > 0) execFileSync('git', ['checkout', mainParent, '--', ...restore], { stdio: 'inherit' });
if (remove.length > 0) execFileSync('git', ['rm', '-f', '--ignore-unmatch', '--', ...remove], { stdio: 'inherit' });
if (restore.length > 0 || remove.length > 0) execFileSync('git', ['add', '--', ...restore, ...remove], { stdio: 'inherit' });

console.log(JSON.stringify({ mainParent, restored: restore.length, removed: remove.length }, null, 2));
NODE

if ! git diff --cached --quiet; then
  git commit --amend --no-edit
fi
```

这一步的语义是：保留 merge commit 的双父历史，但把生产数据相关路径修正为 merge 前 `main` 的状态。

## 6. 数据保护验收

受保护路径相对 merge 前 `main` 必须是 0 diff：

```bash
git diff --name-only HEAD^1 HEAD -- '训练记录.md' source/_data source/images/thoughts
git diff --name-only HEAD^1 HEAD -- source/_posts | rg 'source/_posts/[^/]*-telegram-thought-[0-9]+\.md'
```

以上两条命令都不应输出任何文件。第二条命令没有匹配时 `rg` 会返回退出码 1，这是正常的；重点是没有文件名输出。

查看本次真正合入的代码/配置/文档范围：

```bash
git diff --name-only HEAD^1 HEAD
```

如果看到 `训练记录.md`、`source/_data/**`、Telegram thought 备份文章或 `source/images/thoughts/**`，不要推送，先回到第 5 步修正。

## 7. 测试与清理

先运行合并相关的重点测试：

```bash
node --test test/derived-data-merge.test.mjs test/github-workflows.test.mjs test/telegram-sync-notify.test.mjs
```

再运行完整测试：

```bash
npm test
```

测试后检查是否产生 `_data` 噪音：

```bash
git status --short --branch
git diff --name-only -- source/_data
```

如果只有 `_data` JSON 被测试改动，恢复它们：

```bash
git restore -- source/_data/body-metrics.json source/_data/dashboardView.json source/_data/training.json
```

再次确认工作区干净：

```bash
git status --short --branch
```

## 8. 推送与线上验证

推送前再确认远端 `main` 没有前进：

```bash
git fetch origin main
git merge-base --is-ancestor origin/main HEAD
```

如果命令成功返回，说明当前 HEAD 包含远端 `main`，可以推送：

```bash
git push origin main
```

推送后确认远端 `main` 等于本地 HEAD：

```bash
git ls-remote origin refs/heads/main
git rev-parse HEAD
```

查看 GitHub Actions：

```bash
gh run list --repo soulgo/training_records --branch main --limit 8 --json databaseId,workflowName,status,conclusion,headSha,createdAt,event,url
```

至少确认：

- `CI Tests` 成功。
- `Deploy Cloudflare Worker` 如被触发，应成功。
- `Deploy GitHub Pages` 如被触发，应成功。

如果当前提交只改了测试或文档，Pages workflow 可能不会被 push path filter 触发。需要验证生产 Pages 构建时，可以手动触发：

```bash
gh workflow run "Deploy GitHub Pages" --repo soulgo/training_records --ref main -f strict_database_snapshot=false
```

然后等待结果：

```bash
gh run watch <run_id> --repo soulgo/training_records --exit-status
```

## 9. 失败处理原则

- 非数据路径冲突：停止，不推送，人工阅读冲突后再解决。
- 数据保护校验有输出：停止，不推送，重新执行严格恢复。
- 测试失败：停止，不推送；如果已经推送了合并 commit，再用后续修复提交把 `main` 修绿。
- GitHub Pages 失败：先看 `gh run view <run_id> --log-failed`。如果是测试环境变量污染，优先修测试隔离；如果是生产数据库快照问题，先修数据库或构建配置。
- 不要用 `git reset --hard` 或强推处理生产分支，除非已经明确决定回滚策略。

## 10. 合并记录模板

每次合并完成后，建议在工作记录或 PR/commit 说明里记录：

```text
合并来源：origin/dev@<sha>
合并目标：main@<sha-before>
合并提交：<merge-sha>
数据保护：训练记录.md/source/_data/source/_posts telegram thought/source/images/thoughts 均 0 diff
验证：
- node --test test/derived-data-merge.test.mjs test/github-workflows.test.mjs test/telegram-sync-notify.test.mjs
- npm test
- CI Tests: success
- Deploy Cloudflare Worker: success/未触发
- Deploy GitHub Pages: success/未触发/手动验证 success
远端 main：<sha-after>
```
