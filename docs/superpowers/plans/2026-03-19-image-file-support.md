# Image & File Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users send images and files to the Feishu bot for Claude to analyze, and retrieve project files via `/file` command.

**Architecture:** Images are downloaded from Feishu, saved to temp files, and their local paths embedded in the prompt text. The Claude Code SDK automatically discovers local image paths in the prompt and converts them to multimodal content blocks (same approach as the official OpenClaw plugin — see `dispatch-builders.js` comment: "The SDK's detectAndLoadPromptImages will discover image paths from the text"). If auto-detection fails, Task 4 includes a verification step and fallback to explicit `AsyncIterable<SDKUserMessage>` with base64 image content blocks. Files are saved to the project's `_uploads/` directory and Claude reads them with its built-in tools. The `/file` command uploads project files to Feishu and sends them as file messages.

**Tech Stack:** `@larksuiteoapi/node-sdk` (Feishu API), `@anthropic-ai/claude-agent-sdk`, Node.js `fs`/`path`/`os`

**Reference:** Official OpenClaw Lark plugin at `/tmp/openclaw-lark-latest/extracted/package/src/messaging/` — especially `outbound/media.js` (download/upload), `converters/` (parsing), `inbound/media-resolver.js` (resource download), `inbound/enrich.js` (path substitution).

---

### Task 1: Add ResourceDescriptor type and extend MessageContext

**Files:**
- Modify: `src/messaging/types.ts`

- [ ] **Step 1: Add ResourceDescriptor interface and resources field**

Add to `src/messaging/types.ts`:

```typescript
export interface ResourceDescriptor {
  type: 'image' | 'file';
  fileKey: string;
  fileName?: string;
}
```

Add `resources: ResourceDescriptor[]` field to `MessageContext`.

- [ ] **Step 2: Verify existing tests still pass**

Run: `npx vitest run`
Expected: All tests pass (no behavior change, just added types)

- [ ] **Step 3: Commit**

```bash
git add src/messaging/types.ts
git commit -m "feat: add ResourceDescriptor type to MessageContext"
```

---

### Task 2: Parse resources from image, file, and post messages

**Files:**
- Modify: `src/messaging/inbound/parse.ts`
- Test: `src/messaging/inbound/__tests__/parse.test.ts`

Reference: `/tmp/openclaw-lark-latest/extracted/package/src/messaging/converters/image.js`, `file.js`, `post.js`

- [ ] **Step 1: Write tests for resource extraction**

Test cases:
1. `msg_type: 'image'` — extract `image_key` from content JSON `{"image_key": "img_xxx"}`
2. `msg_type: 'file'` — extract `file_key` and `file_name` from content JSON `{"file_key": "file_xxx", "file_name": "code.py"}`
3. `msg_type: 'post'` — extract embedded images from post content (elements with `tag: 'img'` have `image_key`)
4. `msg_type: 'text'` — resources is empty array (backward compat)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/messaging/inbound/__tests__/parse.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement resource extraction in parseMessageEvent**

In `parse.ts`, after parsing content JSON:
- If `messageType === 'image'`: push `{ type: 'image', fileKey: content.image_key }` to resources
- If `messageType === 'file'`: push `{ type: 'file', fileKey: content.file_key, fileName: content.file_name }` to resources
- If `messageType === 'post'`: walk post content elements, for each `tag: 'img'` push `{ type: 'image', fileKey: el.image_key }`
- For image messages, set `text` to `'[用户发送了一张图片]'` if text is empty
- For file messages, set `text` to `'[用户发送了文件: ${fileName}]'` if text is empty

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/messaging/inbound/__tests__/parse.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/messaging/inbound/parse.ts src/messaging/inbound/__tests__/parse.test.ts
git commit -m "feat: parse image/file/post resources from Feishu messages"
```

---

### Task 3: Create media download module

**Files:**
- Create: `src/messaging/inbound/media.ts`
- Test: `src/messaging/inbound/__tests__/media.test.ts`

Reference: `/tmp/openclaw-lark-latest/extracted/package/src/messaging/outbound/media.js` lines 42-177 (`extractBufferFromResponse`, `downloadMessageResourceFeishu`)

- [ ] **Step 1: Write tests for downloadImage and downloadFile**

Test `downloadImage`:
- Mock `client.im.messageResource.get` to return a buffer
- Verify returns `{ filePath }` where filePath is a temp file with correct extension
- Verify the file exists on disk

Test `downloadFile`:
- Mock `client.im.messageResource.get` to return a buffer
- Verify file is saved to `targetDir/_uploads/<timestamp>-<filename>`
- Verify returns `{ localPath, fileName }`

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/messaging/inbound/__tests__/media.test.ts`
Expected: FAIL

- [ ] **Step 3: Export client from send.ts**

In `src/messaging/outbound/send.ts`, the `client` variable is module-scoped and not exported. Add a getter function:

```typescript
export function getClient(): Lark.Client {
  if (!client) throw new Error('Feishu client not initialized — call initFeishuClient first');
  return client;
}
```

- [ ] **Step 4: Implement media.ts**

Create `src/messaging/inbound/media.ts` with:

```typescript
import { getClient } from '../outbound/send.js';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { logger } from '../../logger.js';

// Download image from Feishu, save to temp file, return local path
// SDK's detectAndLoadPromptImages will discover the path automatically
export async function downloadImage(messageId: string, imageKey: string): Promise<{ filePath: string }> {
  const response = await client.im.messageResource.get({
    path: { message_id: messageId, file_key: imageKey },
    params: { type: 'image' },
  });
  const buffer = await extractBuffer(response);
  const ext = detectImageExt(buffer);
  const filePath = join(tmpdir(), `feishu-img-${Date.now()}-${imageKey}${ext}`);
  writeFileSync(filePath, buffer);
  return { filePath };
}

// Download file from Feishu, save to project _uploads/ directory
export async function downloadFile(
  messageId: string, fileKey: string, fileName: string, targetDir: string,
): Promise<{ localPath: string; fileName: string }> {
  const response = await client.im.messageResource.get({
    path: { message_id: messageId, file_key: fileKey },
    params: { type: 'file' },
  });
  const buffer = await extractBuffer(response);
  const uploadsDir = join(targetDir, '_uploads');
  if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });
  const safeName = `${Date.now()}-${fileName}`;
  const localPath = join(uploadsDir, safeName);
  writeFileSync(localPath, buffer);
  return { localPath, fileName };
}
```

Include `extractBuffer` helper that handles the multiple response formats from the Lark SDK (Buffer, ArrayBuffer, ReadableStream, writeFile — reference official plugin's `extractBufferFromResponse`).

Include `detectImageExt` that checks magic bytes: PNG (`89504e47`), JPEG (`ffd8ff`), GIF (`474946`), WebP (`52494646...57454250`) → defaults to `.png`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/messaging/inbound/__tests__/media.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/messaging/inbound/media.ts src/messaging/inbound/__tests__/media.test.ts
git commit -m "feat: add media download module for Feishu images and files"
```

---

### Task 4: Integrate media download into dispatch and build prompt with image paths

**Files:**
- Modify: `src/messaging/inbound/dispatch.ts`

Reference: `/tmp/openclaw-lark-latest/extracted/package/src/messaging/inbound/enrich.js` (substituteMediaPaths), `/tmp/openclaw-lark-latest/extracted/package/src/messaging/inbound/dispatch-builders.js` (buildBodyForAgent)

- [ ] **Step 1: Remove the non-text message rejection**

In `dispatch.ts`, replace the block that rejects non-text messages:

```typescript
// BEFORE:
if (ctx.messageType !== 'text') {
  await sendText(ctx.chatId, '目前仅支持文本消息。', ctx.threadId ?? undefined);
  return;
}

// AFTER: accept image, file, and post types alongside text
if (!['text', 'image', 'file', 'post'].includes(ctx.messageType)) {
  await sendText(ctx.chatId, '暂不支持该消息类型，请发送文字、图片或文件。', ctx.threadId ?? undefined);
  return;
}
```

- [ ] **Step 2: Add media download before executor call in handleClaudeTask**

After resolving the project path and before calling `executeClaudeTask`, download resources:

```typescript
import { downloadImage, downloadFile } from './media.js';

// In handleClaudeTask, after project resolution:
const imagePaths: string[] = [];
const fileHints: string[] = [];

for (const res of ctx.resources) {
  try {
    if (res.type === 'image') {
      const { filePath } = await downloadImage(ctx.messageId, res.fileKey);
      imagePaths.push(filePath);
    } else if (res.type === 'file') {
      const { localPath, fileName } = await downloadFile(
        ctx.messageId, res.fileKey, res.fileName || 'file', projectPath,
      );
      fileHints.push(`用户上传了文件 "${fileName}"，已保存到 ${localPath}，请查看并分析。`);
    }
  } catch (err) {
    logger.warn({ err, resource: res }, 'Failed to download resource');
  }
}
```

- [ ] **Step 3: Build prompt with image paths and file hints**

Construct the prompt so that:
1. Image paths are included in the text — the SDK's `detectAndLoadPromptImages` will discover them
2. File hints tell Claude where to find uploaded files

```typescript
let prompt = ctx.text;

// Append image paths for SDK auto-detection
if (imagePaths.length > 0) {
  prompt += '\n\n' + imagePaths.join('\n');
}

// Append file location hints
if (fileHints.length > 0) {
  prompt += '\n\n' + fileHints.join('\n');
}

// ... existing reply context / group history appending
```

- [ ] **Step 4: Run all tests**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 5: Manual test — verify image auto-detection works**

1. Start the bot: `npx tsx src/index.ts`
2. Send a screenshot to the bot in Feishu
3. Verify: bot responds with understanding of the image content
4. **If Claude receives the path as text instead of seeing the image:** the SDK's auto-detection is not working. Implement fallback: modify `executor.ts` to accept images as base64 content blocks via `AsyncIterable<SDKUserMessage>` (see spec's Implementation Notes). This would involve:
   - Read image files into base64 in dispatch.ts instead of passing paths
   - Change `executeClaudeTask` signature to accept `images?: Array<{ base64: string; mediaType: string }>`
   - Construct `SDKUserMessage` with image content blocks in executor.ts

- [ ] **Step 6: Manual test — send a file to the bot**

1. Send a `.py` or `.ts` file to the bot
2. Verify: bot acknowledges the file and can analyze its content

- [ ] **Step 7: Commit**

```bash
git add src/messaging/inbound/dispatch.ts
git commit -m "feat: integrate media download into dispatch, support image/file messages"
```

---

### Task 5: Add /file command for file retrieval

**Files:**
- Modify: `src/utils/command.ts`
- Modify: `src/messaging/inbound/dispatch.ts`
- Modify: `src/messaging/outbound/send.ts`
- Test: `src/utils/__tests__/command.test.ts`

Reference: `/tmp/openclaw-lark-latest/extracted/package/src/messaging/outbound/media.js` lines 222-298 (`uploadFileLark`, `sendFileLark`)

- [ ] **Step 1: Add /file command parsing**

In `command.ts`, add `'file'` to the `ParsedCommand.type` union and handle `/file <path>` in `parseCommand`.

- [ ] **Step 2: Write test for /file command parsing**

Test: `/file src/index.ts` → `{ type: 'file', action: null, args: ['src/index.ts'] }`

- [ ] **Step 3: Run test to verify it passes**

Run: `npx vitest run src/utils/__tests__/command.test.ts`
Expected: PASS

- [ ] **Step 4: Add uploadFile and sendFile to send.ts**

```typescript
export async function uploadFile(filePath: string, fileName: string): Promise<string> {
  const fileStream = createReadStream(filePath);
  const ext = extname(fileName).toLowerCase();
  const fileType = EXTENSION_TYPE_MAP[ext] ?? 'stream';
  const response = await client.im.file.create({
    data: { file_type: fileType, file_name: fileName, file: fileStream },
  });
  return response?.data?.file_key ?? response?.file_key;
}

export async function sendFile(chatId: string, fileKey: string, threadId?: string): Promise<void> {
  await client.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: chatId,
      msg_type: 'file',
      content: JSON.stringify({ file_key: fileKey }),
      ...(threadId ? { root_id: threadId } : {}),
    },
  });
}
```

Include `EXTENSION_TYPE_MAP` (reference official plugin's `detectFileType`):
- `.pdf` → `'pdf'`, `.doc/.docx` → `'doc'`, `.xls/.xlsx/.csv` → `'xls'`, `.ppt/.pptx` → `'ppt'`, default → `'stream'`

- [ ] **Step 5: Add /file command handler in dispatch.ts**

In `handleCommand`, add the `'file'` case:

```typescript
case 'file': {
  const filePath = cmd.args.join(' ');
  if (!filePath) {
    await sendText(ctx.chatId, '用法: /file <文件路径>', threadId);
    return;
  }
  // Resolve relative to user's active project
  const user = db.getUser(ctx.senderId);
  const projectName = user?.active_project;
  if (!projectName) {
    await sendText(ctx.chatId, '请先使用 /project use <name> 选择项目', threadId);
    return;
  }
  const projectDir = projectManager.getProjectPath(ctx.senderId, projectName);
  const fullPath = resolve(projectDir, filePath);

  // Security: ensure path is within project directory
  if (!fullPath.startsWith(projectDir)) {
    await sendText(ctx.chatId, '路径不合法：不能访问项目目录以外的文件', threadId);
    return;
  }
  if (!existsSync(fullPath)) {
    await sendText(ctx.chatId, `文件不存在: ${filePath}`, threadId);
    return;
  }
  const stats = statSync(fullPath);
  if (stats.size > 1024 * 1024) {
    await sendText(ctx.chatId, `文件过大 (${(stats.size / 1024 / 1024).toFixed(1)}MB)，上限 1MB。后续将支持通过飞书文档查看。`, threadId);
    return;
  }
  const fileName = basename(fullPath);
  const fileKey = await uploadFile(fullPath, fileName);
  await sendFile(ctx.chatId, fileKey, threadId);
  return;
}
```

- [ ] **Step 6: Run all tests**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 7: Manual test — /file command**

1. Create a small file in a project
2. Send `/file <filename>` to the bot
3. Verify: bot sends the file as a Feishu file message
4. Test error cases: nonexistent file, path traversal attempt, oversized file

- [ ] **Step 8: Commit**

```bash
git add src/utils/command.ts src/messaging/inbound/dispatch.ts src/messaging/outbound/send.ts src/utils/__tests__/command.test.ts
git commit -m "feat: add /file command for retrieving project files"
```

---

### Task 6: Update /help and cleanup

**Files:**
- Modify: `src/messaging/inbound/dispatch.ts` (help text)

- [ ] **Step 1: Update /help output**

Add `/file <path>` to the help text. Also update the non-text rejection message if any stragglers.

- [ ] **Step 2: Add temp image cleanup**

After `executeClaudeTask` completes (in the finally block), delete temp image files:

```typescript
// Cleanup temp images
for (const imgPath of imagePaths) {
  try { unlinkSync(imgPath); } catch { /* ignore */ }
}
```

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/messaging/inbound/dispatch.ts
git commit -m "feat: update help text, add temp image cleanup"
```

---

### Task 7: End-to-end manual testing

- [ ] **Step 1: Test image understanding**

Send various images to the bot:
- Screenshot of code with an error → verify Claude explains the error
- A design mockup → verify Claude describes what it sees
- Image in a group chat with @mention → verify it works in groups

- [ ] **Step 2: Test file upload**

Send various files:
- `.py` file → verify Claude can read and analyze it
- `.json` config file → verify Claude can parse it
- Large file (>20MB) → verify graceful handling

- [ ] **Step 3: Test /file command**

- `/file src/index.ts` → verify file is sent
- `/file nonexistent.txt` → verify error message
- `/file ../../etc/passwd` → verify path traversal blocked
- `/file` (no args) → verify usage hint

- [ ] **Step 4: Test rich text (post) with images**

Send a Feishu post message with embedded images and text → verify all images are processed

- [ ] **Step 5: Test backward compatibility**

Send plain text messages → verify everything works exactly as before

- [ ] **Step 6: Final commit (if any remaining changes)**

```bash
git status
# Stage only relevant files explicitly
git commit -m "feat: image and file support for Feishu bot"
```
