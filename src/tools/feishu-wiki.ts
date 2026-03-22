/**
 * Feishu Wiki tools: feishu_wiki_space and feishu_wiki_space_node
 *
 * Actions:
 *   feishu_wiki_space:      list, get, create
 *   feishu_wiki_space_node: list, get, create, move, copy
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type * as lark from '@larksuiteoapi/node-sdk';
import { assertOk, toToolResult, type WithTokenFn } from './feishu-oapi.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WikiSpaceParams {
  action: 'list' | 'get' | 'create';
  space_id?: string;
  name?: string;
  description?: string;
  page_size?: number;
  page_token?: string;
}

export interface WikiSpaceResult {
  spaces?: unknown[];
  space?: unknown;
  has_more?: boolean;
  page_token?: string;
}

export interface WikiSpaceNodeParams {
  action: 'list' | 'get' | 'create' | 'move' | 'copy';
  space_id?: string;
  token?: string;
  node_token?: string;
  obj_type?: string;
  parent_node_token?: string;
  node_type?: 'origin' | 'shortcut';
  origin_node_token?: string;
  title?: string;
  target_parent_token?: string;
  target_space_id?: string;
  page_size?: number;
  page_token?: string;
}

export interface WikiSpaceNodeResult {
  nodes?: unknown[];
  node?: unknown;
  has_more?: boolean;
  page_token?: string;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function handleWikiSpace(
  params: WikiSpaceParams,
  userAccessToken: string,
  client: lark.Client,
): Promise<WikiSpaceResult> {
  switch (params.action) {
    // -----------------------------------------------------------------------
    // LIST SPACES
    // -----------------------------------------------------------------------
    case 'list': {
      const res = await (client.wiki.space as any).list(
        {
          params: {
            page_size: params.page_size,
            page_token: params.page_token,
          },
        },
        { userAccessToken },
      );
      assertOk(res);
      const data = res.data;
      return {
        spaces: data?.items,
        has_more: data?.has_more,
        page_token: data?.page_token,
      };
    }

    // -----------------------------------------------------------------------
    // GET SPACE
    // -----------------------------------------------------------------------
    case 'get': {
      if (!params.space_id) throw new Error('space_id is required for get');
      const res = await (client.wiki.space as any).get(
        { path: { space_id: params.space_id } },
        { userAccessToken },
      );
      assertOk(res);
      return { space: res.data?.space };
    }

    // -----------------------------------------------------------------------
    // CREATE SPACE
    // -----------------------------------------------------------------------
    case 'create': {
      const res = await (client.wiki.space as any).create(
        {
          data: {
            name: params.name,
            description: params.description,
          },
        },
        { userAccessToken },
      );
      assertOk(res);
      return { space: res.data?.space };
    }
  }
}

export async function handleWikiSpaceNode(
  params: WikiSpaceNodeParams,
  userAccessToken: string,
  client: lark.Client,
): Promise<WikiSpaceNodeResult> {
  switch (params.action) {
    // -----------------------------------------------------------------------
    // LIST NODES
    // -----------------------------------------------------------------------
    case 'list': {
      if (!params.space_id) throw new Error('space_id is required for list');
      const res = await (client.wiki.spaceNode as any).list(
        {
          path: { space_id: params.space_id },
          params: {
            page_size: params.page_size,
            page_token: params.page_token,
            parent_node_token: params.parent_node_token,
          },
        },
        { userAccessToken },
      );
      assertOk(res);
      const data = res.data;
      return {
        nodes: data?.items,
        has_more: data?.has_more,
        page_token: data?.page_token,
      };
    }

    // -----------------------------------------------------------------------
    // GET NODE
    // -----------------------------------------------------------------------
    case 'get': {
      if (!params.token) throw new Error('token is required for get');
      const res = await (client.wiki.space as any).getNode(
        {
          params: {
            token: params.token,
            obj_type: params.obj_type ?? 'wiki',
          },
        },
        { userAccessToken },
      );
      assertOk(res);
      return { node: res.data?.node };
    }

    // -----------------------------------------------------------------------
    // CREATE NODE
    // -----------------------------------------------------------------------
    case 'create': {
      if (!params.space_id) throw new Error('space_id is required for create');
      const res = await (client.wiki.spaceNode as any).create(
        {
          path: { space_id: params.space_id },
          data: {
            obj_type: params.obj_type,
            parent_node_token: params.parent_node_token,
            node_type: params.node_type,
            origin_node_token: params.origin_node_token,
            title: params.title,
          },
        },
        { userAccessToken },
      );
      assertOk(res);
      return { node: res.data?.node };
    }

    // -----------------------------------------------------------------------
    // MOVE NODE
    // -----------------------------------------------------------------------
    case 'move': {
      if (!params.space_id) throw new Error('space_id is required for move');
      if (!params.node_token) throw new Error('node_token is required for move');
      const res = await (client.wiki.spaceNode as any).move(
        {
          path: {
            space_id: params.space_id,
            node_token: params.node_token,
          },
          data: {
            target_parent_token: params.target_parent_token,
          },
        },
        { userAccessToken },
      );
      assertOk(res);
      return { node: res.data?.node };
    }

    // -----------------------------------------------------------------------
    // COPY NODE
    // -----------------------------------------------------------------------
    case 'copy': {
      if (!params.space_id) throw new Error('space_id is required for copy');
      if (!params.node_token) throw new Error('node_token is required for copy');
      const res = await (client.wiki.spaceNode as any).copy(
        {
          path: {
            space_id: params.space_id,
            node_token: params.node_token,
          },
          data: {
            target_space_id: params.target_space_id,
            target_parent_token: params.target_parent_token,
            title: params.title,
          },
        },
        { userAccessToken },
      );
      assertOk(res);
      return { node: res.data?.node };
    }
  }
}

// ---------------------------------------------------------------------------
// Tool factories
// ---------------------------------------------------------------------------

export function createWikiSpaceTool(withTokenFn: WithTokenFn, client: lark.Client) {
  return tool(
    'feishu_wiki_space',
    '飞书知识空间管理工具。当用户要求查看知识库列表、获取知识库信息、创建知识库时使用。' +
      'Actions: list（列出知识空间）, get（获取知识空间信息）, create（创建知识空间）。' +
      '【重要】space_id 可以从浏览器 URL 中获取，或通过 list 接口获取。' +
      '【重要】知识空间（Space）是知识库的基本组成单位，包含多个具有层级关系的文档节点。',
    {
      action: z.enum(['list', 'get', 'create']).describe('操作类型'),
      space_id: z.string().optional().describe('知识空间 ID（get 时必填）'),
      name: z.string().optional().describe('知识空间名称（create 时使用）'),
      description: z.string().optional().describe('知识空间描述（create 时使用）'),
      page_size: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe('分页大小（默认 10，最大 50）'),
      page_token: z.string().optional().describe('分页标记。首次请求无需填写'),
    },
    async (args) =>
      withTokenFn(async (token) => toToolResult(await handleWikiSpace(args as WikiSpaceParams, token, client))),
  );
}

export function createWikiSpaceNodeTool(withTokenFn: WithTokenFn, client: lark.Client) {
  return tool(
    'feishu_wiki_space_node',
    '飞书知识库节点管理工具。操作：list（列表）、get（获取）、create（创建）、move（移动）、copy（复制）。' +
      '节点是知识库中的文档，包括 doc、bitable(多维表格)、sheet(电子表格) 等类型。' +
      'node_token 是节点的唯一标识符，obj_token 是实际文档的 token。' +
      '可通过 get 操作将 wiki 类型的 node_token 转换为实际文档的 obj_token。',
    {
      action: z.enum(['list', 'get', 'create', 'move', 'copy']).describe('操作类型'),
      space_id: z.string().optional().describe('知识空间 ID（list/create/move/copy 时必填）'),
      token: z.string().optional().describe('节点 token（get 时必填）'),
      node_token: z.string().optional().describe('节点 token（move/copy 时必填）'),
      obj_type: z.string().optional().describe('对象类型（get 时默认为 wiki）'),
      parent_node_token: z.string().optional().describe('父节点 token'),
      node_type: z
        .enum(['origin', 'shortcut'])
        .optional()
        .describe('节点类型（origin=原始节点，shortcut=快捷方式）'),
      origin_node_token: z.string().optional().describe('原始节点 token（创建快捷方式时使用）'),
      title: z.string().optional().describe('节点标题'),
      target_parent_token: z.string().optional().describe('目标父节点 token（move/copy 时使用）'),
      target_space_id: z.string().optional().describe('目标知识空间 ID（copy 时使用）'),
      page_size: z.number().int().optional().describe('分页大小'),
      page_token: z.string().optional().describe('分页标记'),
    },
    async (args) =>
      withTokenFn(async (token) => toToolResult(await handleWikiSpaceNode(args as WikiSpaceNodeParams, token, client))),
  );
}
