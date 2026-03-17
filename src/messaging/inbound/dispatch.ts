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
  db.upsertUser(ctx.senderId, ctx.senderName);

  const cmd = parseCommand(ctx.text);
  if (cmd) {
    await handleCommand(cmd, ctx, config, db, sessionManager, projectManager);
    return;
  }

  if (ctx.messageType !== 'text') {
    await sendText(ctx.chatId, '目前仅支持文本消息。', ctx.threadId ?? undefined);
    return;
  }

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
  const reply = (text: string) => sendText(ctx.chatId, text, ctx.threadId ?? undefined);

  switch (cmd.type) {
    case 'help': {
      const help = [
        '📋 可用命令：', '',
        '/help — 显示帮助信息',
        '/status — 查看当前项目和任务状态',
        '/whoami — 查看你的 open_id', '',
        '💬 会话：',
        '/reset — 重置当前对话上下文',
        '/cancel — 取消正在执行的任务', '',
        '📁 项目管理：',
        '/project list — 列出所有项目',
        '/project use <名称> — 切换到指定项目',
        '/project create <名称> — 创建新空项目',
        '/project clone <地址> — 克隆 Git 仓库（仅支持 https）', '',
        '直接发送文字即可与 Claude Code 对话。',
        '无需设置项目，系统会自动为你创建独立的工作目录。',
      ];
      await reply(help.join('\n'));
      break;
    }
    case 'whoami':
      await reply(`open_id: ${ctx.senderId}`);
      break;
    case 'status': {
      const user = db.getUser(ctx.senderId);
      const active = registry.getByUserId(ctx.senderId);
      await reply(`Project: ${user?.active_project || '(default)'}\nTask running: ${active ? 'yes' : 'no'}`);
      break;
    }
    case 'reset': {
      const user = db.getUser(ctx.senderId);
      const project = user?.active_project || 'My Workspace';
      sessionManager.reset(ctx.senderId, ctx.threadId, project);
      await reply('Session reset.');
      break;
    }
    case 'cancel':
      await reply('没有正在执行的任务。');
      break;
    case 'project':
      await handleProjectCommand(cmd, ctx, db, projectManager, reply);
      break;
  }
}

async function handleProjectCommand(
  cmd: NonNullable<ReturnType<typeof parseCommand>>,
  ctx: MessageContext,
  db: Database,
  projectManager: ProjectManager,
  reply: (text: string) => Promise<void>,
): Promise<void> {
  switch (cmd.action) {
    case 'list': {
      const projects = projectManager.list();
      if (projects.length === 0) { await reply('没有已配置的项目。使用 /project create <名称> 或 /project clone <地址>。'); return; }
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
    default: await reply(`未知项目命令: ${cmd.action}`);
  }
}

async function handleClaudeTask(
  ctx: MessageContext, config: Config, db: Database,
  sessionManager: SessionManager, projectManager: ProjectManager,
): Promise<void> {
  const existing = registry.getByUserId(ctx.senderId);
  if (existing) {
    await sendText(ctx.chatId, '上一个任务还在执行中，请等待完成或发送 /cancel 取消。', ctx.threadId ?? undefined);
    return;
  }

  const user = db.getUser(ctx.senderId);
  const projectName = user?.active_project || 'My Workspace';
  let projectPath: string;
  if (user?.active_project) {
    try { projectPath = projectManager.resolve(user.active_project); }
    catch (e: any) { await sendText(ctx.chatId, e.message, ctx.threadId ?? undefined); return; }
  } else {
    projectPath = projectManager.ensureUserDefault(ctx.senderId);
  }

  const session = sessionManager.getOrCreate(ctx.senderId, ctx.threadId, projectName);
  const card = new StreamingCard(ctx.chatId, ctx.threadId, config.debounceMs);
  await card.create(CardBuilder.thinking(projectName));

  const abortController = new AbortController();
  const queueKey = buildQueueKey(ctx.chatId, ctx.threadId);
  registry.setActive(queueKey, { abortController, abortCard: () => card.abortCard(), userId: ctx.senderId });

  const timeout = setTimeout(() => abortController.abort(), config.taskTimeoutMs);
  const tools: ToolStatus[] = [];
  const startTime = Date.now();

  await executeClaudeTask(ctx.text, projectPath, session.claude_session_id, abortController, {
    onText: (fullText) => { card.scheduleUpdate(CardBuilder.working(projectName, fullText, tools)); },
    onToolStart: (tool, detail) => {
      tools.push({ tool, status: 'running', detail });
      card.scheduleUpdate(CardBuilder.working(projectName, '', tools));
    },
    onToolEnd: (tool, _detail) => {
      const match = tools.find(t => t.tool === tool && t.status === 'running') || tools.find(t => t.status === 'running');
      if (match) match.status = 'done';
    },
    onPermissionRequest: async (toolName, input) => {
      const taskId = `perm-${Date.now()}`;
      const command = toolName === 'Bash' ? String((input as any).command || toolName) : `${toolName}(${JSON.stringify(input).slice(0, 100)})`;
      await sendCard(ctx.chatId, CardBuilder.confirm(projectName, command, taskId), ctx.threadId ?? undefined);
      return requestPermission(taskId);
    },
    onComplete: async (result: ExecutionResult) => {
      clearTimeout(timeout);
      registry.removeActive(queueKey);
      if (result.sessionId) db.updateClaudeSessionId(session.id, result.sessionId);
      db.logTask(session.id, ctx.text, result.text, JSON.stringify(tools.map(t => t.tool)), result.durationMs, 'success');
      if (card.isTerminal) { await card.fallbackText(CardBuilder.buildFallbackText(result.text)); }
      else { await card.complete(CardBuilder.done(projectName, result.text, result.toolCount)); }
    },
    onError: async (error) => {
      clearTimeout(timeout);
      registry.removeActive(queueKey);
      db.logTask(session.id, ctx.text, error, null, Date.now() - startTime, 'error');
      if (abortController.signal.aborted) {
        if (!card.isTerminal) await card.abort(CardBuilder.cancelled(projectName));
      } else {
        if (card.isTerminal) await card.fallbackText(error);
        else await card.error(CardBuilder.error(projectName, error));
      }
    },
  });
}
