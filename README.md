# Memory · 有迹可循的记忆库

为 Rowan / Vesper 原来的聊天提供记忆工具，不是另一个聊天窗口。默认无需生成模型、API Key 或嵌入模型。

- 管理页面：**https://memory.r-vera.com/**（登录后访问）
- Streamable HTTP MCP：**https://memory.r-vera.com/mcp**（OAuth 或受限服务令牌）
- 页面与 MCP 共用独立 Cloudflare D1 `memory-db`；OAuth 使用独立 KV。不读取 Atlas / Archive 的私人记录。
- 已完成的线上和本地验收见 [验收记录](docs/acceptance.md)，连接说明见 [连接现有聊天](docs/connecting.md)。

## 功能

清冷、紧凑、手机适配的列表管理页：查看、搜索、新增、纠正，展示完整原文、来源说明/链接、发生时间、记录时间、来源标识及版本关系。没有聊天输入窗口或生成模型配置。

| MCP 工具 | 用途 |
| --- | --- |
| `memory_save` | 原样保存正文、来源、明确的类型；可提供稳定 `source_id` |
| `memory_search` | 返回原文、来源、时间、版本、命中词/依据；无匹配返回 `status: no_match` |
| `memory_get` | 按 ID 回查那一版原文及完整版本关系，不偷偷换成新版 |
| `memory_correct` | 以当前 ID 创建纠正版本，必须提供纠正原因，保留旧原文 |

默认检索排除已替代版本、梦和感受。类型包括 `episode / preference / agreement / reflection / dream`；梦和感受即使被显式搜索，也会标记为 `subjective_not_fact`。经历属于**有来源的记录，未经外部核验**，工具不会自行断言为客观事实，也无法自动识别被错误标成经历的梦境。

## 原文、去重与纠正

- 正文不裁剪、不改写；最多12,000字符。发生时间未知则留空，有值必须使用带时区 ISO 8601。
- 显式 `source_id` 相同、内容相同返回同一 ID；内容不同返回冲突。省略时按正文、来源、类型、时间和纠正关系生成内容哈希，重复保存仍去重。
- 纠正以单个数据库事务写入原文和索引，由唯一约束及触发器保证一个旧版本最多有一个后继。并发或迟到纠正返回 `stale_version`，要求先读取最新版。
- 原文只代表录入者提供的片段，来源链接不会自动抓取或验证。没有导入私人聊天，也没有自动摘要、自动收集或删除工具。

## 检索机制

默认中文双字词 + 英文单词倒排索引，覆盖正文和来源说明，大小写归一。按命中词比例排序，阈值0.18；返回最多20条。查询最多使用80个词元，截断会明确提示。它是词面检索，不是理解式推理，不保证召回所有措辞不同的旧事。

固定偏好和约定也需要与查询匹配，不会用固定偏好填充“已命中”的假象。原文长度和命中条数受限，但**不截断命中记录的原文**；宿主应按自己的上下文预算选择条目。

可选语义增强：设置服务端 `EMBEDDING_URL`、`EMBEDDING_MODEL`，需要时加密设置 `EMBEDDING_API_KEY`。接口为 OpenAI-compatible `POST {model,input}`，读取 `data[0].embedding`，只允许配置好的 HTTPS 服务。没有任何聊天生成模型调用。

向量缓存按端点+模型区分，增强覆盖最近200条合格记录，每轮最多补12条缓存，总增强时间限制约10秒。向量阈值0.65为试验值，需按实际模型评估；缓存不完整、范围限制和故障均返回 `warnings`。失败退回完整关键词检索，不伪称没有相关记忆。启用外部嵌入会把查询和待嵌入的原文发送给该配置服务；默认关闭。

## 安全与鉴权

沿用 [Atlas](https://github.com/veratilier/Atlas) / [Archive](https://github.com/veratilier/Archive) 的已验证架构：Cloudflare OAuth Provider + 官方 MCP SDK Web Standard Streamable HTTP transport。代码独立，cookie、数据库和密钥均隔离。

- OAuth Authorization Code + **PKCE S256**；DCR 和 CIMD；资源绑定、短期 access token、refresh rotation、授权撤销。
- `memory:read` / `memory:write` 分别检查。网页“连接与权限”可查看/撤销 OAuth 授权，生成90天服务令牌（可选择只读）。服务令牌只存哈希，明文仅展示一次。
- 管理页面需登录；口令为加盐 PBKDF2-SHA256（100,000轮，沿用 Workers 兼容实现）。登录节流，Secure / HttpOnly / SameSite=Lax 主机 cookie，服务端会话可撤销。
- 修改密码使全部网页会话、服务令牌和现有 OAuth access token 失效，客户端必须重新授权。
- 同源写入检查、绑定授权请求的 CSRF、严格 CSP、输入限制。API/MCP 响应不缓存，生产请求日志关闭，不记录正文或凭证。
- 当前为**单一所有者的一份共享记忆库**，Rowan/Vesper 是该所有者授权的客户端。不是开放注册、多租户产品。

## 本地开发和测试

Node.js 24+。生产入口是 `src/worker.ts`，不是 Python 开发服务器。

```sh
npm ci
cp .dev.vars.example .dev.vars
# 替换 SESSION_SECRET 为本地随机值
npm run db:local
# 通过环境安全提供用户名/密码，生成私有初始化 SQL
node scripts/owner-sql.mjs /private/path/owner.sql
npx wrangler d1 execute memory-db --local --file /private/path/owner.sql
npm run dev
```

本地页面为 `http://localhost:8791`。用户名/密码通过 `MEMORY_USERNAME` / `MEMORY_PASSWORD` 提供给初始化脚本；不要把真实口令写进命令历史。SQL 文件含口令哈希，使用后删除，禁止提交。

```sh
npm run check
npx playwright install chromium
node scripts/local-acceptance.mjs
python3 -m unittest discover -s tests -v
```

本地验收脚本会自动创建隔离数据库和虚构用户，走真实页面保存、OAuth、官方 MCP SDK、纠正和撤销权限，随后完整停止并重启 Worker 检查持久化。截图和报告位于被忽略的 `artifacts/`。本机已有 Chrome 时可设置 `PLAYWRIGHT_CHROME=1`。Python 的12项测试保留为原型回归检查。

## 部署与维护

详见 [部署说明](docs/deployment.md)。当前复用既有 Cloudflare 账号和 `r-vera.com` 域名，Worker `vera-memory`，数据库 `memory-db`。没有购买新域名，也没有把本地 Python HTTP 服务暴露到公网。

仓库只保存代码、数据库结构和虚构测试。`.dev.vars`、私有初始化 SQL、数据库、备份、密钥和真实聊天不得提交。管理页、MCP 和版本部署不会清空 D1。D1 支持备份导出与恢复；操作前确认目标库，备份放在仓库之外的受保护位置。

本仓库原有 `memory.py`、`app.py`、`static/` 作为仅本地的历史原型保留，**不参与生产构建**；旧 SQLite 数据不会被自动上传或导入。生产页面/API 不提供 `/api/chat`。
