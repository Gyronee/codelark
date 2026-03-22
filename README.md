# CodeLark

[English](./README.md) | [中文](./README.zh-CN.md)

Turn your Feishu group chat into a fully-featured Claude Code workspace.

CodeLark connects [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (via the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk)) to Feishu as a bot, giving your team access to Claude's coding capabilities — file editing, shell commands, project management, and deep Feishu document integration — directly from chat.

## Why CodeLark?

- **Claude Code in your chat** — Read, write, edit files, run shell commands, and manage git repos without leaving Feishu
- **Real-time streaming** — CardKit 2.0 streaming cards with live thinking display, tool execution status, and progressive content updates
- **Feishu-native document tools** — Create, read, update cloud documents; manage wiki spaces; search across docs — all through OAuth-authorized user context
- **Multi-project workspaces** — Create projects, clone repos, switch contexts; each group thread can bind to its own project
- **Team-ready** — User allowlists, per-project access control, admin roles, group chat support with thread isolation

## Features

### AI & Code Execution
- **Claude Opus / Sonnet / Haiku** — Switch models per session with `/model`
- **Full Claude Code toolset** — Read, Write, Edit, Bash, Glob, Grep
- **Extended thinking** — Reasoning displayed in collapsible panels, separated from the final answer
- **Session management** — Resume local CLI sessions, create named sessions, per-project isolation
- **MCP plugin support** — Auto-loads Claude Code plugins from local cache

### Messaging
- **Text, image, file, and rich-text (post) messages** — Images sent to Claude as multimodal content
- **Quote/reply context** — Media and text from quoted messages are merged into the current request
- **Group chat awareness** — Recent chat history (20 messages / 30 min) provided as context
- **Slash commands** — `/help`, `/status`, `/cancel`, `/model`, `/project`, `/session`, `/file`, `/auth`, `/whoami`

### Feishu Document Integration (via MCP + OAuth)
- **Cloud documents** — Create with Feishu-flavored Markdown (callouts, grids, tables, Mermaid, images), fetch as Markdown, update with 7 edit modes
- **Wiki** — List/create knowledge spaces and nodes, auto-convert wiki URLs
- **Drive** — List, copy, move, delete, upload (chunked for large files), download
- **Search** — Unified doc & wiki search with filters (creator, type, time range)
- **Comments** — List, create, and resolve document comments
- **Media** — Insert images/files into documents, download attachments

### Streaming Cards
- **CardKit 2.0** with streaming mode — real-time content updates
- **Phased display** — Thinking panel, tool execution status, main content as separate streams
- **Graceful fallback** — Degrades to standard IM cards if CardKit unavailable
- **Typing indicator** — Reaction on user's message during processing

### Security & Access Control
- **User & group allowlists** — Optional filtering for authorized users and groups
- **Per-project ACL** — `access.json` allowlists with creator-based auto-grant
- **Admin roles** — Unrestricted access to all projects and operations
- **Thread permissions** — Only admins/creators can rename or reset sessions
- **Path traversal prevention** — Realpath resolution, sandboxed to project directory
- **OAuth identity verification** — Prevents cross-user authorization hijacking
- **Tool permission confirmation** — Dangerous operations require user approval via card buttons (60s timeout, auto-deny)

### Reliability
- **Event deduplication** — ID-based with 12h TTL, stale message filtering (>2 min)
- **Per-chat message queue** — Serialized processing prevents interleaved responses
- **Rate limiting** — Card update throttling (100ms CardKit / 1.5s IM fallback), configurable debounce
- **OAuth token management** — Auto-refresh with transient error retry, 60s expiration buffer
- **Graceful shutdown** — SIGINT/SIGTERM handling, abort all active tasks, wait for in-flight updates

## Quick Start

### Prerequisites

- Node.js >= 20
- A Feishu custom app with bot capabilities ([create one here](https://open.feishu.cn/app))
- A Claude subscription or Anthropic API key

### 1. Clone and install

```bash
git clone https://github.com/anthropics/codelark.git
cd codelark
npm install
```

### 2. Configure

```bash
cp .env.example .env
```

Edit `.env`:

```env
FEISHU_APP_ID=cli_xxxxx
FEISHU_APP_SECRET=xxxxx
WORKSPACE_DIR=~/workspaces

# Optional: API key auth (otherwise uses Claude subscription)
# ANTHROPIC_API_KEY=sk-ant-xxxxx

# Optional: restrict access
ALLOWED_USER_IDS=ou_xxx1,ou_xxx2
ALLOWED_GROUP_IDS=oc_xxx1

# Optional: enables accurate @mention detection in groups
# BOT_OPEN_ID=ou_xxxxx
```

### 3. Configure your Feishu app

In the [Feishu Open Platform console](https://open.feishu.cn/app):

1. **Bot** — Enable bot capability
2. **Event subscriptions** — Enable WebSocket mode (long connection), subscribe to:
   - `im.message.receive_v1` — Receive messages
   - `card.action.trigger` — Card button callbacks
3. **Permissions** — Add the required scopes:
   - `im:message` / `im:message:send_as_bot` — Read and send messages
   - `im:chat` / `im:chat:readonly` — Access chat info
   - `im:resource` — Download media (images, files)
   - `contact:user.base:readonly` — Resolve user names

### 4. Start

```bash
# Development (with hot reload)
npm run dev

# Production
npm run build && npm start
```

The bot connects via WebSocket — no public server or domain needed.

### 5. First use

1. Send `/whoami` to the bot in a DM to get your `open_id`
2. Add your `open_id` to `ALLOWED_USER_IDS` in `.env` (if using allowlists)
3. Send `/auth` to authorize Feishu document access (OAuth device flow)
4. Start chatting — or use `/help` to see all commands

## Commands

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/status` | Current project and task status |
| `/whoami` | Get your open_id |
| `/cancel` | Cancel the running task |
| `/model [opus\|sonnet\|haiku]` | Switch model or show current |
| `/project list` | List available projects |
| `/project use <name>` | Switch to a project |
| `/project create <name>` | Create a new project |
| `/project clone <url>` | Clone a git repository |
| `/project grant <name> <user_id>` | Grant project access |
| `/project revoke <name> <user_id>` | Revoke project access |
| `/session list` | List recent sessions |
| `/session resume <id>` | Resume a local CLI session |
| `/session rename <name>` | Rename current session |
| `/session new` or `/new` | Start a fresh session |
| `/file <path>` | Upload a file from the project |
| `/auth` | Authorize Feishu document access |

## Architecture

```
src/
├── index.ts                    # Entry point, startup & shutdown
├── config.ts                   # Environment variable loading
├── logger.ts                   # Structured logging (pino)
├── messaging/
│   ├── inbound/
│   │   ├── event-handlers.ts   # Pipeline orchestration
│   │   ├── parse.ts            # Message type parsing & extraction
│   │   ├── media.ts            # Image/file download
│   │   ├── gate.ts             # User/group allowlist checks
│   │   ├── dedup.ts            # Event deduplication
│   │   ├── dispatch.ts         # Route to command or Claude task
│   │   ├── card-actions.ts     # Card button callbacks
│   │   └── user-name-cache.ts  # User name resolution cache
│   ├── outbound/
│   │   └── send.ts             # Feishu client & message sending
│   └── types.ts                # Shared message types
├── claude/
│   └── executor.ts             # Claude Agent SDK integration
├── card/
│   ├── streaming-card.ts       # CardKit 2.0 streaming lifecycle
│   ├── builder.ts              # Card content construction
│   ├── flush-controller.ts     # Debounced card updates
│   └── markdown-style.ts       # Markdown normalization
├── channel/
│   ├── chat-queue.ts           # Per-chat message serialization
│   ├── chat-history.ts         # Group chat context window
│   ├── active-registry.ts      # Running task tracking & cancellation
│   └── model-config.ts         # Per-session model selection
├── session/
│   ├── db.ts                   # SQLite database (users, sessions, tokens, threads)
│   ├── manager.ts              # Session CRUD & thread binding
│   └── local-sessions.ts       # Local CLI session discovery
├── project/
│   ├── manager.ts              # Project CRUD, git clone, access control
│   └── config.ts               # Project configuration types
├── auth/
│   ├── device-flow.ts          # OAuth device authorization flow
│   ├── token-store.ts          # Token storage & refresh
│   ├── oauth-card.ts           # Authorization prompt cards
│   ├── access.ts               # Project access control (access.json)
│   └── group-admin.ts          # Group admin detection
├── tools/
│   ├── feishu-doc-server.ts    # MCP server aggregating all Feishu tools
│   ├── feishu-oapi.ts          # Document create/fetch/update
│   ├── feishu-wiki.ts          # Wiki space & node operations
│   ├── feishu-drive.ts         # Drive file operations
│   ├── feishu-search.ts        # Doc & wiki search
│   ├── feishu-doc-media.ts     # Document media (images/files)
│   ├── feishu-doc-comments.ts  # Document comments
│   └── feishu-mcp.ts           # MCP tool type definitions
└── utils/
    └── command.ts              # Slash command parser
```

### Pipeline

Every incoming message flows through a 6-stage pipeline:

```
Message → Dedup → Parse → Record (history) → Gate (ACL) → Enqueue → Dispatch
                                                                      ↓
                                                              Command handler
                                                                   or
                                                              Claude task
                                                                   ↓
                                                           Streaming card ← CardKit 2.0
```

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `FEISHU_APP_ID` | Yes | — | Feishu app ID |
| `FEISHU_APP_SECRET` | Yes | — | Feishu app secret |
| `WORKSPACE_DIR` | Yes | — | Root directory for projects and data |
| `ANTHROPIC_API_KEY` | No | — | API key (uses Claude subscription if unset) |
| `ALLOWED_USER_IDS` | No | — | Comma-separated open_ids for user allowlist |
| `ALLOWED_GROUP_IDS` | No | — | Comma-separated chat_ids for group allowlist |
| `BOT_OPEN_ID` | No | — | Bot's open_id for accurate @mention detection |
| `ADMIN_USER_IDS` | No | — | Comma-separated admin open_ids (full access) |
| `TASK_TIMEOUT_MS` | No | `300000` | Max task duration (5 min) |
| `DEBOUNCE_MS` | No | `500` | Message processing debounce |
| `SESSION_TITLED_ONLY` | No | `false` | Only show titled sessions in list |
| `LOG_LEVEL` | No | `info` | Log level (`info` or `debug`) |

## Tech Stack

- **Runtime** — Node.js + TypeScript (ES2022)
- **AI** — [@anthropic-ai/claude-agent-sdk](https://github.com/anthropics/claude-agent-sdk) + [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk)
- **Feishu** — [@larksuiteoapi/node-sdk](https://github.com/larksuite/node-sdk)
- **Database** — SQLite via [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) (WAL mode)
- **Logging** — [pino](https://github.com/pinojs/pino) (structured JSON)
- **Validation** — [zod](https://github.com/colinhacks/zod)
- **Testing** — [vitest](https://vitest.dev/)

## Development

```bash
# Run tests
npm test

# Watch mode
npm run test:watch

# Development server with hot reload
npm run dev
```

## Acknowledgements

CodeLark's Feishu document integration (cloud docs, wiki, drive, search, comments) was heavily inspired by and referenced from [openclaw-lark](https://github.com/larksuite/openclaw-lark), the official Feishu channel plugin for OpenClaw by ByteDance. Thanks to the Lark Open Platform team for open-sourcing their work.

## License

MIT
