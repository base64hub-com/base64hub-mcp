import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/base64hub-mcp.js', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const serverJson = JSON.parse(readFileSync(new URL('../server.json', import.meta.url), 'utf8'));
const { cases } = JSON.parse(readFileSync(new URL('../testdata/vectors.json', import.meta.url), 'utf8'));

const MODERN = '2026-07-28';
const LATEST_LEGACY = '2025-11-25';
const modernMeta = (extra = {}) => ({
  _meta: {
    'io.modelcontextprotocol/protocolVersion': MODERN,
    'io.modelcontextprotocol/clientCapabilities': {},
    'io.modelcontextprotocol/clientInfo': { name: 'test', version: '0' },
    ...extra,
  },
});

// Minimal stdio client: one JSON message per line, every stdout line must parse.
class Client {
  constructor() {
    this.proc = spawn(process.execPath, [BIN], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.lines = [];
    this.waiters = [];
    this.stderr = '';
    this.nextId = 1;
    let buf = '';
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        this.lines.push(JSON.parse(line));
        this.waiters.shift()?.();
      }
    });
    this.proc.stderr.on('data', (d) => (this.stderr += d));
    this.exited = new Promise((resolve) => this.proc.on('exit', (code) => resolve(code)));
  }

  sendRaw(line) {
    this.proc.stdin.write(line + '\n');
  }

  async next(timeout = 3000) {
    if (this.lines.length) return this.lines.shift();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for a response')), timeout);
      this.waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    return this.lines.shift();
  }

  async request(method, params) {
    const id = this.nextId++;
    const msg = { jsonrpc: '2.0', id, method };
    if (params !== undefined) msg.params = params;
    this.sendRaw(JSON.stringify(msg));
    const res = await this.next();
    assert.equal(res.jsonrpc, '2.0');
    assert.equal(res.id, id);
    return res;
  }

  notify(method, params) {
    this.sendRaw(JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }));
  }

  async call(name, args, meta) {
    const res = await this.request('tools/call', { name, arguments: args, ...(meta || {}) });
    assert.ok(res.result, JSON.stringify(res));
    return res.result;
  }

  async close() {
    this.proc.stdin.end();
    return this.exited;
  }
}

let c;
before(() => {
  c = new Client();
});
after(async () => {
  if (c) await c.close();
});

test('legacy handshake: initialize, initialized, ping', async () => {
  const res = await c.request('initialize', {
    protocolVersion: LATEST_LEGACY,
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  });
  assert.equal(res.result.protocolVersion, LATEST_LEGACY);
  assert.deepEqual(res.result.capabilities, { tools: { listChanged: false } });
  assert.equal(res.result.serverInfo.name, 'base64hub-mcp');
  assert.equal(res.result.serverInfo.version, pkg.version);
  assert.equal(typeof res.result.instructions, 'string');
  assert.equal('resultType' in res.result, false);
  c.notify('notifications/initialized');
  const ping = await c.request('ping');
  assert.deepEqual(ping.result, {});
});

test('initialize negotiates the protocol version', async () => {
  for (const v of ['2025-06-18', '2025-03-26', '2024-11-05']) {
    assert.equal((await c.request('initialize', { protocolVersion: v, capabilities: {} })).result.protocolVersion, v);
  }
  for (const v of ['1999-01-01', MODERN, '2099-12-31']) {
    assert.equal((await c.request('initialize', { protocolVersion: v, capabilities: {} })).result.protocolVersion, LATEST_LEGACY);
  }
  const bad = await c.request('initialize', { capabilities: {} });
  assert.equal(bad.error.code, -32602);
});

test('tools/list', async () => {
  const res = await c.request('tools/list');
  const tools = res.result.tools;
  assert.deepEqual(tools.map((t) => t.name), ['base64_encode', 'base64_decode', 'base64_validate']);
  for (const t of tools) {
    assert.ok(t.description.length > 80, t.name);
    assert.equal(t.inputSchema.type, 'object');
    assert.equal(t.annotations.readOnlyHint, true);
    assert.equal(t.annotations.openWorldHint, false);
    assert.equal(typeof t.title, 'string');
    assert.equal('run' in t, false);
  }
  assert.deepEqual(tools[0].inputSchema.required, ['text']);
  assert.deepEqual(Object.keys(tools[0].inputSchema.properties), ['text', 'url_safe', 'padding', 'wrap']);
  assert.deepEqual(tools[1].inputSchema.required, ['data']);
  assert.deepEqual(tools[2].inputSchema.required, ['data']);
  assert.equal(tools[2].outputSchema.type, 'object');
  assert.equal('ttlMs' in res.result, false);
});

test('base64_encode', async () => {
  const text = (r) => {
    assert.notEqual(r.isError, true, JSON.stringify(r));
    return r.content[0].text;
  };
  assert.equal(text(await c.call('base64_encode', { text: 'Hello, hub!' })), 'SGVsbG8sIGh1YiE=');
  assert.equal(text(await c.call('base64_encode', { text: 'Привет', url_safe: true, padding: false })), '0J_RgNC40LLQtdGC');
  assert.equal(text(await c.call('base64_encode', { text: 'foobar', wrap: 4 })), 'Zm9v\nYmFy');
  assert.equal(text(await c.call('base64_encode', { text: '' })), '');
  assert.equal(text(await c.call('base64_encode', { text: 'f', url_safe: null, padding: null })), 'Zg==');
});

test('base64_decode', async () => {
  const r = await c.call('base64_decode', { data: 'SGVsbG8sIGh1YiE=' });
  assert.deepEqual(r, { content: [{ type: 'text', text: 'Hello, hub!' }] });
  assert.equal((await c.call('base64_decode', { data: 'data:text/plain;base64,0J_RgNC40LLQtdGC' })).content[0].text, 'Привет');
  const bin = await c.call('base64_decode', { data: '+/+/' });
  assert.notEqual(bin.isError, true);
  assert.equal(bin.content[0].text, 'The data decodes to 3 bytes that are not valid UTF-8 text. Hex:\nfbffbf');
});

test('base64_decode with invalid Base64 is a tool error', async () => {
  const r = await c.call('base64_decode', { data: 'Zm9v!' });
  assert.equal(r.isError, true);
  assert.equal(r.content[0].text, "Invalid Base64: invalid character '!' at position 4.");
});

test('base64_validate returns JSON text and structured content', async () => {
  const ok = await c.call('base64_validate', { data: 'a+b_' });
  const expected = { valid: true, variant: 'mixed', padded: true, bytes: 3 };
  assert.deepEqual(ok.structuredContent, expected);
  assert.deepEqual(JSON.parse(ok.content[0].text), expected);
  assert.notEqual(ok.isError, true);
  const bad = await c.call('base64_validate', { data: 'Zm9vY' });
  assert.deepEqual(bad.structuredContent, {
    valid: false,
    error: 'invalid length: 5 characters leave a single character in the last group',
  });
  assert.notEqual(bad.isError, true);
  const cases = [
    ['Zm=9v', "unexpected '=' at position 2: padding is only allowed at the end"],
    ['Zg===', "too much padding: 3 '=' at position 2, at most 2 are allowed"],
    ['Zm9v!=YmFy', "invalid character '!' at position 4"],
    [String.fromCharCode(0xa0) + 'Zg==', "invalid character '" + '\\' + "u00a0' at position 0"],
    ['data:text/plain;BASE64,SGk=', "invalid character ':' at position 4"],
  ];
  for (const [data, error] of cases) {
    const r = await c.call('base64_validate', { data });
    assert.deepEqual(r.structuredContent, { valid: false, error }, data);
  }
});

test('argument problems are tool errors the model can fix', async () => {
  const cases = [
    ['base64_encode', {}, 'Missing required argument "text".'],
    ['base64_decode', {}, 'Missing required argument "data".'],
    ['base64_validate', { data: null }, 'Missing required argument "data".'],
    ['base64_encode', { text: 5 }, 'Argument "text" must be a string.'],
    ['base64_encode', { text: 'a', url_safe: 'yes' }, 'Argument "url_safe" must be true or false.'],
    ['base64_encode', { text: 'a', wrap: -1 }, 'Argument "wrap" must be a whole number, 0 or more.'],
    ['base64_encode', { text: 'a', wrap: 2.5 }, 'Argument "wrap" must be a whole number, 0 or more.'],
    ['base64_decode', { data: 'Zg', extra: 1 }, 'Unknown argument "extra". Allowed arguments: data.'],
  ];
  for (const [name, args, message] of cases) {
    const r = await c.call(name, args);
    assert.equal(r.isError, true, `${name} ${JSON.stringify(args)}`);
    assert.equal(r.content[0].text, message);
  }
  const noArgs = await c.request('tools/call', { name: 'base64_decode' });
  assert.equal(noArgs.result.isError, true);
});

test('protocol errors', async () => {
  let r = await c.request('tools/call', { name: 'base64_nope', arguments: {} });
  assert.equal(r.error.code, -32602);
  assert.equal(r.error.message, 'Unknown tool: base64_nope');
  r = await c.request('tools/call', { arguments: {} });
  assert.equal(r.error.code, -32602);
  r = await c.request('tools/call', { name: 'base64_decode', arguments: ['Zg'] });
  assert.equal(r.error.code, -32602);
  r = await c.request('resources/list');
  assert.equal(r.error.code, -32601);
  assert.equal(r.error.message, 'Method not found: resources/list');
  r = await c.request('tools/list', ['positional']);
  assert.equal(r.error.code, -32602);
});

test('malformed lines and invalid requests', async () => {
  c.sendRaw('{"jsonrpc":"2.0","id":99,"method":');
  assert.deepEqual(await c.next(), { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  c.sendRaw('not json at all');
  assert.equal((await c.next()).error.code, -32700);
  c.sendRaw('42');
  assert.deepEqual((await c.next()).error.code, -32600);
  c.sendRaw('{"id":7,"method":"ping"}');
  assert.deepEqual(await c.next(), { jsonrpc: '2.0', id: 7, error: { code: -32600, message: 'Invalid Request: jsonrpc must be "2.0"' } });
  c.sendRaw('{"jsonrpc":"2.0","id":null,"method":"ping"}');
  assert.equal((await c.next()).error.code, -32600);
  c.sendRaw('{"jsonrpc":"2.0","id":8,"method":5}');
  assert.equal((await c.next()).error.code, -32600);
  c.sendRaw('[]');
  assert.equal((await c.next()).error.code, -32600);
  c.sendRaw('');
  c.sendRaw('{"jsonrpc":"2.0","id":5,"result":{}}');
  c.notify('notifications/cancelled', { requestId: 1 });
  c.notify('unknown/notification');
  const ping = await c.request('ping');
  assert.deepEqual(ping.result, {});
});

test('batch requests', async () => {
  c.sendRaw(JSON.stringify([
    { jsonrpc: '2.0', id: 'a', method: 'ping' },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 'b', method: 'nope' },
  ]));
  const out = await c.next();
  assert.ok(Array.isArray(out));
  assert.deepEqual(out.map((r) => r.id), ['a', 'b']);
  assert.equal(out[1].error.code, -32601);
});

test('modern stateless requests (2026-07-28)', async () => {
  const fresh = new Client();
  try {
    const d = await fresh.request('server/discover', modernMeta());
    assert.equal(d.result.resultType, 'complete');
    assert.deepEqual(d.result.supportedVersions, [MODERN, '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
    assert.deepEqual(d.result.capabilities, { tools: {} });
    assert.equal(d.result.cacheScope, 'public');
    assert.ok(d.result.ttlMs > 0);
    assert.equal(d.result._meta['io.modelcontextprotocol/serverInfo'].name, 'base64hub-mcp');

    const list = await fresh.request('tools/list', modernMeta());
    assert.equal(list.result.resultType, 'complete');
    assert.equal(list.result.tools.length, 3);
    assert.equal(list.result.cacheScope, 'public');
    assert.equal(typeof list.result.ttlMs, 'number');
    assert.deepEqual(list.result._meta, { 'io.modelcontextprotocol/serverInfo': { name: 'base64hub-mcp', version: pkg.version } });

    const call = await fresh.call('base64_encode', { text: 'Hello, hub!' }, modernMeta());
    assert.equal(call.resultType, 'complete');
    assert.equal(call.content[0].text, 'SGVsbG8sIGh1YiE=');

    const err = await fresh.call('base64_decode', { data: '====' }, modernMeta());
    assert.equal(err.resultType, 'complete');
    assert.equal(err.isError, true);
  } finally {
    await fresh.close();
  }
});

test('modern version and metadata errors', async () => {
  let r = await c.request('tools/list', modernMeta({ 'io.modelcontextprotocol/protocolVersion': '1900-01-01' }));
  assert.equal(r.error.code, -32022);
  assert.equal(r.error.data.requested, '1900-01-01');
  assert.ok(r.error.data.supported.includes(MODERN));
  const meta = modernMeta();
  delete meta._meta['io.modelcontextprotocol/clientCapabilities'];
  r = await c.request('tools/list', meta);
  assert.equal(r.error.code, -32602);
  r = await c.request('server/discover', {});
  assert.equal(r.error.code, -32602);
  r = await c.request('server/discover');
  assert.equal(r.error.code, -32602);
});

test('all vector cases through the tools', async () => {
  const hexToText = (hex) => new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(hex, 'hex'));
  for (const v of cases) {
    if (v.op === 'encode') {
      let text;
      try {
        text = hexToText(v.in_hex);
      } catch {
        continue; // base64_encode takes text; binary-only cases are covered by core.test.js.
      }
      const r = await c.call('base64_encode', { text, url_safe: v.url, padding: v.pad, wrap: v.wrap });
      assert.equal(r.content[0].text, v.out, JSON.stringify(v));
    } else if (v.op === 'decode') {
      const r = await c.call('base64_decode', { data: v.in });
      if (v.error) {
        assert.equal(r.isError, true, JSON.stringify(v));
        continue;
      }
      let expected;
      try {
        expected = hexToText(v.out_hex);
      } catch {
        expected = `The data decodes to ${v.out_hex.length / 2} bytes that are not valid UTF-8 text. Hex:\n${v.out_hex}`;
      }
      assert.equal(r.content[0].text, expected, JSON.stringify(v));
    } else if (v.op === 'validate') {
      const r = await c.call('base64_validate', { data: v.in });
      assert.equal(r.structuredContent.valid, v.valid);
      if (v.valid) {
        assert.deepEqual(r.structuredContent, { valid: true, variant: v.variant, padded: v.padded, bytes: v.bytes });
      }
    }
  }
});

test('stdout carries only protocol messages; stderr has the log', async () => {
  const fresh = new Client();
  await fresh.request('ping');
  const code = await fresh.close();
  assert.equal(code, 0);
  assert.match(fresh.stderr, /base64hub-mcp: .*ready on stdio/);
  assert.equal(fresh.lines.length, 0);
});

test('--version and --help', () => {
  const v = spawnSync(process.execPath, [BIN, '--version'], { encoding: 'utf8' });
  assert.equal(v.stdout, `base64hub-mcp ${pkg.version}\n`);
  const h = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.match(h.stdout, /claude mcp add base64hub -- npx -y base64hub-mcp/);
  const bad = spawnSync(process.execPath, [BIN, '--nope'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.equal(bad.stdout, '');
});

test('package.json and server.json agree', () => {
  assert.equal(pkg.mcpName, 'com.base64hub/mcp');
  assert.equal(serverJson.name, pkg.mcpName);
  assert.equal(serverJson.version, pkg.version);
  assert.ok(serverJson.description.length <= 100);
  const [npm] = serverJson.packages;
  assert.equal(npm.registryType, 'npm');
  assert.equal(npm.identifier, pkg.name);
  assert.equal(npm.version, pkg.version);
  assert.deepEqual(npm.transport, { type: 'stdio' });
  assert.deepEqual(serverJson.remotes, [{ type: 'streamable-http', url: 'https://mcp.base64hub.com/mcp' }]);
});
