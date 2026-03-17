import 'dotenv/config';
import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { Database } from './session/db.js';
import { SessionManager } from './session/manager.js';
import { ProjectManager } from './project/manager.js';
import { FeishuClient } from './feishu/client.js';
import { MessageHandler } from './feishu/handler.js';
import { join } from 'path';

async function main(): Promise<void> {
  const config = loadConfig();
  logger.info({ workspaceDir: config.workspaceDir }, 'Starting remote-control');

  // Initialize database
  const dbPath = join(config.workspaceDir, 'remote-control.db');
  const db = new Database(dbPath);

  // Initialize managers
  const sessionManager = new SessionManager(db);
  const projectManager = new ProjectManager(config.workspaceDir);

  // Cleanup old tmp projects on startup
  projectManager.cleanupTmp();

  // Initialize Feishu client
  const feishu = new FeishuClient(config);
  const handler = new MessageHandler(config, feishu, sessionManager, projectManager, db);

  // Start WebSocket connection
  const dispatcher = handler.createEventDispatcher();
  feishu.start(dispatcher);

  logger.info('remote-control is ready');

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down...');
    sessionManager.cancelAll();
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
