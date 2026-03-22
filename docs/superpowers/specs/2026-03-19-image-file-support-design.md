# Image & File Support for Feishu Bot

**Date:** 2026-03-19
**Status:** Draft

## Goal

Let users send images and files to the bot, and retrieve files from the project directory. This is the most critical capability gap for a Claude Code bot — users need to share screenshots, error messages, design mockups, and code files.

## Scope

### In Scope (This Iteration)

**Input — User sends media to bot:**

1. **Images** — User sends an image (screenshot, design mockup, error message). The bot downloads it and passes it directly to Claude as a vision content block. Claude sees the image natively via its multimodal capability.

2. **Files** — User sends a file (code, config, PDF, etc.). The bot downloads it and saves it to the project's `_uploads/` directory. Claude is told the file path and can read/analyze it with its built-in tools.

3. **Rich text (post) with embedded images** — Feishu "post" messages can contain inline images mixed with text. All embedded images are extracted and passed to Claude alongside the text.

**Output — Bot sends files to user:**

4. **`/file <path>` command** — User requests a specific file from the project directory. Bot sends it as a Feishu file message. Limited to 1MB; larger files prompt the user to wait for Feishu Docs integration.

### Out of Scope (Future Iterations)

- Voice messages (next iteration, local Whisper)
- Feishu Docs output (iteration 3)
- Bitable integration (iteration 4)
- Video messages
- Stickers / emoji-only messages

## Architecture

### Input Flow

```
User sends image/file in Feishu
        ↓
parse.ts — Extract resource descriptors (type, key, name)
           from message content (no download yet)
        ↓
dispatch.ts — After gate check, before calling executor:
              1. Images → download via Feishu API → hold in memory as base64
              2. Files → download via Feishu API → save to project _uploads/ dir
        ↓
executor.ts — Build SDKUserMessage with:
              - Image content blocks (base64) for images
              - Text content block with file path hints for files
              - Original user text
        ↓
Claude processes multimodal input
```

### Output Flow (`/file` command)

```
User sends "/file path/to/file"
        ↓
dispatch.ts — Recognize /file command
        ↓
Validate: file exists, within project dir, ≤ 1MB
        ↓
Upload file to Feishu via im.v1.files API
        ↓
Send as file message to user
```

## New Module

**`src/messaging/inbound/media.ts`** — Handles downloading images and files from Feishu.

- `downloadImage(messageId, imageKey)` → `{ base64, mediaType }`
- `downloadFile(messageId, fileKey, targetDir)` → `{ localPath, fileName }`

Implementation references the official OpenClaw Lark plugin's media handling patterns (`/tmp/openclaw-lark-latest/extracted/package/src/messaging/`).

## Changes to Existing Modules

| Module | Change |
|--------|--------|
| `messaging/types.ts` | Add `ResourceDescriptor` type and `resources` field to `MessageContext` |
| `messaging/inbound/parse.ts` | Extract image_key/file_key from `image`, `file`, and `post` message types |
| `messaging/inbound/dispatch.ts` | Download resources before calling executor; add `/file` command handler |
| `claude/executor.ts` | Accept images + file hints; build `SDKUserMessage` with mixed content blocks instead of plain string prompt |
| `messaging/outbound/send.ts` | Add `uploadFile()` and `sendFile()` functions for `/file` command |
| `utils/command.ts` | Register `/file` command |

## Constraints

- **Image size limit:** 20MB (Feishu platform limit)
- **File size limit:** 20MB for input, 1MB for output via `/file`
- **Supported image formats:** PNG, JPEG, GIF, WebP (Claude's supported formats)
- **File storage:** Saved to `<project>/_uploads/<timestamp>-<filename>`, cleaned up periodically
- **Security:** File output restricted to project directory (no path traversal)
- **Backward compatibility:** Text-only messages continue to work exactly as before

## Implementation Notes

- **SDK prompt type:** Executor switches from `query({ prompt: string })` to `query({ prompt: AsyncIterable<SDKUserMessage> })` to support image content blocks. For text-only messages, emit a single SDKUserMessage with one text block — behavior unchanged.
- **Feishu API auth:** `media.ts` uses the shared Lark SDK client (same as `send.ts`) for downloading resources. No additional auth setup needed.
- **Message type gate:** `dispatch.ts` currently rejects non-text messages. Must relax to accept `image`, `file`, and `post` types.
- **`_uploads/` cleanup:** Deferred — not blocking this iteration. Can add TTL-based cleanup later.

## Non-Goals

- No automatic file push from Claude to user (avoid spamming)
- No image generation or manipulation
- No OCR preprocessing (Claude handles vision natively)
