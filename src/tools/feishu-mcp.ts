/**
 * Feishu MCP endpoint caller (JSON-RPC 2.0)
 */

const FEISHU_MCP_ENDPOINT = 'https://mcp.feishu.cn/mcp';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * Recursively unwraps JSON-RPC responses:
 * - If v has `jsonrpc` + `result` → unwrap v.result
 * - If v has `jsonrpc` + `error`  → throw error
 * - If v has only `result` (no `jsonrpc`) → unwrap v.result
 * - Otherwise return as-is
 */
export function unwrapResult(v: unknown): unknown {
  if (!isRecord(v)) return v;

  const hasJsonRpc = typeof v['jsonrpc'] === 'string';
  const hasResult = 'result' in v;
  const hasError = 'error' in v;

  if (hasJsonRpc && (hasResult || hasError)) {
    if (hasError) {
      const err = v['error'];
      if (isRecord(err) && typeof err['message'] === 'string') {
        throw new Error(err['message']);
      }
      throw new Error('MCP returned error but could not parse message');
    }
    return unwrapResult(v['result']);
  }

  // Some implementations wrap with only { result: ... } without jsonrpc field
  if (!hasJsonRpc && hasResult && !hasError) {
    return unwrapResult(v['result']);
  }

  return v;
}

/**
 * Calls the Feishu MCP endpoint using JSON-RPC 2.0.
 *
 * @param toolName - MCP tool name
 * @param args - Tool arguments
 * @param userAccessToken - User access token (UAT)
 */
export async function callFeishuMcp(
  toolName: string,
  args: Record<string, unknown>,
  userAccessToken: string,
): Promise<unknown> {
  const id = `${toolName}-${Date.now()}`;

  const body = {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: {
      name: toolName,
      arguments: args,
    },
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Lark-MCP-UAT': userAccessToken,
    'X-Lark-MCP-Allowed-Tools': toolName,
  };

  const res = await fetch(FEISHU_MCP_ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`MCP HTTP ${res.status} ${res.statusText}: ${text.slice(0, 4000)}`);
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`MCP returned non-JSON: ${text.slice(0, 4000)}`);
  }

  if (isRecord(data) && 'error' in data) {
    const err = data['error'];
    if (isRecord(err) && typeof err['message'] === 'string') {
      throw new Error(`MCP error ${err['code']}: ${err['message']}`);
    }
    throw new Error('MCP returned error but could not parse message');
  }

  return unwrapResult(isRecord(data) ? data['result'] : data);
}
