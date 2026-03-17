import * as Lark from '@larksuiteoapi/node-sdk';
import type { Config } from '../config.js';
import { FeishuClient } from './client.js';
import { SessionManager } from '../session/manager.js';
import { Database } from '../session/db.js';
import { ProjectManager } from '../project/manager.js';
import { CardBuilder, type ToolStatus } from './cards.js';
import { DebouncedUpdater } from '../claude/stream.js';
import { executeClaudeTask, type ExecutionResult } from '../claude/executor.js';
import { parseCommand, type ParsedCommand } from '../utils/command.js';
import { handleCardAction, type CardAction } from './actions.js';
import { logger } from '../logger.js';

const pendingPermissions = new Map<string, (allowed: boolean) => void>();

export class MessageHandler {
  constructor(
    private config: Config,
    private feishu: FeishuClient,
    private sessionManager: SessionManager,
    private projectManager: ProjectManager,
    private db: Database,
  ) {}

  createEventDispatcher(): Lark.EventDispatcher {
    return new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: any) => {
        try {
          await this.handleMessage(data);
        } catch (err) {
          logger.error({ err }, 'Unhandled error in message handler');
        }
      },
    });
  }

  createCardActionHandler(): Lark.CardActionHandler {
    return new Lark.CardActionHandler(
      {},
      async (data: any) => {
        const userId = data?.operator?.user_id;
        const actionValue = data?.action?.value as CardAction | undefined;
        if (!userId || !actionValue) return;

        if (actionValue.action === 'confirm_danger' || actionValue.action === 'reject_danger') {
          const taskId = actionValue.taskId;
          if (taskId) {
            const resolve = pendingPermissions.get(taskId);
            if (resolve) {
              resolve(actionValue.action === 'confirm_danger');
              pendingPermissions.delete(taskId);
            }
          }
          return;
        }

        handleCardAction(actionValue, userId, this.sessionManager, this.db);
      },
    );
  }

  requestPermission(taskId: string): Promise<boolean> {
    return new Promise((resolve) => {
      pendingPermissions.set(taskId, resolve);
      setTimeout(() => {
        if (pendingPermissions.has(taskId)) {
          pendingPermissions.delete(taskId);
          resolve(false);
        }
      }, 60_000);
    });
  }

  private async handleMessage(data: any): Promise<void> {
    const { message, sender } = data;
    const userId = sender?.sender_id?.user_id;
    const chatId = message?.chat_id;
    const msgType = message?.message_type;
    const content = message?.content ? JSON.parse(message.content) : {};
    const text = content?.text?.replace(/@_user_\d+/g, '').trim() || '';
    const topicId = message?.root_id || null;

    if (!userId || !chatId) return;

    // Auth: user allowlist
    if (this.config.allowedUserIds.length > 0 && !this.config.allowedUserIds.includes(userId)) {
      logger.warn({ userId }, 'Unauthorized user');
      return;
    }

    // Auth: group allowlist
    const chatType = message?.chat_type;
    if (chatType === 'group' && this.config.allowedGroupIds.length > 0
        && !this.config.allowedGroupIds.includes(chatId)) {
      logger.warn({ chatId }, 'Unauthorized group');
      return;
    }

    if (msgType !== 'text') {
      await this.feishu.sendText(chatId, 'Currently only text messages are supported.');
      return;
    }

    this.db.upsertUser(userId, sender?.sender_id?.id || null);

    const cmd = parseCommand(text);
    if (cmd) {
      await this.handleCommand(cmd, userId, chatId, topicId);
      return;
    }

    await this.handleClaudeMessage(text, userId, chatId, topicId);
  }

  private async handleCommand(cmd: ParsedCommand, userId: string, chatId: string, topicId: string | null): Promise<void> {
    switch (cmd.type) {
      case 'project':
        await this.handleProjectCommand(cmd, userId, chatId);
        break;
      case 'reset': {
        const user = this.db.getUser(userId);
        if (!user?.active_project) {
          await this.feishu.sendText(chatId, 'No active project. Use /project use <name> first.');
          return;
        }
        this.sessionManager.reset(userId, topicId, user.active_project);
        await this.feishu.sendText(chatId, 'Session reset.');
        break;
      }
      case 'cancel':
        if (this.sessionManager.hasActiveTask(userId)) {
          this.sessionManager.cancelTask(userId);
          await this.feishu.sendText(chatId, 'Task cancelled.');
        } else {
          await this.feishu.sendText(chatId, 'No active task to cancel.');
        }
        break;
      case 'status': {
        const user = this.db.getUser(userId);
        const hasTask = this.sessionManager.hasActiveTask(userId);
        await this.feishu.sendText(chatId,
          `Project: ${user?.active_project || '(none)'}\nTask running: ${hasTask ? 'yes' : 'no'}`);
        break;
      }
    }
  }

  private async handleProjectCommand(cmd: ParsedCommand, userId: string, chatId: string): Promise<void> {
    switch (cmd.action) {
      case 'list': {
        const projects = this.projectManager.list();
        if (projects.length === 0) {
          await this.feishu.sendText(chatId, 'No projects configured. Use /project create <name> or /project clone <url>.');
          return;
        }
        const list = projects.map(p => `• ${p.name}${p.description ? ` — ${p.description}` : ''}`).join('\n');
        await this.feishu.sendText(chatId, list);
        break;
      }
      case 'use': {
        const name = cmd.args[0];
        if (!name) { await this.feishu.sendText(chatId, 'Usage: /project use <name>'); return; }
        try {
          this.projectManager.resolve(name);
          this.db.setActiveProject(userId, name);
          await this.feishu.sendText(chatId, `Switched to project: ${name}`);
        } catch (err: any) {
          await this.feishu.sendText(chatId, err.message);
        }
        break;
      }
      case 'create': {
        const name = cmd.args[0];
        if (!name) { await this.feishu.sendText(chatId, 'Usage: /project create <name>'); return; }
        try {
          this.projectManager.create(name);
          this.db.setActiveProject(userId, name);
          await this.feishu.sendText(chatId, `Project created: ${name}`);
        } catch (err: any) {
          await this.feishu.sendText(chatId, err.message);
        }
        break;
      }
      case 'clone': {
        const url = cmd.args[0];
        if (!url) { await this.feishu.sendText(chatId, 'Usage: /project clone <https://url>'); return; }
        try {
          await this.feishu.sendText(chatId, `Cloning ${url}...`);
          const { name } = await this.projectManager.clone(url);
          this.db.setActiveProject(userId, name);
          await this.feishu.sendText(chatId, `Cloned and switched to: ${name}`);
        } catch (err: any) {
          await this.feishu.sendText(chatId, err.message);
        }
        break;
      }
      default:
        await this.feishu.sendText(chatId, `Unknown project command: ${cmd.action}`);
    }
  }

  private async handleClaudeMessage(text: string, userId: string, chatId: string, topicId: string | null): Promise<void> {
    const user = this.db.getUser(userId);
    const projectName = user?.active_project;
    if (!projectName) {
      await this.feishu.sendText(chatId, 'No active project. Use /project use <name>, /project create <name>, or /project clone <url> first.');
      return;
    }

    if (this.sessionManager.hasActiveTask(userId)) {
      await this.feishu.sendText(chatId, 'Your previous task is still running. Wait for it to finish or send /cancel.');
      return;
    }

    let projectPath: string;
    try {
      projectPath = this.projectManager.resolve(projectName);
    } catch (err: any) {
      await this.feishu.sendText(chatId, err.message);
      return;
    }

    const session = this.sessionManager.getOrCreate(userId, topicId, projectName);

    const thinkingCard = CardBuilder.thinking(projectName);
    const messageId = await this.feishu.sendCard(chatId, thinkingCard);
    if (!messageId) return;

    const abortController = new AbortController();
    this.sessionManager.setActiveTask(userId, abortController);

    const timeout = setTimeout(() => {
      abortController.abort();
    }, this.config.taskTimeoutMs);

    const tools: ToolStatus[] = [];
    const startTime = Date.now();

    const updater = new DebouncedUpdater(async (content: string) => {
      const card = CardBuilder.working(projectName, content, tools);
      await this.feishu.updateCard(messageId, card);
    }, this.config.debounceMs);

    await executeClaudeTask(
      text,
      projectPath,
      session.claude_session_id,
      abortController,
      {
        onText: (fullText) => {
          updater.schedule(fullText);
        },
        onToolStart: (tool, detail) => {
          tools.push({ tool, status: 'running', detail });
          const card = CardBuilder.working(projectName, '', tools);
          this.feishu.updateCard(messageId, card).catch(() => {});
        },
        onToolEnd: (tool, _detail) => {
          const match = tools.find(t => t.tool === tool && t.status === 'running')
            || tools.find(t => t.status === 'running');
          if (match) match.status = 'done';
        },
        onPermissionRequest: async (toolName, input) => {
          const taskId = `perm-${Date.now()}`;
          const command = toolName === 'Bash'
            ? String((input as any).command || toolName)
            : `${toolName}(${JSON.stringify(input).slice(0, 100)})`;
          const confirmCard = CardBuilder.confirm(projectName, command, taskId);
          await this.feishu.sendCard(chatId, confirmCard);
          return this.requestPermission(taskId);
        },
        onComplete: async (result: ExecutionResult) => {
          clearTimeout(timeout);
          await updater.flush();
          updater.destroy();
          this.sessionManager.clearActiveTask(userId);

          if (result.sessionId) {
            this.db.updateClaudeSessionId(session.id, result.sessionId);
          }

          this.db.logTask(session.id, text, result.text, JSON.stringify(tools.map(t => t.tool)), result.durationMs, 'success');

          const card = CardBuilder.done(projectName, result.text, result.toolCount);
          await this.feishu.updateCard(messageId, card);
        },
        onError: async (error) => {
          clearTimeout(timeout);
          updater.destroy();
          this.sessionManager.clearActiveTask(userId);
          const durationMs = Date.now() - startTime;
          this.db.logTask(session.id, text, error, null, durationMs, 'error');

          if (abortController.signal.aborted) {
            const card = CardBuilder.cancelled(projectName);
            await this.feishu.updateCard(messageId, card);
          } else {
            const card = CardBuilder.error(projectName, error);
            await this.feishu.updateCard(messageId, card);
          }
        },
      },
    );
  }
}
