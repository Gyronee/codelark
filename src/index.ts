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

  // Isolate bot session storage from CLI if BOT_CLAUDE_HOME is set
  if (config.botClaudeHome) {
    process.env.HOME = config.botClaudeHome;
    logger.info({ botClaudeHome: config.botClaudeHome }, 'Using isolated HOME for bot sessions — CLI session resume disabled');
  } else {
    logger.warn('BOT_CLAUDE_HOME not set — bot sessions will be visible to CLI tools like /insights. Set BOT_CLAUDE_HOME to isolate.');
  }

  logger.info({ workspaceDir: config.workspaceDir }, 'Starting codelark');

  const dbPath = join(config.workspaceDir, 'codelark.db');
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
  logger.info('codelark is ready');

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down...');
    registry.abortAll();
    // Give in-flight card updates a moment to complete
    await new Promise(r => setTimeout(r, 1000));
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
