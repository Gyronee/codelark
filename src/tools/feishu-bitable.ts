/**
 * Feishu Bitable tools: feishu_bitable, feishu_bitable_field, feishu_bitable_record
 *
 * Full CRUD for Bitable apps, tables, views, fields, and records.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type * as lark from '@larksuiteoapi/node-sdk';
import { assertOk, toToolResult, type WithTokenFn } from './feishu-oapi.js';
import { logger } from '../logger.js';
const log = logger.child({ module: 'tools/feishu-bitable' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BitableAction =
  | 'create_app' | 'get_app' | 'copy_app'
  | 'list_tables' | 'create_table' | 'delete_table'
  | 'list_views' | 'create_view' | 'delete_view';

export interface BitableParams {
  action: BitableAction;
  app_token?: string;
  name?: string;
  folder_token?: string;
  table_id?: string;
  fields?: Array<{ field_name: string; type: number; property?: Record<string, unknown> }>;
  view_name?: string;
  view_type?: string;
  view_id?: string;
  page_size?: number;
  page_token?: string;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleBitable(
  params: BitableParams,
  userAccessToken: string,
  client: lark.Client,
): Promise<unknown> {
  switch (params.action) {
    case 'create_app': {
      log.info({ action: 'create_app', name: params.name }, 'bitable create_app');
      const res = await client.bitable.app.create(
        { data: { name: params.name, folder_token: params.folder_token } },
        { userAccessToken },
      );
      assertOk(res);
      return res.data;
    }

    case 'get_app': {
      log.info({ action: 'get_app', app_token: params.app_token }, 'bitable get_app');
      const res = await client.bitable.app.get(
        { path: { app_token: params.app_token! } },
        { userAccessToken },
      );
      assertOk(res);
      return res.data;
    }

    case 'copy_app': {
      log.info({ action: 'copy_app', app_token: params.app_token, name: params.name }, 'bitable copy_app');
      const res = await client.bitable.app.copy(
        { path: { app_token: params.app_token! }, data: { name: params.name, folder_token: params.folder_token } },
        { userAccessToken },
      );
      assertOk(res);
      return res.data;
    }

    case 'list_tables': {
      log.info({ action: 'list_tables', app_token: params.app_token }, 'bitable list_tables');
      const res = await client.bitable.appTable.list(
        { path: { app_token: params.app_token! }, params: { page_size: params.page_size, page_token: params.page_token } },
        { userAccessToken },
      );
      assertOk(res);
      return res.data;
    }

    case 'create_table': {
      log.info({ action: 'create_table', app_token: params.app_token, name: params.name }, 'bitable create_table');
      const res = await client.bitable.appTable.create(
        { path: { app_token: params.app_token! }, data: { table: { name: params.name, fields: params.fields as any } } },
        { userAccessToken },
      );
      assertOk(res);
      return res.data;
    }

    case 'delete_table': {
      log.info({ action: 'delete_table', app_token: params.app_token, table_id: params.table_id }, 'bitable delete_table');
      const res = await client.bitable.appTable.delete(
        { path: { app_token: params.app_token!, table_id: params.table_id! } },
        { userAccessToken },
      );
      assertOk(res);
      return res.data;
    }

    case 'list_views': {
      log.info({ action: 'list_views', app_token: params.app_token, table_id: params.table_id }, 'bitable list_views');
      const res = await client.bitable.appTableView.list(
        { path: { app_token: params.app_token!, table_id: params.table_id! }, params: { page_size: params.page_size, page_token: params.page_token } },
        { userAccessToken },
      );
      assertOk(res);
      return res.data;
    }

    case 'create_view': {
      log.info({ action: 'create_view', app_token: params.app_token, table_id: params.table_id }, 'bitable create_view');
      const res = await client.bitable.appTableView.create(
        { path: { app_token: params.app_token!, table_id: params.table_id! }, data: { view_name: params.view_name, view_type: params.view_type } },
        { userAccessToken },
      );
      assertOk(res);
      return res.data;
    }

    case 'delete_view': {
      log.info({ action: 'delete_view', app_token: params.app_token, table_id: params.table_id, view_id: params.view_id }, 'bitable delete_view');
      const res = await client.bitable.appTableView.delete(
        { path: { app_token: params.app_token!, table_id: params.table_id!, view_id: params.view_id! } },
        { userAccessToken },
      );
      assertOk(res);
      return res.data;
    }

    default:
      throw new Error(`Unknown bitable action: ${(params as any).action}`);
  }
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createBitableTool(withTokenFn: WithTokenFn, client: lark.Client) {
  return tool(
    'feishu_bitable',
    '【以用户身份】飞书多维表格管理工具。管理多维表格（app）、数据表（table）和视图（view）。' +
      '\n\nActions:' +
      '\n- create_app — 创建多维表格（需要 name，可选 folder_token）' +
      '\n- get_app — 获取多维表格元数据（需要 app_token）' +
      '\n- copy_app — 复制多维表格（需要 app_token, name）' +
      '\n- list_tables — 列出数据表（需要 app_token）' +
      '\n- create_table — 创建数据表（需要 app_token, name，可选 fields 初始字段定义）' +
      '\n- delete_table — 删除数据表（需要 app_token, table_id）' +
      '\n- list_views — 列出视图（需要 app_token, table_id）' +
      '\n- create_view — 创建视图（需要 app_token, table_id, view_name）' +
      '\n- delete_view — 删除视图（需要 app_token, table_id, view_id）' +
      '\n\n字段类型和记录值格式见系统提示中的多维表格指南。',
    {
      action: z.enum([
        'create_app', 'get_app', 'copy_app',
        'list_tables', 'create_table', 'delete_table',
        'list_views', 'create_view', 'delete_view',
      ]).describe('操作类型'),
      app_token: z.string().optional().describe('多维表格 app_token（除 create_app 外必填）'),
      name: z.string().optional().describe('名称（create_app/copy_app/create_table 时使用）'),
      folder_token: z.string().optional().describe('目标文件夹 token（create_app/copy_app 时可选）'),
      table_id: z.string().optional().describe('数据表 ID（table/view 操作时必填）'),
      fields: z.array(z.object({
        field_name: z.string(),
        type: z.number(),
        property: z.record(z.unknown()).optional(),
      })).optional().describe('初始字段定义（create_table 时可选）'),
      view_name: z.string().optional().describe('视图名称（create_view 时必填）'),
      view_type: z.string().optional().describe('视图类型：grid/kanban/gallery/gantt/form（create_view 时可选，默认 grid）'),
      view_id: z.string().optional().describe('视图 ID（delete_view 时必填）'),
      page_size: z.number().int().min(1).max(100).optional().describe('分页大小'),
      page_token: z.string().optional().describe('分页标记'),
    },
    async (args) =>
      withTokenFn(async (token) => toToolResult(await handleBitable(args as BitableParams, token, client))),
  );
}

// ---------------------------------------------------------------------------
// Field types & handler
// ---------------------------------------------------------------------------

export type BitableFieldAction = 'list' | 'create' | 'update' | 'delete';

export interface BitableFieldParams {
  action: BitableFieldAction;
  app_token: string;
  table_id: string;
  field_id?: string;
  field_name?: string;
  type?: number;
  property?: Record<string, unknown>;
  view_id?: string;
  page_size?: number;
  page_token?: string;
}

export async function handleBitableField(
  params: BitableFieldParams,
  userAccessToken: string,
  client: lark.Client,
): Promise<unknown> {
  switch (params.action) {
    case 'list': {
      log.info({ action: 'list', app_token: params.app_token, table_id: params.table_id }, 'bitable_field list');
      const res = await client.bitable.appTableField.list(
        { path: { app_token: params.app_token, table_id: params.table_id }, params: { view_id: params.view_id, page_size: params.page_size, page_token: params.page_token } },
        { userAccessToken },
      );
      assertOk(res);
      return res.data;
    }

    case 'create': {
      log.info({ action: 'create', app_token: params.app_token, table_id: params.table_id, field_name: params.field_name }, 'bitable_field create');
      const res = await client.bitable.appTableField.create(
        { path: { app_token: params.app_token, table_id: params.table_id }, data: { field_name: params.field_name!, type: params.type!, property: params.property as any } },
        { userAccessToken },
      );
      assertOk(res);
      return res.data;
    }

    case 'update': {
      log.info({ action: 'update', app_token: params.app_token, table_id: params.table_id, field_id: params.field_id }, 'bitable_field update');
      const res = await client.bitable.appTableField.update(
        { path: { app_token: params.app_token, table_id: params.table_id, field_id: params.field_id! }, data: { field_name: params.field_name, type: params.type, property: params.property as any } },
        { userAccessToken },
      );
      assertOk(res);
      return res.data;
    }

    case 'delete': {
      log.info({ action: 'delete', app_token: params.app_token, table_id: params.table_id, field_id: params.field_id }, 'bitable_field delete');
      const res = await client.bitable.appTableField.delete(
        { path: { app_token: params.app_token, table_id: params.table_id, field_id: params.field_id! } },
        { userAccessToken },
      );
      assertOk(res);
      return res.data;
    }

    default:
      throw new Error(`Unknown bitable_field action: ${(params as any).action}`);
  }
}

// ---------------------------------------------------------------------------
// Field tool factory
// ---------------------------------------------------------------------------

export function createBitableFieldTool(withTokenFn: WithTokenFn, client: lark.Client) {
  return tool(
    'feishu_bitable_field',
    '【以用户身份】多维表格字段管理工具。管理数据表中的字段（列）。' +
      '\n\nActions:' +
      '\n- list — 列出字段（需要 app_token, table_id，可选 view_id 按视图过滤）' +
      '\n- create — 创建字段（需要 app_token, table_id, field_name, type，可选 property）' +
      '\n- update — 更新字段（需要 app_token, table_id, field_id，可选 field_name, type, property）' +
      '\n- delete — 删除字段（需要 app_token, table_id, field_id）' +
      '\n\n字段 type 值和 property 结构见系统提示中的多维表格指南。',
    {
      action: z.enum(['list', 'create', 'update', 'delete']).describe('操作类型'),
      app_token: z.string().describe('多维表格 app_token'),
      table_id: z.string().describe('数据表 ID'),
      field_id: z.string().optional().describe('字段 ID（update/delete 时必填）'),
      field_name: z.string().optional().describe('字段名称（create 时必填）'),
      type: z.number().int().optional().describe('字段类型数字代码（create 时必填，见多维表格指南）'),
      property: z.record(z.unknown()).optional().describe('字段属性（根据 type 不同结构不同，见多维表格指南）'),
      view_id: z.string().optional().describe('视图 ID（list 时可选，按视图过滤字段）'),
      page_size: z.number().int().min(1).max(100).optional().describe('分页大小'),
      page_token: z.string().optional().describe('分页标记'),
    },
    async (args) =>
      withTokenFn(async (token) => toToolResult(await handleBitableField(args as BitableFieldParams, token, client))),
  );
}

// ---------------------------------------------------------------------------
// Record types & handler
// ---------------------------------------------------------------------------

export type BitableRecordAction =
  | 'list' | 'get' | 'search'
  | 'create' | 'batch_create'
  | 'update' | 'batch_update'
  | 'delete' | 'batch_delete';

export interface BitableRecordParams {
  action: BitableRecordAction;
  app_token: string;
  table_id: string;
  record_id?: string;
  record_ids?: string[];
  fields?: Record<string, unknown>;
  records?: Array<{ record_id?: string; fields: Record<string, unknown> }>;
  filter?: string | Record<string, unknown>;
  sort?: string | Array<Record<string, unknown>>;
  field_names?: string[];
  view_id?: string;
  page_size?: number;
  page_token?: string;
}

export async function handleBitableRecord(
  params: BitableRecordParams,
  userAccessToken: string,
  client: lark.Client,
): Promise<unknown> {
  switch (params.action) {
    case 'list': {
      log.info({ action: 'list', app_token: params.app_token, table_id: params.table_id }, 'bitable_record list');
      const res = await client.bitable.appTableRecord.list(
        {
          path: { app_token: params.app_token, table_id: params.table_id },
          params: {
            view_id: params.view_id,
            filter: params.filter as string | undefined,
            sort: params.sort as string | undefined,
            page_size: params.page_size,
            page_token: params.page_token,
          },
        },
        { userAccessToken },
      );
      assertOk(res);
      return res.data;
    }

    case 'get': {
      log.info({ action: 'get', app_token: params.app_token, table_id: params.table_id, record_id: params.record_id }, 'bitable_record get');
      const res = await client.bitable.appTableRecord.get(
        { path: { app_token: params.app_token, table_id: params.table_id, record_id: params.record_id! } },
        { userAccessToken },
      );
      assertOk(res);
      return res.data;
    }

    case 'search': {
      log.info({ action: 'search', app_token: params.app_token, table_id: params.table_id }, 'bitable_record search');
      const res = await client.bitable.appTableRecord.search(
        {
          path: { app_token: params.app_token, table_id: params.table_id },
          data: {
            filter: params.filter as any,
            sort: params.sort as any,
            field_names: params.field_names,
            automatic_fields: true,
          },
          params: {
            page_size: params.page_size,
            page_token: params.page_token,
            user_id_type: 'open_id',
          },
        },
        { userAccessToken },
      );
      assertOk(res);
      return res.data;
    }

    case 'create': {
      log.info({ action: 'create', app_token: params.app_token, table_id: params.table_id }, 'bitable_record create');
      const res = await client.bitable.appTableRecord.create(
        { path: { app_token: params.app_token, table_id: params.table_id }, data: { fields: params.fields! } },
        { userAccessToken },
      );
      assertOk(res);
      return res.data;
    }

    case 'batch_create': {
      log.info({ action: 'batch_create', app_token: params.app_token, table_id: params.table_id, count: params.records?.length }, 'bitable_record batch_create');
      const res = await client.bitable.appTableRecord.batchCreate(
        { path: { app_token: params.app_token, table_id: params.table_id }, data: { records: params.records as any } },
        { userAccessToken },
      );
      assertOk(res);
      return res.data;
    }

    case 'update': {
      log.info({ action: 'update', app_token: params.app_token, table_id: params.table_id, record_id: params.record_id }, 'bitable_record update');
      const res = await client.bitable.appTableRecord.update(
        { path: { app_token: params.app_token, table_id: params.table_id, record_id: params.record_id! }, data: { fields: params.fields! } },
        { userAccessToken },
      );
      assertOk(res);
      return res.data;
    }

    case 'batch_update': {
      log.info({ action: 'batch_update', app_token: params.app_token, table_id: params.table_id, count: params.records?.length }, 'bitable_record batch_update');
      const res = await client.bitable.appTableRecord.batchUpdate(
        { path: { app_token: params.app_token, table_id: params.table_id }, data: { records: params.records as any } },
        { userAccessToken },
      );
      assertOk(res);
      return res.data;
    }

    case 'delete': {
      log.info({ action: 'delete', app_token: params.app_token, table_id: params.table_id, record_id: params.record_id }, 'bitable_record delete');
      const res = await client.bitable.appTableRecord.delete(
        { path: { app_token: params.app_token, table_id: params.table_id, record_id: params.record_id! } },
        { userAccessToken },
      );
      assertOk(res);
      return res.data;
    }

    case 'batch_delete': {
      log.info({ action: 'batch_delete', app_token: params.app_token, table_id: params.table_id, count: params.record_ids?.length }, 'bitable_record batch_delete');
      const res = await client.bitable.appTableRecord.batchDelete(
        { path: { app_token: params.app_token, table_id: params.table_id }, data: { records: params.record_ids! } },
        { userAccessToken },
      );
      assertOk(res);
      return res.data;
    }

    default:
      throw new Error(`Unknown bitable_record action: ${(params as any).action}`);
  }
}

// ---------------------------------------------------------------------------
// Record tool factory
// ---------------------------------------------------------------------------

export function createBitableRecordTool(withTokenFn: WithTokenFn, client: lark.Client) {
  return tool(
    'feishu_bitable_record',
    '【以用户身份】多维表格记录管理工具。CRUD 数据表中的记录（行）。' +
      '\n\nActions:' +
      '\n- list — 列出记录（需要 app_token, table_id，可选 filter/sort/view_id）' +
      '\n- get — 获取单条记录（需要 app_token, table_id, record_id）' +
      '\n- search — 搜索记录（需要 app_token, table_id，可选 filter/sort/field_names）' +
      '\n- create — 创建单条记录（需要 app_token, table_id, fields）' +
      '\n- batch_create — 批量创建（需要 app_token, table_id, records，最多 500 条）' +
      '\n- update — 更新单条记录（需要 app_token, table_id, record_id, fields）' +
      '\n- batch_update — 批量更新（需要 app_token, table_id, records 含 record_id，最多 500 条）' +
      '\n- delete — 删除单条记录（需要 app_token, table_id, record_id）' +
      '\n- batch_delete — 批量删除（需要 app_token, table_id, record_ids，最多 500 条）' +
      '\n\n【list 的 filter/sort】为字符串格式，filter 如 CurrentValue.[Status]="Done"，sort 如 [{"field_name":"Date","desc":true}]' +
      '\n【search 的 filter】为对象格式：{conjunction:"and",conditions:[{field_name:"状态",operator:"is",value:["进行中"]}]}' +
      '\n\n记录值格式和 filter 语法见系统提示中的多维表格指南。',
    {
      action: z.enum([
        'list', 'get', 'search',
        'create', 'batch_create',
        'update', 'batch_update',
        'delete', 'batch_delete',
      ]).describe('操作类型'),
      app_token: z.string().describe('多维表格 app_token'),
      table_id: z.string().describe('数据表 ID'),
      record_id: z.string().optional().describe('记录 ID（get/update/delete 时必填）'),
      record_ids: z.array(z.string()).optional().describe('记录 ID 数组（batch_delete 时必填，最多 500）'),
      fields: z.record(z.unknown()).optional().describe('字段值对象 {字段名: 值}（create/update 时必填）'),
      records: z.array(z.object({
        record_id: z.string().optional(),
        fields: z.record(z.unknown()),
      })).optional().describe('记录数组（batch_create/batch_update 时必填，最多 500 条）'),
      filter: z.union([z.string(), z.record(z.unknown())]).optional().describe('过滤条件（list 用字符串格式，search 用对象格式）'),
      sort: z.union([z.string(), z.array(z.record(z.unknown()))]).optional().describe('排序条件'),
      field_names: z.array(z.string()).optional().describe('返回的字段列表（search 时可选）'),
      view_id: z.string().optional().describe('视图 ID（list 时可选）'),
      page_size: z.number().int().min(1).max(500).optional().describe('分页大小（最大 500）'),
      page_token: z.string().optional().describe('分页标记'),
    },
    async (args) =>
      withTokenFn(async (token) => toToolResult(await handleBitableRecord(args as BitableRecordParams, token, client))),
  );
}
