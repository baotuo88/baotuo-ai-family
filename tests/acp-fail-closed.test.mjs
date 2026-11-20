import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { loadConfig } from '../dist/apps/server/config/load-config.js';

// Exercise the real backend while replacing only the external ACP connection.
const require = createRequire(import.meta.url);
const connectionPath = require.resolve('../dist/apps/server/codex/acp-connection.js');
let connectionAttempts = 0;
require.cache[connectionPath] = { id: connectionPath, filename: connectionPath, loaded: true, exports: {
  AcpConnection: class {
    async ensureReady() { connectionAttempts++; throw new Error('sandbox initialization failed'); }
    dispose() {}
  },
} };
const { AcpCodexBackend } = require('../dist/apps/server/codex/acp-backend.js');

test('family ACP rejects disabled isolation before starting a connection and does not retry sandbox failure unsandboxed', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-acp-closed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { ...loadConfig().codex.family, workspace: path.join(root, 'workspace'), acpWorkspaceIsolation: false };
  const backend = new AcpCodexBackend(config);
  const request = { conversationId: 'conversation', prompt: 'process file', role: 'family', persistentSession: false };
  connectionAttempts = 0;
  await assert.rejects(backend.run(request), /requires workspace isolation/);
  assert.equal(connectionAttempts, 0);
  assert.equal(fs.existsSync(config.workspace), false);
  config.acpWorkspaceIsolation = true;
  await assert.rejects(backend.run(request), /sandbox initialization failed/);
  assert.equal(connectionAttempts, 1);
});

test('persisted ACP sessions are not reused after endpoint/model/credential changes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-acp-fingerprint-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { ...loadConfig().codex.admin, workspace: root, apiBaseUrl: 'https://example.invalid/v1', apiKey: 'original-key', apiModel: 'model-a' };
  const original = new AcpCodexBackend(config);
  original.persistedSessions.set('conversation', 'remote-session'); original.savePersistedSessions();
  const same = new AcpCodexBackend(config);
  assert.equal(same.persistedSessions.get('conversation'), 'remote-session');
  for (const patch of [{ apiKey: 'new-key' }, { apiModel: 'model-b' }, { apiBaseUrl: 'https://other.invalid/v1' }]) {
    const changed = new AcpCodexBackend({ ...config, ...patch });
    assert.equal(changed.persistedSessions.size, 0);
  }
  assert.equal(fs.readFileSync(path.join(root, '.acp-session-map.json'), 'utf8').includes('original-key'), false);
});
