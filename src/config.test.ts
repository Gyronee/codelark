import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('loads required config from env', () => {
    process.env.FEISHU_APP_ID = 'test_app_id';
    process.env.FEISHU_APP_SECRET = 'test_secret';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    process.env.WORKSPACE_DIR = '/tmp/workspaces';
    process.env.ALLOWED_USER_IDS = 'ou_1,ou_2';
    process.env.ALLOWED_GROUP_IDS = 'oc_1';

    const config = loadConfig();
    expect(config.feishu.appId).toBe('test_app_id');
    expect(config.feishu.appSecret).toBe('test_secret');
    expect(config.anthropicApiKey).toBe('sk-ant-test');
    expect(config.workspaceDir).toBe('/tmp/workspaces');
    expect(config.allowedUserIds).toEqual(['ou_1', 'ou_2']);
    expect(config.allowedGroupIds).toEqual(['oc_1']);
  });

  it('throws if required env vars are missing', () => {
    delete process.env.FEISHU_APP_ID;
    expect(() => loadConfig()).toThrow('FEISHU_APP_ID');
  });

  it('defaults allowedUserIds to empty array when not set', () => {
    process.env.FEISHU_APP_ID = 'id';
    process.env.FEISHU_APP_SECRET = 'secret';
    process.env.ANTHROPIC_API_KEY = 'key';
    process.env.WORKSPACE_DIR = '/tmp/ws';

    const config = loadConfig();
    expect(config.allowedUserIds).toEqual([]);
  });
});
