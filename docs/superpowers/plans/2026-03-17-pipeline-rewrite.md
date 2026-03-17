# Pipeline Rewrite Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the Feishu bot's message handling from a monolithic handler into a 7-stage pipeline with serial per-chat queuing, bounded dedup, mutex-protected card streaming, and fast cancel.

**Architecture:** Bottom-up build: shared types → infrastructure (dedup, queue, registry, flush) → outbound send → card system → pipeline stages (parse, gate, dispatch) → event handler → entry point rewire. Existing modules (session, project, executor, config) preserved with minimal import-path fixes.

**Tech Stack:** TypeScript, `@larksuiteoapi/node-sdk`, `@anthropic-ai/claude-agent-sdk`, `better-sqlite3`, `pino`, `vitest`

**Spec:** `docs/superpowers/specs/2026-03-17-pipeline-rewrite-design.md`

---

### Task 1: Shared Types + Config Update

**Files:**
- Create: `src/messaging/types.ts`
- Modify: `src/config.ts` — add `botOpenId` field
- Modify: `src/.env.example` — add `BOT_OPEN_ID`

- [ ] **Step 0: Add botOpenId to Config**

In `src/config.ts`, add `botOpenId: string;` to the `Config` interface and `botOpenId: process.env.BOT_OPEN_ID || '',` to `loadConfig()`.

In `.env.example`, add:
```
# Bot's open_id — get it by @bot in a group then check mention data in logs
BOT_OPEN_ID=ou_xxxxx
```

- [ ] **Step 1: Create the types file**

```typescript
// src/messaging/types.ts

export interface MentionInfo {
  key: string;       // e.g. "@_user_1"
  openId: string;
  name: string;
  isBot: boolean;
}

export interface MessageContext {
  eventId: string;
  messageId: string;
  chatId: string;
  chatType: 'p2p' | 'group';
  threadId: string | null;
  senderId: string;
  senderName: string | null;
  text: string;
  rawText: string;
  messageType: string;
  mentions: MentionInfo[];
  botMentioned: boolean;
  createTime: number;
  appId: string;
}
```

- [ ] **Step 2: Verify types compile**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/messaging/types.ts
git commit -m "feat: add shared MessageContext and MentionInfo types"
```

---

### Task 2: Bounded FIFO Dedup

**Files:**
- Create: `src/messaging/inbound/dedup.ts`
- Create: `src/messaging/inbound/dedup.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/messaging/inbound/dedup.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Dedup } from './dedup.js';

describe('Dedup', () => {
  let dedup: Dedup;

  beforeEach(() => {
    dedup = new Dedup({ maxSize: 5, ttlMs: 60_000, staleMs: 120_000 });
  });

  afterEach(() => {
    dedup.destroy();
  });

  it('allows first occurrence of an event', () => {
    expect(dedup.check('evt_1', Date.now())).toBe(true);
  });

  it('rejects duplicate event_id', () => {
    dedup.check('evt_1', Date.now());
    expect(dedup.check('evt_1', Date.now())).toBe(false);
  });

  it('rejects stale messages by create_time', () => {
    const old = Date.now() - 200_000; // 200s ago
    expect(dedup.check('evt_new', old)).toBe(false);
  });

  it('evicts oldest when exceeding maxSize', () => {
    for (let i = 0; i < 5; i++) dedup.check(`evt_${i}`, Date.now());
    // Add one more, should evict evt_0
    dedup.check('evt_5', Date.now());
    // evt_0 was evicted, so it's treated as new
    expect(dedup.check('evt_0', Date.now())).toBe(true);
  });

  it('allows re-delivery after TTL expires', async () => {
    const shortDedup = new Dedup({ maxSize: 100, ttlMs: 50, staleMs: 120_000 });
    shortDedup.check('evt_1', Date.now());
    await new Promise(r => setTimeout(r, 100));
    shortDedup.sweep();
    expect(shortDedup.check('evt_1', Date.now())).toBe(true);
    shortDedup.destroy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/messaging/inbound/dedup.test.ts
```

- [ ] **Step 3: Implement dedup.ts**

```typescript
// src/messaging/inbound/dedup.ts

export interface DedupOptions {
  maxSize: number;    // Max entries before FIFO eviction
  ttlMs: number;      // Per-entry TTL
  staleMs: number;    // Max message age by create_time
}

export class Dedup {
  private seen = new Map<string, number>(); // eventId → timestamp
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private opts: DedupOptions;

  constructor(opts?: Partial<DedupOptions>) {
    this.opts = {
      maxSize: opts?.maxSize ?? 5000,
      ttlMs: opts?.ttlMs ?? 12 * 60 * 60 * 1000, // 12 hours
      staleMs: opts?.staleMs ?? 120_000,           // 120 seconds
    };
    this.sweepTimer = setInterval(() => this.sweep(), 5 * 60 * 1000);
    this.sweepTimer.unref();
  }

  /**
   * Returns true if the event should be processed (not a duplicate, not stale).
   */
  check(eventId: string, createTime: number): boolean {
    // Reject stale messages
    if (Date.now() - createTime > this.opts.staleMs) return false;

    // Reject already-seen events
    if (this.seen.has(eventId)) return false;

    // Evict oldest if at capacity
    while (this.seen.size >= this.opts.maxSize) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }

    this.seen.set(eventId, Date.now());
    return true;
  }

  sweep(): void {
    const now = Date.now();
    for (const [id, ts] of this.seen) {
      if (now - ts > this.opts.ttlMs) {
        this.seen.delete(id);
      } else {
        break; // Map is ordered by insertion, so once we find a fresh one, all after are fresh
      }
    }
  }

  destroy(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.seen.clear();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/messaging/inbound/dedup.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/messaging/inbound/dedup.ts src/messaging/inbound/dedup.test.ts
git commit -m "feat: add bounded FIFO event deduplication"
```

---

### Task 3: Chat Queue

**Files:**
- Create: `src/channel/chat-queue.ts`
- Create: `src/channel/chat-queue.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/channel/chat-queue.test.ts
import { describe, it, expect } from 'vitest';
import { ChatQueue, buildQueueKey } from './chat-queue.js';

describe('buildQueueKey', () => {
  it('uses chatId when no threadId', () => {
    expect(buildQueueKey('oc_123', null)).toBe('oc_123');
  });
  it('includes threadId when present', () => {
    expect(buildQueueKey('oc_123', 'thread_1')).toBe('oc_123:thread:thread_1');
  });
});

describe('ChatQueue', () => {
  it('executes tasks serially for same key', async () => {
    const queue = new ChatQueue();
    const order: number[] = [];

    queue.enqueue('chat_a', async () => {
      await new Promise(r => setTimeout(r, 50));
      order.push(1);
    });
    queue.enqueue('chat_a', async () => {
      order.push(2);
    });

    // Wait for both to complete
    await new Promise(r => setTimeout(r, 150));
    expect(order).toEqual([1, 2]);
  });

  it('executes tasks in parallel for different keys', async () => {
    const queue = new ChatQueue();
    const order: string[] = [];

    queue.enqueue('chat_a', async () => {
      await new Promise(r => setTimeout(r, 50));
      order.push('a');
    });
    queue.enqueue('chat_b', async () => {
      order.push('b');
    });

    await new Promise(r => setTimeout(r, 100));
    expect(order).toEqual(['b', 'a']); // b finishes first
  });

  it('continues after a task throws', async () => {
    const queue = new ChatQueue();
    const results: string[] = [];

    queue.enqueue('chat_a', async () => {
      throw new Error('fail');
    });
    queue.enqueue('chat_a', async () => {
      results.push('ok');
    });

    await new Promise(r => setTimeout(r, 50));
    expect(results).toEqual(['ok']);
  });

  it('cleans up key after last task completes', async () => {
    const queue = new ChatQueue();
    queue.enqueue('chat_a', async () => {});
    await new Promise(r => setTimeout(r, 50));
    expect(queue.hasActiveTask('chat_a')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/channel/chat-queue.test.ts
```

- [ ] **Step 3: Implement chat-queue.ts**

```typescript
// src/channel/chat-queue.ts

export function buildQueueKey(chatId: string, threadId: string | null): string {
  return threadId ? `${chatId}:thread:${threadId}` : chatId;
}

export class ChatQueue {
  private queues = new Map<string, Promise<void>>();

  enqueue(key: string, task: () => Promise<void>): void {
    const prev = this.queues.get(key) ?? Promise.resolve();
    const next = prev.then(task, task).then(
      () => this.cleanup(key, next),
      () => this.cleanup(key, next),
    );
    this.queues.set(key, next);
  }

  hasActiveTask(key: string): boolean {
    return this.queues.has(key);
  }

  private cleanup(key: string, promise: Promise<void>): void {
    if (this.queues.get(key) === promise) {
      this.queues.delete(key);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/channel/chat-queue.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/channel/chat-queue.ts src/channel/chat-queue.test.ts
git commit -m "feat: add serial per-chat queue with self-cleanup"
```

---

### Task 4: Active Registry

**Files:**
- Create: `src/channel/active-registry.ts`

- [ ] **Step 1: Implement active-registry.ts**

```typescript
// src/channel/active-registry.ts

export interface ActiveDispatcher {
  abortController: AbortController;
  abortCard: () => void;
  userId: string;
}

const registry = new Map<string, ActiveDispatcher>();

export function setActive(key: string, dispatcher: ActiveDispatcher): void {
  registry.set(key, dispatcher);
}

export function getActive(key: string): ActiveDispatcher | undefined {
  return registry.get(key);
}

export function getByUserId(userId: string): [string, ActiveDispatcher] | undefined {
  for (const [key, d] of registry) {
    if (d.userId === userId) return [key, d];
  }
  return undefined;
}

export function removeActive(key: string): void {
  registry.delete(key);
}

export function abortAll(): void {
  for (const [, d] of registry) {
    d.abortController.abort();
    d.abortCard();
  }
  registry.clear();
}
```

- [ ] **Step 2: Verify compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/channel/active-registry.ts
git commit -m "feat: add active task registry for fast cancel"
```

---

### Task 5: Flush Controller

**Files:**
- Create: `src/card/flush-controller.ts`
- Create: `src/card/flush-controller.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/card/flush-controller.test.ts
import { describe, it, expect, vi } from 'vitest';
import { FlushController } from './flush-controller.js';

describe('FlushController', () => {
  it('flushes scheduled content after throttle', async () => {
    const updates: string[] = [];
    const fc = new FlushController(async (c) => { updates.push(c); }, 50);

    fc.schedule('hello');
    expect(updates).toEqual([]); // not yet
    await new Promise(r => setTimeout(r, 100));
    expect(updates).toEqual(['hello']);
    fc.destroy();
  });

  it('coalesces rapid updates', async () => {
    const updates: string[] = [];
    const fc = new FlushController(async (c) => { updates.push(c); }, 50);

    fc.schedule('a');
    fc.schedule('b');
    fc.schedule('c');
    await new Promise(r => setTimeout(r, 100));
    // Only the last value should be flushed
    expect(updates).toEqual(['c']);
    fc.destroy();
  });

  it('reflushes if new content arrives during flush', async () => {
    const updates: string[] = [];
    const fc = new FlushController(async (c) => {
      updates.push(c);
      // Simulate slow API call
      await new Promise(r => setTimeout(r, 50));
    }, 10);

    fc.schedule('first');
    await new Promise(r => setTimeout(r, 20)); // flush starts
    fc.schedule('second'); // arrives during flush
    await new Promise(r => setTimeout(r, 150));
    expect(updates).toContain('first');
    expect(updates).toContain('second');
    fc.destroy();
  });

  it('waitForFlush resolves after pending flush', async () => {
    const updates: string[] = [];
    const fc = new FlushController(async (c) => {
      await new Promise(r => setTimeout(r, 30));
      updates.push(c);
    }, 10);

    fc.schedule('data');
    await new Promise(r => setTimeout(r, 20)); // let flush start
    await fc.waitForFlush();
    expect(updates).toEqual(['data']);
    fc.destroy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/card/flush-controller.test.ts
```

- [ ] **Step 3: Implement flush-controller.ts**

```typescript
// src/card/flush-controller.ts

const LONG_GAP_MS = 2000;
const BATCH_AFTER_GAP_MS = 200;

export class FlushController {
  private pendingContent: string | null = null;
  private flushInProgress = false;
  private needsReflush = false;
  private lastUpdateTime = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushResolvers: Array<() => void> = [];

  constructor(
    private updateFn: (content: string) => Promise<void>,
    private throttleMs: number = 500,
  ) {}

  schedule(content: string): void {
    this.pendingContent = content;

    if (this.flushInProgress) {
      this.needsReflush = true;
      return;
    }

    if (this.timer) return; // already scheduled

    const elapsed = Date.now() - this.lastUpdateTime;

    if (this.lastUpdateTime === 0) {
      // First update ever — flush immediately
      this.doFlush();
    } else if (elapsed > LONG_GAP_MS) {
      // Long gap — batch briefly so first visible update has content
      this.timer = setTimeout(() => this.doFlush(), BATCH_AFTER_GAP_MS);
    } else if (elapsed < this.throttleMs) {
      // Too soon — wait for throttle
      this.timer = setTimeout(() => this.doFlush(), this.throttleMs - elapsed);
    } else {
      this.doFlush();
    }
  }

  private async doFlush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pendingContent === null) return;

    this.flushInProgress = true;
    const content = this.pendingContent;
    this.pendingContent = null;
    this.lastUpdateTime = Date.now();

    try {
      await this.updateFn(content);
    } catch {
      // Restore content so reflush can retry
      if (this.pendingContent === null) this.pendingContent = content;
    }

    this.flushInProgress = false;

    // Resolve any waiters
    const resolvers = this.flushResolvers;
    this.flushResolvers = [];
    resolvers.forEach(r => r());

    if (this.needsReflush) {
      this.needsReflush = false;
      if (this.pendingContent !== null) {
        setTimeout(() => this.doFlush(), 0);
      }
    }
  }

  async waitForFlush(): Promise<void> {
    if (!this.flushInProgress && this.pendingContent === null) return;
    // If there's pending content but no flush in progress, trigger it
    if (!this.flushInProgress && this.pendingContent !== null) {
      await this.doFlush();
      return;
    }
    return new Promise(resolve => {
      this.flushResolvers.push(resolve);
    });
  }

  destroy(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/card/flush-controller.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/card/flush-controller.ts src/card/flush-controller.test.ts
git commit -m "feat: add mutex-protected flush controller for card updates"
```

---

### Task 6: Outbound Send Module

**Files:**
- Create: `src/messaging/outbound/send.ts`

- [ ] **Step 1: Implement send.ts**

Adapted from current `src/feishu/client.ts` with threadId support and typed return values.

```typescript
// src/messaging/outbound/send.ts
import * as Lark from '@larksuiteoapi/node-sdk';
import type { Config } from '../../config.js';
import { logger } from '../../logger.js';

let client: Lark.Client;
let wsClient: Lark.WSClient;

export function initFeishuClient(config: Config): { client: Lark.Client; wsClient: Lark.WSClient } {
  const baseConfig = {
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
  };
  client = new Lark.Client(baseConfig);
  wsClient = new Lark.WSClient({
    ...baseConfig,
    loggerLevel: Lark.LoggerLevel.info,
  });
  return { client, wsClient };
}

export function startWebSocket(dispatcher: Lark.EventDispatcher): void {
  wsClient.start({ eventDispatcher: dispatcher });
  logger.info('Feishu WebSocket client started');
}

export async function sendText(chatId: string, text: string, threadId?: string): Promise<void> {
  try {
    await client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        content: JSON.stringify({ text }),
        msg_type: 'text' as any,
        ...(threadId ? { root_id: threadId } : {}),
      } as any,
    });
  } catch (err) {
    logger.error({ err, chatId }, 'Failed to send text');
  }
}

export async function sendCard(chatId: string, card: object, threadId?: string): Promise<string | null> {
  try {
    const resp = await client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        content: JSON.stringify(card),
        msg_type: 'interactive' as any,
        ...(threadId ? { root_id: threadId } : {}),
      } as any,
    });
    return resp?.data?.message_id || null;
  } catch (err) {
    logger.error({ err, chatId }, 'Failed to send card');
    return null;
  }
}

export async function updateCard(messageId: string, card: object): Promise<boolean> {
  try {
    await client.im.v1.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    });
    return true;
  } catch (err) {
    logger.warn({ err, messageId }, 'Failed to update card');
    return false;
  }
}
```

- [ ] **Step 2: Verify compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/messaging/outbound/send.ts
git commit -m "feat: add outbound send module with threadId support"
```

---

### Task 7: Card Builder

**Files:**
- Create: `src/card/builder.ts`
- Create: `src/card/builder.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/card/builder.test.ts
import { describe, it, expect } from 'vitest';
import { CardBuilder, sanitizeMarkdown } from './builder.js';

describe('CardBuilder', () => {
  it('builds a thinking card', () => {
    const card = CardBuilder.thinking('my-app');
    expect(card.header.template).toBe('blue');
    expect(card.header.title.content).toContain('my-app');
  });

  it('builds a working card', () => {
    const card = CardBuilder.working('my-app', 'Analyzing...', [
      { tool: 'Read', status: 'done', detail: 'src/index.ts' },
    ]);
    expect(card.header.template).toBe('orange');
    expect(JSON.stringify(card)).toContain('Analyzing...');
  });

  it('builds a done card with tool count', () => {
    const card = CardBuilder.done('my-app', 'Result here', 3);
    expect(card.header.template).toBe('green');
    expect(JSON.stringify(card)).toContain('Result here');
  });

  it('builds an error card', () => {
    const card = CardBuilder.error('my-app', 'Something broke');
    expect(card.header.template).toBe('red');
  });

  it('builds a confirm card with taskId', () => {
    const card = CardBuilder.confirm('my-app', 'rm -rf /', 'task-1');
    const json = JSON.stringify(card);
    expect(json).toContain('rm -rf /');
    expect(json).toContain('task-1');
  });

  it('builds a cancelled card', () => {
    const card = CardBuilder.cancelled('my-app');
    expect(card.header.title.content).toContain('my-app');
  });

  it('builds fallback text from markdown', () => {
    expect(CardBuilder.buildFallbackText('**bold** text')).toBe('bold text');
  });
});

describe('sanitizeMarkdown', () => {
  it('passes through short text', () => {
    expect(sanitizeMarkdown('hello')).toBe('hello');
  });

  it('truncates long text', () => {
    const long = 'a'.repeat(5000);
    const result = sanitizeMarkdown(long, 2000);
    expect(result.length).toBeLessThanOrEqual(2100);
    expect(result).toContain('...');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/card/builder.test.ts
```

- [ ] **Step 3: Implement builder.ts**

```typescript
// src/card/builder.ts

export interface ToolStatus {
  tool: string;
  status: 'running' | 'done';
  detail: string;
}

interface FeishuCard {
  header: { title: { tag: string; content: string }; template: string };
  elements: unknown[];
}

export function sanitizeMarkdown(text: string, maxLength = 3000): string {
  if (text.length > maxLength) {
    return text.slice(0, maxLength) + '\n\n... (content truncated)';
  }
  return text;
}

function toolStatusText(tools: ToolStatus[]): string {
  return tools
    .map(t => t.status === 'done' ? `✓ ${t.tool}: ${t.detail}` : `⟳ ${t.tool}: ${t.detail}`)
    .join('\n');
}

export const CardBuilder = {
  thinking(project: string): FeishuCard {
    return {
      header: { title: { tag: 'plain_text', content: `⏳ Thinking · ${project}` }, template: 'blue' },
      elements: [{ tag: 'div', text: { tag: 'plain_text', content: 'Processing...' } }],
    };
  },

  working(project: string, text: string, tools: ToolStatus[]): FeishuCard {
    const elements: unknown[] = [];
    if (text) elements.push({ tag: 'div', text: { tag: 'lark_md', content: sanitizeMarkdown(text) } });
    if (tools.length > 0) {
      elements.push({ tag: 'hr' });
      elements.push({ tag: 'div', text: { tag: 'lark_md', content: toolStatusText(tools) } });
    }
    elements.push({
      tag: 'action',
      actions: [{ tag: 'button', text: { tag: 'plain_text', content: 'Cancel' }, type: 'danger', value: { action: 'cancel_task' } }],
    });
    return {
      header: { title: { tag: 'plain_text', content: `🔧 Working · ${project}` }, template: 'orange' },
      elements,
    };
  },

  done(project: string, text: string, toolCount: number): FeishuCard {
    const elements: unknown[] = [
      { tag: 'div', text: { tag: 'lark_md', content: sanitizeMarkdown(text) } },
    ];
    if (toolCount > 0) {
      elements.push({ tag: 'hr' });
      elements.push({ tag: 'div', text: { tag: 'plain_text', content: `Tool calls: ${toolCount}` } });
    }
    return {
      header: { title: { tag: 'plain_text', content: `✓ Done · ${project}` }, template: 'green' },
      elements,
    };
  },

  error(project: string, msg: string): FeishuCard {
    return {
      header: { title: { tag: 'plain_text', content: `✗ Error · ${project}` }, template: 'red' },
      elements: [{ tag: 'div', text: { tag: 'lark_md', content: sanitizeMarkdown(msg) } }],
    };
  },

  confirm(project: string, command: string, taskId: string): FeishuCard {
    return {
      header: { title: { tag: 'plain_text', content: `⚠️ Confirm · ${project}` }, template: 'yellow' },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: `Claude wants to execute:\n\`\`\`\n${command}\n\`\`\`` } },
        { tag: 'action', actions: [
          { tag: 'button', text: { tag: 'plain_text', content: 'Allow' }, type: 'primary', value: { action: 'confirm_danger', taskId } },
          { tag: 'button', text: { tag: 'plain_text', content: 'Deny' }, type: 'danger', value: { action: 'reject_danger', taskId } },
        ]},
      ],
    };
  },

  cancelled(project: string): FeishuCard {
    return {
      header: { title: { tag: 'plain_text', content: `⊘ Cancelled · ${project}` }, template: 'grey' },
      elements: [{ tag: 'div', text: { tag: 'plain_text', content: 'Task was cancelled.' } }],
    };
  },

  buildFallbackText(markdown: string): string {
    return markdown.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/#+\s/g, '').trim();
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/card/builder.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/card/builder.ts src/card/builder.test.ts
git commit -m "feat: add card builder with fallback text support"
```

---

### Task 8: Streaming Card State Machine

**Files:**
- Create: `src/card/streaming-card.ts`

- [ ] **Step 1: Implement streaming-card.ts**

```typescript
// src/card/streaming-card.ts
import { FlushController } from './flush-controller.js';
import { sendCard, updateCard, sendText } from '../messaging/outbound/send.js';
import { CardBuilder } from './builder.js';
import { logger } from '../logger.js';

type Phase = 'idle' | 'creating' | 'streaming' | 'completed' | 'aborted' | 'error' | 'creation_failed';
const TERMINAL: Phase[] = ['completed', 'aborted', 'error', 'creation_failed'];

export class StreamingCard {
  private phase: Phase = 'idle';
  private cardMessageId: string | null = null;
  private createEpoch = 0;
  private flush: FlushController;
  private chatId: string;
  private threadId: string | null;

  constructor(chatId: string, threadId: string | null, throttleMs = 500) {
    this.chatId = chatId;
    this.threadId = threadId;
    this.flush = new FlushController(
      async (content) => {
        if (this.cardMessageId && this.phase === 'streaming') {
          await updateCard(this.cardMessageId, JSON.parse(content));
        }
      },
      throttleMs,
    );
  }

  get isTerminal(): boolean {
    return TERMINAL.includes(this.phase);
  }

  async create(card: object): Promise<void> {
    if (this.phase !== 'idle') return;
    this.phase = 'creating';
    this.createEpoch++;
    const epoch = this.createEpoch;

    const messageId = await sendCard(this.chatId, card, this.threadId ?? undefined);

    // Stale check: if phase changed during async create, discard result
    if (this.createEpoch !== epoch || this.isTerminal) return;

    if (messageId) {
      this.cardMessageId = messageId;
      this.phase = 'streaming';
    } else {
      this.phase = 'creation_failed';
      logger.warn({ chatId: this.chatId }, 'Card creation failed, will use text fallback');
    }
  }

  scheduleUpdate(card: object): void {
    if (this.phase !== 'streaming') return;
    this.flush.schedule(JSON.stringify(card));
  }

  async complete(card: object): Promise<void> {
    if (this.isTerminal) return;
    await this.flush.waitForFlush();
    this.flush.destroy();
    if (this.cardMessageId) {
      await updateCard(this.cardMessageId, card);
    }
    this.phase = 'completed';
  }

  async abort(card: object): Promise<void> {
    if (this.isTerminal) return;
    this.flush.destroy();
    if (this.cardMessageId) {
      await updateCard(this.cardMessageId, card);
    }
    this.phase = 'aborted';
  }

  async error(card: object): Promise<void> {
    if (this.isTerminal) return;
    this.flush.destroy();
    if (this.cardMessageId) {
      await updateCard(this.cardMessageId, card);
    }
    this.phase = 'error';
  }

  async fallbackText(text: string): Promise<void> {
    await sendText(this.chatId, text, this.threadId ?? undefined);
  }

  abortCard(): void {
    this.flush.destroy();
    this.phase = 'aborted';
  }
}
```

- [ ] **Step 2: Verify compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/card/streaming-card.ts
git commit -m "feat: add streaming card state machine"
```

---

### Task 9: Card Actions (Permission Requests)

**Files:**
- Create: `src/messaging/inbound/card-actions.ts`

- [ ] **Step 1: Implement card-actions.ts**

```typescript
// src/messaging/inbound/card-actions.ts
import { logger } from '../../logger.js';

const pendingPermissions = new Map<string, (allowed: boolean) => void>();

export function requestPermission(taskId: string, timeoutMs = 60_000): Promise<boolean> {
  return new Promise((resolve) => {
    pendingPermissions.set(taskId, resolve);
    const timer = setTimeout(() => {
      if (pendingPermissions.has(taskId)) {
        pendingPermissions.delete(taskId);
        resolve(false);
        logger.info({ taskId }, 'Permission request timed out, auto-denied');
      }
    }, timeoutMs);
    // Don't prevent process exit
    if (timer.unref) timer.unref();
  });
}

export function resolvePermission(taskId: string, allowed: boolean): void {
  const resolve = pendingPermissions.get(taskId);
  if (resolve) {
    pendingPermissions.delete(taskId);
    resolve(allowed);
  }
}
```

- [ ] **Step 2: Verify compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/messaging/inbound/card-actions.ts
git commit -m "feat: add card action permission request module"
```

---

### Task 10: Parse and Gate

**Files:**
- Create: `src/messaging/inbound/parse.ts`
- Create: `src/messaging/inbound/parse.test.ts`
- Create: `src/messaging/inbound/gate.ts`
- Create: `src/messaging/inbound/gate.test.ts`

- [ ] **Step 1: Write parse test**

```typescript
// src/messaging/inbound/parse.test.ts
import { describe, it, expect } from 'vitest';
import { parseMessageEvent } from './parse.js';

const makeEvent = (overrides: any = {}) => ({
  app_id: 'cli_test',
  message: {
    chat_id: 'oc_123',
    chat_type: 'p2p',
    content: JSON.stringify({ text: '/whoami' }),
    message_type: 'text',
    message_id: 'msg_1',
    root_id: null,
    create_time: String(Date.now()),
    mentions: undefined,
    ...overrides.message,
  },
  sender: {
    sender_id: { open_id: 'ou_abc', user_id: null, union_id: 'on_xyz' },
    sender_type: 'user',
    ...overrides.sender,
  },
  event_id: 'evt_1',
  ...overrides,
});

describe('parseMessageEvent', () => {
  it('parses a simple p2p text message', () => {
    const ctx = parseMessageEvent(makeEvent(), 'ou_bot');
    expect(ctx.text).toBe('/whoami');
    expect(ctx.chatType).toBe('p2p');
    expect(ctx.senderId).toBe('ou_abc');
    expect(ctx.botMentioned).toBe(false);
  });

  it('parses mentions and strips bot mention from text', () => {
    const ctx = parseMessageEvent(makeEvent({
      message: {
        chat_type: 'group',
        content: JSON.stringify({ text: '@_user_1 hello' }),
        mentions: [
          { key: '@_user_1', id: { open_id: 'ou_bot', user_id: null }, name: 'Bot', tenant_key: 'tk' },
        ],
      },
    }), 'ou_bot');
    expect(ctx.botMentioned).toBe(true);
    expect(ctx.text).toBe('hello');
    expect(ctx.mentions).toHaveLength(1);
    expect(ctx.mentions[0].isBot).toBe(true);
  });

  it('extracts threadId from root_id', () => {
    const ctx = parseMessageEvent(makeEvent({
      message: { root_id: 'thread_42' },
    }), 'ou_bot');
    expect(ctx.threadId).toBe('thread_42');
  });
});
```

- [ ] **Step 2: Run parse test to verify it fails**

```bash
npx vitest run src/messaging/inbound/parse.test.ts
```

- [ ] **Step 3: Implement parse.ts**

```typescript
// src/messaging/inbound/parse.ts
import type { MessageContext, MentionInfo } from '../types.js';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseMessageEvent(data: any, botOpenId: string): MessageContext {
  const { message, sender, event_id, app_id } = data;

  // Build mention info
  const rawMentions: any[] = message?.mentions ?? [];
  const mentions: MentionInfo[] = rawMentions.map((m: any) => ({
    key: m.key,
    openId: m.id?.open_id ?? '',
    name: m.name ?? '',
    isBot: m.id?.open_id === botOpenId,
  }));

  const botMentioned = mentions.some(m => m.isBot);

  // Parse content
  const content = message?.content ? JSON.parse(message.content) : {};
  const rawText: string = content?.text ?? '';

  // Strip all mention keys from text
  let text = rawText;
  for (const m of mentions) {
    if (m.key) {
      text = text.replace(new RegExp(escapeRegExp(m.key), 'g'), '');
    }
  }
  text = text.trim();

  const senderId = sender?.sender_id?.open_id ?? sender?.sender_id?.user_id ?? '';

  return {
    eventId: event_id ?? '',
    messageId: message?.message_id ?? '',
    chatId: message?.chat_id ?? '',
    chatType: message?.chat_type === 'group' ? 'group' : 'p2p',
    threadId: message?.root_id || null,
    senderId,
    senderName: sender?.sender_id?.name ?? null,
    text,
    rawText,
    messageType: message?.message_type ?? 'text',
    mentions,
    botMentioned,
    createTime: Number(message?.create_time ?? 0),
    appId: app_id ?? '',
  };
}
```

- [ ] **Step 4: Run parse test to verify it passes**

```bash
npx vitest run src/messaging/inbound/parse.test.ts
```

- [ ] **Step 5: Write gate test**

```typescript
// src/messaging/inbound/gate.test.ts
import { describe, it, expect } from 'vitest';
import { checkGate } from './gate.js';
import type { MessageContext } from '../types.js';
import type { Config } from '../../config.js';

const makeCtx = (overrides: Partial<MessageContext> = {}): MessageContext => ({
  eventId: 'evt_1', messageId: 'msg_1', chatId: 'oc_123', chatType: 'p2p',
  threadId: null, senderId: 'ou_user1', senderName: 'User', text: 'hello',
  rawText: 'hello', messageType: 'text', mentions: [], botMentioned: false,
  createTime: Date.now(), appId: 'cli_test', ...overrides,
});

const makeConfig = (overrides: Partial<Config> = {}): Config => ({
  feishu: { appId: 'cli_test', appSecret: 'secret' },
  anthropicApiKey: undefined,
  workspaceDir: '/tmp', allowedUserIds: [], allowedGroupIds: [],
  taskTimeoutMs: 300000, debounceMs: 500, ...overrides,
});

describe('checkGate', () => {
  it('always passes /whoami', () => {
    expect(checkGate(makeCtx({ text: '/whoami' }), makeConfig({ allowedUserIds: ['ou_other'] }))).toBe('pass');
  });

  it('passes when allowedUserIds is empty', () => {
    expect(checkGate(makeCtx(), makeConfig())).toBe('pass');
  });

  it('rejects user not in allowlist', () => {
    expect(checkGate(makeCtx(), makeConfig({ allowedUserIds: ['ou_other'] }))).toBe('reject');
  });

  it('passes user in allowlist', () => {
    expect(checkGate(makeCtx(), makeConfig({ allowedUserIds: ['ou_user1'] }))).toBe('pass');
  });

  it('rejects group not in allowlist', () => {
    expect(checkGate(
      makeCtx({ chatType: 'group', botMentioned: true }),
      makeConfig({ allowedGroupIds: ['oc_other'] }),
    )).toBe('reject');
  });

  it('rejects group message without bot mention', () => {
    expect(checkGate(
      makeCtx({ chatType: 'group', botMentioned: false }),
      makeConfig(),
    )).toBe('reject');
  });

  it('passes group message with bot mention and no group allowlist', () => {
    expect(checkGate(
      makeCtx({ chatType: 'group', botMentioned: true }),
      makeConfig(),
    )).toBe('pass');
  });
});
```

- [ ] **Step 6: Implement gate.ts**

```typescript
// src/messaging/inbound/gate.ts
import type { MessageContext } from '../types.js';
import type { Config } from '../../config.js';
import { logger } from '../../logger.js';

export function checkGate(ctx: MessageContext, config: Config): 'pass' | 'reject' {
  // /whoami always passes
  if (ctx.text === '/whoami') return 'pass';

  // User allowlist
  if (config.allowedUserIds.length > 0 && !config.allowedUserIds.includes(ctx.senderId)) {
    logger.debug({ senderId: ctx.senderId }, 'Gate: user not in allowlist');
    return 'reject';
  }

  // Group checks
  if (ctx.chatType === 'group') {
    // Group allowlist
    if (config.allowedGroupIds.length > 0 && !config.allowedGroupIds.includes(ctx.chatId)) {
      logger.debug({ chatId: ctx.chatId }, 'Gate: group not in allowlist');
      return 'reject';
    }
    // Must be @mentioned
    if (!ctx.botMentioned) {
      logger.debug({ chatId: ctx.chatId }, 'Gate: bot not mentioned in group');
      return 'reject';
    }
  }

  return 'pass';
}
```

- [ ] **Step 7: Run all new tests**

```bash
npx vitest run src/messaging/inbound/parse.test.ts src/messaging/inbound/gate.test.ts
```

- [ ] **Step 8: Commit**

```bash
git add src/messaging/inbound/parse.ts src/messaging/inbound/parse.test.ts src/messaging/inbound/gate.ts src/messaging/inbound/gate.test.ts
git commit -m "feat: add message parser and access gate"
```

---

### Task 11: Dispatch (Command + Claude orchestration)

**Files:**
- Create: `src/messaging/inbound/dispatch.ts`

- [ ] **Step 1: Implement dispatch.ts**

This is the core orchestration module. It handles commands and Claude Code tasks, wiring together session/project management, streaming cards, and the executor.

```typescript
// src/messaging/inbound/dispatch.ts
import type { MessageContext } from '../types.js';
import type { Config } from '../../config.js';
import type { Database } from '../../session/db.js';
import type { SessionManager } from '../../session/manager.js';
import type { ProjectManager } from '../../project/manager.js';
import { parseCommand } from '../../utils/command.js';
import { sendText, sendCard } from '../outbound/send.js';
import { StreamingCard } from '../../card/streaming-card.js';
import { CardBuilder, type ToolStatus } from '../../card/builder.js';
import { executeClaudeTask, type ExecutionResult } from '../../claude/executor.js';
import { requestPermission } from './card-actions.js';
import * as registry from '../../channel/active-registry.js';
import { buildQueueKey } from '../../channel/chat-queue.js';
import { logger } from '../../logger.js';

export async function dispatch(
  ctx: MessageContext,
  config: Config,
  db: Database,
  sessionManager: SessionManager,
  projectManager: ProjectManager,
): Promise<void> {
  // Record user
  db.upsertUser(ctx.senderId, ctx.senderName);

  // Try as command
  const cmd = parseCommand(ctx.text);
  if (cmd) {
    await handleCommand(cmd, ctx, config, db, sessionManager, projectManager);
    return;
  }

  // Non-text messages
  if (ctx.messageType !== 'text') {
    await sendText(ctx.chatId, '目前仅支持文本消息。', ctx.threadId ?? undefined);
    return;
  }

  // Claude Code task
  await handleClaudeTask(ctx, config, db, sessionManager, projectManager);
}

async function handleCommand(
  cmd: ReturnType<typeof parseCommand>,
  ctx: MessageContext,
  config: Config,
  db: Database,
  sessionManager: SessionManager,
  projectManager: ProjectManager,
): Promise<void> {
  if (!cmd) return;

  switch (cmd.type) {
    case 'help': {
      const help = [
        '📋 可用命令：',
        '',
        '/help — 显示帮助信息',
        '/status — 查看当前项目和任务状态',
        '/whoami — 查看你的 open_id',
        '',
        '💬 会话：',
        '/reset — 重置当前对话上下文',
        '/cancel — 取消正在执行的任务',
        '',
        '📁 项目管理：',
        '/project list — 列出所有项目',
        '/project use <名称> — 切换到指定项目',
        '/project create <名称> — 创建新空项目',
        '/project clone <地址> — 克隆 Git 仓库（仅支持 https）',
        '',
        '直接发送文字即可与 Claude Code 对话。',
        '无需设置项目，系统会自动为你创建独立的工作目录。',
      ];
      await sendText(ctx.chatId, help.join('\n'), ctx.threadId ?? undefined);
      break;
    }
    case 'whoami':
      await sendText(ctx.chatId, `open_id: ${ctx.senderId}`, ctx.threadId ?? undefined);
      break;
    case 'status': {
      const user = db.getUser(ctx.senderId);
      const active = registry.getByUserId(ctx.senderId);
      await sendText(ctx.chatId,
        `Project: ${user?.active_project || '(default)'}\nTask running: ${active ? 'yes' : 'no'}`,
        ctx.threadId ?? undefined);
      break;
    }
    case 'reset': {
      const user = db.getUser(ctx.senderId);
      const project = user?.active_project || 'My Workspace';
      sessionManager.reset(ctx.senderId, ctx.threadId, project);
      await sendText(ctx.chatId, 'Session reset.', ctx.threadId ?? undefined);
      break;
    }
    case 'cancel': {
      // Fallback cancel (fast-path in event-handlers didn't find active task)
      await sendText(ctx.chatId, '没有正在执行的任务。', ctx.threadId ?? undefined);
      break;
    }
    case 'project': {
      await handleProjectCommand(cmd, ctx, db, projectManager);
      break;
    }
  }
}

async function handleProjectCommand(
  cmd: NonNullable<ReturnType<typeof parseCommand>>,
  ctx: MessageContext,
  db: Database,
  projectManager: ProjectManager,
): Promise<void> {
  const reply = (text: string) => sendText(ctx.chatId, text, ctx.threadId ?? undefined);

  switch (cmd.action) {
    case 'list': {
      const projects = projectManager.list();
      if (projects.length === 0) {
        await reply('没有已配置的项目。使用 /project create <名称> 或 /project clone <地址>。');
        return;
      }
      await reply(projects.map(p => `• ${p.name}${p.description ? ` — ${p.description}` : ''}`).join('\n'));
      break;
    }
    case 'use': {
      const name = cmd.args[0];
      if (!name) { await reply('用法: /project use <名称>'); return; }
      try { projectManager.resolve(name); db.setActiveProject(ctx.senderId, name); await reply(`已切换到项目: ${name}`); }
      catch (e: any) { await reply(e.message); }
      break;
    }
    case 'create': {
      const name = cmd.args[0];
      if (!name) { await reply('用法: /project create <名称>'); return; }
      try { projectManager.create(name); db.setActiveProject(ctx.senderId, name); await reply(`项目已创建: ${name}`); }
      catch (e: any) { await reply(e.message); }
      break;
    }
    case 'clone': {
      const url = cmd.args[0];
      if (!url) { await reply('用法: /project clone <https://地址>'); return; }
      try {
        await reply(`正在克隆 ${url}...`);
        const { name } = await projectManager.clone(url);
        db.setActiveProject(ctx.senderId, name);
        await reply(`已克隆并切换到: ${name}`);
      } catch (e: any) { await reply(e.message); }
      break;
    }
    default:
      await reply(`未知项目命令: ${cmd.action}`);
  }
}

async function handleClaudeTask(
  ctx: MessageContext,
  config: Config,
  db: Database,
  sessionManager: SessionManager,
  projectManager: ProjectManager,
): Promise<void> {
  // Per-user concurrency check
  const existing = registry.getByUserId(ctx.senderId);
  if (existing) {
    await sendText(ctx.chatId, '上一个任务还在执行中，请等待完成或发送 /cancel 取消。', ctx.threadId ?? undefined);
    return;
  }

  // Resolve project path
  const user = db.getUser(ctx.senderId);
  const projectName = user?.active_project || 'My Workspace';
  let projectPath: string;
  if (user?.active_project) {
    try { projectPath = projectManager.resolve(user.active_project); }
    catch (e: any) { await sendText(ctx.chatId, e.message, ctx.threadId ?? undefined); return; }
  } else {
    projectPath = projectManager.ensureUserDefault(ctx.senderId);
  }

  // Session
  const session = sessionManager.getOrCreate(ctx.senderId, ctx.threadId, projectName);

  // Create streaming card
  const card = new StreamingCard(ctx.chatId, ctx.threadId, config.debounceMs);
  await card.create(CardBuilder.thinking(projectName));

  // Register for abort
  const abortController = new AbortController();
  const queueKey = buildQueueKey(ctx.chatId, ctx.threadId);
  registry.setActive(queueKey, {
    abortController,
    abortCard: () => card.abortCard(),
    userId: ctx.senderId,
  });

  // Timeout
  const timeout = setTimeout(() => abortController.abort(), config.taskTimeoutMs);

  const tools: ToolStatus[] = [];
  const startTime = Date.now();

  await executeClaudeTask(
    ctx.text,
    projectPath,
    session.claude_session_id,
    abortController,
    {
      onText: (fullText) => {
        card.scheduleUpdate(CardBuilder.working(projectName, fullText, tools));
      },
      onToolStart: (tool, detail) => {
        tools.push({ tool, status: 'running', detail });
        card.scheduleUpdate(CardBuilder.working(projectName, '', tools));
      },
      onToolEnd: (tool) => {
        const match = tools.find(t => t.tool === tool && t.status === 'running')
          || tools.find(t => t.status === 'running');
        if (match) match.status = 'done';
      },
      onPermissionRequest: async (toolName, input) => {
        const taskId = `perm-${Date.now()}`;
        const command = toolName === 'Bash'
          ? String((input as any).command || toolName)
          : `${toolName}(${JSON.stringify(input).slice(0, 100)})`;
        await sendCard(ctx.chatId, CardBuilder.confirm(projectName, command, taskId), ctx.threadId ?? undefined);
        return requestPermission(taskId);
      },
      onComplete: async (result: ExecutionResult) => {
        clearTimeout(timeout);
        registry.removeActive(queueKey);

        if (result.sessionId) db.updateClaudeSessionId(session.id, result.sessionId);
        db.logTask(session.id, ctx.text, result.text, JSON.stringify(tools.map(t => t.tool)), result.durationMs, 'success');

        if (card.isTerminal) {
          // Card was already aborted/failed — send text fallback
          await card.fallbackText(CardBuilder.buildFallbackText(result.text));
        } else {
          await card.complete(CardBuilder.done(projectName, result.text, result.toolCount));
        }
      },
      onError: async (error) => {
        clearTimeout(timeout);
        registry.removeActive(queueKey);
        const durationMs = Date.now() - startTime;
        db.logTask(session.id, ctx.text, error, null, durationMs, 'error');

        if (abortController.signal.aborted) {
          if (!card.isTerminal) await card.abort(CardBuilder.cancelled(projectName));
        } else {
          if (card.isTerminal) {
            await card.fallbackText(error);
          } else {
            await card.error(CardBuilder.error(projectName, error));
          }
        }
      },
    },
  );
}
```

- [ ] **Step 2: Fix executor.ts import path**

Change `src/claude/executor.ts` line 4 from:
```typescript
import { type ToolStatus } from '../feishu/cards.js';
```
to:
```typescript
import { type ToolStatus } from '../card/builder.js';
```

- [ ] **Step 3: Verify compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add src/messaging/inbound/dispatch.ts src/claude/executor.ts
git commit -m "feat: add dispatch module with command handling and Claude task orchestration"
```

---

### Task 12: Event Handler (Pipeline Entry Point)

**Files:**
- Create: `src/messaging/inbound/event-handlers.ts`

- [ ] **Step 1: Implement event-handlers.ts**

```typescript
// src/messaging/inbound/event-handlers.ts
import * as Lark from '@larksuiteoapi/node-sdk';
import type { Config } from '../../config.js';
import type { Database } from '../../session/db.js';
import type { SessionManager } from '../../session/manager.js';
import type { ProjectManager } from '../../project/manager.js';
import { Dedup } from './dedup.js';
import { parseMessageEvent } from './parse.js';
import { checkGate } from './gate.js';
import { dispatch } from './dispatch.js';
import { ChatQueue, buildQueueKey } from '../../channel/chat-queue.js';
import * as registry from '../../channel/active-registry.js';
import { logger } from '../../logger.js';

export interface PipelineDeps {
  config: Config;
  db: Database;
  sessionManager: SessionManager;
  projectManager: ProjectManager;
  botOpenId: string;
}

export function createPipeline(deps: PipelineDeps): {
  dispatcher: Lark.EventDispatcher;
  dedup: Dedup;
  queue: ChatQueue;
} {
  const dedup = new Dedup();
  const queue = new ChatQueue();

  const dispatcher = new Lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data: any) => {
      try {
        // Stage 1: App ID validation
        if (data.app_id && data.app_id !== deps.config.feishu.appId) {
          logger.debug({ appId: data.app_id }, 'Ignoring event from different app');
          return;
        }

        const eventId = data.event_id;
        const createTime = Number(data.message?.create_time ?? 0);

        // Stage 1b: Fast cancel detection — strip mention keys before matching
        const rawContent = data.message?.content ? JSON.parse(data.message.content) : {};
        let rawText = (rawContent?.text ?? '').trim();
        const rawMentions: any[] = data.message?.mentions ?? [];
        for (const m of rawMentions) {
          if (m.key) rawText = rawText.replace(m.key, '');
        }
        rawText = rawText.trim();
        if (rawText === '/cancel') {
          const chatId = data.message?.chat_id;
          const threadId = data.message?.root_id || null;
          if (chatId) {
            const key = buildQueueKey(chatId, threadId);
            const active = registry.getActive(key);
            if (active) {
              active.abortController.abort();
              active.abortCard();
              registry.removeActive(key);
              logger.info({ key }, 'Fast cancel: task aborted');
              return; // Don't enqueue — cancel is done
            }
          }
          // No active task found — let it fall through to dispatch as fallback
        }

        // Stage 2: Dedup
        if (!dedup.check(eventId, createTime)) {
          logger.debug({ eventId }, 'Ignoring duplicate/stale event');
          return;
        }

        // Stage 3: Parse
        const ctx = parseMessageEvent(data, deps.botOpenId);
        logger.info({ eventId, chatId: ctx.chatId, text: ctx.text.slice(0, 50) }, 'Processing message');

        // Stage 4: Gate
        if (checkGate(ctx, deps.config) === 'reject') {
          return;
        }

        // Stage 5: Enqueue
        const queueKey = buildQueueKey(ctx.chatId, ctx.threadId);
        queue.enqueue(queueKey, async () => {
          // Stage 6+7: Dispatch (commands, Claude tasks, replies)
          await dispatch(ctx, deps.config, deps.db, deps.sessionManager, deps.projectManager);
        });
      } catch (err) {
        logger.error({ err }, 'Unhandled error in message pipeline');
      }
    },
  });

  return { dispatcher, dedup, queue };
}
```

- [ ] **Step 2: Verify compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/messaging/inbound/event-handlers.ts
git commit -m "feat: add 7-stage message pipeline with event handlers"
```

---

### Task 13: Rewrite Entry Point + Delete Old Files

**Files:**
- Modify: `src/index.ts`
- Delete: `src/feishu/handler.ts`, `src/feishu/client.ts`, `src/feishu/actions.ts`, `src/feishu/cards.ts`, `src/feishu/cards.test.ts`, `src/claude/stream.ts`, `src/integration.test.ts`

- [ ] **Step 1: Rewrite index.ts**

```typescript
// src/index.ts
import 'dotenv/config';
import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { Database } from './session/db.js';
import { SessionManager } from './session/manager.js';
import { ProjectManager } from './project/manager.js';
import { initFeishuClient, startWebSocket } from './messaging/outbound/send.js';
import { createPipeline } from './messaging/inbound/event-handlers.js';
import * as registry from './channel/active-registry.js';
import { join } from 'path';

async function main(): Promise<void> {
  const config = loadConfig();
  logger.info({ workspaceDir: config.workspaceDir }, 'Starting remote-control');

  const dbPath = join(config.workspaceDir, 'remote-control.db');
  const db = new Database(dbPath);
  const sessionManager = new SessionManager(db);
  const projectManager = new ProjectManager(config.workspaceDir);
  projectManager.cleanupTmp();

  initFeishuClient(config);

  if (!config.botOpenId) {
    logger.warn('BOT_OPEN_ID not set — group @mention detection will not work. Use /whoami in a group to find the bot open_id, then set BOT_OPEN_ID in .env');
  }

  const { dispatcher, dedup } = createPipeline({
    config,
    db,
    sessionManager,
    projectManager,
    botOpenId: config.botOpenId,
  });

  startWebSocket(dispatcher);
  logger.info('remote-control is ready');

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down...');
    registry.abortAll();
    dedup.destroy();
    db.close();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start');
  process.exit(1);
});
```

- [ ] **Step 2: Delete old files**

```bash
rm src/feishu/handler.ts src/feishu/client.ts src/feishu/actions.ts src/feishu/cards.ts src/feishu/cards.test.ts src/claude/stream.ts src/integration.test.ts
rmdir src/feishu 2>/dev/null || true
```

- [ ] **Step 3: Verify compiles**

```bash
npx tsc --noEmit
```

Fix any remaining import issues if tsc reports errors.

- [ ] **Step 4: Run all tests**

```bash
npx vitest run
```

Preserved tests (config, db, session/manager, project/manager, command) should still pass. New tests (dedup, chat-queue, flush-controller, parse, gate, builder) should pass. Old tests (feishu/cards, integration) were deleted.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: complete pipeline rewrite — replace monolithic handler with 7-stage pipeline"
```

---

### Task 14: New Integration Test

**Files:**
- Create: `src/integration.test.ts`

- [ ] **Step 1: Write integration test**

```typescript
// src/integration.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from './session/db.js';
import { SessionManager } from './session/manager.js';
import { ProjectManager } from './project/manager.js';
import { parseCommand } from './utils/command.js';
import { CardBuilder } from './card/builder.js';
import { Dedup } from './messaging/inbound/dedup.js';
import { parseMessageEvent } from './messaging/inbound/parse.js';
import { checkGate } from './messaging/inbound/gate.js';
import { ChatQueue, buildQueueKey } from './channel/chat-queue.js';
import { existsSync, unlinkSync, rmSync } from 'fs';

const TEST_DB = '/tmp/rc-integration.db';
const TEST_WORKSPACE = '/tmp/rc-integration-workspace';

describe('Integration: pipeline flow', () => {
  let db: Database;
  let sm: SessionManager;
  let pm: ProjectManager;

  beforeEach(() => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    rmSync(TEST_WORKSPACE, { recursive: true, force: true });
    db = new Database(TEST_DB);
    sm = new SessionManager(db);
    pm = new ProjectManager(TEST_WORKSPACE);
  });

  afterEach(() => {
    db.close();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    rmSync(TEST_WORKSPACE, { recursive: true, force: true });
  });

  it('full flow: parse → gate → session → card', () => {
    // Parse
    const ctx = parseMessageEvent({
      app_id: 'cli_test',
      event_id: 'evt_1',
      message: {
        chat_id: 'oc_123', chat_type: 'p2p',
        content: JSON.stringify({ text: 'hello' }),
        message_type: 'text', message_id: 'msg_1',
        root_id: null, create_time: String(Date.now()),
      },
      sender: { sender_id: { open_id: 'ou_user1', user_id: null }, sender_type: 'user' },
    }, 'ou_bot');

    expect(ctx.text).toBe('hello');
    expect(ctx.chatType).toBe('p2p');

    // Gate
    const config = {
      feishu: { appId: 'cli_test', appSecret: '' },
      anthropicApiKey: undefined, workspaceDir: TEST_WORKSPACE,
      allowedUserIds: ['ou_user1'], allowedGroupIds: [],
      taskTimeoutMs: 300000, debounceMs: 500,
    };
    expect(checkGate(ctx, config)).toBe('pass');

    // Session
    db.upsertUser('ou_user1', 'User');
    const session = sm.getOrCreate('ou_user1', null, 'My Workspace');
    expect(session.id).toBeTruthy();

    // Card
    const thinking = CardBuilder.thinking('My Workspace');
    expect(thinking.header.template).toBe('blue');
    const done = CardBuilder.done('My Workspace', 'Result', 2);
    expect(done.header.template).toBe('green');
  });

  it('dedup + queue integration', async () => {
    const dedup = new Dedup({ maxSize: 10, ttlMs: 60000, staleMs: 120000 });
    const queue = new ChatQueue();

    expect(dedup.check('evt_1', Date.now())).toBe(true);
    expect(dedup.check('evt_1', Date.now())).toBe(false); // duplicate

    const order: number[] = [];
    queue.enqueue('oc_123', async () => { await new Promise(r => setTimeout(r, 30)); order.push(1); });
    queue.enqueue('oc_123', async () => { order.push(2); });
    await new Promise(r => setTimeout(r, 100));
    expect(order).toEqual([1, 2]);

    dedup.destroy();
  });

  it('command parsing + project manager', () => {
    const cmd = parseCommand('/project create new-service');
    expect(cmd).toEqual({ type: 'project', action: 'create', args: ['new-service'] });
    pm.create('new-service');
    expect(existsSync(pm.resolve('new-service'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run all tests**

```bash
npx vitest run
```

All tests should pass.

- [ ] **Step 3: Commit**

```bash
git add src/integration.test.ts
git commit -m "test: add pipeline integration test"
```

---

## Post-Implementation Notes

### Bot Open ID Setup

After deploying, set `BOT_OPEN_ID` in `.env`:
1. @机器人 in a group chat
2. Check the logs for the mention data — the bot's `open_id` is in `mentions[].id.open_id`
3. Set `BOT_OPEN_ID=ou_xxxxx` in `.env` and restart

Without this, group @mention detection won't work (a warning is logged on startup).

### Migration from v1

After the rewrite, the `src/feishu/` directory is deleted entirely. The old `DebouncedUpdater` in `claude/stream.ts` is replaced by `card/flush-controller.ts`. All session/project/config/executor code is preserved unchanged (except the one import path fix in executor.ts).
