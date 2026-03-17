export interface Config {
  feishu: {
    appId: string;
    appSecret: string;
  };
  anthropicApiKey: string;
  workspaceDir: string;
  allowedUserIds: string[];
  allowedGroupIds: string[];
  taskTimeoutMs: number;
  debounceMs: number;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function parseList(value: string | undefined): string[] {
  if (!value || value.trim() === '') return [];
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

export function loadConfig(): Config {
  return {
    feishu: {
      appId: requireEnv('FEISHU_APP_ID'),
      appSecret: requireEnv('FEISHU_APP_SECRET'),
    },
    anthropicApiKey: requireEnv('ANTHROPIC_API_KEY'),
    workspaceDir: requireEnv('WORKSPACE_DIR').replace(/^~/, process.env.HOME || ''),
    allowedUserIds: parseList(process.env.ALLOWED_USER_IDS),
    allowedGroupIds: parseList(process.env.ALLOWED_GROUP_IDS),
    taskTimeoutMs: parseInt(process.env.TASK_TIMEOUT_MS || '300000', 10),
    debounceMs: parseInt(process.env.DEBOUNCE_MS || '500', 10),
  };
}
