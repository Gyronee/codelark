import type { MessageContext } from '../types.js';
import type { Config } from '../../config.js';
import type { Database } from '../../session/db.js';
import type { SessionManager } from '../../session/manager.js';
import type { ProjectManager } from '../../project/manager.js';
import { parseCommand } from '../../utils/command.js';
import { resolve, basename, sep } from 'path';
import { realpathSync, statSync, unlinkSync } from 'fs';
import { sendText, sendCard, updateCard, uploadFile, sendFile } from '../outbound/send.js';
import { StreamingCard } from '../../card/streaming-card.js';
import { CardBuilder, type ToolStatus } from '../../card/builder.js';
import { executeClaudeTask, type ExecutionResult } from '../../claude/executor.js';
import { requestPermission } from './card-actions.js';
import * as registry from '../../channel/active-registry.js';
import { buildQueueKey } from '../../channel/chat-queue.js';
import { getRecentHistory, formatHistoryContext } from '../../channel/chat-history.js';
import { getUserModel, setUserModel, listModels } from '../../channel/user-model.js';
import { downloadImage, downloadFile } from './media.js';
import { logger } from '../../logger.js';

const DEFAULT_PROJECT_LABEL = 'My Workspace';

function formatTimeAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return '刚刚';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  return `${Math.floor(diff / 86400_000)} 天前`;
}

function resolveProjectPath(
  senderId: string, db: Database, projectManager: ProjectManager,
): { projectName: string; projectPath: string } {
  const user = db.getUser(senderId);
  if (user?.active_project) {
    return { projectName: user.active_project, projectPath: projectManager.resolve(user.active_project) };
  }
  return { projectName: DEFAULT_PROJECT_LABEL, projectPath: projectManager.ensureUserDefault(senderId) };
}

export async function dispatch(
  ctx: MessageContext,
  config: Config,
  db: Database,
  sessionManager: SessionManager,
  projectManager: ProjectManager,
): Promise<void> {
  db.upsertUser(ctx.senderId, ctx.senderName);
  const threadId = ctx.threadId ?? undefined;

  const cmd = parseCommand(ctx.text);
  if (cmd) {
    await handleCommand(cmd, ctx, config, db, sessionManager, projectManager);
    return;
  }

  if (!['text', 'image', 'file', 'post'].includes(ctx.messageType)) {
    await sendText(ctx.chatId, '暂不支持该消息类型，请发送文字、图片或文件。', threadId);
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
  const threadId = ctx.threadId ?? undefined;
  const reply = (text: string) => sendText(ctx.chatId, text, threadId);

  switch (cmd.type) {
    case 'help': {
      const help = [
        '📋 可用命令：', '',
        '/help — 显示帮助信息',
        '/status — 查看当前项目和任务状态',
        '/whoami — 查看你的 open_id', '',
        '💬 会话：',
        '/reset — 重置当前对话上下文',
        '/cancel — 取消正在执行的任务',
        '/model — 查看/切换模型（opus, sonnet, haiku）', '',
        '📁 项目管理：',
        '/project list — 列出所有项目',
        '/project use <名称> — 切换到指定项目',
        '/project create <名称> — 创建新空项目',
        '/project clone <地址> — 克隆 Git 仓库（仅支持 https）',
        '/project home — 切换到个人目录',
        '/file <path> — 从项目目录获取文件',
        '/auth — 授权飞书账号（文档读写）', '',
        '🖥️ 本地会话：',
        '/session list — 列出本地 Claude Code 会话',
        '/session resume <ID> — 恢复指定会话',
        '/session exit — 退出恢复模式', '',
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
      const lines = [
        `📁 项目: ${user?.active_project || '个人目录'}`,
        `⚡ 任务: ${active ? '执行中' : '空闲'}`,
      ];
      if (user?.resumed_session_id) {
        const shortId = user.resumed_session_id.slice(0, 8);
        const projectName = user.resumed_cwd?.split('/').pop() || '未知';
        lines.push(`🔄 恢复会话: ${shortId} (${projectName})`);
      }
      await reply(lines.join('\n'));
      break;
    }
    case 'reset': {
      const user = db.getUser(ctx.senderId);
      const project = user?.active_project || DEFAULT_PROJECT_LABEL;
      sessionManager.reset(ctx.senderId, ctx.threadId, project);
      await reply('对话上下文已重置。');
      break;
    }
    case 'cancel':
      await reply('没有正在执行的任务。');
      break;
    case 'project':
      await handleProjectCommand(cmd, ctx, db, projectManager, reply);
      break;
    case 'model': {
      if (!cmd.action) {
        const current = getUserModel(ctx.senderId);
        const models = listModels();
        await reply(`当前模型: ${current}\n\n可用模型:\n${models.map(m => `• ${m}`).join('\n')}\n\n用法: /model <名称>\n快捷: /model opus, /model sonnet, /model haiku`);
      } else {
        const resolved = setUserModel(ctx.senderId, cmd.action);
        if (resolved) {
          await reply(`模型已切换为: ${resolved}`);
        } else {
          await reply(`无效模型: ${cmd.action}\n可用: ${listModels().join(', ')}\n快捷: opus, sonnet, haiku`);
        }
      }
      break;
    }
    case 'file': {
      const filePath = cmd.args.join(' ');
      if (!filePath) {
        await sendText(ctx.chatId, '用法: /file <文件路径>', threadId);
        return;
      }
      const { projectPath: projectDir } = resolveProjectPath(ctx.senderId, db, projectManager);
      const fullPath = resolve(projectDir, filePath);

      // Security: path traversal prevention (resolve symlinks to catch ../.. tricks)
      const realProjectDir = realpathSync(projectDir);
      let realFullPath: string;
      try { realFullPath = realpathSync(fullPath); }
      catch { await sendText(ctx.chatId, `文件不存在: ${filePath}`, threadId); return; }
      if (!realFullPath.startsWith(realProjectDir + sep)) {
        await sendText(ctx.chatId, '路径不合法：不能访问项目目录以外的文件', threadId);
        return;
      }
      const stats = statSync(fullPath);
      if (stats.size > 1024 * 1024) {
        await sendText(ctx.chatId, `文件过大 (${(stats.size / 1024 / 1024).toFixed(1)}MB)，上限 1MB。后续将支持通过飞书文档查看。`, threadId);
        return;
      }
      const fileName = basename(fullPath);
      const fileKey = await uploadFile(fullPath, fileName);
      await sendFile(ctx.chatId, fileKey, threadId);
      return;
    }
    case 'auth': {
      const { requestDeviceAuthorization, pollDeviceToken } = await import('../../auth/device-flow.js');
      const { buildOAuthCard, buildOAuthSuccessCard, buildOAuthFailedCard } = await import('../../auth/oauth-card.js');

      try {
        const scopes = 'docx:document:create docx:document:readonly docx:document:write_only';
        const deviceAuth = await requestDeviceAuthorization(config.feishu.appId, config.feishu.appSecret, scopes);
        const card = buildOAuthCard(deviceAuth.verificationUriComplete, deviceAuth.userCode);
        const messageId = await sendCard(ctx.chatId, card, threadId);

        // Poll in background (fire-and-forget)
        pollDeviceToken({
          appId: config.feishu.appId,
          appSecret: config.feishu.appSecret,
          deviceCode: deviceAuth.deviceCode,
          interval: deviceAuth.interval,
          expiresIn: deviceAuth.expiresIn,
        }).then(async (result) => {
          if (result.ok) {
            // Verify identity to prevent group chat hijacking
            try {
              const identityResp = await fetch('https://open.feishu.cn/open-apis/authen/v1/user_info', {
                headers: { Authorization: `Bearer ${result.token.accessToken}` },
              });
              const identity = await identityResp.json() as { data?: { open_id?: string } };
              const actualOpenId = identity.data?.open_id;
              if (actualOpenId && actualOpenId !== ctx.senderId) {
                if (messageId) await updateCard(messageId, buildOAuthFailedCard('授权用户与发起用户不匹配'));
                return;
              }
            } catch (err) {
              logger.warn({ err }, 'Identity verification failed');
              if (messageId) await updateCard(messageId, CardBuilder.status('✗ 身份验证失败，请重试'));
              return;
            }

            const now = Date.now();
            db.saveToken(ctx.senderId, {
              accessToken: result.token.accessToken,
              refreshToken: result.token.refreshToken,
              expiresAt: now + result.token.expiresIn * 1000,
              refreshExpiresAt: now + result.token.refreshExpiresIn * 1000,
              scope: result.token.scope,
              grantedAt: now,
            });
            if (messageId) await updateCard(messageId, buildOAuthSuccessCard());
          } else {
            if (messageId) await updateCard(messageId, buildOAuthFailedCard(result.message));
          }
        }).catch(err => logger.error({ err }, 'OAuth polling failed'));

        return;
      } catch (err: any) {
        await reply(`授权发起失败: ${err.message}`);
        return;
      }
    }
    case 'session': {
      const { listLocalSessions, findSessionById, getRecentMessages } = await import('../../session/local-sessions.js');

      if (cmd.action === 'list' || !cmd.action) {
        let sessions = listLocalSessions(20);
        if (config.sessionTitledOnly) {
          sessions = sessions.filter(s => s.hasCustomTitle);
        }
        sessions = sessions.slice(0, 10);
        if (sessions.length === 0) {
          await reply('没有发现本地 Claude Code 会话。');
          return;
        }
        const lines: string[] = [];
        for (let i = 0; i < sessions.length; i++) {
          const s = sessions[i];
          const ago = formatTimeAgo(s.lastModified);
          const status = s.isActive ? ' · 🔒 使用中' : '';
          const title = s.summary !== s.sessionId.slice(0, 8) ? `**${s.summary}**` : '_(未命名)_';
          lines.push(`${i + 1}. ${title}${status}\n    📁 ${s.projectName} · 🕐 ${ago} · ID: ${s.sessionId.slice(0, 8)}`);
        }
        lines.push('---\n输入 /session resume ID 恢复会话');
        await sendCard(ctx.chatId, {
          header: { title: { tag: 'plain_text', content: '📋 本地 Claude Code 会话' }, template: 'blue' },
          elements: [{ tag: 'markdown', content: lines.join('\n\n') }],
        }, threadId);
        return;
      }

      if (cmd.action === 'resume') {
        const idPrefix = cmd.args[0];
        if (!idPrefix) { await reply('用法: /session resume <ID>'); return; }

        const session = findSessionById(idPrefix);
        if (!session) { await reply(`未找到 ID 以 "${idPrefix}" 开头的会话`); return; }
        if (session.isActive) {
          await reply(`该会话正在被本地 CLI 使用中 (PID: ${session.activePid})，请先关闭本地会话。`);
          return;
        }

        db.setResumedSession(ctx.senderId, session.sessionId, session.cwd);

        const messages = getRecentMessages(session.sessionId, 5);
        const lines = [
          `**${session.summary}**`,
          `📁 ${session.projectName} · 🕐 ${formatTimeAgo(session.lastModified)}`,
        ];
        if (messages.length > 0) {
          lines.push('---', '**最近对话：**');
          for (const m of messages) {
            const icon = m.role === 'user' ? '👤' : '🤖';
            const text = m.text.slice(0, 120) + (m.text.length > 120 ? '...' : '');
            lines.push(`${icon} ${text}`);
          }
        }
        lines.push('---', '会话已恢复，直接发消息继续对话。\n输入 /session exit 退出恢复模式。');
        await sendCard(ctx.chatId, {
          header: { title: { tag: 'plain_text', content: '🔄 已恢复会话' }, template: 'green' },
          elements: [{ tag: 'markdown', content: lines.join('\n') }],
        }, threadId);
        return;
      }

      if (cmd.action === 'exit') {
        const user = db.getUser(ctx.senderId);
        if (user?.resumed_session_id) {
          db.clearResumedSession(ctx.senderId);
          await reply('已退出恢复模式，回到正常会话。');
        } else {
          await reply('当前没有恢复的会话。');
        }
        return;
      }

      await reply('用法: /session list | resume <ID> | exit');
      return;
    }
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
    case 'home': {
      db.setActiveProject(ctx.senderId, null);
      projectManager.ensureUserDefault(ctx.senderId);
      await reply('已切换到个人目录');
      break;
    }
    default: await reply(`未知项目命令: ${cmd.action}`);
  }
}

async function handleClaudeTask(
  ctx: MessageContext, config: Config, db: Database,
  sessionManager: SessionManager, projectManager: ProjectManager,
): Promise<void> {
  const threadId = ctx.threadId ?? undefined;
  const existing = registry.getByUserId(ctx.senderId);
  if (existing) {
    await sendText(ctx.chatId, '上一个任务还在执行中，请等待完成或发送 /cancel 取消。', threadId);
    return;
  }

  // Check if user has a resumed CLI session
  const user = db.getUser(ctx.senderId);
  let projectPath: string;
  let projectName: string;
  let resumedCliSession: string | null = null;

  if (user?.resumed_session_id && user?.resumed_cwd) {
    projectPath = user.resumed_cwd;
    projectName = user.resumed_cwd.split('/').pop() || 'CLI Session';
    resumedCliSession = user.resumed_session_id;
  } else {
    try {
      ({ projectName, projectPath } = resolveProjectPath(ctx.senderId, db, projectManager));
    } catch (e: any) {
      await sendText(ctx.chatId, e.message, threadId);
      return;
    }
  }

  // Download attached resources (images / files)
  const imagePaths: string[] = [];
  const fileHints: string[] = [];

  await Promise.allSettled(ctx.resources.map(async (res) => {
    try {
      const msgId = res.sourceMessageId || ctx.messageId;
      if (res.type === 'image') {
        const { filePath } = await downloadImage(msgId, res.fileKey);
        imagePaths.push(filePath);
      } else if (res.type === 'file') {
        const { localPath, fileName } = await downloadFile(
          msgId, res.fileKey, res.fileName || 'file', projectPath,
        );
        fileHints.push(`用户上传了文件 "${fileName}"，已保存到 ${localPath}，请查看并分析。`);
      }
    } catch (err) {
      logger.warn({ err, resource: res }, 'Failed to download resource');
    }
  }));

  const session = sessionManager.getOrCreate(ctx.senderId, ctx.threadId, projectName);
  const effectiveSessionId = resumedCliSession || session.claude_session_id;
  const card = new StreamingCard(ctx.chatId, ctx.threadId, ctx.messageId);
  await card.startTyping(); // Add typing reaction immediately, defer card creation to first token

  const abortController = new AbortController();
  const queueKey = buildQueueKey(ctx.chatId, ctx.threadId);
  registry.setActive(queueKey, { abortController, abortCard: () => card.abortCard(), userId: ctx.senderId });

  const timeout = setTimeout(() => abortController.abort(), config.taskTimeoutMs);
  const tools: ToolStatus[] = [];
  const startTime = Date.now();
  let confirmMessageId: string | null = null;
  let confirmCount = 0;
  let permissionQueue: Promise<boolean> = Promise.resolve(true);

  // Build prompt with context
  let prompt = ctx.text;

  // Append image paths for SDK auto-detection (detectAndLoadPromptImages)
  if (imagePaths.length > 0) {
    prompt += '\n\n' + imagePaths.join('\n');
  }

  // Append file location hints
  if (fileHints.length > 0) {
    prompt += '\n\n' + fileHints.join('\n');
  }

  if (ctx.quotedContent) {
    prompt = `[Replying to: "${ctx.quotedContent}"]\n\n${prompt}`;
  }
  // Inject group chat history for context
  if (ctx.chatType === 'group') {
    const history = getRecentHistory(ctx.chatId);
    const historyContext = formatHistoryContext(history);
    if (historyContext) {
      prompt = `${historyContext}\n\n---\n\n${prompt}`;
    }
  }

  const userModel = getUserModel(ctx.senderId);

  await executeClaudeTask(prompt, projectPath, effectiveSessionId, abortController, {
    onText: (fullText) => { void card.scheduleStreamText(fullText); },
    onToolStart: (tool, detail) => {
      tools.push({ tool, status: 'running', detail });
    },
    onToolEnd: (tool, _detail) => {
      const match = tools.find(t => t.tool === tool && t.status === 'running') || tools.find(t => t.status === 'running');
      if (match) match.status = 'done';
    },
    onPermissionRequest: async (toolName, input) => {
      // Queue: serialize permission requests, show one at a time on one card
      const result = new Promise<boolean>((resolve) => {
        permissionQueue = permissionQueue.then(async () => {
          try {
          confirmCount++;
          const taskId = `perm-${Date.now()}`;
          const command = toolName === 'Bash' ? String((input as any).command || toolName) : `${toolName}(${JSON.stringify(input).slice(0, 100)})`;
          const confirmCard = CardBuilder.confirm(projectName, command, taskId, ctx.senderId);

          // Create or reuse the single confirm card
          if (!confirmMessageId) {
            confirmMessageId = await sendCard(ctx.chatId, confirmCard, threadId);
            if (!confirmMessageId) {
              // sendCard failed — auto-deny, notify user
              await sendText(ctx.chatId, '⚠️ 确认卡片发送失败，操作已自动跳过', threadId);
              resolve(false);
              return false;
            }
          } else {
            await updateCard(confirmMessageId, confirmCard);
          }

          // Wait for user decision (or timeout/abort)
          const allowed = await requestPermission(taskId, 60_000, abortController.signal);

          // Update card after decision — dispatch is the sole owner
          if (confirmMessageId) {
            if (allowed) {
              await updateCard(confirmMessageId, CardBuilder.status('⏳ 已允许，执行中...'));
            } else if (abortController.signal.aborted) {
              await updateCard(confirmMessageId, CardBuilder.status('⊘ 任务已取消'));
            } else {
              await updateCard(confirmMessageId, CardBuilder.status('✗ 已拒绝'));
            }
          }

          resolve(allowed);
          return allowed;
          } catch (err) {
            logger.error({ err }, 'Permission request failed');
            resolve(false);
            return false;
          }
        });
      });
      return result;
    },
    onComplete: async (result: ExecutionResult) => {
      clearTimeout(timeout);
      registry.removeActive(queueKey);
      // Update confirm card to final summary
      if (confirmMessageId) {
        await updateCard(confirmMessageId, CardBuilder.status(`✓ 任务完成，共确认 ${confirmCount} 次操作`));
      }
      if (result.sessionId) db.updateClaudeSessionId(session.id, result.sessionId);
      db.logTask(session.id, ctx.text, result.text, JSON.stringify(tools.map(t => t.tool)), result.durationMs, 'success');
      if (card.isTerminal) { await card.fallbackText(CardBuilder.buildFallbackText(result.text)); }
      else {
        await card.complete(CardBuilder.done(projectName, result.text, result.toolCount, {
          reasoningText: result.reasoningText || undefined,
          reasoningElapsedMs: result.reasoningElapsedMs || undefined,
          elapsedMs: result.durationMs,
        }));
      }
    },
    onError: async (error) => {
      clearTimeout(timeout);
      registry.removeActive(queueKey);
      if (confirmMessageId) {
        await updateCard(confirmMessageId, CardBuilder.status(`✗ 任务异常，共确认 ${confirmCount} 次操作`));
      }
      db.logTask(session.id, ctx.text, error, null, Date.now() - startTime, 'error');
      if (abortController.signal.aborted) {
        if (!card.isTerminal) await card.abort(CardBuilder.cancelled(projectName));
      } else {
        if (card.isTerminal) await card.fallbackText(error);
        else await card.error(CardBuilder.error(projectName, error, Date.now() - startTime));
      }
    },
  }, userModel, ctx.senderId, db);

  // Cleanup temp images (delay to avoid race with Claude reading them)
  if (imagePaths.length > 0) {
    setTimeout(() => {
      for (const imgPath of imagePaths) {
        try { unlinkSync(imgPath); } catch { /* ignore */ }
      }
    }, 5000);
  }
}
