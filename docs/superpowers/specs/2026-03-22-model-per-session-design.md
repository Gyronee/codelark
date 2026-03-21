# Model Per-Session

**Date:** 2026-03-22
**Status:** Draft

## Goal

让 `/model` 切换模型只影响当前 session，不影响其他 session。解决群聊话题里切模型影响单聊的问题。

## 现状

`/model` 目前存在全局的 `user-model.ts` 内存 Map 里（per-user），切换后影响该用户所有对话。

## 设计

### 存储

在 sessions 表加 `model` 列：

```sql
ALTER TABLE sessions ADD COLUMN model TEXT;
```

`/model` 切换时更新当前 session 的 `model` 字段。未设置时使用环境变量 `CLAUDE_MODEL` 的默认值。

### 群聊

群聊共享 session（`getOrCreateGroup`），所以群内 `/model` 切换对所有群成员生效（同一个 session）。这是合理的——群聊共享上下文，也应该共享模型。

### 读取

`handleClaudeTask` 在获取 session 后，从 `session.model` 读模型，传给 `executeClaudeTask`。

### 删除旧模块

移除 `src/channel/user-model.ts`（全局 per-user Map），用 DB 的 per-session model 替代。

## 变更模块

| 模块 | 变更 |
|------|------|
| `src/session/db.ts` | sessions 表加 `model` 列；SessionRow 加 `model` 字段；加 `setSessionModel()` 方法 |
| `src/messaging/inbound/dispatch.ts` | `/model` 命令改为更新 session.model；`handleClaudeTask` 从 session 读 model |
| `src/channel/user-model.ts` | 删除 |
