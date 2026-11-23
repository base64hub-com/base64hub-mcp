// Streamable HTTP binding for the protocol layer, written against the Fetch API so it runs as a
// Cloudflare Worker (worker.js is generated from this file, see scripts/build-worker.js).
// Stateless: every POST is answered with one JSON body, no sessions, no SSE streams.
import { decode } from './core.js';
import { SUPPORTED_VERSIONS, MODERN_VERSIONS, META_VERSION, RpcError, errorResponse, PARSE_ERROR, INVALID_REQUEST, METHOD_NOT_FOUND, INVALID_PARAMS, INTERNAL_ERROR, HEADER_MISMATCH, UNSUPPORTED_PROTOCOL_VERSION } from './protocol.js';

export const MCP_PATH = '/mcp';
export const MAX_BODY = 256 * 1024; // 256 KiB keeps the worst case well inside a Worker's CPU budget

const DOCS_URL = 'https://base64hub.com/mcp/';
const CORS_HEADERS = 'Content-Type, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id, Last-Event-ID';
const SENTINEL_RE = /^=\?base64\?(.*)\?=$/s;
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

// Every origin may call this server: it is public, needs no credentials and keeps no state, so
// there is nothing a DNS rebinding or cross-site request could reach that a direct one cannot.
function baseHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
}

function json(status, body, extra) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...baseHeaders(), 'Content-Type': 'application/json; charset=utf-8', ...extra },
  });
}

function empty(status, extra) {
  return new Response(null, { status, headers: { ...baseHeaders(), ...extra } });
}

function rpcFailure(status, code, message, data, id = null) {
  return json(status, errorResponse(id, new RpcError(code, message, data)));
}

class BodyTooLarge extends Error {}

// Reads the body with a hard byte limit. Content-Length is only a fast path for rejection;
// the limit is enforced on the bytes actually read.
async function readBody(request) {
  const declared = request.headers.get('Content-Length');
  if (declared !== null && Number(declared) > MAX_BODY) throw new BodyTooLarge();
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY) {
      await reader.cancel();
      throw new BodyTooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

// Mcp-Name may carry "=?base64?...?=" when the name is not a plain ASCII header value.
function headerValue(raw) {
  const m = SENTINEL_RE.exec(raw);
  if (!m) return raw;
  try {
    return strictUtf8.decode(decode(m[1]));
  } catch {
    return null;
  }
}

// Revision 2026-07-28 mirrors body fields into headers and requires them to agree.
// Returns the text of the mismatch, or null when the headers are consistent.
function headerMismatch(request, msg, headerVersion, bodyVersion) {
  if (headerVersion === null) return 'Header mismatch: the MCP-Protocol-Version header is missing';
  if (headerVersion !== bodyVersion) {
    return `Header mismatch: MCP-Protocol-Version header value '${headerVersion}' does not match the body _meta value`;
  }
  const method = request.headers.get('Mcp-Method');
  if (method === null) return 'Header mismatch: the Mcp-Method header is missing';
  if (method !== msg.method) return `Header mismatch: Mcp-Method header value '${method}' does not match the body method`;
  if (msg.method === 'tools/call') {
    const raw = request.headers.get('Mcp-Name');
    if (raw === null) return 'Header mismatch: the Mcp-Name header is missing';
    const name = headerValue(raw);
    if (name === null) return 'Header mismatch: the Mcp-Name header is not valid Base64 of UTF-8 text';
    if (name !== msg.params.name) return `Header mismatch: Mcp-Name header value '${name}' does not match the body tool name`;
  }
  return null;
}

function statusFor(response, modern) {
  if (!response.error) return 200;
  const { code } = response.error;
  if (code === PARSE_ERROR || code === INVALID_REQUEST || code === UNSUPPORTED_PROTOCOL_VERSION) return 400;
  if (modern && code === METHOD_NOT_FOUND) return 404;
  if (modern && code === INVALID_PARAMS) return 400;
  return 200; // Legacy revisions carry JSON-RPC errors in a normal response.
}

async function handlePost(request, protocol) {
  const contentType = request.headers.get('Content-Type');
  if (contentType !== null && !/^application\/json\s*(;|$)/i.test(contentType)) {
    return rpcFailure(415, INVALID_REQUEST, 'Unsupported Media Type: send application/json');
  }

  let bytes;
  try {
    bytes = await readBody(request);
  } catch (err) {
    if (err instanceof BodyTooLarge) {
      return rpcFailure(413, INVALID_REQUEST, `Request body too large: the limit is ${MAX_BODY} bytes`);
    }
    throw err;
  }

  let msg;
  try {
    msg = JSON.parse(strictUtf8.decode(bytes));
  } catch {
    return rpcFailure(400, PARSE_ERROR, 'Parse error');
  }

  const headerVersion = request.headers.get('MCP-Protocol-Version');
  if (headerVersion !== null && !SUPPORTED_VERSIONS.includes(headerVersion)) {
    return rpcFailure(400, UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', {
      supported: SUPPORTED_VERSIONS,
      requested: headerVersion,
    });
  }

  let modern = false;
  const isRequest = typeof msg === 'object' && msg !== null && !Array.isArray(msg) && typeof msg.method === 'string';
  if (isRequest) {
    const params = typeof msg.params === 'object' && msg.params !== null && !Array.isArray(msg.params) ? msg.params : {};
    const meta = typeof params._meta === 'object' && params._meta !== null ? params._meta : {};
    const bodyVersion = meta[META_VERSION];
    modern = MODERN_VERSIONS.includes(headerVersion) || MODERN_VERSIONS.includes(bodyVersion);
    if (modern) {
      const problem = headerMismatch(request, { method: msg.method, params }, headerVersion, bodyVersion);
      if (problem) {
        const id = typeof msg.id === 'string' || (typeof msg.id === 'number' && Number.isFinite(msg.id)) ? msg.id : null;
        return rpcFailure(400, HEADER_MISMATCH, problem, undefined, id);
      }
    }
  }

  const response = protocol.handleParsed(msg);
  if (response === null) return empty(202);
  if (Array.isArray(response)) return json(200, response);
  return json(statusFor(response, modern), response);
}

/** Builds the Worker's fetch handler for a protocol created by createProtocol(). */
export function createFetch(protocol) {
  return async function fetch(request) {
    const { pathname } = new URL(request.url);

    if (pathname === MCP_PATH) {
      switch (request.method) {
        case 'POST':
          try {
            return await handlePost(request, protocol);
          } catch {
            return rpcFailure(500, INTERNAL_ERROR, 'Internal error');
          }
        case 'OPTIONS':
          return empty(204, {
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': CORS_HEADERS,
            'Access-Control-Max-Age': '86400',
          });
        default:
          // No GET stream and no sessions to DELETE: this server answers every POST in full.
          return withAllow(rpcFailure(405, INVALID_REQUEST, 'Method Not Allowed: POST JSON-RPC messages to this endpoint'));
      }
    }

    if (pathname === '/' && (request.method === 'GET' || request.method === 'HEAD')) {
      return new Response(null, { status: 302, headers: { ...baseHeaders(), Location: DOCS_URL } });
    }

    return json(404, { error: `Not found. The MCP endpoint is ${MCP_PATH}; docs: ${DOCS_URL}` });
  };
}

function withAllow(response) {
  response.headers.set('Allow', 'POST, OPTIONS');
  return response;
}
