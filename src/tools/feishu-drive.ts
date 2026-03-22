/**
 * Feishu Drive File tool: feishu_drive_file
 *
 * Actions: list, get_meta, copy, move, delete, upload, download
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type * as lark from '@larksuiteoapi/node-sdk';
import { assertOk, toToolResult, type WithTokenFn } from './feishu-oapi.js';
import * as fs from 'fs/promises';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DriveFileAction = 'list' | 'get_meta' | 'copy' | 'move' | 'delete' | 'upload' | 'download';

export interface DriveFileParams {
  action: DriveFileAction;
  // list
  folder_token?: string;
  page_size?: number;
  page_token?: string;
  order_by?: 'EditedTime' | 'CreatedTime';
  direction?: 'ASC' | 'DESC';
  // get_meta
  request_docs?: Array<{ doc_token: string; doc_type: string }>;
  // copy/move/delete/download
  file_token?: string;
  // copy
  name?: string;
  // copy/move/delete
  type?: string;
  // copy alias
  parent_node?: string;
  // upload
  file_path?: string;
  file_content_base64?: string;
  file_name?: string;
  size?: number;
  // download
  output_path?: string;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleDriveFile(
  params: DriveFileParams,
  userAccessToken: string,
  client: lark.Client,
): Promise<unknown> {
  const p = params;

  switch (p.action) {
    // -------------------------------------------------------------------------
    // LIST FILES
    // -------------------------------------------------------------------------
    case 'list': {
      const res = await (client.drive.file as any).list(
        {
          params: {
            folder_token: p.folder_token,
            page_size: p.page_size,
            page_token: p.page_token,
            order_by: p.order_by,
            direction: p.direction,
          },
        },
        { userAccessToken },
      );
      assertOk(res);
      const data = res.data;
      return {
        files: data?.files,
        has_more: data?.has_more,
        page_token: data?.next_page_token,
      };
    }

    // -------------------------------------------------------------------------
    // GET META
    // -------------------------------------------------------------------------
    case 'get_meta': {
      if (!p.request_docs || !Array.isArray(p.request_docs) || p.request_docs.length === 0) {
        return {
          error: "request_docs must be a non-empty array. Correct format: {action: 'get_meta', request_docs: [{doc_token: '...', doc_type: 'sheet'}]}",
        };
      }
      const res = await (client.drive.meta as any).batchQuery(
        {
          data: {
            request_docs: p.request_docs,
          },
        },
        { userAccessToken },
      );
      assertOk(res);
      return {
        metas: res.data?.metas ?? [],
      };
    }

    // -------------------------------------------------------------------------
    // COPY FILE
    // -------------------------------------------------------------------------
    case 'copy': {
      if (!p.file_token) throw new Error('file_token is required for copy');
      if (!p.name) throw new Error('name is required for copy');
      if (!p.type) throw new Error('type is required for copy');
      const targetFolderToken = p.folder_token || p.parent_node;
      const res = await (client.drive.file as any).copy(
        {
          path: { file_token: p.file_token },
          data: {
            name: p.name,
            type: p.type,
            folder_token: targetFolderToken,
          },
        },
        { userAccessToken },
      );
      assertOk(res);
      return {
        file: res.data?.file,
      };
    }

    // -------------------------------------------------------------------------
    // MOVE FILE
    // -------------------------------------------------------------------------
    case 'move': {
      if (!p.file_token) throw new Error('file_token is required for move');
      if (!p.type) throw new Error('type is required for move');
      if (!p.folder_token) throw new Error('folder_token is required for move');
      const res = await (client.drive.file as any).move(
        {
          path: { file_token: p.file_token },
          data: {
            type: p.type,
            folder_token: p.folder_token,
          },
        },
        { userAccessToken },
      );
      assertOk(res);
      return {
        success: true,
        task_id: res.data?.task_id,
        file_token: p.file_token,
        target_folder_token: p.folder_token,
      };
    }

    // -------------------------------------------------------------------------
    // DELETE FILE
    // -------------------------------------------------------------------------
    case 'delete': {
      if (!p.file_token) throw new Error('file_token is required for delete');
      if (!p.type) throw new Error('type is required for delete');
      const res = await (client.drive.file as any).delete(
        {
          path: { file_token: p.file_token },
          params: {
            type: p.type,
          },
        },
        { userAccessToken },
      );
      assertOk(res);
      return {
        success: true,
        task_id: res.data?.task_id,
        file_token: p.file_token,
      };
    }

    // -------------------------------------------------------------------------
    // UPLOAD FILE
    // -------------------------------------------------------------------------
    case 'upload': {
      let fileBuffer: Buffer;
      let fileName: string;
      let fileSize: number;

      if (p.file_path) {
        try {
          fileBuffer = await fs.readFile(p.file_path);
          fileName = p.file_name || path.basename(p.file_path);
          fileSize = fileBuffer.length;
        } catch (err) {
          return {
            error: `failed to read local file: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      } else if (p.file_content_base64) {
        if (!p.file_name || !p.size) {
          return {
            error: 'file_name and size are required when using file_content_base64',
          };
        }
        fileBuffer = Buffer.from(p.file_content_base64, 'base64');
        fileName = p.file_name;
        fileSize = p.size;
      } else {
        return {
          error: 'either file_path or file_content_base64 is required',
        };
      }

      const res = await (client.drive.file as any).uploadAll(
        {
          data: {
            file_name: fileName,
            parent_type: 'explorer',
            parent_node: p.parent_node || '',
            size: fileSize,
            file: fileBuffer,
          },
        },
        { userAccessToken },
      );
      assertOk(res);
      return {
        file_token: res.data?.file_token,
        file_name: fileName,
        size: fileSize,
      };
    }

    // -------------------------------------------------------------------------
    // DOWNLOAD FILE
    // -------------------------------------------------------------------------
    case 'download': {
      if (!p.file_token) throw new Error('file_token is required for download');
      const res = await (client.drive.file as any).download(
        {
          path: { file_token: p.file_token },
        },
        { userAccessToken },
      );

      const stream = res.getReadableStream();
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk as Buffer);
      }
      const fileBuffer = Buffer.concat(chunks);

      if (p.output_path) {
        try {
          await fs.mkdir(path.dirname(p.output_path), { recursive: true });
          await fs.writeFile(p.output_path, fileBuffer);
          return {
            saved_path: p.output_path,
            size: fileBuffer.length,
          };
        } catch (err) {
          return {
            error: `failed to save file: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      } else {
        return {
          file_content_base64: fileBuffer.toString('base64'),
          size: fileBuffer.length,
        };
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createDriveFileTool(withTokenFn: WithTokenFn, client: lark.Client) {
  return tool(
    'feishu_drive_file',
    '【以用户身份】飞书云空间文件管理工具。当用户要求查看云空间(云盘)中的文件列表、获取文件信息、复制/移动/删除文件、上传/下载文件时使用。消息中的文件读写**禁止**使用该工具！' +
      '\n\nActions:' +
      '\n- list（列出文件）：列出文件夹下的文件。不提供 folder_token 时获取根目录清单' +
      "\n- get_meta（批量获取元数据）：批量查询文档元信息，使用 request_docs 数组参数，格式：[{doc_token: '...', doc_type: 'sheet'}]" +
      '\n- copy（复制文件）：复制文件到指定位置' +
      '\n- move（移动文件）：移动文件到指定文件夹' +
      '\n- delete（删除文件）：删除文件' +
      '\n- upload（上传文件）：上传本地文件到云空间。提供 file_path（本地文件路径）或 file_content_base64（Base64 编码）' +
      '\n- download（下载文件）：下载文件到本地。提供 output_path（本地保存路径）则保存到本地，否则返回 Base64 编码' +
      '\n\n【重要】copy/move/delete 操作需要 file_token 和 type 参数。get_meta 使用 request_docs 数组参数。' +
      '\n【重要】upload 优先使用 file_path（自动读取文件、提取文件名和大小），也支持 file_content_base64（需手动提供 file_name 和 size）。' +
      '\n【重要】download 提供 output_path 时保存到本地，不提供则返回 Base64。',
    {
      action: z
        .enum(['list', 'get_meta', 'copy', 'move', 'delete', 'upload', 'download'])
        .describe('操作类型'),
      folder_token: z
        .string()
        .optional()
        .describe('文件夹 token（可选，用于 list/copy）。不填时获取根目录'),
      page_size: z.number().int().min(1).max(200).optional().describe('分页大小（1-200）'),
      page_token: z.string().optional().describe('分页标记。首次请求无需填写'),
      order_by: z
        .enum(['EditedTime', 'CreatedTime'])
        .optional()
        .describe('排序方式：EditedTime（编辑时间）、CreatedTime（创建时间）'),
      direction: z
        .enum(['ASC', 'DESC'])
        .optional()
        .describe('排序方向：ASC（升序）、DESC（降序）'),
      request_docs: z
        .array(
          z.object({
            doc_token: z.string().describe('文档 token'),
            doc_type: z
              .enum(['doc', 'sheet', 'file', 'bitable', 'docx', 'folder', 'mindnote', 'slides'])
              .describe('文档类型'),
          }),
        )
        .optional()
        .describe('要查询的文档列表（get_meta 时必填，最多 50 个）'),
      file_token: z.string().optional().describe('文件 token（copy/move/delete/download 时必填）'),
      name: z.string().optional().describe('目标文件名（copy 时必填）'),
      type: z
        .enum(['doc', 'sheet', 'file', 'bitable', 'docx', 'folder', 'mindnote', 'slides'])
        .optional()
        .describe('文档类型（copy/move/delete 时必填）'),
      file_path: z.string().optional().describe('本地文件路径（upload 时与 file_content_base64 二选一）'),
      file_content_base64: z
        .string()
        .optional()
        .describe('文件内容的 Base64 编码（upload 时与 file_path 二选一）'),
      file_name: z
        .string()
        .optional()
        .describe('文件名（upload 时可选；使用 file_content_base64 时必填）'),
      size: z
        .number()
        .int()
        .optional()
        .describe('文件大小（字节，upload 时可选；使用 file_content_base64 时必填）'),
      parent_node: z
        .string()
        .optional()
        .describe('父节点 token（upload 时可选，不填则上传到根目录）'),
      output_path: z
        .string()
        .optional()
        .describe("本地保存路径（download 时可选，如 '/tmp/file.pdf'）。不提供则返回 Base64"),
    },
    async (args) =>
      withTokenFn(async (token) => toToolResult(await handleDriveFile(args as DriveFileParams, token, client))),
  );
}
