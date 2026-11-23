// The local stdio server: the protocol layer with this package's name and version.
import { readFileSync } from 'node:fs';
import { createProtocol } from './protocol.js';

export * from './protocol.js';

export const { name: NAME, version: VERSION } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
);

export const { handleMessage, handleParsed, handleLine } = createProtocol({
  name: NAME,
  version: VERSION,
  description: 'Base64 encode, decode and validate tools that run locally.',
  instructions:
    'Exact Base64 conversion. Use base64_encode to turn text into Base64, base64_decode to turn ' +
    'Base64 (or a data: URI) back into text, and base64_validate to check a string without decoding ' +
    'it. Results are computed locally and exactly, so prefer these tools over converting by hand.',
});
