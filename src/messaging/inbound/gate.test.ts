import { describe, it, expect } from 'vitest';
import { checkGate } from './gate.js';
import type { MessageContext } from '../types.js';
import type { Config } from '../../config.js';

const makeCtx = (o: Partial<MessageContext> = {}): MessageContext => ({
  eventId: 'e1', messageId: 'm1', chatId: 'oc_123', chatType: 'p2p',
  threadId: null, senderId: 'ou_user1', senderName: 'User', text: 'hello',
  rawText: 'hello', messageType: 'text', mentions: [], botMentioned: false,
  createTime: Date.now(), appId: 'cli_test', parentMessageId: null, quotedContent: null, quotedMessageId: null, resources: [], ...o,
});

const makeConfig = (o: Partial<Config> = {}): Config => ({
  feishu: { appId: 'cli_test', appSecret: 's' }, anthropicApiKey: undefined,
  workspaceDir: '/tmp', allowedUserIds: [], allowedGroupIds: [], adminUserIds: [],
  taskTimeoutMs: 300000, debounceMs: 500, botOpenId: '', sessionTitledOnly: false, botClaudeHome: null, ...o,
});

describe('checkGate', () => {
  it('always passes /whoami', () => {
    expect(checkGate(makeCtx({ text: '/whoami' }), makeConfig({ allowedUserIds: ['ou_other'] }))).toBe('pass');
  });
  it('passes when no allowlist', () => {
    expect(checkGate(makeCtx(), makeConfig())).toBe('pass');
  });
  it('rejects user not in allowlist', () => {
    expect(checkGate(makeCtx(), makeConfig({ allowedUserIds: ['ou_other'] }))).toBe('reject');
  });
  it('passes user in allowlist', () => {
    expect(checkGate(makeCtx(), makeConfig({ allowedUserIds: ['ou_user1'] }))).toBe('pass');
  });
  it('rejects group not in allowlist', () => {
    expect(checkGate(makeCtx({ chatType: 'group', botMentioned: true }), makeConfig({ allowedGroupIds: ['oc_other'] }))).toBe('reject');
  });
  it('rejects group without mention', () => {
    expect(checkGate(makeCtx({ chatType: 'group', botMentioned: false }), makeConfig())).toBe('reject');
  });
  it('passes group with mention', () => {
    expect(checkGate(makeCtx({ chatType: 'group', botMentioned: true }), makeConfig())).toBe('pass');
  });
});
