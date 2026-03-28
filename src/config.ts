export interface Config {
  feishu: {
    appId: string;
    appSecret: string;
  };
  anthropicApiKey: string | undefined;
  workspaceDir: string;
  allowedUserIds: string[];
  allowedGroupIds: string[];
  adminUserIds: string[];
  taskTimeoutMs: number;
  debounceMs: number;
  botOpenId: string;
  sessionTitledOnly: boolean;  // /session list only shows sessions with customTitle
  botClaudeHome: string | null; // 独立 HOME 目录，隔离 bot session 和 CLI session
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
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    workspaceDir: requireEnv('WORKSPACE_DIR').replace(/^~/, process.env.HOME || ''),
    allowedUserIds: parseList(process.env.ALLOWED_USER_IDS),
    allowedGroupIds: parseList(process.env.ALLOWED_GROUP_IDS),
    taskTimeoutMs: Number(process.env.TASK_TIMEOUT_MS) || 300000,
    debounceMs: Number(process.env.DEBOUNCE_MS) || 500,
    botOpenId: process.env.BOT_OPEN_ID || '',
    sessionTitledOnly: process.env.SESSION_TITLED_ONLY === 'true',
    adminUserIds: parseList(process.env.ADMIN_USER_IDS),
    botClaudeHome: process.env.BOT_CLAUDE_HOME || null,
  };
}
