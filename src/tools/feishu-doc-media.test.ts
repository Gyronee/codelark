import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'stream';

vi.mock('./feishu-oapi.js', () => ({
  assertOk: (res: any) => { if (res.code !== 0) throw new Error(res.msg); },
}));

vi.mock('fs/promises', () => ({
  stat: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
}));

vi.mock('fs', () => ({ createReadStream: vi.fn(() => 'mock-stream') }));

// Mock Lark SDK client
const mockClient = {
  docx: {
    documentBlockChildren: { create: vi.fn() },
    documentBlock: { batchUpdate: vi.fn() },
  },
  drive: {
    v1: { media: { uploadAll: vi.fn(), download: vi.fn() } },
  },
  board: {
    v1: { whiteboard: { downloadAsImage: vi.fn() } },
  },
} as any;

const { handleDocMedia, extractDocumentId } = await import('./feishu-doc-media.js');

import * as fsMock from 'fs/promises';

describe('extractDocumentId', () => {
  it('extracts ID from a full Feishu doc URL', () => {
    const url = 'https://example.feishu.cn/docx/AbCd1234EfGh';
    expect(extractDocumentId(url)).toBe('AbCd1234EfGh');
  });

  it('returns plain ID as-is', () => {
    expect(extractDocumentId('AbCd1234EfGh')).toBe('AbCd1234EfGh');
  });

  it('trims whitespace', () => {
    expect(extractDocumentId('  MyDocId  ')).toBe('MyDocId');
  });

  it('handles URL with extra path segments after doc ID', () => {
    const url = 'https://example.feishu.cn/docx/DocId999?foo=bar';
    expect(extractDocumentId(url)).toBe('DocId999');
  });
});

describe('handleDocMedia - insert image', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('full 3-step flow: create block → upload → patch', async () => {
    (fsMock.stat as any).mockResolvedValue({ size: 1024 });
    mockClient.docx.documentBlockChildren.create.mockResolvedValue({
      code: 0,
      msg: 'success',
      data: {
        children: [{ block_id: 'img-block-id-001' }],
      },
    });
    mockClient.drive.v1.media.uploadAll.mockResolvedValue({
      file_token: 'file-token-img-001',
    });
    mockClient.docx.documentBlock.batchUpdate.mockResolvedValue({
      code: 0,
      msg: 'success',
    });

    const result = await handleDocMedia(
      {
        action: 'insert',
        doc_id: 'https://example.feishu.cn/docx/DocId123',
        file_path: '/tmp/test-image.png',
        type: 'image',
        align: 'center',
      },
      'u-token',
      mockClient,
    ) as any;

    // Step 1: create block
    expect(mockClient.docx.documentBlockChildren.create).toHaveBeenCalledWith(
      {
        path: { document_id: 'DocId123', block_id: 'DocId123' },
        data: {
          children: [{ block_type: 27, image: {} }],
        },
        params: { document_revision_id: -1 },
      },
      { userAccessToken: 'u-token' },
    );

    // Step 2: upload media
    expect(mockClient.drive.v1.media.uploadAll).toHaveBeenCalledWith(
      {
        data: {
          file_name: 'test-image.png',
          parent_type: 'docx_image',
          parent_node: 'img-block-id-001',
          size: 1024,
          file: 'mock-stream',
          extra: JSON.stringify({ drive_route_token: 'DocId123' }),
        },
      },
      { userAccessToken: 'u-token' },
    );

    // Step 3: patch block
    expect(mockClient.docx.documentBlock.batchUpdate).toHaveBeenCalledWith(
      {
        path: { document_id: 'DocId123' },
        data: {
          requests: [
            {
              block_id: 'img-block-id-001',
              replace_image: {
                token: 'file-token-img-001',
                align: 2, // center
              },
            },
          ],
        },
        params: { document_revision_id: -1 },
      },
      { userAccessToken: 'u-token' },
    );

    expect(result.success).toBe(true);
    expect(result.type).toBe('image');
    expect(result.document_id).toBe('DocId123');
    expect(result.block_id).toBe('img-block-id-001');
    expect(result.file_token).toBe('file-token-img-001');
    expect(result.file_name).toBe('test-image.png');
  });

  it('uses left align when specified', async () => {
    (fsMock.stat as any).mockResolvedValue({ size: 512 });
    mockClient.docx.documentBlockChildren.create.mockResolvedValue({
      code: 0, msg: 'success',
      data: { children: [{ block_id: 'blk-left' }] },
    });
    mockClient.drive.v1.media.uploadAll.mockResolvedValue({ file_token: 'ft-left' });
    mockClient.docx.documentBlock.batchUpdate.mockResolvedValue({ code: 0, msg: 'success' });

    await handleDocMedia(
      { action: 'insert', doc_id: 'DocId', file_path: '/tmp/img.jpg', type: 'image', align: 'left' },
      'u-token',
      mockClient,
    );

    const patchCall = mockClient.docx.documentBlock.batchUpdate.mock.calls[0][0];
    expect(patchCall.data.requests[0].replace_image.align).toBe(1);
  });

  it('includes caption in patch when provided', async () => {
    (fsMock.stat as any).mockResolvedValue({ size: 512 });
    mockClient.docx.documentBlockChildren.create.mockResolvedValue({
      code: 0, msg: 'success',
      data: { children: [{ block_id: 'blk-cap' }] },
    });
    mockClient.drive.v1.media.uploadAll.mockResolvedValue({ file_token: 'ft-cap' });
    mockClient.docx.documentBlock.batchUpdate.mockResolvedValue({ code: 0, msg: 'success' });

    await handleDocMedia(
      { action: 'insert', doc_id: 'DocId', file_path: '/tmp/img.jpg', type: 'image', caption: 'My caption' },
      'u-token',
      mockClient,
    );

    const patchCall = mockClient.docx.documentBlock.batchUpdate.mock.calls[0][0];
    expect(patchCall.data.requests[0].replace_image.caption).toEqual({ content: 'My caption' });
  });

  it('uses data.file_token fallback from uploadAll response', async () => {
    (fsMock.stat as any).mockResolvedValue({ size: 256 });
    mockClient.docx.documentBlockChildren.create.mockResolvedValue({
      code: 0, msg: 'success',
      data: { children: [{ block_id: 'blk-fallback' }] },
    });
    // No top-level file_token, only nested data.file_token
    mockClient.drive.v1.media.uploadAll.mockResolvedValue({
      data: { file_token: 'nested-ft' },
    });
    mockClient.docx.documentBlock.batchUpdate.mockResolvedValue({ code: 0, msg: 'success' });

    const result = await handleDocMedia(
      { action: 'insert', doc_id: 'DocId', file_path: '/tmp/img.png', type: 'image' },
      'u-token',
      mockClient,
    ) as any;

    expect(result.file_token).toBe('nested-ft');
  });

  it('returns error when file exceeds 20MB', async () => {
    (fsMock.stat as any).mockResolvedValue({ size: 21 * 1024 * 1024 });

    const result = await handleDocMedia(
      { action: 'insert', doc_id: 'DocId', file_path: '/tmp/big.bin' },
      'u-token',
      mockClient,
    ) as any;

    expect(result.error).toMatch(/exceeds 20MB limit/);
    expect(mockClient.docx.documentBlockChildren.create).not.toHaveBeenCalled();
  });

  it('returns error when stat fails', async () => {
    (fsMock.stat as any).mockRejectedValue(new Error('ENOENT: no such file'));

    const result = await handleDocMedia(
      { action: 'insert', doc_id: 'DocId', file_path: '/tmp/missing.png' },
      'u-token',
      mockClient,
    ) as any;

    expect(result.error).toMatch(/failed to read file/);
    expect(result.error).toMatch(/ENOENT/);
  });

  it('returns error when create block returns no block_id', async () => {
    (fsMock.stat as any).mockResolvedValue({ size: 100 });
    mockClient.docx.documentBlockChildren.create.mockResolvedValue({
      code: 0, msg: 'success',
      data: { children: [] },
    });

    const result = await handleDocMedia(
      { action: 'insert', doc_id: 'DocId', file_path: '/tmp/img.png' },
      'u-token',
      mockClient,
    ) as any;

    expect(result.error).toMatch(/no block_id returned/);
  });

  it('returns error when upload returns no file_token', async () => {
    (fsMock.stat as any).mockResolvedValue({ size: 100 });
    mockClient.docx.documentBlockChildren.create.mockResolvedValue({
      code: 0, msg: 'success',
      data: { children: [{ block_id: 'blk-noft' }] },
    });
    mockClient.drive.v1.media.uploadAll.mockResolvedValue({});

    const result = await handleDocMedia(
      { action: 'insert', doc_id: 'DocId', file_path: '/tmp/img.png' },
      'u-token',
      mockClient,
    ) as any;

    expect(result.error).toMatch(/no file_token returned/);
  });
});

describe('handleDocMedia - insert file', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('uses block_type=23 and extracts blockId from children[0].children[0]', async () => {
    (fsMock.stat as any).mockResolvedValue({ size: 2048 });
    mockClient.docx.documentBlockChildren.create.mockResolvedValue({
      code: 0,
      msg: 'success',
      data: {
        // File block returns View Block wrapper; actual file block ID is nested
        children: [{ children: ['file-block-id-001'] }],
      },
    });
    mockClient.drive.v1.media.uploadAll.mockResolvedValue({
      file_token: 'file-token-doc-001',
    });
    mockClient.docx.documentBlock.batchUpdate.mockResolvedValue({
      code: 0,
      msg: 'success',
    });

    const result = await handleDocMedia(
      {
        action: 'insert',
        doc_id: 'FileDocId',
        file_path: '/tmp/report.pdf',
        type: 'file',
      },
      'u-token',
      mockClient,
    ) as any;

    // Verify block_type=23 and file block data
    const createCall = mockClient.docx.documentBlockChildren.create.mock.calls[0][0];
    expect(createCall.data.children[0].block_type).toBe(23);
    expect(createCall.data.children[0].file).toEqual({ token: '' });

    // Verify blockId extracted from children[0].children[0]
    expect(result.block_id).toBe('file-block-id-001');

    // Verify parent_type is docx_file
    const uploadCall = mockClient.drive.v1.media.uploadAll.mock.calls[0][0];
    expect(uploadCall.data.parent_type).toBe('docx_file');
    expect(uploadCall.data.parent_node).toBe('file-block-id-001');

    // Verify patch uses replace_file
    const patchCall = mockClient.docx.documentBlock.batchUpdate.mock.calls[0][0];
    expect(patchCall.data.requests[0].replace_file).toEqual({ token: 'file-token-doc-001' });
    expect(patchCall.data.requests[0].replace_image).toBeUndefined();

    expect(result.success).toBe(true);
    expect(result.type).toBe('file');
    expect(result.file_name).toBe('report.pdf');
  });
});

describe('handleDocMedia - download media', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('downloads media and saves to file', async () => {
    const fileData = Buffer.from('binary file data');
    mockClient.drive.v1.media.download.mockResolvedValue({
      headers: { 'content-type': 'image/png' },
      getReadableStream: () => Readable.from([fileData]),
    });
    (fsMock.mkdir as any).mockResolvedValue(undefined);
    (fsMock.writeFile as any).mockResolvedValue(undefined);

    const result = await handleDocMedia(
      {
        action: 'download',
        resource_token: 'media-token-001',
        resource_type: 'media',
        output_path: '/tmp/downloaded.png',
      },
      'u-token',
      mockClient,
    ) as any;

    expect(mockClient.drive.v1.media.download).toHaveBeenCalledWith(
      { path: { file_token: 'media-token-001' } },
      { userAccessToken: 'u-token' },
    );
    expect(fsMock.mkdir).toHaveBeenCalledWith('/tmp', { recursive: true });
    expect(fsMock.writeFile).toHaveBeenCalledWith('/tmp/downloaded.png', fileData);
    expect(result.resource_type).toBe('media');
    expect(result.resource_token).toBe('media-token-001');
    expect(result.size_bytes).toBe(fileData.length);
    expect(result.content_type).toBe('image/png');
    expect(result.saved_path).toBe('/tmp/downloaded.png');
  });

  it('auto-detects extension from Content-Type when output_path has no ext', async () => {
    const fileData = Buffer.from('png data');
    mockClient.drive.v1.media.download.mockResolvedValue({
      headers: { 'content-type': 'image/png' },
      getReadableStream: () => Readable.from([fileData]),
    });
    (fsMock.mkdir as any).mockResolvedValue(undefined);
    (fsMock.writeFile as any).mockResolvedValue(undefined);

    const result = await handleDocMedia(
      {
        action: 'download',
        resource_token: 'media-token-002',
        resource_type: 'media',
        output_path: '/tmp/image-no-ext',
      },
      'u-token',
      mockClient,
    ) as any;

    expect(result.saved_path).toBe('/tmp/image-no-ext.png');
    expect(fsMock.writeFile).toHaveBeenCalledWith('/tmp/image-no-ext.png', fileData);
  });

  it('downloads whiteboard image', async () => {
    const imgData = Buffer.from('whiteboard image data');
    mockClient.board.v1.whiteboard.downloadAsImage.mockResolvedValue({
      headers: { 'content-type': 'image/png' },
      getReadableStream: () => Readable.from([imgData]),
    });
    (fsMock.mkdir as any).mockResolvedValue(undefined);
    (fsMock.writeFile as any).mockResolvedValue(undefined);

    const result = await handleDocMedia(
      {
        action: 'download',
        resource_token: 'wb-token-001',
        resource_type: 'whiteboard',
        output_path: '/tmp/whiteboard.png',
      },
      'u-token',
      mockClient,
    ) as any;

    expect(mockClient.board.v1.whiteboard.downloadAsImage).toHaveBeenCalledWith(
      { path: { whiteboard_id: 'wb-token-001' } },
      { userAccessToken: 'u-token' },
    );
    expect(result.resource_type).toBe('whiteboard');
    expect(result.saved_path).toBe('/tmp/whiteboard.png');
  });

  it('whiteboard auto-appends .png when no ext and unknown content-type', async () => {
    const imgData = Buffer.from('wb data');
    mockClient.board.v1.whiteboard.downloadAsImage.mockResolvedValue({
      headers: { 'content-type': 'application/octet-stream' },
      getReadableStream: () => Readable.from([imgData]),
    });
    (fsMock.mkdir as any).mockResolvedValue(undefined);
    (fsMock.writeFile as any).mockResolvedValue(undefined);

    const result = await handleDocMedia(
      {
        action: 'download',
        resource_token: 'wb-token-002',
        resource_type: 'whiteboard',
        output_path: '/tmp/wb-no-ext',
      },
      'u-token',
      mockClient,
    ) as any;

    expect(result.saved_path).toBe('/tmp/wb-no-ext.png');
  });

  it('returns error when file write fails', async () => {
    mockClient.drive.v1.media.download.mockResolvedValue({
      headers: {},
      getReadableStream: () => Readable.from([Buffer.from('data')]),
    });
    (fsMock.mkdir as any).mockResolvedValue(undefined);
    (fsMock.writeFile as any).mockRejectedValue(new Error('EACCES: permission denied'));

    const result = await handleDocMedia(
      {
        action: 'download',
        resource_token: 'tok',
        resource_type: 'media',
        output_path: '/readonly/file.bin',
      },
      'u-token',
      mockClient,
    ) as any;

    expect(result.error).toMatch(/failed to save file/);
    expect(result.error).toMatch(/EACCES/);
  });
});
