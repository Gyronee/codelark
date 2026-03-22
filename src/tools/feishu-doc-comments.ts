/**
 * Feishu Doc Comments tool: feishu_doc_comments
 *
 * Actions: list (with full replies), create, patch (resolve/recover)
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type * as lark from '@larksuiteoapi/node-sdk';
import { assertOk, toToolResult, type WithTokenFn } from './feishu-oapi.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DocCommentElementType = 'text' | 'mention' | 'link';

export interface DocCommentElement {
  type: DocCommentElementType;
  text?: string;
  open_id?: string;
  url?: string;
}

export interface DocCommentsParams {
  action: 'list' | 'create' | 'patch';
  file_token: string;
  file_type: 'doc' | 'docx' | 'sheet' | 'file' | 'slides' | 'wiki';
  // list
  is_whole?: boolean;
  is_solved?: boolean;
  page_size?: number;
  page_token?: string;
  user_id_type?: 'open_id' | 'union_id' | 'user_id';
  // create
  elements?: DocCommentElement[];
  // patch
  comment_id?: string;
  is_solved_value?: boolean;
}

// ---------------------------------------------------------------------------
// Helper: convert elements to SDK format
// ---------------------------------------------------------------------------

function convertElementsToSDKFormat(elements: DocCommentElement[]): unknown[] {
  return elements.map((el) => {
    if (el.type === 'text') {
      return { type: 'text_run', text_run: { text: el.text } };
    } else if (el.type === 'mention') {
      return { type: 'person', person: { user_id: el.open_id } };
    } else if (el.type === 'link') {
      return { type: 'docs_link', docs_link: { url: el.url } };
    }
    return { type: 'text_run', text_run: { text: '' } };
  });
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleDocComments(
  params: DocCommentsParams,
  userAccessToken: string,
  client: lark.Client,
): Promise<unknown> {
  const userIdType = params.user_id_type ?? 'open_id';

  // Wiki token auto-conversion
  let actualFileToken = params.file_token;
  let actualFileType: string = params.file_type;

  if (params.file_type === 'wiki') {
    const wikiNodeRes = await (client.wiki.space as any).getNode(
      { params: { token: params.file_token, obj_type: 'wiki' } },
      { userAccessToken },
    );
    assertOk(wikiNodeRes);
    const node = wikiNodeRes.data?.node;
    if (!node || !node.obj_token || !node.obj_type) {
      return {
        error: `failed to resolve wiki token "${params.file_token}" to document object (may be a folder node rather than a document)`,
        wiki_node: node,
      };
    }
    actualFileToken = node.obj_token;
    actualFileType = node.obj_type;
  }

  // -------------------------------------------------------------------------
  // LIST
  // -------------------------------------------------------------------------
  if (params.action === 'list') {
    const res = await (client.drive.v1.fileComment as any).list(
      {
        path: { file_token: actualFileToken },
        params: {
          file_type: actualFileType,
          is_whole: params.is_whole,
          is_solved: params.is_solved,
          page_size: params.page_size ?? 50,
          page_token: params.page_token,
          user_id_type: userIdType,
        },
      },
      { userAccessToken },
    );
    assertOk(res);
    const items: any[] = res.data?.items ?? [];

    // Fetch full reply list for each comment that has replies
    const assembledItems = await Promise.all(
      items.map(async (comment: any) => {
        if (comment.reply_list?.replies?.length > 0) {
          try {
            const replies: unknown[] = [];
            let pageToken: string | undefined = undefined;
            let hasMore = true;

            while (hasMore) {
              const replyRes = await (client.drive.v1.fileCommentReply as any).list(
                {
                  path: { file_token: actualFileToken, comment_id: comment.comment_id },
                  params: {
                    file_type: actualFileType,
                    page_token: pageToken,
                    page_size: 50,
                    user_id_type: userIdType,
                  },
                },
                { userAccessToken },
              );
              const replyData = replyRes.data;
              if (replyRes.code === 0 && replyData?.items) {
                replies.push(...(replyData.items as unknown[]));
                hasMore = replyData.has_more ?? false;
                pageToken = replyData.page_token;
              } else {
                break;
              }
            }

            return { ...comment, reply_list: { replies } };
          } catch {
            // preserve original reply data on error
            return comment;
          }
        }
        return comment;
      }),
    );

    return {
      items: assembledItems,
      has_more: res.data?.has_more ?? false,
      page_token: res.data?.page_token,
    };
  }

  // -------------------------------------------------------------------------
  // CREATE
  // -------------------------------------------------------------------------
  if (params.action === 'create') {
    if (!params.elements || params.elements.length === 0) {
      return { error: 'elements 参数必填且不能为空' };
    }
    const sdkElements = convertElementsToSDKFormat(params.elements);
    const res = await (client.drive.v1.fileComment as any).create(
      {
        path: { file_token: actualFileToken },
        params: {
          file_type: actualFileType,
          user_id_type: userIdType,
        },
        data: {
          reply_list: {
            replies: [{ content: { elements: sdkElements } }],
          },
        },
      },
      { userAccessToken },
    );
    assertOk(res);
    return res.data;
  }

  // -------------------------------------------------------------------------
  // PATCH
  // -------------------------------------------------------------------------
  if (params.action === 'patch') {
    if (!params.comment_id) {
      return { error: 'comment_id 参数必填' };
    }
    if (params.is_solved_value === undefined) {
      return { error: 'is_solved_value 参数必填' };
    }
    const res = await (client.drive.v1.fileComment as any).patch(
      {
        path: { file_token: actualFileToken, comment_id: params.comment_id },
        params: { file_type: actualFileType },
        data: { is_solved: params.is_solved_value },
      },
      { userAccessToken },
    );
    assertOk(res);
    return { success: true };
  }

  return { error: `未知的 action: ${params.action}` };
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createDocCommentsTool(withTokenFn: WithTokenFn, client: lark.Client) {
  return tool(
    'feishu_doc_comments',
    '【以用户身份】管理云文档评论。支持: ' +
      '(1) list - 获取评论列表(含完整回复); ' +
      '(2) create - 添加全文评论(支持文本、@用户、超链接); ' +
      '(3) patch - 解决/恢复评论。' +
      '支持 wiki token 自动转换。',
    {
      action: z.enum(['list', 'create', 'patch']).describe('操作类型'),
      file_token: z
        .string()
        .describe(
          '云文档 token 或 wiki 节点 token（可从文档 URL 获取）。如果是 wiki token，会自动转换为实际文档的 obj_token',
        ),
      file_type: z
        .enum(['doc', 'docx', 'sheet', 'file', 'slides', 'wiki'])
        .describe('文档类型。wiki 类型会自动解析为实际文档类型'),
      is_whole: z.boolean().optional().describe('是否只获取全文评论（action=list 时可选）'),
      is_solved: z.boolean().optional().describe('是否只获取已解决的评论（action=list 时可选）'),
      page_size: z.number().int().optional().describe('分页大小'),
      page_token: z.string().optional().describe('分页标记'),
      user_id_type: z
        .enum(['open_id', 'union_id', 'user_id'])
        .optional()
        .describe('用户 ID 类型（默认 open_id）'),
      elements: z
        .array(
          z.object({
            type: z.enum(['text', 'mention', 'link']).describe('元素类型'),
            text: z.string().optional().describe('文本内容（type=text 时必填）'),
            open_id: z.string().optional().describe('被 @ 用户的 open_id（type=mention 时必填）'),
            url: z.string().optional().describe('链接 URL（type=link 时必填）'),
          }),
        )
        .optional()
        .describe('评论内容元素数组（action=create 时必填）'),
      comment_id: z.string().optional().describe('评论 ID（action=patch 时必填）'),
      is_solved_value: z
        .boolean()
        .optional()
        .describe('解决状态：true=解决，false=恢复（action=patch 时必填）'),
    },
    async (args) =>
      withTokenFn(async (token) => toToolResult(await handleDocComments(args as DocCommentsParams, token, client))),
  );
}
