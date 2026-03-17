import { describe, it, expect } from 'vitest';
import { parseMessageEvent } from './parse.js';

const makeEvent = (overrides: any = {}) => ({
  app_id: 'cli_test', event_id: 'evt_1',
  message: {
    chat_id: 'oc_123', chat_type: 'p2p',
    content: JSON.stringify({ text: '/whoami' }),
    message_type: 'text', message_id: 'msg_1',
    root_id: null, create_time: String(Date.now()),
    mentions: undefined,
    ...overrides.message,
  },
  sender: {
    sender_id: { open_id: 'ou_abc', user_id: null, union_id: 'on_xyz' },
    sender_type: 'user', ...overrides.sender,
  },
  ...overrides,
});

describe('parseMessageEvent', () => {
  it('parses simple p2p text', () => {
    const ctx = parseMessageEvent(makeEvent(), 'ou_bot');
    expect(ctx.text).toBe('/whoami');
    expect(ctx.chatType).toBe('p2p');
    expect(ctx.senderId).toBe('ou_abc');
    expect(ctx.botMentioned).toBe(false);
  });
  it('parses mentions and strips bot mention', () => {
    const ctx = parseMessageEvent(makeEvent({
      message: {
        chat_type: 'group',
        content: JSON.stringify({ text: '@_user_1 hello' }),
        mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot', user_id: null }, name: 'Bot', tenant_key: 'tk' }],
      },
    }), 'ou_bot');
    expect(ctx.botMentioned).toBe(true);
    expect(ctx.text).toBe('hello');
    expect(ctx.mentions).toHaveLength(1);
    expect(ctx.mentions[0].isBot).toBe(true);
  });
  it('extracts threadId from root_id', () => {
    const ctx = parseMessageEvent(makeEvent({ message: { root_id: 'thread_42' } }), 'ou_bot');
    expect(ctx.threadId).toBe('thread_42');
  });
});
