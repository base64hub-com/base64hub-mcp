import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../worker.js';
import { build } from '../scripts/build-worker.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const URL_MCP = 'https://mcp.base64hub.com/mcp';
const MODERN = '2026-07-28';
const META = {
  'io.modelcontextprotocol/protocolVersion': MODERN,
  'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

function post(body, headers = {}) {
  return worker.fetch(
    new Request(URL_MCP, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });

function modern(method, params = {}, headers = {}) {
  const extra = method === 'tools/call' ? { 'Mcp-Name': params.name } : {};
  return post(rpc(1, method, { ...params, _meta: META }), {
    'MCP-Protocol-Version': MODERN,
    'Mcp-Method': method,
    ...extra,
    ...headers,
  });
}

test('worker.js is up to date with its sources', () => {
  assert.equal(readFileSync(new URL('../worker.js', import.meta.url), 'utf8'), build());
});

test('legacy flow: initialize, initialized, tools/list, tools/call', async () => {
  let res = await post(rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } }));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Content-Type'), /^application\/json/);
  assert.equal(res.headers.get('Mcp-Session-Id'), null);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  let body = await res.json();
  assert.equal(body.result.protocolVersion, '2025-06-18');
  assert.equal(body.result.serverInfo.name, 'base64hub-mcp');
  assert.equal(body.result.serverInfo.version, pkg.version);
  assert.match(body.result.serverInfo.description, /hosted/);
  assert.doesNotMatch(body.result.instructions, /locally/);

  res = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { 'MCP-Protocol-Version': '2025-06-18' });
  assert.equal(res.status, 202);
  assert.equal(await res.text(), '');

  res = await post(rpc(2, 'tools/list'), { 'MCP-Protocol-Version': '2025-06-18' });
  body = await res.json();
  assert.deepEqual(body.result.tools.map((t) => t.name), ['base64_encode', 'base64_decode', 'base64_validate']);

  res = await post(rpc(3, 'tools/call', { name: 'base64_decode', arguments: { data: 'SGVsbG8sIGh1YiE=' } }));
  body = await res.json();
  assert.equal(body.result.content[0].text, 'Hello, hub!');
});

test('legacy errors stay in a 200 response', async () => {
  const res = await post(rpc(1, 'nope'));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).error.code, -32601);
});

test('batches (2025-03-26)', async () => {
  let res = await post([rpc(1, 'ping'), { jsonrpc: '2.0', method: 'notifications/initialized' }, rpc(2, 'tools/list')]);
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).map((r) => r.id), [1, 2]);
  res = await post([{ jsonrpc: '2.0', method: 'notifications/initialized' }]);
  assert.equal(res.status, 202);
});

test('modern requests (2026-07-28)', async () => {
  let res = await modern('server/discover');
  assert.equal(res.status, 200);
  let body = await res.json();
  assert.ok(body.result.supportedVersions.includes(MODERN));
  assert.equal(body.result._meta['io.modelcontextprotocol/serverInfo'].name, 'base64hub-mcp');

  res = await modern('tools/call', { name: 'base64_encode', arguments: { text: 'hi', url_safe: true } });
  assert.equal(res.status, 200);
  body = await res.json();
  assert.equal(body.result.content[0].text, 'aGk=');
  assert.equal(body.result.resultType, 'complete');

  res = await modern('tools/call', { name: 'base64_validate', arguments: { data: 'Zm9v!' } }, { 'Mcp-Name': '=?base64?YmFzZTY0X3ZhbGlkYXRl?=' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).result.structuredContent.valid, false);
});

test('modern header validation', async () => {
  const mismatch = async (res) => {
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, -32020);
    assert.equal(body.id, 1);
    return body.error.message;
  };
  const call = { name: 'base64_encode', arguments: { text: 'hi' } };
  assert.match(await mismatch(await post(rpc(1, 'tools/list', { _meta: META }))), /MCP-Protocol-Version header is missing/);
  assert.match(await mismatch(await post(rpc(1, 'tools/list', { _meta: META }), { 'MCP-Protocol-Version': '2025-11-25', 'Mcp-Method': 'tools/list' })), /does not match/);
  assert.match(await mismatch(await post(rpc(1, 'tools/list'), { 'MCP-Protocol-Version': MODERN, 'Mcp-Method': 'tools/list' })), /does not match/);
  assert.match(await mismatch(await post(rpc(1, 'tools/list', { _meta: META }), { 'MCP-Protocol-Version': MODERN })), /Mcp-Method header is missing/);
  assert.match(await mismatch(await modern('tools/list', {}, { 'Mcp-Method': 'tools/call' })), /Mcp-Method/);
  assert.match(await mismatch(await modern('tools/call', call, { 'Mcp-Name': 'base64_decode' })), /Mcp-Name/);
  assert.match(await mismatch(await modern('tools/call', call, { 'Mcp-Name': '=?base64?!!!?=' })), /not valid Base64/);
  const noName = await post(rpc(1, 'tools/call', { ...call, _meta: META }), { 'MCP-Protocol-Version': MODERN, 'Mcp-Method': 'tools/call' });
  assert.match(await mismatch(noName), /Mcp-Name header is missing/);
});

test('modern status codes', async () => {
  let res = await modern('nope');
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error.code, -32601);

  res = await post(rpc(1, 'tools/list', { _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN } }), {
    'MCP-Protocol-Version': MODERN,
    'Mcp-Method': 'tools/list',
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, -32602);

  res = await post(rpc(1, 'tools/list'), { 'MCP-Protocol-Version': '2099-01-01' });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, -32022);
  assert.ok(body.error.data.supported.includes(MODERN));
});

test('malformed requests', async () => {
  let res = await post('{nope');
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, -32700);

  res = await post({ id: 1, method: 'ping' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, -32600);

  res = await post('{}', { 'Content-Type': 'text/plain' });
  assert.equal(res.status, 415);

  res = await post(rpc(1, 'tools/call', { name: 'base64_encode', arguments: { text: 'a'.repeat(256 * 1024) } }));
  assert.equal(res.status, 413);
  assert.equal((await res.json()).error.code, -32600);
});

test('a body just under the limit is served', async () => {
  const text = 'a'.repeat(256 * 1024 - 200);
  const res = await post(rpc(1, 'tools/call', { name: 'base64_encode', arguments: { text } }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).result.content[0].text.length, Math.ceil(text.length / 3) * 4);
});

test('other methods and paths', async () => {
  for (const method of ['GET', 'DELETE', 'PUT']) {
    const res = await worker.fetch(new Request(URL_MCP, { method }));
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.get('Allow'), 'POST, OPTIONS');
  }

  let res = await worker.fetch(new Request(URL_MCP, { method: 'OPTIONS', headers: { Origin: 'https://example.com', 'Access-Control-Request-Method': 'POST' } }));
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  assert.match(res.headers.get('Access-Control-Allow-Headers'), /MCP-Protocol-Version/);
  assert.match(res.headers.get('Access-Control-Allow-Methods'), /POST/);

  res = await worker.fetch(new Request('https://mcp.base64hub.com/'));
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('Location'), 'https://base64hub.com/mcp/');

  res = await worker.fetch(new Request('https://mcp.base64hub.com/sse'));
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /\/mcp/);
});
