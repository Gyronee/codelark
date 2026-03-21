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
    const ctx = parseMessageEvent({
      app_id: 'cli_test', event_id: 'evt_1',
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

    const config = {
      feishu: { appId: 'cli_test', appSecret: '' },
      anthropicApiKey: undefined, workspaceDir: TEST_WORKSPACE,
      allowedUserIds: ['ou_user1'], allowedGroupIds: [],
      taskTimeoutMs: 300000, debounceMs: 500, botOpenId: 'ou_bot', sessionTitledOnly: false,
    };
    expect(checkGate(ctx, config)).toBe('pass');

    db.upsertUser('ou_user1', 'User');
    const session = sm.getOrCreate('ou_user1', null, 'My Workspace');
    expect(session.id).toBeTruthy();

    const thinking = CardBuilder.thinking('My Workspace');
    expect(thinking.header?.template).toBe('blue');
    const done = CardBuilder.done('My Workspace', 'Result', 2);
    expect(done.header).toBeUndefined(); // done cards are headerless
    expect(JSON.stringify(done)).toContain('已完成');
  });

  it('dedup + queue integration', async () => {
    const dedup = new Dedup({ maxSize: 10, ttlMs: 60000, staleMs: 120000 });
    const queue = new ChatQueue();

    expect(dedup.check('evt_1', Date.now())).toBe(true);
    expect(dedup.check('evt_1', Date.now())).toBe(false);

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
