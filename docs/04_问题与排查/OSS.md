# OSS / COS

## 现象

- 随想图片没有出现在页面。
- Actions summary 的 `Image storage` 中 `failed` 大于 0。
- 日志出现 COS PutObject / HeadObject 失败。

## 原因

- `COS_ENABLED=true` 但 `COS_SECRET_ID`、`COS_SECRET_KEY`、`COS_BUCKET`、`COS_REGION`、`COS_DOMAIN`、`COS_PATH_PREFIX` 不完整。
- `COS_DOMAIN` 不是 `https://{COS_BUCKET}.cos.{COS_REGION}.myqcloud.com`。
- `COS_PATH_PREFIX` 包含 `..` 或反斜杠。
- 当前 `main` 分支 `sync.yml` 未注入 `COS_*`，生产 main 不会按 COS 配置上传。

## 日志特征

- `[image-storage] COS PutObject failed`
- `[image-storage] COS HeadObject failed`
- `Invalid COS configuration`
- summary `imageUploadStats.failed`

## 排查步骤

1. 确认环境：dev 读 `DEV_COS_*` 并映射为 `COS_*`，见 `01_系统配置/dev.md`。
2. 确认 main 分支：`main:sync.yml` 未注入 `COS_*`，见 `01_系统配置/main.md`。
3. 查读取代码：`tools/telegram-thoughts.mjs:493-632`。
4. 查上传重试：`tools/telegram-thoughts.mjs:690-720`。
5. 查 `core.thought.image_refs_json` 是否写入 URL。

## 解决方案

- dev 环境补齐 `DEV_COS_*`，并保证 bucket/domain 不等于 main。
- 如果要让 main 使用 COS，先修改 main workflow 注入 `COS_*`，再更新文档和测试。
- COS 配置异常时临时关闭 `COS_ENABLED`，回退本地图片路径。

## 预防措施

- COS Secret 不放 Cloudflare Worker。
- 修改 COS 域名时同步校验默认域名格式。
- workflow 中保留 dev 与 main bucket/domain 隔离检查。
