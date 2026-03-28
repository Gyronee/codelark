// src/tools/feishu-bitable.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@larksuiteoapi/node-sdk', () => ({
  withUserAccessToken: (token: string) => ({ userAccessToken: token }),
}));

import { handleBitable, handleBitableField, handleBitableRecord } from './feishu-bitable.js';

function mockClient() {
  return {
    bitable: {
      app: {
        create: vi.fn().mockResolvedValue({ code: 0, msg: 'success', data: { app: { app_token: 'appXXX', name: 'Test' } } }),
        get: vi.fn().mockResolvedValue({ code: 0, msg: 'success', data: { app: { app_token: 'appXXX', name: 'Test' } } }),
        copy: vi.fn().mockResolvedValue({ code: 0, msg: 'success', data: { app: { app_token: 'appYYY', name: 'Copy' } } }),
      },
      appTable: {
        list: vi.fn().mockResolvedValue({ code: 0, msg: 'success', data: { items: [], has_more: false } }),
        create: vi.fn().mockResolvedValue({ code: 0, msg: 'success', data: { table_id: 'tblXXX' } }),
        delete: vi.fn().mockResolvedValue({ code: 0, msg: 'success', data: {} }),
      },
      appTableView: {
        list: vi.fn().mockResolvedValue({ code: 0, msg: 'success', data: { items: [], has_more: false } }),
        create: vi.fn().mockResolvedValue({ code: 0, msg: 'success', data: { view: { view_id: 'viwXXX' } } }),
        delete: vi.fn().mockResolvedValue({ code: 0, msg: 'success', data: {} }),
      },
    },
  } as any;
}

describe('handleBitable', () => {
  let client: ReturnType<typeof mockClient>;
  const token = 'test-token';

  beforeEach(() => {
    client = mockClient();
  });

  it('create_app: passes name and folder_token', async () => {
    const result = await handleBitable(
      { action: 'create_app', name: 'My Table', folder_token: 'fldXXX' },
      token, client,
    );
    expect(client.bitable.app.create).toHaveBeenCalledWith(
      { data: { name: 'My Table', folder_token: 'fldXXX' } },
      { userAccessToken: token },
    );
    expect(result).toHaveProperty('app');
  });

  it('get_app: passes app_token in path', async () => {
    await handleBitable({ action: 'get_app', app_token: 'appXXX' }, token, client);
    expect(client.bitable.app.get).toHaveBeenCalledWith(
      { path: { app_token: 'appXXX' } },
      { userAccessToken: token },
    );
  });

  it('copy_app: passes app_token, name, folder_token', async () => {
    await handleBitable(
      { action: 'copy_app', app_token: 'appXXX', name: 'Copy', folder_token: 'fldYYY' },
      token, client,
    );
    expect(client.bitable.app.copy).toHaveBeenCalledWith(
      { path: { app_token: 'appXXX' }, data: { name: 'Copy', folder_token: 'fldYYY' } },
      { userAccessToken: token },
    );
  });

  it('list_tables: passes app_token and pagination', async () => {
    await handleBitable(
      { action: 'list_tables', app_token: 'appXXX', page_size: 10 },
      token, client,
    );
    expect(client.bitable.appTable.list).toHaveBeenCalledWith(
      { path: { app_token: 'appXXX' }, params: { page_size: 10, page_token: undefined } },
      { userAccessToken: token },
    );
  });

  it('create_table: passes app_token and table config', async () => {
    const fields = [{ field_name: 'Name', type: 1 }];
    await handleBitable(
      { action: 'create_table', app_token: 'appXXX', name: 'Sheet1', fields },
      token, client,
    );
    expect(client.bitable.appTable.create).toHaveBeenCalledWith(
      { path: { app_token: 'appXXX' }, data: { table: { name: 'Sheet1', fields } } },
      { userAccessToken: token },
    );
  });

  it('delete_table: passes app_token and table_id', async () => {
    await handleBitable(
      { action: 'delete_table', app_token: 'appXXX', table_id: 'tblXXX' },
      token, client,
    );
    expect(client.bitable.appTable.delete).toHaveBeenCalledWith(
      { path: { app_token: 'appXXX', table_id: 'tblXXX' } },
      { userAccessToken: token },
    );
  });

  it('list_views: passes app_token and table_id', async () => {
    await handleBitable(
      { action: 'list_views', app_token: 'appXXX', table_id: 'tblXXX' },
      token, client,
    );
    expect(client.bitable.appTableView.list).toHaveBeenCalledWith(
      { path: { app_token: 'appXXX', table_id: 'tblXXX' }, params: { page_size: undefined, page_token: undefined } },
      { userAccessToken: token },
    );
  });

  it('create_view: passes view_name and view_type', async () => {
    await handleBitable(
      { action: 'create_view', app_token: 'appXXX', table_id: 'tblXXX', view_name: 'Grid', view_type: 'grid' },
      token, client,
    );
    expect(client.bitable.appTableView.create).toHaveBeenCalledWith(
      { path: { app_token: 'appXXX', table_id: 'tblXXX' }, data: { view_name: 'Grid', view_type: 'grid' } },
      { userAccessToken: token },
    );
  });

  it('delete_view: passes view_id', async () => {
    await handleBitable(
      { action: 'delete_view', app_token: 'appXXX', table_id: 'tblXXX', view_id: 'viwXXX' },
      token, client,
    );
    expect(client.bitable.appTableView.delete).toHaveBeenCalledWith(
      { path: { app_token: 'appXXX', table_id: 'tblXXX', view_id: 'viwXXX' } },
      { userAccessToken: token },
    );
  });

  it('throws on unknown action', async () => {
    await expect(handleBitable({ action: 'unknown' } as any, token, client))
      .rejects.toThrow('Unknown bitable action: unknown');
  });
});

function mockFieldClient() {
  return {
    bitable: {
      appTableField: {
        list: vi.fn().mockResolvedValue({ code: 0, msg: 'success', data: { items: [{ field_id: 'fldXXX', field_name: 'Name', type: 1 }], has_more: false } }),
        create: vi.fn().mockResolvedValue({ code: 0, msg: 'success', data: { field: { field_id: 'fldXXX', field_name: 'Status', type: 3 } } }),
        update: vi.fn().mockResolvedValue({ code: 0, msg: 'success', data: { field: { field_id: 'fldXXX', field_name: 'Updated', type: 3 } } }),
        delete: vi.fn().mockResolvedValue({ code: 0, msg: 'success', data: {} }),
      },
    },
  } as any;
}

describe('handleBitableField', () => {
  let client: ReturnType<typeof mockFieldClient>;
  const token = 'test-token';

  beforeEach(() => {
    client = mockFieldClient();
  });

  it('list: passes app_token, table_id, view_id', async () => {
    await handleBitableField(
      { action: 'list', app_token: 'appXXX', table_id: 'tblXXX', view_id: 'viwXXX' },
      token, client,
    );
    expect(client.bitable.appTableField.list).toHaveBeenCalledWith(
      { path: { app_token: 'appXXX', table_id: 'tblXXX' }, params: { view_id: 'viwXXX', page_size: undefined, page_token: undefined } },
      { userAccessToken: token },
    );
  });

  it('create: passes field_name, type, and property', async () => {
    const property = { options: [{ name: 'Todo' }, { name: 'Done' }] };
    await handleBitableField(
      { action: 'create', app_token: 'appXXX', table_id: 'tblXXX', field_name: 'Status', type: 3, property },
      token, client,
    );
    expect(client.bitable.appTableField.create).toHaveBeenCalledWith(
      { path: { app_token: 'appXXX', table_id: 'tblXXX' }, data: { field_name: 'Status', type: 3, property } },
      { userAccessToken: token },
    );
  });

  it('update: passes field_id with updated fields', async () => {
    await handleBitableField(
      { action: 'update', app_token: 'appXXX', table_id: 'tblXXX', field_id: 'fldXXX', field_name: 'Updated' },
      token, client,
    );
    expect(client.bitable.appTableField.update).toHaveBeenCalledWith(
      { path: { app_token: 'appXXX', table_id: 'tblXXX', field_id: 'fldXXX' }, data: { field_name: 'Updated', type: undefined, property: undefined } },
      { userAccessToken: token },
    );
  });

  it('delete: passes field_id', async () => {
    await handleBitableField(
      { action: 'delete', app_token: 'appXXX', table_id: 'tblXXX', field_id: 'fldXXX' },
      token, client,
    );
    expect(client.bitable.appTableField.delete).toHaveBeenCalledWith(
      { path: { app_token: 'appXXX', table_id: 'tblXXX', field_id: 'fldXXX' } },
      { userAccessToken: token },
    );
  });
});

const sampleRecord = { record_id: 'recXXX', fields: { Name: 'Test' } };

function mockRecordClient() {
  return {
    bitable: {
      appTableRecord: {
        list: vi.fn().mockResolvedValue({ code: 0, msg: 'success', data: { items: [sampleRecord], has_more: false, total: 1 } }),
        get: vi.fn().mockResolvedValue({ code: 0, msg: 'success', data: { record: sampleRecord } }),
        search: vi.fn().mockResolvedValue({ code: 0, msg: 'success', data: { items: [sampleRecord], has_more: false, total: 1 } }),
        create: vi.fn().mockResolvedValue({ code: 0, msg: 'success', data: { record: sampleRecord } }),
        batchCreate: vi.fn().mockResolvedValue({ code: 0, msg: 'success', data: { records: [sampleRecord] } }),
        update: vi.fn().mockResolvedValue({ code: 0, msg: 'success', data: { record: sampleRecord } }),
        batchUpdate: vi.fn().mockResolvedValue({ code: 0, msg: 'success', data: { records: [sampleRecord] } }),
        delete: vi.fn().mockResolvedValue({ code: 0, msg: 'success', data: { deleted: true } }),
        batchDelete: vi.fn().mockResolvedValue({ code: 0, msg: 'success', data: { records: [{ deleted: true, record_id: 'recXXX' }] } }),
      },
    },
  } as any;
}

describe('handleBitableRecord', () => {
  let client: ReturnType<typeof mockRecordClient>;
  const token = 'test-token';

  beforeEach(() => {
    client = mockRecordClient();
  });

  it('list: passes filter and sort as strings', async () => {
    const filter = '{"conjunction":"and","conditions":[]}';
    const sort = '[{"field_name":"Name","desc":true}]';
    await handleBitableRecord(
      { action: 'list', app_token: 'appXXX', table_id: 'tblXXX', filter, sort, page_size: 20 },
      token, client,
    );
    expect(client.bitable.appTableRecord.list).toHaveBeenCalledWith(
      {
        path: { app_token: 'appXXX', table_id: 'tblXXX' },
        params: { view_id: undefined, filter, sort, page_size: 20, page_token: undefined },
      },
      { userAccessToken: token },
    );
  });

  it('get: passes record_id', async () => {
    await handleBitableRecord(
      { action: 'get', app_token: 'appXXX', table_id: 'tblXXX', record_id: 'recXXX' },
      token, client,
    );
    expect(client.bitable.appTableRecord.get).toHaveBeenCalledWith(
      { path: { app_token: 'appXXX', table_id: 'tblXXX', record_id: 'recXXX' } },
      { userAccessToken: token },
    );
  });

  it('search: passes filter in body and field_names', async () => {
    const filter = { conjunction: 'and', conditions: [{ field_name: 'Status', operator: 'is', value: ['Done'] }] };
    await handleBitableRecord(
      { action: 'search', app_token: 'appXXX', table_id: 'tblXXX', filter, field_names: ['Name', 'Status'] },
      token, client,
    );
    expect(client.bitable.appTableRecord.search).toHaveBeenCalledWith(
      {
        path: { app_token: 'appXXX', table_id: 'tblXXX' },
        data: { filter, sort: undefined, field_names: ['Name', 'Status'], automatic_fields: true },
        params: { page_size: undefined, page_token: undefined, user_id_type: 'open_id' },
      },
      { userAccessToken: token },
    );
  });

  it('create: passes fields object', async () => {
    const fields = { Name: 'New Record', Status: 'Todo' };
    await handleBitableRecord(
      { action: 'create', app_token: 'appXXX', table_id: 'tblXXX', fields },
      token, client,
    );
    expect(client.bitable.appTableRecord.create).toHaveBeenCalledWith(
      { path: { app_token: 'appXXX', table_id: 'tblXXX' }, data: { fields } },
      { userAccessToken: token },
    );
  });

  it('batch_create: passes records array', async () => {
    const records = [{ fields: { Name: 'A' } }, { fields: { Name: 'B' } }];
    await handleBitableRecord(
      { action: 'batch_create', app_token: 'appXXX', table_id: 'tblXXX', records },
      token, client,
    );
    expect(client.bitable.appTableRecord.batchCreate).toHaveBeenCalledWith(
      { path: { app_token: 'appXXX', table_id: 'tblXXX' }, data: { records } },
      { userAccessToken: token },
    );
  });

  it('update: passes record_id and fields', async () => {
    const fields = { Status: 'Done' };
    await handleBitableRecord(
      { action: 'update', app_token: 'appXXX', table_id: 'tblXXX', record_id: 'recXXX', fields },
      token, client,
    );
    expect(client.bitable.appTableRecord.update).toHaveBeenCalledWith(
      { path: { app_token: 'appXXX', table_id: 'tblXXX', record_id: 'recXXX' }, data: { fields } },
      { userAccessToken: token },
    );
  });

  it('batch_update: passes records array with record_id', async () => {
    const records = [{ record_id: 'recXXX', fields: { Status: 'Done' } }];
    await handleBitableRecord(
      { action: 'batch_update', app_token: 'appXXX', table_id: 'tblXXX', records },
      token, client,
    );
    expect(client.bitable.appTableRecord.batchUpdate).toHaveBeenCalledWith(
      { path: { app_token: 'appXXX', table_id: 'tblXXX' }, data: { records } },
      { userAccessToken: token },
    );
  });

  it('delete: passes record_id', async () => {
    await handleBitableRecord(
      { action: 'delete', app_token: 'appXXX', table_id: 'tblXXX', record_id: 'recXXX' },
      token, client,
    );
    expect(client.bitable.appTableRecord.delete).toHaveBeenCalledWith(
      { path: { app_token: 'appXXX', table_id: 'tblXXX', record_id: 'recXXX' } },
      { userAccessToken: token },
    );
  });

  it('batch_delete: passes record_ids array', async () => {
    await handleBitableRecord(
      { action: 'batch_delete', app_token: 'appXXX', table_id: 'tblXXX', record_ids: ['recA', 'recB'] },
      token, client,
    );
    expect(client.bitable.appTableRecord.batchDelete).toHaveBeenCalledWith(
      { path: { app_token: 'appXXX', table_id: 'tblXXX' }, data: { records: ['recA', 'recB'] } },
      { userAccessToken: token },
    );
  });
});
