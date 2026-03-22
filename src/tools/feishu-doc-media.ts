/**
 * Feishu Doc Media tool: feishu_doc_media
 *
 * Actions: insert (image/file into doc), download (media/whiteboard)
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type * as lark from '@larksuiteoapi/node-sdk';
import { assertOk, toToolResult, type WithTokenFn } from './feishu-oapi.js';
import * as fs from 'fs/promises';
import { createReadStream } from 'fs';
import * as path from 'path';
import { imageSize } from 'image-size';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

const ALIGN_MAP: Record<string, number> = {
  left: 1,
  center: 2,
  right: 3,
};

const MEDIA_CONFIG = {
  image: {
    block_type: 27,
    block_data: { image: {} },
    parent_type: 'docx_image',
    label: '图片',
  },
  file: {
    block_type: 23,
    block_data: { file: { token: '' } },
    parent_type: 'docx_file',
    label: '文件',
  },
} as const;

/** MIME type → extension mapping */
const MIME_TO_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
  'image/tiff': '.tiff',
  'video/mp4': '.mp4',
  'video/mpeg': '.mpeg',
  'video/quicktime': '.mov',
  'video/x-msvideo': '.avi',
  'video/webm': '.webm',
  'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/zip': '.zip',
  'application/x-rar-compressed': '.rar',
  'text/plain': '.txt',
  'application/json': '.json',
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DocMediaInsertParams {
  action: 'insert';
  doc_id: string;
  file_path: string;
  type?: 'image' | 'file';
  align?: 'left' | 'center' | 'right';
  caption?: string;
}

export interface DocMediaDownloadParams {
  action: 'download';
  resource_token: string;
  resource_type: 'media' | 'whiteboard';
  output_path: string;
}

export type DocMediaParams = DocMediaInsertParams | DocMediaDownloadParams;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract document_id from a Feishu doc URL or plain ID.
 */
export function extractDocumentId(input: string): string {
  const trimmed = input.trim();
  const urlMatch = trimmed.match(/\/docx\/([A-Za-z0-9]+)/);
  if (urlMatch) return urlMatch[1];
  return trimmed;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleDocMedia(
  params: DocMediaParams,
  userAccessToken: string,
  client: lark.Client,
): Promise<unknown> {
  if (params.action === 'insert') {
    return handleInsert(params, userAccessToken, client);
  }
  if (params.action === 'download') {
    return handleDownload(params, userAccessToken, client);
  }
  return { error: `unknown action: ${(params as any).action}` };
}

async function handleInsert(
  p: DocMediaInsertParams,
  userAccessToken: string,
  client: lark.Client,
): Promise<unknown> {
  const documentId = extractDocumentId(p.doc_id);
  const mediaType = p.type ?? 'image';
  const config = MEDIA_CONFIG[mediaType];
  const filePath = p.file_path;

  let fileSize: number;
  try {
    const stat = await fs.stat(filePath);
    fileSize = stat.size;
  } catch (err) {
    return {
      error: `failed to read file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (fileSize > MAX_FILE_SIZE) {
    return {
      error: `file ${(fileSize / 1024 / 1024).toFixed(1)}MB exceeds 20MB limit`,
    };
  }

  const fileName = path.basename(filePath);

  // Detect image dimensions before upload to avoid reading the file twice
  let imgWidth: number | undefined;
  let imgHeight: number | undefined;
  if (mediaType === 'image') {
    try {
      const imgBuf = await fs.readFile(filePath);
      const dims = imageSize(imgBuf);
      if (dims.width && dims.height) {
        imgWidth = dims.width;
        imgHeight = dims.height;
      }
    } catch { /* dimensions are optional */ }
  }

  const createRes = await (client.docx.documentBlockChildren as any).create(
    {
      path: {
        document_id: documentId,
        block_id: documentId,
      },
      data: {
        children: [{ block_type: config.block_type, ...config.block_data }],
      },
      params: { document_revision_id: -1 },
    },
    { userAccessToken },
  );
  assertOk(createRes);

  // File Block returns View Block (block_type: 33) as wrapper;
  // actual File Block ID is in children[0].children[0].
  // Image Block is direct: children[0].block_id
  let blockId: string;
  if (mediaType === 'file') {
    blockId = createRes.data?.children?.[0]?.children?.[0];
  } else {
    blockId = createRes.data?.children?.[0]?.block_id;
  }

  if (!blockId) {
    return {
      error: `failed to create ${config.label} block: no block_id returned`,
    };
  }

  const uploadRes = await (client.drive.v1.media as any).uploadAll(
    {
      data: {
        file_name: fileName,
        parent_type: config.parent_type,
        parent_node: blockId,
        size: fileSize,
        file: createReadStream(filePath),
        extra: JSON.stringify({ drive_route_token: documentId }),
      },
    },
    { userAccessToken },
  );

  const fileToken = uploadRes?.file_token ?? uploadRes?.data?.file_token;
  if (!fileToken) {
    return {
      error: `failed to upload ${config.label} media: no file_token returned`,
    };
  }

  const patchRequest: Record<string, unknown> = { block_id: blockId };
  if (mediaType === 'image') {
    const alignNum = ALIGN_MAP[p.align ?? 'center'];
    patchRequest.replace_image = {
      token: fileToken,
      align: alignNum,
      ...(imgWidth != null ? { width: imgWidth } : {}),
      ...(imgHeight != null ? { height: imgHeight } : {}),
      ...(p.caption ? { caption: { content: p.caption } } : {}),
    };
  } else {
    patchRequest.replace_file = { token: fileToken };
  }

  const patchRes = await (client.docx.documentBlock as any).batchUpdate(
    {
      path: { document_id: documentId },
      data: { requests: [patchRequest] },
      params: { document_revision_id: -1 },
    },
    { userAccessToken },
  );
  assertOk(patchRes);

  return {
    success: true,
    type: mediaType,
    document_id: documentId,
    block_id: blockId,
    file_token: fileToken,
    file_name: fileName,
  };
}

async function handleDownload(
  p: DocMediaDownloadParams,
  userAccessToken: string,
  client: lark.Client,
): Promise<unknown> {
  let res: any;
  if (p.resource_type === 'media') {
    res = await (client.drive.v1.media as any).download(
      { path: { file_token: p.resource_token } },
      { userAccessToken },
    );
  } else {
    res = await (client.board.v1.whiteboard as any).downloadAsImage(
      { path: { whiteboard_id: p.resource_token } },
      { userAccessToken },
    );
  }

  // Read binary stream
  const stream = res.getReadableStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  const buffer = Buffer.concat(chunks);

  // Infer extension from Content-Type
  const contentType: string = res.headers?.['content-type'] || '';
  let finalPath = p.output_path;
  const currentExt = path.extname(p.output_path);
  if (!currentExt && contentType) {
    const mimeType = contentType.split(';')[0].trim();
    const defaultExt = p.resource_type === 'whiteboard' ? '.png' : undefined;
    const suggestedExt = MIME_TO_EXT[mimeType] || defaultExt;
    if (suggestedExt) {
      finalPath = p.output_path + suggestedExt;
    }
  }

  // Ensure parent directory exists and save
  await fs.mkdir(path.dirname(finalPath), { recursive: true });
  try {
    await fs.writeFile(finalPath, buffer);
  } catch (err) {
    return {
      error: `failed to save file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return {
    resource_type: p.resource_type,
    resource_token: p.resource_token,
    size_bytes: buffer.length,
    content_type: contentType,
    saved_path: finalPath,
  };
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createDocMediaTool(withTokenFn: WithTokenFn, client: lark.Client) {
  return tool(
    'feishu_doc_media',
    '【以用户身份】飞书文档媒体管理工具。' +
      '支持两种操作：' +
      '(1) insert - 在飞书文档末尾插入本地图片或文件（需要文档 ID/URL + 本地文件路径，最大 20MB）；' +
      '(2) download - 下载文档素材或画板缩略图到本地（需要资源 token + 输出路径）。' +
      '\n\n【重要】insert 仅支持本地文件路径，不支持 URL。图片对齐默认居中。',
    {
      action: z.enum(['insert', 'download']).describe('操作类型：insert（插入媒体）或 download（下载媒体）'),
      doc_id: z
        .string()
        .optional()
        .describe('文档 ID 或文档 URL（insert 时必填）。支持从 URL 自动提取 document_id'),
      file_path: z
        .string()
        .optional()
        .describe('本地文件的绝对路径（insert 时必填）。图片支持 jpg/png/gif/webp 等，文件支持任意格式，最大 20MB'),
      type: z
        .enum(['image', 'file'])
        .optional()
        .describe('媒体类型："image"（图片，默认）或 "file"（文件附件）'),
      align: z
        .enum(['left', 'center', 'right'])
        .optional()
        .describe('对齐方式（仅图片生效）："center"（默认居中）、"left"（居左）、"right"（居右）'),
      caption: z
        .string()
        .optional()
        .describe('图片描述/标题（可选，仅图片生效）'),
      resource_token: z
        .string()
        .optional()
        .describe('资源的唯一标识（download 时必填）。file_token 用于文档素材，whiteboard_id 用于画板'),
      resource_type: z
        .enum(['media', 'whiteboard'])
        .optional()
        .describe('资源类型（download 时必填）：media（文档素材）或 whiteboard（画板缩略图）'),
      output_path: z
        .string()
        .optional()
        .describe(
          '保存文件的完整本地路径（download 时必填）。可包含扩展名（如 /tmp/image.png），不带扩展名时系统自动根据 Content-Type 添加',
        ),
    },
    async (args) =>
      withTokenFn(async (token) => toToolResult(await handleDocMedia(args as DocMediaParams, token, client))),
  );
}
