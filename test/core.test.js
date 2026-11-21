import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encode, decode, validate, Base64Error } from '../core.js';

const { cases } = JSON.parse(readFileSync(new URL('../testdata/vectors.json', import.meta.url), 'utf8'));
const fromHex = (hex) => Uint8Array.from(Buffer.from(hex, 'hex'));
const toHex = (bytes) => Buffer.from(bytes).toString('hex');

test('vectors: all cases through the core', async (t) => {
  assert.ok(cases.length > 0);
  for (const [i, c] of cases.entries()) {
    await t.test(`#${i} ${c.op} ${JSON.stringify(c.in ?? c.in_hex).slice(0, 40)}`, () => {
      if (c.op === 'encode') {
        assert.equal(encode(fromHex(c.in_hex), { url: c.url, pad: c.pad, wrap: c.wrap }), c.out);
      } else if (c.op === 'decode') {
        if (c.error) assert.throws(() => decode(c.in), Base64Error);
        else assert.equal(toHex(decode(c.in)), c.out_hex);
      } else if (c.op === 'validate') {
        const r = validate(c.in);
        assert.equal(r.valid, c.valid);
        if (c.valid) assert.deepEqual(r, { valid: true, variant: c.variant, padded: c.padded, bytes: c.bytes });
        else assert.equal(typeof r.error, 'string');
      } else {
        assert.fail(`unknown op ${c.op}`);
      }
    });
  }
});
