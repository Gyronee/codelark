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
    '创建飞书云文档。支持放置到文件夹、知识库节点或知识空间（folder_token/wiki_node/wiki_space 三者互斥）。' +
    '\n\n【Lark Markdown 格式】内容使用 Lark-flavored Markdown：' +
    '\n- 标题 # ~ ###### 及 <h7>~<h9>，支持 {color="blue" align="center"}' +
    '\n- 高亮块：<callout emoji="💡" background-color="light-blue">内容</callout>' +
    '\n- 分栏：<grid cols="2"><column>左</column><column>右</column></grid>' +
    '\n- 飞书表格：<lark-table header-row="true"><lark-tr><lark-td>\\n\\n内容\\n\\n</lark-td></lark-tr></lark-table>' +
    '\n- 图片：<image url="https://..." width="800" height="600" align="center" caption="描述"/>（URL 自动上传）' +
    '\n- 文件：<file url="https://..." name="文件.pdf"/>（URL 自动上传）' +
    '\n- Mermaid：```mermaid\\ngraph TD\\n...\\n```（自动渲染为画板）' +
    '\n- 文字颜色：<text color="red">红色</text> <text background-color="yellow">黄底</text>' +
    '\n- @用户：<mention-user id="ou_xxx"/>  @文档：<mention-doc token="xxx" type="docx">标题</mention-doc>' +
    '\n\n【重要】markdown 开头不要写与 title 相同的一级标题（title 已是文档标题）。飞书自动生成目录，无需手动添加。' +
    '\n创建较长文档时，建议先创建再用 feishu_doc_update 的 append 模式分段追加。' +
    '\n本地图片/文件需用 feishu_doc_media 的 insert 操作。' +
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
    '\n\n【Wiki URL 处理】知识库链接（/wiki/TOKEN）可能是 docx/sheet/bitable 等类型。' +
    '不确定类型时，先用 feishu_wiki_space_node（action: get）解析 wiki token，' +
    '根据返回的 obj_type 决定用哪个工具（docx→本工具，sheet/bitable→对应工具）。' +
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
    '更新飞书云文档。优先使用局部更新（replace_range/append/insert_before/insert_after），慎用 overwrite（会清空文档，可能丢失图片、评论）。' +
    '\n\n【定位方式】replace_range/replace_all/insert_before/insert_after/delete_range 需要定位，二选一：' +
    '\n- selection_with_ellipsis：范围匹配 "开头内容...结尾内容"，或精确匹配 "完整内容"（不含 ...）。内容本身含 ... 时用 \\.\\.\\. 转义。建议 10-20 字符确保唯一' +
    '\n- selection_by_title："## 章节标题"，自动定位整个章节（到下一个同级标题前）' +
    '\n\n【最佳实践】' +
    '\n- 小粒度精确替换：定位范围越小越安全，尤其是表格/分栏等嵌套块' +
    '\n- 保护不可重建内容：图片/画板/表格等以 token 存储，替换时避开这些区域' +
    '\n- 分步更新优于整体覆盖：多次小范围替换比一次 overwrite 更安全' +
    '\n- replace_all 返回 replace_count 字段，表示替换次数' +
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
