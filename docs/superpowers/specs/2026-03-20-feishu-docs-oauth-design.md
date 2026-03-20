# Feishu Docs + User OAuth Support

**Date:** 2026-03-20
**Status:** Draft

## Goal

让 Claude 能读写用户的飞书文档。用户说"把这个方案写成飞书文档"，Claude 自动创建文档并返回链接；用户发飞书文档链接，Claude 能读取内容并分析/修改。

## Scope

### In Scope

1. **用户 OAuth 授权** — 首次使用文档功能时，bot 发送授权卡片，用户完成飞书 OAuth。token 持久化存储，支持自动刷新。

2. **三个 MCP 工具（Claude 自主调用）：**
   - `feishu_doc_create` — 创建飞书文档（Markdown 内容 + 标题），返回文档 URL
   - `feishu_doc_fetch` — 读取飞书文档（URL 或 doc_id → Markdown 内容）
   - `feishu_doc_update` — 更新飞书文档（支持覆盖、追加、范围替换等模式）

3. **通过飞书官方 MCP 端点 `https://mcp.feishu.cn/mcp`** 调用，由飞书服务端处理 Markdown ↔ Block 转换，不自己造轮子。

### Out of Scope

- 多维表格（下期，复用本期的 OAuth 基础设施）
- 文档内媒体上传下载（图片/附件）
- Wiki 空间管理
- 文档权限管理
- 文档评论

## Architecture

### OAuth Flow

```
用户首次触发文档操作（Claude 调用 feishu_doc_* 工具）
        ↓
检测用户无有效 OAuth token
        ↓
Bot 发送授权卡片（含授权链接）到聊天
        ↓
用户点击链接 → 浏览器完成飞书 OAuth 授权
        ↓
Bot 通过回调或轮询获取 access_token + refresh_token
        ↓
Token 持久化到 SQLite（per user）
        ↓
自动重试原始文档操作
```

参考官方插件的 OAuth Device Flow：`/tmp/openclaw-lark-latest/extracted/package/src/tools/oauth.js`

### MCP 工具调用流

```
Claude 决定调用 feishu_doc_create
        ↓
SDK MCP server 收到工具调用
        ↓
查询用户 OAuth token（从 DB）
        ↓
如果 token 过期 → 用 refresh_token 刷新
如果无 token → 返回错误提示用户授权
        ↓
构造 JSON-RPC 请求，调用 https://mcp.feishu.cn/mcp
Headers: X-Lark-MCP-UAT: <user_access_token>
        ↓
返回结果给 Claude
```

参考官方插件的 MCP 调用模式：`/tmp/openclaw-lark-latest/extracted/package/src/tools/mcp/shared.js`

### MCP 工具注册

使用 Agent SDK 导出的 `createSdkMcpServer()` 和 `tool()` 函数创建进程内 MCP server。SDK 类型定义确认支持：
- `McpSdkServerConfigWithInstance`：包含 `McpServer` 实例的配置
- `options.mcpServers`：`query()` 的选项，接受 `Record<string, McpServerConfig>`

在 `executor.ts` 调用 `query()` 时通过 `options.mcpServers` 注入：

```typescript
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';

const docServer = createSdkMcpServer({
  name: 'feishu-docs',
  tools: [createDocTool, fetchDocTool, updateDocTool],
});

query({ prompt, options: { mcpServers: { 'feishu-docs': docServer }, ... } });
```

## 工具定义

### feishu_doc_create

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| title | string | 是 | 文档标题 |
| markdown | string | 是 | Lark-flavored Markdown 内容 |
| folder_token | string | 否 | 目标文件夹 token |

返回：`{ doc_id, doc_url, message }`

### feishu_doc_fetch

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| doc_id | string | 是 | 文档 ID 或 URL（自动解析） |
| offset | number | 否 | 字符偏移（分页） |
| limit | number | 否 | 最大返回字符数 |

返回：`{ doc_id, title, content }`

### feishu_doc_update

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| doc_id | string | 是 | 文档 ID 或 URL |
| markdown | string | 是 | 更新内容 |
| mode | string | 是 | overwrite / append / replace_range / replace_all / insert_before / insert_after / delete_range |
| selection_with_ellipsis | string | 否 | 范围选择（用于 range 模式） |
| selection_by_title | string | 否 | 按标题选择（用于 range 模式） |
| new_title | string | 否 | 更新文档标题 |

返回：`{ success, doc_id, mode, message }`

## 新增模块

| 模块 | 职责 |
|------|------|
| `src/auth/oauth.ts` | OAuth 授权流程：构造授权 URL、轮询/回调获取 token、刷新 token |
| `src/auth/token-store.ts` | Token 持久化：SQLite 存储 per-user 的 access_token / refresh_token / expires_at |
| `src/tools/feishu-doc-mcp.ts` | 进程内 MCP server：注册三个文档工具，调用飞书 MCP 端点 |

## 变更模块

| 模块 | 变更 |
|------|------|
| `src/session/db.ts` | 新增 `oauth_tokens` 表（user_id, access_token, refresh_token, expires_at, scopes） |
| `src/claude/executor.ts` | 在 `query()` 的 `options.mcpServers` 中注入文档 MCP server |
| `src/card/builder.ts` | 新增 OAuth 授权卡片模板 |

## OAuth 细节

- **授权方式：** 飞书 OAuth 2.0 Device Flow（RFC 8628）。Bot 无 web server，不能接收 redirect 回调，所以用 Device Flow（发送授权链接 → 用户浏览器授权 → bot 轮询获取 token）。
- **所需 Scopes：** `docx:document:create`, `docx:document:readonly`, `docx:document:write_only`（后续迭代如需 wiki/media 再追加）
- **Token 存储：** SQLite `oauth_tokens` 表，per-user。选择 SQLite 而非 Keychain 是因为项目已有 SQLite 基础设施（sessions、users 表），保持一致性，且 bot 部署环境不一定有 Keychain。
- **Token 刷新：** access_token 过期前自动用 refresh_token 刷新
- **刷新失败处理：** 参考官方插件的 `REFRESH_TOKEN_RETRYABLE` 错误码集合，server error 时重试，token 失效时提示用户重新授权
- **群聊安全：** 授权卡片包含用户标识，防止群内其他成员代替完成授权（参考官方插件 `oauth.js` 的 identity verification 逻辑）

参考实现：
- OAuth 流程：`/tmp/openclaw-lark-latest/extracted/package/src/tools/oauth.js`
- Token 刷新：`/tmp/openclaw-lark-latest/extracted/package/src/core/uat-client.js`
- 错误处理：`/tmp/openclaw-lark-latest/extracted/package/src/core/auth-errors.js`

## 飞书 MCP 端点调用

参考官方插件 `/tmp/openclaw-lark-latest/extracted/package/src/tools/mcp/shared.js`：

- **端点：** `https://mcp.feishu.cn/mcp`
- **协议：** JSON-RPC 2.0
- **认证：** `X-Lark-MCP-UAT: <user_access_token>` header
- **工具名映射：** `feishu_doc_create` → MCP tool `create-doc`，`feishu_doc_fetch` → `fetch-doc`，`feishu_doc_update` → `update-doc`

## Constraints

- OAuth token 过期时间由飞书控制（通常 2 小时），refresh_token 有效期更长
- MCP 端点由飞书维护，我们不控制其可用性
- Lark-flavored Markdown 有特定语法限制（无递归表格，callout 高度限制等）
- 文档操作以用户身份执行，受用户在飞书中的权限约束
