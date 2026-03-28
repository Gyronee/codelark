/**
 * In-process MCP server with Feishu document tools.
 *
 * Provides create/fetch/update doc tools that proxy to the Feishu MCP endpoint,
 * handling token acquisition and authorization errors transparently.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { callFeishuMcp } from './feishu-mcp.js';
import { getValidAccessToken, NeedAuthorizationError } from '../auth/token-store.js';
import { createLarkClient } from './feishu-oapi.js';
import { createSearchTool } from './feishu-search.js';
import { createWikiSpaceTool, createWikiSpaceNodeTool } from './feishu-wiki.js';
import { createDriveFileTool } from './feishu-drive.js';
import { createDocMediaTool } from './feishu-doc-media.js';
import { createDocCommentsTool } from './feishu-doc-comments.js';
import { createBitableTool, createBitableFieldTool, createBitableRecordTool } from './feishu-bitable.js';
import type { Database } from '../session/db.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Helper: acquire a valid token, call the action, and handle NeedAuthorizationError.
 */
export async function withToken(
  db: Database,
  userId: string,
  appId: string,
  appSecret: string,
  action: (token: string) => Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    const token = await getValidAccessToken(db, userId, appId, appSecret);
    return await action(token);
  } catch (err) {
    if (err instanceof NeedAuthorizationError) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'need_authorization',
              message:
                'The user has not authorized Feishu access yet. Please ask them to run the /auth command to connect their Feishu account.',
            }),
          },
        ],
      };
    }
    throw err;
  }
}

/**
 * Creates an in-process MCP server exposing Feishu document tools.
 */
export function createFeishuDocServer(
  userId: string,
  db: Database,
  appId: string,
  appSecret: string,
) {
  const feishuDocCreate = tool(
    'feishu_doc_create',
    '创建飞书云文档。支持放置到文件夹、知识库节点或知识空间（folder_token/wiki_node/wiki_space 三者互斥）。' +
    '\n内容格式见系统提示中的 Lark Markdown 参考。' +
    '\n\n【异步】大文档创建可能返回 task_id，用同一工具传入 task_id 查询状态。',
    {
      title: z.string().optional().describe('文档标题'),
      markdown: z.string().optional().describe('Markdown 格式的文档内容'),
      folder_token: z.string().optional().describe('父文件夹 token（与 wiki_node/wiki_space 互斥）'),
      wiki_node: z.string().optional().describe('知识库节点 token 或 URL（在该节点下创建文档，与 folder_token/wiki_space 互斥）'),
      wiki_space: z.string().optional().describe('知识空间 ID（特殊值 my_library 表示个人空间，与 folder_token/wiki_node 互斥）'),
      task_id: z.string().optional().describe('异步任务 ID。传入时查询任务状态而非创建新文档'),
    },
    async (args) =>
      withToken(db, userId, appId, appSecret, async (token) => {
        const result = await callFeishuMcp('create-doc', args as Record<string, unknown>, token);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
      }),
  );

  const feishuDocFetch = tool(
    'feishu_doc_fetch',
    '获取飞书云文档内容，返回 Lark-flavored Markdown。' +
    '\nWiki URL 解析流程见系统提示中的工作流指南。' +
    '\n\n【媒体处理】返回的 Markdown 中图片/文件/画板以 HTML 标签形式出现：' +
    '\n- 图片：<image token="xxx" width="800" height="600"/>' +
    '\n- 文件：<view type="1"><file token="xxx" name="file.zip"/></view>' +
    '\n- 画板：<whiteboard token="xxx"/>' +
    '\n需要查看这些内容时，用 feishu_doc_media（action: download）下载。',
    {
      doc_id: z.string().describe('文档 ID 或 URL（支持 docx URL 和 wiki URL，自动提取 token）'),
      offset: z.number().optional().describe('字符偏移量（分页读取时使用）'),
      limit: z.number().optional().describe('最大返回字符数（仅用户明确要求分页时使用）'),
    },
    async (args) =>
      withToken(db, userId, appId, appSecret, async (token) => {
        const result = await callFeishuMcp('fetch-doc', args as Record<string, unknown>, token);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
      }),
  );

  const feishuDocUpdate = tool(
    'feishu_doc_update',
    '更新飞书云文档。支持 7 种模式：append, overwrite, replace_range, replace_all, insert_before, insert_after, delete_range。' +
    '\n优先使用局部更新，慎用 overwrite（会清空文档，可能丢失图片、评论）。' +
    '\n模式选择和定位语法见系统提示中的文档更新指南。' +
    '\n\n【异步】大文档更新可能返回 task_id，用同一工具传入 task_id 查询状态。',
    {
      doc_id: z.string().optional().describe('文档 ID 或 URL（未提供 task_id 时必填）'),
      markdown: z.string().optional().describe('Markdown 内容'),
      mode: z
        .enum([
          'overwrite',
          'append',
          'replace_range',
          'replace_all',
          'insert_before',
          'insert_after',
          'delete_range',
        ])
        .describe('更新模式'),
      selection_with_ellipsis: z
        .string()
        .optional()
        .describe('定位表达式：开头内容...结尾内容（与 selection_by_title 二选一）'),
      selection_by_title: z
        .string()
        .optional()
        .describe('标题定位：如 ## 章节标题（与 selection_with_ellipsis 二选一）'),
      new_title: z.string().optional().describe('新的文档标题'),
      task_id: z.string().optional().describe('异步任务 ID，用于查询任务状态'),
    },
    async (args) =>
      withToken(db, userId, appId, appSecret, async (token) => {
        const result = await callFeishuMcp('update-doc', args as Record<string, unknown>, token);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
      }),
  );

  // Create Lark SDK client and bound withToken for new OAPI tools
  const client = createLarkClient(appId, appSecret);
  const boundWithToken = (action: (token: string) => Promise<CallToolResult>) =>
    withToken(db, userId, appId, appSecret, action);

  const searchTool = createSearchTool(boundWithToken);
  const wikiSpaceTool = createWikiSpaceTool(boundWithToken, client);
  const wikiSpaceNodeTool = createWikiSpaceNodeTool(boundWithToken, client);
  const driveFileTool = createDriveFileTool(boundWithToken, client);
  const docMediaTool = createDocMediaTool(boundWithToken, client);
  const docCommentsTool = createDocCommentsTool(boundWithToken, client);
  const bitableTool = createBitableTool(boundWithToken, client);
  const bitableFieldTool = createBitableFieldTool(boundWithToken, client);
  const bitableRecordTool = createBitableRecordTool(boundWithToken, client);

  return createSdkMcpServer({
    name: 'feishu-docs',
    version: '1.0.0',
    tools: [
      feishuDocCreate, feishuDocFetch, feishuDocUpdate,
      searchTool, wikiSpaceTool, wikiSpaceNodeTool,
      driveFileTool, docMediaTool, docCommentsTool,
      bitableTool, bitableFieldTool, bitableRecordTool,
    ],
  });
}
