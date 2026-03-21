# User Names & @Mention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve real user names from Feishu, show them in group chat context, auto-@mention the message sender in group replies, and let Claude proactively @mention users who have spoken in the conversation.

**Architecture:** A user-name-cache module queries Feishu's contact API and caches results with LRU+TTL. Sender names are resolved in the event pipeline before dispatch. Chat-history records senderId alongside senderName, enabling a name→userId reverse map. In group chats, StreamingCard and CardBuilder prepend a mention element for the sender. Claude's output text is scanned for `@用户名` patterns and replaced with Feishu mention syntax before sending.

**Tech Stack:** `@larksuiteoapi/node-sdk` (contact API), existing chat-history, StreamingCard, CardBuilder

---

## File Structure

| File | Change |
|------|--------|
| Create: `src/messaging/inbound/user-name-cache.ts` | User name resolution + LRU cache |
| Modify: `src/channel/chat-history.ts` | Add senderId to HistoryEntry; add getActiveUsers(); update recordMessage |
| Modify: `src/messaging/inbound/event-handlers.ts` | Resolve senderName before dispatch |
| Modify: `src/messaging/inbound/dispatch.ts` | Pass mentionTarget to StreamingCard; inject active users in prompt; replace @mentions in output |
| Modify: `src/card/streaming-card.ts` | Accept mentionTarget; prepend mention element in card |
| Modify: `src/card/builder.ts` | done/error/cancelled accept mentionTarget; prepend mention element |

---

### Task 1: Create user-name-cache module

**Files:**
- Create: `src/messaging/inbound/user-name-cache.ts`
- Test: `src/messaging/inbound/user-name-cache.test.ts`

- [ ] **Step 1: Write tests**

Mock `getClient()`. Test cases:
1. `resolveUserName(userId)` — API returns name → cached, returns name
2. `resolveUserName(userId)` — cache hit → no API call
3. `resolveUserName(userId)` — API failure → returns empty string, cached to prevent retry
4. Cache TTL — after 30min, refetches

- [ ] **Step 2: Implement user-name-cache.ts**

```typescript
import { getClient } from '../outbound/send.js';
import { logger } from '../../logger.js';

interface CacheEntry { name: string; fetchedAt: number; }
const cache = new Map<string, CacheEntry>();
const MAX_CACHE_SIZE = 500;
const CACHE_TTL_MS = 30 * 60 * 1000;

export async function resolveUserName(userId: string): Promise<string> {
  const cached = cache.get(userId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.name;
  }
  try {
    const client = getClient();
    const resp = await (client as any).contact.v3.user.get({
      path: { user_id: userId },
      params: { user_id_type: 'open_id' },
    });
    const name = (resp as any)?.data?.user?.name || '';
    setCache(userId, name);
    return name;
  } catch (err) {
    logger.debug({ err, userId }, 'Failed to resolve user name');
    setCache(userId, ''); // cache failure to prevent retry
    return '';
  }
}

function setCache(userId: string, name: string): void {
  if (cache.size >= MAX_CACHE_SIZE) {
    const oldest = cache.keys().next().value!;
    cache.delete(oldest);
  }
  cache.set(userId, { name, fetchedAt: Date.now() });
}

export function clearUserNameCache(): void { cache.clear(); }
```

- [ ] **Step 3: Run tests and commit**

Run: `npx tsc --noEmit && npx vitest run`
Commit: `git commit -m "feat: add user name cache with Feishu contact API"`

---

### Task 2: Add senderId to chat-history and getActiveUsers

**Files:**
- Modify: `src/channel/chat-history.ts`
- Test: (existing chat-history tests or inline verification)

- [ ] **Step 1: Update HistoryEntry and recordMessage**

Add `senderId` to `HistoryEntry`:
```typescript
export interface HistoryEntry {
  senderName: string;
  senderId: string;
  text: string;
  timestamp: number;
}
```

Update `recordMessage` signature — add `senderId` parameter:
```typescript
export function recordMessage(
  chatId: string, senderName: string, senderId: string, text: string, threadId?: string | null,
): void
```

Update the push: `entries.push({ senderName, senderId, text: text.slice(0, 500), timestamp: Date.now() });`

- [ ] **Step 2: Add getActiveUsers function**

Returns deduplicated list of users who have spoken in this context:
```typescript
export interface ActiveUser { name: string; userId: string; }

export function getActiveUsers(chatId: string, threadId?: string | null): ActiveUser[] {
  const entries = getRecentHistory(chatId, threadId);
  const seen = new Map<string, string>(); // userId → name
  for (const e of entries) {
    if (e.senderId && !seen.has(e.senderId)) {
      seen.set(e.senderId, e.senderName);
    }
  }
  return Array.from(seen, ([userId, name]) => ({ name, userId }));
}
```

- [ ] **Step 3: Update caller in event-handlers.ts**

Change `recordMessage` call to pass `ctx.senderId`:
```typescript
recordMessage(ctx.chatId, ctx.senderName || ctx.senderId, ctx.senderId, ctx.text, ctx.threadId);
```

- [ ] **Step 4: Run tests and commit**

Run: `npx tsc --noEmit && npx vitest run`
Commit: `git commit -m "feat: chat-history tracks senderId, exports getActiveUsers"`

---

### Task 3: Resolve senderName in event pipeline

**Files:**
- Modify: `src/messaging/inbound/event-handlers.ts`

- [ ] **Step 1: Add name resolution after parse**

In event-handlers.ts, after `parseMessageEvent` and before `recordMessage`, resolve the sender's real name:

```typescript
// After: const ctx = parseMessageEvent(data, deps.botOpenId);
// Add:
if (!ctx.senderName && ctx.senderId) {
  const { resolveUserName } = await import('./user-name-cache.js');
  const name = await resolveUserName(ctx.senderId);
  if (name) ctx.senderName = name;
}
```

Note: `ctx` fields are mutable (plain object from parse). The `await` is fine here since the pipeline is already async.

- [ ] **Step 2: Run tests and commit**

Run: `npx tsc --noEmit && npx vitest run`
Commit: `git commit -m "feat: resolve sender name from Feishu contact API"`

---

### Task 4: Add mention support to StreamingCard and CardBuilder

**Files:**
- Modify: `src/card/streaming-card.ts`
- Modify: `src/card/builder.ts`

- [ ] **Step 1: Define MentionTarget type**

In `src/card/builder.ts`, add:
```typescript
export interface MentionTarget {
  userId: string;
  name: string;
}
```

- [ ] **Step 2: Update CardBuilder.done/error/cancelled to accept mentionTarget**

Add optional `mentionTarget?: MentionTarget` to the options. If provided, prepend a mention markdown element:

```typescript
done(project: string, text: string, toolCount: number, opts?: {
  reasoningText?: string; reasoningElapsedMs?: number; elapsedMs?: number;
  mentionTarget?: MentionTarget;
}): FeishuCard {
  const elements: unknown[] = [];
  // Prepend mention element in group chats
  if (opts?.mentionTarget) {
    elements.push({ tag: 'markdown', content: `<at id=${opts.mentionTarget.userId}></at>` });
  }
  // ... rest of existing elements
}
```

Apply same pattern to `error()` and `cancelled()`.

- [ ] **Step 3: Update StreamingCard to accept and use mentionTarget**

Add `mentionTarget` to constructor:
```typescript
constructor(chatId: string, threadId: string | null, userMessageId: string | null, mentionTarget?: MentionTarget) {
  // ... existing init
  this.mentionTarget = mentionTarget ?? null;
}
```

In `buildStreamingThinkingCard()` (or `ensureCardCreated`), if mentionTarget is set, add a mention markdown element before the streaming content element:
```typescript
elements: [
  ...(this.mentionTarget ? [{ tag: 'markdown', content: `<at id=${this.mentionTarget.userId}></at>`, text_align: 'left' }] : []),
  { tag: 'markdown', content: '', text_align: 'left', element_id: STREAMING_ELEMENT_ID },
]
```

Pass mentionTarget through `complete(card, mentionTarget?)` → `finalizeCard` → the card object already has mention from CardBuilder.

- [ ] **Step 4: Run tests and commit**

Run: `npx tsc --noEmit && npx vitest run`
Commit: `git commit -m "feat: StreamingCard and CardBuilder support mention elements"`

---

### Task 5: Wire mentions into dispatch and add output-side replacement

**Files:**
- Modify: `src/messaging/inbound/dispatch.ts`

- [ ] **Step 1: Construct mentionTarget and pass to StreamingCard**

In `handleClaudeTask`, construct the mention target for group chats:
```typescript
const mentionTarget = ctx.chatType === 'group' ? { userId: ctx.senderId, name: ctx.senderName || ctx.senderId } : undefined;
const card = new StreamingCard(ctx.chatId, ctx.threadId, ctx.messageId, mentionTarget);
```

- [ ] **Step 2: Inject active users into group prompt**

After the existing group history injection, add active user list:
```typescript
if (ctx.chatType === 'group') {
  const { getActiveUsers } = await import('../../channel/chat-history.js');
  const activeUsers = getActiveUsers(ctx.chatId, ctx.threadId);
  if (activeUsers.length > 0) {
    const userList = activeUsers.map(u => u.name).join(', ');
    prompt = `[可 @mention 的用户: ${userList}]\n如需提及某人，使用 @用户名 格式。\n\n${prompt}`;
  }
}
```

- [ ] **Step 3: Add replaceMentions function**

Add at module level:
```typescript
function replaceMentions(text: string, chatId: string, threadId?: string | null): string {
  const { getActiveUsers } = require('../../channel/chat-history.js');  // sync since already imported
  const users = getActiveUsers(chatId, threadId);
  // Build name → userId map, skip duplicates
  const nameMap = new Map<string, string | null>();
  for (const u of users) {
    if (nameMap.has(u.name)) {
      nameMap.set(u.name, null); // duplicate name — skip
    } else {
      nameMap.set(u.name, u.userId);
    }
  }
  // Replace @用户名 patterns
  return text.replace(/@([\u4e00-\u9fff\w]+)/g, (match, name) => {
    const userId = nameMap.get(name);
    if (userId) return `<at user_id="${userId}">${name}</at>`;
    return match; // no match or duplicate — leave as-is
  });
}
```

Note: use dynamic import instead of require for ESM. Or import `getActiveUsers` statically at file top.

- [ ] **Step 4: Apply replaceMentions in onComplete callback**

In the `onComplete` callback, before passing text to CardBuilder:
```typescript
let resultText = result.text;
if (ctx.chatType === 'group') {
  resultText = replaceMentions(resultText, ctx.chatId, ctx.threadId);
}
```

Pass `resultText` instead of `result.text` to `CardBuilder.done()`.

Also pass `mentionTarget` to CardBuilder:
```typescript
CardBuilder.done(projectName, resultText, result.toolCount, {
  ...opts,
  mentionTarget,
})
```

- [ ] **Step 5: Run all tests**

Run: `npx tsc --noEmit && npx vitest run`

- [ ] **Step 6: Commit**

```bash
git commit -m "feat: group chat mentions — auto @sender, Claude can @mention active users"
```

---

### Task 6: Manual testing

- [ ] **Step 1: Test user name resolution**

1. Start bot, send a message in group
2. Check logs — should see real user name, not open_id

- [ ] **Step 2: Test auto @mention sender**

1. Send message in group → bot's reply card should have @mention at top
2. Send in thread → same behavior
3. Send in DM → no @mention

- [ ] **Step 3: Test Claude proactive @mention**

1. Have two users speak in a group thread
2. Ask Claude "刚才张三说了什么？请 @他"
3. Verify Claude's response contains @mention that renders correctly in Feishu

- [ ] **Step 4: Test duplicate names**

1. If possible, test with two users sharing a name → @mention should not render (stays as plain text)
