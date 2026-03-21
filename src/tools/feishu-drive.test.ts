import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'stream';

vi.mock('./feishu-oapi.js', () => ({
  assertOk: (res: any) => { if (res.code !== 0) throw new Error(res.msg); },
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  stat: vi.fn(),
  mkdir: vi.fn(),
}));

// Create mock client
const mockClient = {
  drive: {
    file: {
      list: vi.fn(),
      copy: vi.fn(),
      move: vi.fn(),
      delete: vi.fn(),
      uploadAll: vi.fn(),
      download: vi.fn(),
    },
    meta: {
      batchQuery: vi.fn(),
    },
  },
} as any;

const { handleDriveFile } = await import('./feishu-drive.js');

import * as fsMock from 'fs/promises';

describe('handleDriveFile', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  // -------------------------------------------------------------------------
  // LIST
  // -------------------------------------------------------------------------
  it('list: returns files with pagination', async () => {
    const files = [{ token: 'f1', name: 'Doc One', type: 'docx' }];
    mockClient.drive.file.list.mockResolvedValue({
      code: 0,
      msg: 'success',
      data: { files, has_more: true, next_page_token: 'next-token' },
    });

    const result = await handleDriveFile(
      { action: 'list', folder_token: 'folder-1', page_size: 20 },
      'u-token',
      mockClient,
    ) as any;

    expect(mockClient.drive.file.list).toHaveBeenCalledWith(
      {
        params: {
          folder_token: 'folder-1',
          page_size: 20,
          page_token: undefined,
          order_by: undefined,
          direction: undefined,
        },
      },
      { userAccessToken: 'u-token' },
    );
    expect(result.files).toEqual(files);
    expect(result.has_more).toBe(true);
    expect(result.page_token).toBe('next-token');
  });

  it('list: works without folder_token (root)', async () => {
    mockClient.drive.file.list.mockResolvedValue({
      code: 0, msg: 'success',
      data: { files: [], has_more: false },
    });

    const result = await handleDriveFile(
      { action: 'list' },
      'u-token',
      mockClient,
    ) as any;

    expect(result.files).toEqual([]);
    expect(result.has_more).toBe(false);
  });

  it('list: throws on API error', async () => {
    mockClient.drive.file.list.mockResolvedValue({ code: 99991400, msg: 'Permission denied' });

    await expect(
      handleDriveFile({ action: 'list' }, 'u-token', mockClient),
    ).rejects.toThrow('Permission denied');
  });

  // -------------------------------------------------------------------------
  // GET META
  // -------------------------------------------------------------------------
  it('get_meta: batch queries metadata', async () => {
    const metas = [{ doc_token: 'tok1', doc_type: 'sheet', title: 'Sheet 1' }];
    mockClient.drive.meta.batchQuery.mockResolvedValue({
      code: 0, msg: 'success',
      data: { metas },
    });

    const requestDocs = [{ doc_token: 'tok1', doc_type: 'sheet' }];
    const result = await handleDriveFile(
      { action: 'get_meta', request_docs: requestDocs },
      'u-token',
      mockClient,
    ) as any;

    expect(mockClient.drive.meta.batchQuery).toHaveBeenCalledWith(
      { data: { request_docs: requestDocs } },
      { userAccessToken: 'u-token' },
    );
    expect(result.metas).toEqual(metas);
  });

  it('get_meta: returns error when request_docs is empty', async () => {
    const result = await handleDriveFile(
      { action: 'get_meta', request_docs: [] },
      'u-token',
      mockClient,
    ) as any;

    expect(result.error).toMatch(/request_docs must be a non-empty array/);
    expect(mockClient.drive.meta.batchQuery).not.toHaveBeenCalled();
  });

  it('get_meta: returns error when request_docs is missing', async () => {
    const result = await handleDriveFile(
      { action: 'get_meta' },
      'u-token',
      mockClient,
    ) as any;

    expect(result.error).toMatch(/request_docs must be a non-empty array/);
  });

  // -------------------------------------------------------------------------
  // COPY
  // -------------------------------------------------------------------------
  it('copy: copies file to target folder', async () => {
    const file = { token: 'new-f1', name: 'Copy of Doc' };
    mockClient.drive.file.copy.mockResolvedValue({
      code: 0, msg: 'success',
      data: { file },
    });

    const result = await handleDriveFile(
      {
        action: 'copy',
        file_token: 'f1',
        name: 'Copy of Doc',
        type: 'docx',
        folder_token: 'folder-dest',
      },
      'u-token',
      mockClient,
    ) as any;

    expect(mockClient.drive.file.copy).toHaveBeenCalledWith(
      {
        path: { file_token: 'f1' },
        data: { name: 'Copy of Doc', type: 'docx', folder_token: 'folder-dest' },
      },
      { userAccessToken: 'u-token' },
    );
    expect(result.file).toEqual(file);
  });

  it('copy: uses parent_node as folder_token alias', async () => {
    mockClient.drive.file.copy.mockResolvedValue({
      code: 0, msg: 'success',
      data: { file: { token: 'new-f2' } },
    });

    await handleDriveFile(
      {
        action: 'copy',
        file_token: 'f1',
        name: 'Copy',
        type: 'docx',
        parent_node: 'pn-alias',
      },
      'u-token',
      mockClient,
    );

    const call = mockClient.drive.file.copy.mock.calls[0][0];
    expect(call.data.folder_token).toBe('pn-alias');
  });

  it('copy: throws when required params are missing', async () => {
    await expect(
      handleDriveFile({ action: 'copy', name: 'x', type: 'docx' }, 'u-token', mockClient),
    ).rejects.toThrow('file_token is required');

    await expect(
      handleDriveFile({ action: 'copy', file_token: 'f1', type: 'docx' }, 'u-token', mockClient),
    ).rejects.toThrow('name is required');

    await expect(
      handleDriveFile({ action: 'copy', file_token: 'f1', name: 'x' }, 'u-token', mockClient),
    ).rejects.toThrow('type is required');
  });

  // -------------------------------------------------------------------------
  // MOVE
  // -------------------------------------------------------------------------
  it('move: moves file to target folder', async () => {
    mockClient.drive.file.move.mockResolvedValue({
      code: 0, msg: 'success',
      data: { task_id: 'task-1' },
    });

    const result = await handleDriveFile(
      {
        action: 'move',
        file_token: 'f1',
        type: 'docx',
        folder_token: 'folder-dest',
      },
      'u-token',
      mockClient,
    ) as any;

    expect(mockClient.drive.file.move).toHaveBeenCalledWith(
      {
        path: { file_token: 'f1' },
        data: { type: 'docx', folder_token: 'folder-dest' },
      },
      { userAccessToken: 'u-token' },
    );
    expect(result.success).toBe(true);
    expect(result.task_id).toBe('task-1');
    expect(result.file_token).toBe('f1');
    expect(result.target_folder_token).toBe('folder-dest');
  });

  it('move: throws when required params are missing', async () => {
    await expect(
      handleDriveFile({ action: 'move', type: 'docx', folder_token: 'fd' }, 'u-token', mockClient),
    ).rejects.toThrow('file_token is required');

    await expect(
      handleDriveFile({ action: 'move', file_token: 'f1', folder_token: 'fd' }, 'u-token', mockClient),
    ).rejects.toThrow('type is required');

    await expect(
      handleDriveFile({ action: 'move', file_token: 'f1', type: 'docx' }, 'u-token', mockClient),
    ).rejects.toThrow('folder_token is required');
  });

  // -------------------------------------------------------------------------
  // DELETE
  // -------------------------------------------------------------------------
  it('delete: deletes file', async () => {
    mockClient.drive.file.delete.mockResolvedValue({
      code: 0, msg: 'success',
      data: { task_id: 'del-task-1' },
    });

    const result = await handleDriveFile(
      { action: 'delete', file_token: 'f1', type: 'docx' },
      'u-token',
      mockClient,
    ) as any;

    expect(mockClient.drive.file.delete).toHaveBeenCalledWith(
      {
        path: { file_token: 'f1' },
        params: { type: 'docx' },
      },
      { userAccessToken: 'u-token' },
    );
    expect(result.success).toBe(true);
    expect(result.task_id).toBe('del-task-1');
    expect(result.file_token).toBe('f1');
  });

  it('delete: throws when required params are missing', async () => {
    await expect(
      handleDriveFile({ action: 'delete', type: 'docx' }, 'u-token', mockClient),
    ).rejects.toThrow('file_token is required');

    await expect(
      handleDriveFile({ action: 'delete', file_token: 'f1' }, 'u-token', mockClient),
    ).rejects.toThrow('type is required');
  });

  // -------------------------------------------------------------------------
  // UPLOAD (file_path)
  // -------------------------------------------------------------------------
  it('upload with file_path: reads file and uploads', async () => {
    const fileContent = Buffer.from('hello world');
    (fsMock.readFile as any).mockResolvedValue(fileContent);
    mockClient.drive.file.uploadAll.mockResolvedValue({
      code: 0, msg: 'success',
      data: { file_token: 'uploaded-f1' },
    });

    const result = await handleDriveFile(
      {
        action: 'upload',
        file_path: '/tmp/test.txt',
        parent_node: 'folder-root',
      },
      'u-token',
      mockClient,
    ) as any;

    expect(fsMock.readFile).toHaveBeenCalledWith('/tmp/test.txt');
    expect(mockClient.drive.file.uploadAll).toHaveBeenCalledWith(
      {
        data: {
          file_name: 'test.txt',
          parent_type: 'explorer',
          parent_node: 'folder-root',
          size: fileContent.length,
          file: fileContent,
        },
      },
      { userAccessToken: 'u-token' },
    );
    expect(result.file_token).toBe('uploaded-f1');
    expect(result.file_name).toBe('test.txt');
    expect(result.size).toBe(fileContent.length);
  });

  it('upload with file_path: uses provided file_name and size', async () => {
    const fileContent = Buffer.from('data');
    (fsMock.readFile as any).mockResolvedValue(fileContent);
    mockClient.drive.file.uploadAll.mockResolvedValue({
      code: 0, msg: 'success',
      data: { file_token: 'ft2' },
    });

    const result = await handleDriveFile(
      {
        action: 'upload',
        file_path: '/tmp/something.bin',
        file_name: 'custom.bin',
        size: 999,
      },
      'u-token',
      mockClient,
    ) as any;

    const call = mockClient.drive.file.uploadAll.mock.calls[0][0];
    expect(call.data.file_name).toBe('custom.bin');
    expect(call.data.size).toBe(999);
    expect(result.file_name).toBe('custom.bin');
  });

  it('upload with file_path: returns error when file read fails', async () => {
    (fsMock.readFile as any).mockRejectedValue(new Error('ENOENT: no such file'));

    const result = await handleDriveFile(
      { action: 'upload', file_path: '/tmp/nonexistent.txt' },
      'u-token',
      mockClient,
    ) as any;

    expect(result.error).toMatch(/failed to read local file/);
    expect(result.error).toMatch(/ENOENT/);
  });

  // -------------------------------------------------------------------------
  // UPLOAD (file_content_base64)
  // -------------------------------------------------------------------------
  it('upload with file_content_base64: decodes and uploads', async () => {
    const content = 'base64 content here';
    const base64 = Buffer.from(content).toString('base64');
    mockClient.drive.file.uploadAll.mockResolvedValue({
      code: 0, msg: 'success',
      data: { file_token: 'b64-ft' },
    });

    const result = await handleDriveFile(
      {
        action: 'upload',
        file_content_base64: base64,
        file_name: 'report.pdf',
        size: Buffer.from(content).length,
      },
      'u-token',
      mockClient,
    ) as any;

    expect(fsMock.readFile).not.toHaveBeenCalled();
    const call = mockClient.drive.file.uploadAll.mock.calls[0][0];
    expect(call.data.file_name).toBe('report.pdf');
    expect(call.data.file.toString()).toBe(content);
    expect(result.file_token).toBe('b64-ft');
  });

  it('upload with file_content_base64: returns error when file_name or size missing', async () => {
    const result = await handleDriveFile(
      {
        action: 'upload',
        file_content_base64: 'abc',
        // file_name and size omitted
      },
      'u-token',
      mockClient,
    ) as any;

    expect(result.error).toMatch(/file_name and size are required/);
  });

  it('upload: returns error when neither file_path nor base64 is given', async () => {
    const result = await handleDriveFile(
      { action: 'upload' },
      'u-token',
      mockClient,
    ) as any;

    expect(result.error).toMatch(/either file_path or file_content_base64 is required/);
  });

  // -------------------------------------------------------------------------
  // DOWNLOAD (with output_path)
  // -------------------------------------------------------------------------
  it('download with output_path: saves file to disk', async () => {
    (fsMock.mkdir as any).mockResolvedValue(undefined);
    (fsMock.writeFile as any).mockResolvedValue(undefined);
    mockClient.drive.file.download.mockResolvedValue({
      code: 0,
      msg: 'success',
      getReadableStream: () => Readable.from([Buffer.from('file content')]),
    });

    const result = await handleDriveFile(
      { action: 'download', file_token: 'f1', output_path: '/tmp/out/file.pdf' },
      'u-token',
      mockClient,
    ) as any;

    expect(mockClient.drive.file.download).toHaveBeenCalledWith(
      { path: { file_token: 'f1' } },
      { userAccessToken: 'u-token' },
    );
    expect(fsMock.mkdir).toHaveBeenCalledWith('/tmp/out', { recursive: true });
    expect(fsMock.writeFile).toHaveBeenCalledWith(
      '/tmp/out/file.pdf',
      Buffer.from('file content'),
    );
    expect(result.saved_path).toBe('/tmp/out/file.pdf');
    expect(result.size).toBe(Buffer.from('file content').length);
  });

  it('download with output_path: returns error when write fails', async () => {
    (fsMock.mkdir as any).mockResolvedValue(undefined);
    (fsMock.writeFile as any).mockRejectedValue(new Error('EACCES: permission denied'));
    mockClient.drive.file.download.mockResolvedValue({
      code: 0,
      msg: 'success',
      getReadableStream: () => Readable.from([Buffer.from('data')]),
    });

    const result = await handleDriveFile(
      { action: 'download', file_token: 'f1', output_path: '/readonly/file.pdf' },
      'u-token',
      mockClient,
    ) as any;

    expect(result.error).toMatch(/failed to save file/);
    expect(result.error).toMatch(/EACCES/);
  });

  // -------------------------------------------------------------------------
  // DOWNLOAD (without output_path)
  // -------------------------------------------------------------------------
  it('download without output_path: returns base64 content', async () => {
    mockClient.drive.file.download.mockResolvedValue({
      code: 0,
      msg: 'success',
      getReadableStream: () => Readable.from([Buffer.from('file content')]),
    });

    const result = await handleDriveFile(
      { action: 'download', file_token: 'f1' },
      'u-token',
      mockClient,
    ) as any;

    expect(fsMock.writeFile).not.toHaveBeenCalled();
    const expectedBase64 = Buffer.from('file content').toString('base64');
    expect(result.file_content_base64).toBe(expectedBase64);
    expect(result.size).toBe(Buffer.from('file content').length);
  });

  it('download: throws when file_token is missing', async () => {
    await expect(
      handleDriveFile({ action: 'download' }, 'u-token', mockClient),
    ).rejects.toThrow('file_token is required');
  });
});
