import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getClient } from '../outbound/send.js';
import { logger } from '../../logger.js';

// ---------------------------------------------------------------------------
// Response extraction helper
// ---------------------------------------------------------------------------

/**
 * Extract a Buffer from the various response formats the Feishu Node SDK may
 * return (direct Buffer, ArrayBuffer, { data: ... }, readable stream, etc.).
 */
export async function extractBuffer(response: unknown): Promise<Buffer> {
  // Direct Buffer
  if (Buffer.isBuffer(response)) return response;

  // ArrayBuffer
  if (response instanceof ArrayBuffer) return Buffer.from(response);

  // Null / undefined guard
  if (response == null) {
    throw new Error('Received null/undefined response from Feishu SDK');
  }

  const resp = response as any;

  // Response with .data as Buffer or ArrayBuffer or stream
  if (resp.data != null) {
    if (Buffer.isBuffer(resp.data)) return resp.data;
    if (resp.data instanceof ArrayBuffer) return Buffer.from(resp.data);
    if (typeof resp.data.pipe === 'function') return streamToBuffer(resp.data);
  }

  // Response with .getReadableStream()
  if (typeof resp.getReadableStream === 'function') {
    const stream = await resp.getReadableStream();
    return streamToBuffer(stream);
  }

  // Response with .writeFile(path) — write to temp, read back
  if (typeof resp.writeFile === 'function') {
    const tmpFile = path.join(os.tmpdir(), `feishu-extract-${Date.now()}`);
    try {
      await resp.writeFile(tmpFile);
      return fs.readFileSync(tmpFile);
    } finally {
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  }

  // Async iterable / iterator
  if (typeof resp[Symbol.asyncIterator] === 'function' || typeof resp.next === 'function') {
    const chunks: Buffer[] = [];
    const iterable: AsyncIterable<any> =
      typeof resp[Symbol.asyncIterator] === 'function'
        ? resp
        : asyncIteratorToIterable(resp);
    for await (const chunk of iterable) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  // Node.js Readable stream (pipe-able)
  if (typeof resp.pipe === 'function') {
    return streamToBuffer(resp);
  }

  throw new Error('Unable to extract binary data from Feishu SDK response: unrecognised format');
}

function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: any) => chunks.push(Buffer.from(chunk)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

async function* asyncIteratorToIterable(iterator: AsyncIterator<any>): AsyncIterable<any> {
  while (true) {
    const { value, done } = await iterator.next();
    if (done) break;
    yield value;
  }
}

// ---------------------------------------------------------------------------
// Image extension detection from magic bytes
// ---------------------------------------------------------------------------

function detectImageExtension(buf: Buffer): string {
  if (buf.length < 12) return '.png';
  const hex8 = buf.subarray(0, 4).toString('hex');
  if (hex8 === '89504e47') return '.png';
  if (hex8.startsWith('ffd8ff')) return '.jpg';
  if (hex8 === '47494638') return '.gif';
  // WebP: starts with RIFF....WEBP
  if (hex8 === '52494646' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return '.webp';
  return '.png';
}

// ---------------------------------------------------------------------------
// downloadImage
// ---------------------------------------------------------------------------

/**
 * Download an image attached to a Feishu message and save it to a temp file.
 * Returns the local file path so it can be loaded as multimodal content.
 */
export async function downloadImage(
  messageId: string,
  imageKey: string,
): Promise<{ filePath: string }> {
  const client = getClient();
  const response = await (client.im as any).messageResource.get({
    path: { message_id: messageId, file_key: imageKey },
    params: { type: 'image' },
  });

  const buf = await extractBuffer(response);
  const ext = detectImageExtension(buf);
  const filePath = path.join(os.tmpdir(), `feishu-img-${Date.now()}-${imageKey}${ext}`);
  fs.writeFileSync(filePath, buf);
  logger.debug({ messageId, imageKey, filePath, size: buf.length }, 'Downloaded image');
  return { filePath };
}

// ---------------------------------------------------------------------------
// downloadFile
// ---------------------------------------------------------------------------

/**
 * Download a file attached to a Feishu message and save it to the project's
 * _uploads/ directory so Claude can access it with built-in tools.
 */
export async function downloadFile(
  messageId: string,
  fileKey: string,
  fileName: string,
  targetDir: string,
): Promise<{ localPath: string; fileName: string }> {
  const client = getClient();
  const response = await (client.im as any).messageResource.get({
    path: { message_id: messageId, file_key: fileKey },
    params: { type: 'file' },
  });

  const buf = await extractBuffer(response);
  const uploadsDir = path.join(targetDir, '_uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });
  const safeName = `${Date.now()}-${fileName.replace(/[\/\\]/g, '_')}`;
  const localPath = path.join(uploadsDir, safeName);
  fs.writeFileSync(localPath, buf);
  logger.debug({ messageId, fileKey, localPath, size: buf.length }, 'Downloaded file');
  return { localPath, fileName };
}
