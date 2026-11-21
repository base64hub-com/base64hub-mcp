// MCP protocol layer: JSON-RPC 2.0 messages in, JSON-RPC 2.0 messages out.
// Dual-era: answers modern stateless requests (per-request _meta, server/discover)
// and the legacy initialize handshake. Transport-free, so it is easy to test.
import { readFileSync } from 'node:fs';
import { encode, decode, validate, Base64Error } from './core.js';

export const { name: NAME, version: VERSION } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
);

/** Revisions with per-request metadata (no initialize). */
export const MODERN_VERSIONS = ['2026-07-28'];
/** Revisions that start with the initialize handshake, newest first. */
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const SUPPORTED_VERSIONS = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];

const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;
export const UNSUPPORTED_PROTOCOL_VERSION = -32022;

const TOOL_LIST_TTL_MS = 3600000;

const SERVER_INFO = {
  name: NAME,
  title: 'base64hub',
  version: VERSION,
  description: 'Base64 encode, decode and validate tools that run locally.',
  websiteUrl: 'https://base64hub.com/mcp/',
  icons: [
    { src: 'https://base64hub.com/favicon.svg', mimeType: 'image/svg+xml', sizes: ['any'] },
    { src: 'https://base64hub.com/web-app-manifest-512x512.png', mimeType: 'image/png', sizes: ['512x512'] },
  ],
};

const INSTRUCTIONS =
  'Exact Base64 conversion. Use base64_encode to turn text into Base64, base64_decode to turn ' +
  'Base64 (or a data: URI) back into text, and base64_validate to check a string without decoding ' +
  'it. Results are computed locally and exactly, so prefer these tools over converting by hand.';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const TOOLS = [
  {
    name: 'base64_encode',
    title: 'Base64 encode',
    description:
      'Encode text to Base64. The text is converted to UTF-8 bytes first, so any language and emoji ' +
      'work. Set url_safe for the URL- and filename-safe alphabet (- and _ instead of + and /, as in ' +
      "JWTs and URLs), padding=false to drop the trailing '=' characters, and wrap to break the " +
      'output into lines (76 for MIME email). Returns only the Base64 string.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to encode, taken as UTF-8.' },
        url_safe: {
          type: 'boolean',
          default: false,
          description: 'Use the URL-safe alphabet (- and _, RFC 4648 section 5).',
        },
        padding: { type: 'boolean', default: true, description: "Add '=' padding at the end." },
        wrap: {
          type: 'integer',
          minimum: 0,
          default: 0,
          description: 'Insert a line break after every N output characters. 0 = one line, 76 = MIME.',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    annotations: { title: 'Base64 encode', ...READ_ONLY },
    run: ({ text, url_safe = false, padding = true, wrap = 0 }) =>
      textResult(encode(text, { url: url_safe, pad: padding, wrap })),
  },
  {
    name: 'base64_decode',
    title: 'Base64 decode',
    description:
      'Decode Base64 back to text. Accepts the standard and the URL-safe alphabet (even mixed), ' +
      "missing '=' padding, spaces and line breaks, and data URIs such as data:image/png;base64,... " +
      'Returns the decoded UTF-8 text exactly. If the bytes are not valid UTF-8 (an image, compressed ' +
      'or encrypted data), says so and returns them as hex instead. Invalid input fails with the ' +
      'reason and the position of the offending character.',
    inputSchema: {
      type: 'object',
      properties: {
        data: { type: 'string', description: 'Base64 text or a data: URI.' },
      },
      required: ['data'],
      additionalProperties: false,
    },
    annotations: { title: 'Base64 decode', ...READ_ONLY },
    run: ({ data }) => {
      let bytes;
      try {
        bytes = decode(data);
      } catch (err) {
        if (err instanceof Base64Error) return errorResult(`Invalid Base64: ${err.message}.`);
        throw err;
      }
      try {
        return textResult(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
      } catch {
        const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
        return textResult(`The data decodes to ${bytes.length} bytes that are not valid UTF-8 text. Hex:\n${hex}`);
      }
    },
  },
  {
    name: 'base64_validate',
    title: 'Base64 validate',
    description:
      'Check whether a string is valid Base64 and describe it, without returning the decoded ' +
      'content. Uses the same lenient rules as base64_decode. Returns JSON: valid, variant ' +
      '(standard if + or / occurs, url if - or _ occurs, mixed if both, either if neither), padded ' +
      "(whether the '=' padding is complete) and bytes (decoded size); or valid: false with the " +
      'error base64_decode would report, such as the offending character and its position.',
    inputSchema: {
      type: 'object',
      properties: {
        data: { type: 'string', description: 'The string to check. A data: URI is accepted too.' },
      },
      required: ['data'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        valid: { type: 'boolean' },
        variant: { type: 'string', enum: ['standard', 'url', 'mixed', 'either'] },
        padded: { type: 'boolean' },
        bytes: { type: 'integer', minimum: 0 },
        error: { type: 'string' },
      },
      required: ['valid'],
      additionalProperties: false,
    },
    annotations: { title: 'Base64 validate', ...READ_ONLY },
    run: ({ data }) => {
      const result = validate(data);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    },
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
const TOOL_LIST = TOOLS.map(({ run, ...tool }) => tool);

function textResult(text) {
  return { content: [{ type: 'text', text }] };
}

function errorResult(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

// Returns a message for the model when the arguments don't match the tool's input schema.
function checkArguments(tool, args) {
  const { properties, required } = tool.inputSchema;
  for (const key of required) {
    if (args[key] === undefined || args[key] === null) return `Missing required argument "${key}".`;
  }
  for (const [key, value] of Object.entries(args)) {
    const prop = properties[key];
    if (!prop) return `Unknown argument "${key}". Allowed arguments: ${Object.keys(properties).join(', ')}.`;
    if (value === null && !required.includes(key)) continue;
    if (prop.type === 'string' && typeof value !== 'string') return `Argument "${key}" must be a string.`;
    if (prop.type === 'boolean' && typeof value !== 'boolean') return `Argument "${key}" must be true or false.`;
    if (prop.type === 'integer' && !(Number.isInteger(value) && value >= (prop.minimum ?? -Infinity))) {
      return `Argument "${key}" must be a whole number, ${prop.minimum ?? 0} or more.`;
    }
  }
  return null;
}

function callTool(params) {
  if (typeof params.name !== 'string') throw new RpcError(INVALID_PARAMS, 'Missing tool name');
  const tool = TOOL_BY_NAME.get(params.name);
  if (!tool) throw new RpcError(INVALID_PARAMS, `Unknown tool: ${params.name}`);
  const args = params.arguments ?? {};
  if (!isObject(args)) throw new RpcError(INVALID_PARAMS, 'Tool arguments must be an object');
  const problem = checkArguments(tool, args);
  if (problem) return errorResult(problem);
  const clean = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== null));
  return tool.run(clean);
}

// Decides how to serve a request: modern (per-request _meta) or legacy (initialize era).
function requestEra(method, params) {
  const meta = isObject(params._meta) ? params._meta : {};
  const version = meta[META_VERSION];
  if (method === 'initialize') return 'legacy';
  if (version === undefined) {
    if (method === 'server/discover') {
      throw new RpcError(INVALID_PARAMS, `Missing _meta "${META_VERSION}"`, { supported: SUPPORTED_VERSIONS });
    }
    return 'legacy';
  }
  if (typeof version !== 'string' || !SUPPORTED_VERSIONS.includes(version)) {
    throw new RpcError(UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', {
      supported: SUPPORTED_VERSIONS,
      requested: version,
    });
  }
  if (!MODERN_VERSIONS.includes(version)) return 'legacy';
  if (!isObject(meta[META_CAPABILITIES])) {
    throw new RpcError(INVALID_PARAMS, `Missing _meta "${META_CAPABILITIES}"`);
  }
  return 'modern';
}

function initialize(params) {
  const requested = params.protocolVersion;
  if (typeof requested !== 'string') throw new RpcError(INVALID_PARAMS, 'Missing protocolVersion');
  return {
    protocolVersion: LEGACY_VERSIONS.includes(requested) ? requested : LEGACY_VERSIONS[0],
    capabilities: { tools: { listChanged: false } },
    serverInfo: SERVER_INFO,
    instructions: INSTRUCTIONS,
  };
}

function dispatch(method, params, era) {
  const modern = era === 'modern';
  switch (method) {
    case 'initialize':
      return initialize(params);
    case 'server/discover':
      return {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        instructions: INSTRUCTIONS,
        ttlMs: TOOL_LIST_TTL_MS,
        cacheScope: 'public',
      };
    case 'ping':
      return {};
    case 'tools/list':
      return modern ? { tools: TOOL_LIST, ttlMs: TOOL_LIST_TTL_MS, cacheScope: 'public' } : { tools: TOOL_LIST };
    case 'tools/call':
      return callTool(params);
    default:
      throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

function errorResponse(id, err) {
  const error = { code: err.code, message: err.message };
  if (err.data !== undefined) error.data = err.data;
  return { jsonrpc: '2.0', id, error };
}

const validId = (id) => typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));

/** Handles one parsed JSON-RPC message. Returns the response object, or null for none. */
export function handleMessage(msg, log = () => {}) {
  if (!isObject(msg)) return errorResponse(null, new RpcError(INVALID_REQUEST, 'Invalid Request'));
  const hasId = 'id' in msg;
  const id = hasId && validId(msg.id) ? msg.id : null;
  if (msg.jsonrpc !== '2.0') return errorResponse(id, new RpcError(INVALID_REQUEST, 'Invalid Request: jsonrpc must be "2.0"'));
  if (!('method' in msg)) {
    // A response from the client; this server never sends requests, so there is nothing to match.
    if (hasId && ('result' in msg || 'error' in msg)) return null;
    return errorResponse(id, new RpcError(INVALID_REQUEST, 'Invalid Request: missing method'));
  }
  if (typeof msg.method !== 'string') return errorResponse(id, new RpcError(INVALID_REQUEST, 'Invalid Request: method must be a string'));
  if (!hasId) return null; // Notifications (initialized, cancelled, ...) need no answer.
  if (id === null) return errorResponse(null, new RpcError(INVALID_REQUEST, 'Invalid Request: id must be a string or number'));

  try {
    if (msg.params !== undefined && !isObject(msg.params)) throw new RpcError(INVALID_PARAMS, 'params must be an object');
    const params = msg.params ?? {};
    const era = requestEra(msg.method, params);
    let result = dispatch(msg.method, params, era);
    if (era === 'modern' || msg.method === 'server/discover') {
      const info = msg.method === 'server/discover' ? SERVER_INFO : { name: NAME, version: VERSION };
      result = { resultType: 'complete', ...result, _meta: { [META_SERVER_INFO]: info } };
    }
    return { jsonrpc: '2.0', id, result };
  } catch (err) {
    if (err instanceof RpcError) return errorResponse(id, err);
    log(`internal error in ${msg.method}: ${err && err.stack ? err.stack : err}`);
    return errorResponse(id, new RpcError(INTERNAL_ERROR, 'Internal error'));
  }
}

/** Handles one line of the stdio stream. Returns the line to write back (without newline), or null. */
export function handleLine(line, log = () => {}) {
  if (!line.trim()) return null;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return JSON.stringify(errorResponse(null, new RpcError(PARSE_ERROR, 'Parse error')));
  }
  if (Array.isArray(msg)) {
    // JSON-RPC batches (only the 2025-03-26 revision allowed them).
    if (msg.length === 0) return JSON.stringify(errorResponse(null, new RpcError(INVALID_REQUEST, 'Invalid Request: empty batch')));
    const out = msg.map((m) => handleMessage(m, log)).filter((r) => r !== null);
    return out.length ? JSON.stringify(out) : null;
  }
  const response = handleMessage(msg, log);
  return response === null ? null : JSON.stringify(response);
}
