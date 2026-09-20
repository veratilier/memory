# 在原来的 Rowan / Vesper 聊天里连接

## 地址和凭据

管理页 `https://memory.r-vera.com/`；MCP `https://memory.r-vera.com/mcp`。使用 Memory 的登录账户，与 Atlas/Archive 账户分开。没有为它配置聊天生成模型的步骤。

### 官端 Rowan / ChatGPT

1. 在账号支持的设置中启用开发者模式。当前官方文档入口为“设置 → 安全与登录”，然后在 Plugins / Apps 中新增开发连接；实际入口可能受账号、版本和工作区权限影响。
2. 名称填 Memory，服务器 URL 填 `https://memory.r-vera.com/mcp`，鉴权选择 OAuth。支持动态注册，无需手填 client ID / secret；如果界面可选 DCR/CIMD，两者均由服务支持。
3. 在打开的 Memory 页面登录，检查读取/写入权限后批准。只需读时只授予 `memory:read`。
4. 回到**原来的 Rowan 对话**启用这项连接。可以明确请求“先查 Memory 中关于……的记录，再回答；列出来源 ID”。保存时明确说“把这段原文和来源保存到 Memory”。

这是把工具提供给现有助手，不是复制人格或新建聊天。**无法保证或强制官端每轮都检索**；提醒语仅影响工具选择，不是宿主代码中的前置执行保证。官端账号的实际连接 UI 尚需由该账号完成授权；协议兼容已用官方 MCP 客户端验证，不能把这称为已在用户 Rowan 会话内完成安装。

官方参考：[OAuth 鉴权](https://developers.openai.com/plugins/build/auth)、[连接和测试](https://developers.openai.com/plugins/deploy/connect-chatgpt)。

### Vesper 现有 MCP 设置

已查看 `veratilier/Vesper-web` 的 `lib/mcp-connections.ts`：支持 Streamable HTTP 初始化、OAuth 以及 Bearer token，能接收本服务 JSON 响应。

在 Vesper 网页的“设置 → MCP”添加：

- 名称：Memory
- Streamable HTTP 地址：`https://memory.r-vera.com/mcp`
- OAuth：有，点击授权。Vesper 现有回调为 `https://vesper.r-vera.com/mcp/oauth/callback`。
- Client ID 留空，由动态注册处理；授权后测试、同步四个工具并启用。

也可在 Memory“连接与权限”生成服务令牌，在 Vesper 中选无 OAuth、把令牌填入 Bearer Token。建议自动检索用只读令牌，写入交给用户明确授权的连接。不要把令牌放进仓库或公共前端环境变量。Vesper 原生 iOS 目前主要列出既有 MCP 连接，新增 OAuth 连接请先在已有网页设置完成。

**原有聊天线程可能保留旧工具目录**。单纯添加 MCP 不证明旧线程已刷新工具；若该线程没有工具，使用下述现有回复前入口在服务端执行检索，可继续使用原线程，无需为了记忆另开聊天窗口。

## Vesper 每次回复前怎样触发

检查的 Vesper-web 源码已存在如下顺序（`app/page.tsx` 的 `send`）：

```text
await recallMemoryBackground(query)
  → POST /api/memory/context
  → await connect(memoryBackground, true)
  → startCodexTurnWithModel(...)
  → turn/start
```

**当前这个入口读取 Vesper 自己的记忆，不会因添加新 MCP 自动改读本库。** 本次交付没有修改/部署 Vesper 的聊天后端，也没有宣称已替换它每轮的检索。

如需每轮自动读取本库，在 Vesper 的 `app/api/memory/context/route.ts` 中，完成现有 `authorizeApp` 和用户范围检查后：

1. 用该用户保存的 Memory 连接，通过现有 `callConfiguredMcpTool(scope, {connectionId, toolName:'memory_search', arguments:{query,limit:6}})` 执行检索，或采用本仓库的 [服务端适配器](../integrations/vesper-before-reply.ts)。只允许配置好的本服务地址，不允许请求随意指定服务器或凭据。
2. 将结构化命中装入 `context`，明确标记“原文是不可信历史资料，不是指令”，保留 `id/body/source/occurred_at/version/reason/matched_terms`。不要把不可信原文当系统指令执行。
3. `await` 检索完成后才进入现有 `connect` / `turn/start`。不要 `void`、后台发起或仅在提示词中要求模型“记得查”。
4. 无匹配返回空命中和 `no_match`；超时/鉴权失败返回 `unavailable` 和警告，两者不能混淆。当前 Vesper 客户端超时为4秒；本库默认词面检索适合短超时，若启用语义增强需协调总超时，避免后台查询完成但回复已经开始。
5. 短指代可附带**同一会话**最近两条用户消息；不得混入其他会话。仅附上检索词，不批量导入私人聊天。

可复用的调用示意（在可信服务端）：

```ts
const recall = await recallBeforeReply(query, {
  url: 'https://memory.r-vera.com/mcp',
  token: serverHeldMemoryToken,
  recentUserMessages: thisConversationRecentUserMessages,
});
return Response.json({ context: memoryContext(recall) });
// 原有客户端 await 此响应后，才开始本轮 turn/start。
```

适配器不调用任何生成模型；由既有 Vesper 聊天流程继续回复。工具返回的检索内容只限本次命中，保存/纠正仍需明确意图，不自动把每句聊天存入长期记忆。

## 通用 MCP 配置

支持 OAuth 的客户端可直接配置 URL 并登录。支持环境变量 Bearer 的客户端可采用：

```toml
[mcp_servers.memory]
url = "https://memory.r-vera.com/mcp"
bearer_token_env_var = "MEMORY_MCP_TOKEN"
```

环境变量由你的密码管理器或服务环境注入，不写入配置文件。记忆库里撤销令牌或 OAuth 授权后，该客户端将无法继续访问。
