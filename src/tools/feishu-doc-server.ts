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
    'Create a Feishu document with the given title and markdown content.',
    {
      title: z.string().describe('Document title'),
      markdown: z.string().describe('Document content in markdown format'),
      folder_token: z.string().optional().describe('Optional folder token to place the document in'),
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
    'Read a Feishu document by its doc_id.',
    {
      doc_id: z.string().describe('The document ID to fetch'),
      offset: z.number().optional().describe('Offset for paginated content'),
      limit: z.number().optional().describe('Limit for paginated content'),
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
    'Update a Feishu document. Supports overwrite, append, replace, insert, and delete operations.',
    {
      doc_id: z.string().describe('The document ID to update'),
      markdown: z.string().optional().describe('Markdown content for the update'),
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
        .describe('The update mode'),
      selection_with_ellipsis: z
        .string()
        .optional()
        .describe('Content selection using ellipsis for range operations'),
      selection_by_title: z
        .string()
        .optional()
        .describe('Content selection by title/heading'),
      new_title: z.string().optional().describe('New title for the document'),
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

  return createSdkMcpServer({
    name: 'feishu-docs',
    version: '1.0.0',
    tools: [
      feishuDocCreate, feishuDocFetch, feishuDocUpdate,
      searchTool, wikiSpaceTool, wikiSpaceNodeTool,
      driveFileTool, docMediaTool, docCommentsTool,
    ],
  });
}
