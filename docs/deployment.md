# 部署、凭据与维护

## 当前设施

- 已检查现有 VPS：Vesper 的 `codex-app-server` 和 `vesper-codex-history` 正常运行；无需改动它们即可提供远程记忆工具。
- 已检查 Cloudflare 账号、Atlas/Archive Workers、D1 和现有 `r-vera.com` 域名；复用该平台，创建 Memory 独立的 D1/KV 资源。
- 正式 Worker：`vera-memory`，域名 `memory.r-vera.com`。
- 正式 D1：`memory-db`；正式 OAuth KV：配置中的 `OAUTH_KV`。
- 页面 `/` 和 MCP `/mcp` 在同一个 Worker 中，经生产 Workers 运行时提供 HTTPS。Python `app.py` 不在部署中。
- `workers.dev` 和预览 URL 关闭，应用还检查规范主机名。资源 ID 属于非秘密部署标识，可保存在公开配置；凭据不能。

## 从源码发布

Node 24+，在正确 Cloudflare 账号登录后：

```sh
npm ci
npm run check
npm run db:remote
npm run deploy -- --keep-vars
```

`SESSION_SECRET` 必须通过 Workers Secrets 设置（至少32个随机字符）。服务未配置该密钥时会关闭所有业务请求并返回503，不会匿名开放记忆。

```sh
npx wrangler secret put SESSION_SECRET
```

首次建站，在安全环境设置 `MEMORY_USERNAME`、`MEMORY_PASSWORD` 后生成私有用户初始化 SQL，再通过已授权的 Wrangler 执行：

```sh
node scripts/owner-sql.mjs /private/path/memory-owner.sql
npx wrangler d1 execute memory-db --remote --file /private/path/memory-owner.sql
```

该文件只用于初始化 **单一 owner**；已存在时不会覆盖。执行后删除文件。遗失口令时，`--rotate` 可生成重置 SQL，重置同时提高鉴权版本并撤销全部会话/服务令牌；旧 OAuth access token 随之失效，需要重新授权。

不要在 GitHub、日志或 issue 中展示密码、原文、令牌或 SQL 用户哈希。初始登录资料通过用户本机受保护文件交付；它不在仓库内。用户可以在页面“连接与权限 → 修改登录密码”换成自己的密码。

## GitHub Actions

每次 push / PR：安装锁定依赖，类型检查、SQLite 行为测试、生产打包、旧原型回归、真实浏览器+MCP验收以及本地进程重启持久化检查。测试只使用自动生成的虚构资料。

手动 Deployment workflow 另需仓库 Secrets：`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`。当前本机已授权 Cloudflare 登录可直接部署，**没有把该登录令牌上传到 GitHub**；不因此声称 GitHub 已配置自动部署权限。密钥应按最小权限授予 Workers/D1/KV 和域名发布范围。

## 数据与备份

D1 与 Worker 版本生命周期分开：代码重启/重新部署不会清空记录。OAuth KV、D1 和生产密钥不会从 Git 恢复，因此不要删除这些资源。

在维护前备份到仓库之外的受保护目录：

```sh
npx wrangler d1 export memory-db --remote --output /private/backups/memory.sql
```

备份包含原文、来源和鉴权数据，需加密存储并限制权限，禁止提交。恢复优先遵循 [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)；SQL导入恢复先在独立测试库验证，不能在已有数据上盲目重放 `CREATE TABLE`。本次没有创建自动定时备份任务，备份/恢复流程需由维护者执行。

## 线上检查与清理

只读公开检查：`GET /health`、OAuth discovery，以及未授权 `/api/memories`、`/mcp` 的401。不要以 `/health` 正常代替完整验收。

带凭据的验收：

```sh
# 安全注入 MEMORY_USERNAME / MEMORY_PASSWORD；不要放入公开命令记录
MEMORY_BASE_URL=https://memory.r-vera.com node scripts/verify-connection.mjs
```

脚本会向该目标写入3条明确标注的虚构版本/梦境并创建临时 OAuth 连接，成功后撤销连接和测试令牌，输出的 `artifacts/acceptance.json` 只包含虚构记录ID和检查名称。**它不是纯只读检查**。生产运行需明确授权；本次用户已要求使用虚构样本做线上验收。

清理测试数据时，只按本次报告中的精确 ID 删除测试词元、向量、纠正版本，再删被替代版本；不得用“删除全部记忆”或模糊来源条件清库。保留业务用户原文。本次交付前清理了本次线上虚构样本，并撤销测试凭据。

生产的请求日志关闭；不要临时启用会泄漏 OAuth query 参数或正文的全量日志。健康检查只返回服务标识。服务错误对外返回简短错误代码，不返回内部堆栈或原始请求。
