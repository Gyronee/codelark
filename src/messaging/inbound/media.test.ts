import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Mock getClient before importing the module under test
vi.mock('../outbound/send.js', () => ({
  getClient: vi.fn(),
}));

import { getClient } from '../outbound/send.js';
import { downloadImage, downloadFile, extractBuffer } from './media.js';

const PNG_HEADER = Buffer.from('89504e470d0a1a0a', 'hex'); // PNG magic bytes + IHDR preamble
const JPEG_HEADER = Buffer.from('ffd8ffe000104a464946', 'hex'); // JPEG magic bytes
const SAMPLE_CONTENT = Buffer.concat([PNG_HEADER, Buffer.from('fake-image-data')]);

function makeMockClient(responseData: unknown) {
  return {
    im: {
      messageResource: {
        get: vi.fn().mockResolvedValue(responseData),
      },
    },
  };
}

describe('extractBuffer', () => {
  it('handles direct Buffer', async () => {
    const buf = Buffer.from('hello');
    expect(await extractBuffer(buf)).toEqual(buf);
  });

  it('handles { data: Buffer }', async () => {
    const buf = Buffer.from('world');
    const result = await extractBuffer({ data: buf });
    expect(result).toEqual(buf);
  });

  it('handles ArrayBuffer', async () => {
    const ab = new ArrayBuffer(4);
    new Uint8Array(ab).set([1, 2, 3, 4]);
    const result = await extractBuffer(ab);
    expect(result).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it('handles { data: ArrayBuffer }', async () => {
    const ab = new ArrayBuffer(3);
    new Uint8Array(ab).set([10, 20, 30]);
    const result = await extractBuffer({ data: ab });
    expect(result).toEqual(Buffer.from([10, 20, 30]));
  });

  it('throws on null', async () => {
    await expect(extractBuffer(null)).rejects.toThrow('null/undefined');
  });

  it('throws on unrecognised format', async () => {
    await expect(extractBuffer({ unknown: true })).rejects.toThrow('unrecognised format');
  });
});

describe('downloadImage', () => {
  let cleanupFiles: string[] = [];

  beforeEach(() => {
    cleanupFiles = [];
  });
  afterEach(() => {
    for (const f of cleanupFiles) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  });

  it('downloads image and saves to temp file with .png extension', async () => {
    const mock = makeMockClient(SAMPLE_CONTENT);
    vi.mocked(getClient).mockReturnValue(mock as any);

    const { filePath } = await downloadImage('msg_123', 'img_key_abc');

    // Verify API was called correctly
    expect(mock.im.messageResource.get).toHaveBeenCalledWith({
      path: { message_id: 'msg_123', file_key: 'img_key_abc' },
      params: { type: 'image' },
    });

    // Verify file exists and has correct content
    cleanupFiles.push(filePath);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(filePath).toContain('feishu-img-');
    expect(filePath).toContain('img_key_abc');
    expect(filePath).toMatch(/\.png$/);
    expect(fs.readFileSync(filePath)).toEqual(SAMPLE_CONTENT);
  });

  it('detects JPEG extension from magic bytes', async () => {
    const jpegContent = Buffer.concat([JPEG_HEADER, Buffer.from('jpeg-data')]);
    const mock = makeMockClient(jpegContent);
    vi.mocked(getClient).mockReturnValue(mock as any);

    const { filePath } = await downloadImage('msg_456', 'img_key_jpg');
    cleanupFiles.push(filePath);
    expect(filePath).toMatch(/\.jpg$/);
  });

  it('handles response wrapped in { data: Buffer }', async () => {
    const mock = makeMockClient({ data: SAMPLE_CONTENT });
    vi.mocked(getClient).mockReturnValue(mock as any);

    const { filePath } = await downloadImage('msg_789', 'img_wrap');
    cleanupFiles.push(filePath);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath)).toEqual(SAMPLE_CONTENT);
  });
});

describe('downloadFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-test-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('downloads file and saves to _uploads/ directory', async () => {
    const fileContent = Buffer.from('file-content-here');
    const mock = makeMockClient(fileContent);
    vi.mocked(getClient).mockReturnValue(mock as any);

    const result = await downloadFile('msg_f1', 'file_key_1', 'report.pdf', tmpDir);

    // Verify API call
    expect(mock.im.messageResource.get).toHaveBeenCalledWith({
      path: { message_id: 'msg_f1', file_key: 'file_key_1' },
      params: { type: 'file' },
    });

    // Verify file
    expect(result.fileName).toBe('report.pdf');
    expect(result.localPath).toContain(path.join('_uploads'));
    expect(result.localPath).toContain('report.pdf');
    expect(fs.existsSync(result.localPath)).toBe(true);
    expect(fs.readFileSync(result.localPath)).toEqual(fileContent);
  });

  it('creates _uploads directory if it does not exist', async () => {
    const mock = makeMockClient(Buffer.from('data'));
    vi.mocked(getClient).mockReturnValue(mock as any);

    const uploadsDir = path.join(tmpDir, '_uploads');
    expect(fs.existsSync(uploadsDir)).toBe(false);

    await downloadFile('msg_f2', 'fk2', 'test.txt', tmpDir);
    expect(fs.existsSync(uploadsDir)).toBe(true);
  });
});
