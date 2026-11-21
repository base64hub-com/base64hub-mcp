#!/usr/bin/env node
// base64hub-mcp: MCP server over stdio. stdout carries protocol messages only; logs go to stderr.
import { createInterface } from 'node:readline';
import { handleLine, NAME, VERSION, SUPPORTED_VERSIONS } from '../server.js';

const log = (message) => process.stderr.write(`${NAME}: ${message}\n`);

const args = process.argv.slice(2);
if (args.includes('-v') || args.includes('--version')) {
  process.stdout.write(`${NAME} ${VERSION}\n`);
} else if (args.includes('-h') || args.includes('--help')) {
  process.stdout.write(
    `Usage: ${NAME}\n\n` +
      'MCP server with Base64 tools (base64_encode, base64_decode, base64_validate).\n' +
      'It speaks JSON-RPC over stdin/stdout; start it from an MCP client, for example:\n\n' +
      '  claude mcp add base64hub -- npx -y base64hub-mcp\n\n' +
      `Protocol versions: ${SUPPORTED_VERSIONS.join(', ')}\n` +
      'Docs: https://base64hub.com/docs/mcp/\n',
  );
} else if (args.length) {
  log(`unknown argument: ${args[0]} (try --help)`);
  process.exitCode = 2;
} else {
  start();
}

function start() {
  if (process.stdin.isTTY) log('waiting for MCP messages on stdin; this server is meant to be started by an MCP client');
  log(`${VERSION} ready on stdio`);
  process.stdout.on('error', (err) => {
    if (err.code === 'EPIPE') process.exit(0);
    throw err;
  });
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  rl.on('line', (line) => {
    const out = handleLine(line, log);
    if (out !== null) process.stdout.write(out + '\n');
  });
  // When the client closes stdin the event loop drains and the process exits on its own.
}
