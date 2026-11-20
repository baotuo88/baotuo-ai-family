import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('../scripts/verify.mjs', import.meta.url));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-verify-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync(script, path.join(root, 'scripts/verify.mjs'));
  fs.mkdirSync(path.join(root, 'dist/apps/server'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dist/apps/server/old.js'), 'old-build');
  return root;
}
test('verify fails when dependencies are missing rather than running stale dist', t => {
  const root = fixture(t);
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/verify.mjs')], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Existing dist is NOT tested/);
  assert.equal(fs.readFileSync(path.join(root, 'dist/apps/server/old.js'), 'utf8'), 'old-build');
});
test('verify clears stale artifacts and stops on compile failure before executing tests', t => {
  const root = fixture(t);
  const compiler = path.join(root, 'node_modules/typescript/bin');
  fs.mkdirSync(compiler, { recursive: true });
  fs.writeFileSync(path.join(compiler, 'tsc'), `process.exit(process.argv.includes('--noEmit') ? 0 : 7);`);
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/verify.mjs')], { encoding: 'utf8' });
  assert.equal(result.status, 7);
  assert.equal(fs.existsSync(path.join(root, 'dist/apps/server/old.js')), false);
});
test('verify tests the newly built module rather than an existing stale artifact', t => {
  const root = fixture(t);
  const compiler = path.join(root, 'node_modules/typescript/bin');
  fs.mkdirSync(compiler, { recursive: true });
  fs.writeFileSync(path.join(compiler, 'tsc'), `
    const fs = require('node:fs');
    if (!process.argv.includes('--noEmit')) {
      fs.mkdirSync('dist/apps/server', { recursive: true });
      fs.writeFileSync('dist/apps/server/fresh.cjs', 'module.exports = 42;');
    }
  `);
  fs.mkdirSync(path.join(root, 'tests'));
  fs.writeFileSync(path.join(root, 'tests/fresh.test.cjs'), `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    assert.equal(require('../dist/apps/server/fresh.cjs'), 42);
    assert.equal(fs.existsSync('dist/apps/server/old.js'), false);
  `);
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/verify.mjs'), 'tests/fresh.test.cjs'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
