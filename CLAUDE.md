# CodeLark — Feishu Bot for Claude Code

## Quick Reference
- `npm run dev` — tsx watch 开发模式
- `npm test` — vitest run
- `npm run build` — tsc 编译到 dist/

## Architecture
TypeScript ESM project. Feishu bot 通过 WebSocket 长连接接收消息，代理到 Claude Agent SDK 执行，结果通过 CardKit 2.0 流式卡片回传。

核心模块:
- `src/messaging/inbound/` — 6 阶段消息管道: dedup → parse → record → gate → enqueue → dispatch
- `src/claude/executor.ts` — Claude Agent SDK 集成，回调驱动
- `src/card/` — CardKit 2.0 流式卡片（thinking 折叠面板 + 工具状态 + 正文）
- `src/channel/` — per-chat 队列串行化、聊天历史窗口、活跃任务注册
- `src/session/` — SQLite 会话管理，按 (userId, topicId, projectName) 三元组 get-or-create
- `src/project/` — 项目 CRUD、git clone、ACL
- `src/auth/` — Feishu OAuth device flow + token 刷新（per-user 锁防并发）
- `src/tools/` — 飞书文档/Wiki/云盘 MCP 工具（进程内 MCP server）

## Database
SQLite (better-sqlite3) WAL 模式，位于 `<WORKSPACE_DIR>/codelark.db`
表: users, sessions, task_logs, oauth_tokens, thread_bindings

## Key Patterns
- Config: Zod 校验环境变量，`loadConfig()` 启动时调用一次
- 消息去重: eventId 12h TTL，拒绝 >2min 的过期消息
- 卡片流式: CardKit 2.0 100ms 节流，降级到 IM 卡片 1.5s 节流
- Session: DM 自动恢复会话；群聊按 thread 隔离
- 群聊历史: 20 条消息 / 30 分钟滑动窗口，最多 200 个 chat buffer

## Known Workarounds
- `card.action.trigger` 事件类型未在 SDK 类型中暴露，用 `as any` 注册（同官方插件方案）
- Thinking 标签用正则匹配多种变体: `<think>`, `<thinking>`, `<thought>`, `<antthinking>`

## Code Style
- TypeScript 为主，默认用 TypeScript 写新代码
- 测试用 vitest describe/it/expect，env 隔离用 beforeEach/afterEach
- 模块导出倾向具名导出，避免 default export
- 中文注释和 commit message 均可

## Working Rules
- 不要做未被明确要求的代码修改。发现可改进之处应先说明，等待确认后再动手
- 修改 UI/视觉元素时，做最小增量修改，一次只改一个方面，确认后再继续
- 不要随便猜测根因，系统性排查后再修复
- 大任务开始前先给出编号计划，等用户批准后再写代码
- 不要重复发起 sub-agent 批次，每次限一批，除非用户明确要求并行
- Debug MCP 工具故障时，先查基础项（runtime 是否安装、命令是否正确、参数传递、token 有效性），再深入排查
- 设计评审时不要问技术实现细节，直接参考官方插件方案实现
