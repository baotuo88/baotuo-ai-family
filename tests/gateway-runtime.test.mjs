import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { AppDatabase } from '../dist/apps/server/storage/database.js';
import { loadConfig } from '../dist/apps/server/config/load-config.js';
import { ILinkApiClient } from '../dist/apps/server/transport/ilink/api-client.js';

// No external ACP SDK or credentials are needed to exercise the real worker.
const require = createRequire(import.meta.url);
const factoryPath = require.resolve('../dist/apps/server/codex/factory.js');
require.cache[factoryPath] = { id: factoryPath, filename: factoryPath, loaded: true, exports: {
  createCodexBackend: () => ({ clearSession() {}, dispose() {}, cancel() {}, run() { throw new Error('unexpected model call'); } }),
} };
const { WechatWorker } = require('../dist/apps/server/transport/ilink/worker.js');
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('condition did not settle');
}
function message(id, contact = 'a', text = 'hello') {
  return { wechatAccountId: 'account', contactId: contact, text, mediaSummary: '', attachments: [], contextToken: 'context', receivedAt: new Date().toISOString(), sourceMessageId: id };
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-runtime-'));
  const file = path.join(root, 'gateway.sqlite');
  const db = new AppDatabase(file);
  db.initialize();
  db.saveAccount({ id: 'account', role: 'family', authToken: 'test', uin: 'owner' });
  const config = loadConfig(); config.server.dataDir = root; config.wechat.maxConcurrentTasks = 2;
  const worker = new WechatWorker({ config, database: db });
  t.after(async () => { await worker.stop(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { db, worker, root, file };
}

test('scheduler bounds concurrency, keeps peer order, refills capacity and bypasses backlog for stop', async t => {
  const { db, worker } = fixture(t);
  const gates = { first: deferred(), second: deferred(), other: deferred(), third: deferred() };
  const started = [];
  worker.handleInboundMessage = async (_account, _client, inbound) => {
    started.push(inbound.sourceMessageId);
    await gates[inbound.sourceMessageId]?.promise;
  };
  t.after(() => { for (const gate of Object.values(gates)) gate.resolve(); });
  db.receiveInboundBatch('account', 'cursor', [message('first'), message('second'), message('other', 'b'), message('third', 'c')]);
  worker.running = true;
  worker.scheduleQueuedJobs();
  await until(() => started.length === 2);
  assert.deepEqual(started, ['first', 'other']);
  assert.equal(worker.scheduledJobs.size, 2);
  db.receiveInboundBatch('account', 'next', [message('stop', 'a', '/stop')]);
  worker.scheduleQueuedJobs();
  await until(() => started.includes('stop'));
  assert.equal(started.includes('second'), false);
  gates.first.resolve();
  await until(() => started.includes('second'));
  assert.equal(started.includes('third'), false);
  gates.other.resolve();
  await until(() => started.includes('third'));
  gates.second.resolve(); gates.third.resolve();
  await until(() => worker.scheduledJobs.size === 0);
  assert.equal(db.getInboundJobCounts().succeeded, 5);
});

test('disabled accounts do not occupy capacity and their jobs resume when enabled', async t => {
  const { db, worker } = fixture(t);
  db.receiveInboundBatch('account', 'cursor', [message('first')]);
  db.updateAccountStatus('account', 'disabled');
  assert.deepEqual(db.listDispatchableJobs(2, false, []), []);
  worker.running = true;
  worker.handleInboundMessage = async () => {};
  worker.scheduleQueuedJobs();
  assert.equal(worker.scheduledJobs.size, 0);
  db.updateAccountStatus('account', 'active');
  worker.scheduleQueuedJobs();
  await until(() => db.getInboundJobCounts().succeeded === 1);
});

test('all accounts begin polling independently and stop aborts both polls promptly', async t => {
  const { db, worker } = fixture(t);
  db.saveAccount({ id: 'second', role: 'family', authToken: 'test', uin: 'second' });
  const started = [], aborted = [];
  worker.pollAccount = async (account, signal) => {
    started.push(account.id);
    await new Promise(resolve => signal.addEventListener('abort', () => { aborted.push(account.id); resolve(); }, { once: true }));
  };
  worker.start();
  await until(() => started.length === 2);
  assert.deepEqual(started.sort(), ['account', 'second']);
  const firstStop = worker.stop();
  assert.equal(firstStop, worker.stop());
  assert.equal(worker.lifecycleController.signal.aborted, true);
  await firstStop;
  assert.deepEqual(aborted.sort(), ['account', 'second']);
  assert.equal(worker.accountPollers.size, 0);
});

test('shutdown cancels every active turn before waiting for a slow poller or cancellation', async t => {
  const { worker } = fixture(t);
  const pollGate = deferred(), cancelGate = deferred();
  const turns = [new AbortController(), new AbortController()];
  const called = [];
  worker.running = true;
  worker.loopPromise = pollGate.promise;
  turns.forEach((controller, i) => worker.activeTurns.set(String(i), {
    controller, conversationId: String(i), startedAt: '',
    backend: { cancel: async () => { called.push(i); await cancelGate.promise; } },
  }));
  const stopping = worker.stop();
  assert.deepEqual(called, [0, 1]);
  assert.ok(turns.every(controller => controller.signal.aborted));
  pollGate.resolve(); cancelGate.resolve();
  await stopping;
});

test('poll errors do not advance cursor or enqueue rejected response payloads', async t => {
  const { db, worker } = fixture(t);
  const previous = ILinkApiClient.prototype.getUpdates;
  ILinkApiClient.prototype.getUpdates = async () => ({ ret: -1, get_updates_buf: 'wrong', msgs: [] });
  try {
    db.savePollingCursor('account', 'old');
    await assert.rejects(worker.pollAccount(db.getAccountById('account')), /polling rejected/);
    assert.equal(db.getPollingCursor('account'), 'old');
    assert.equal(db.listQueuedJobs().length, 0);
  } finally { ILinkApiClient.prototype.getUpdates = previous; }
});

test('poll transport distinguishes external cancellation from normal long-poll timeout', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async (_url, options) => new Promise((_resolve, reject) => {
    const abort = () => reject(new DOMException('aborted', 'AbortError'));
    if (options.signal.aborted) abort();
    else options.signal.addEventListener('abort', abort, { once: true });
  });
  const client = new ILinkApiClient({ baseUrl: 'https://example.test', cdnBaseUrl: 'https://example.test', channelVersion: 'test' });
  try {
    const controller = new AbortController();
    const polling = client.getUpdates('cursor', 30000, controller.signal);
    controller.abort();
    await assert.rejects(polling, { name: 'AbortError' });
    const timeout = await client.getUpdates('cursor', 1);
    assert.deepEqual(timeout, { ret: 0, msgs: [], get_updates_buf: 'cursor' });
  } finally { globalThis.fetch = previous; }
});

test('existing durable job schema migrates and preserves stop-command priority', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-migration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'db.sqlite');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE inbound_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT,
    wechat_account_id TEXT NOT NULL, source_message_id TEXT NOT NULL,
    payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(wechat_account_id, source_message_id));`);
  for (const inbound of [message('one'), message('two', 'a', '/cancel')]) {
    old.prepare('INSERT INTO inbound_jobs (wechat_account_id, source_message_id, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('account', inbound.sourceMessageId, JSON.stringify(inbound), '', '');
  }
  old.close();
  const db = new AppDatabase(file);
  try {
    db.initialize(); db.initialize();
    db.saveAccount({ id: 'account', role: 'family', authToken: 'test', uin: 'test' });
    assert.deepEqual(db.listDispatchableJobs(1, true, []).map(job => job.message.sourceMessageId), ['two']);
    assert.deepEqual(db.listDispatchableJobs(1, false, []).map(job => job.message.sourceMessageId), ['one']);
  } finally { db.close(); }
});

test('family output rejects file and directory symlinks escaping the session', async t => {
  const { root } = fixture(t);
  const { resolveFamilyOutputFile, handleFileCommand, handleAssistantFileActions } = await import('../dist/apps/server/transport/ilink/file-command.js');
  const config = loadConfig(); config.server.dataDir = root;
  const outbox = path.join(root, 'outbox', 'session'); fs.mkdirSync(outbox, { recursive: true });
  const allowed = path.join(outbox, '..report.txt'); fs.writeFileSync(allowed, 'ok');
  const secret = path.join(root, 'secret'); fs.writeFileSync(secret, 'private');
  const link = path.join(outbox, 'linked.txt'); fs.symlinkSync(secret, link);
  assert.equal(resolveFamilyOutputFile(config, 'session', allowed), fs.realpathSync(allowed));
  assert.equal(resolveFamilyOutputFile(config, 'session', link), undefined);
  const external = path.join(root, 'external'); fs.mkdirSync(external); fs.writeFileSync(path.join(external, 'file'), 'private');
  fs.symlinkSync(external, path.join(root, 'outbox', 'redirected'));
  assert.equal(resolveFamilyOutputFile(config, 'redirected', path.join(root, 'outbox', 'redirected', 'file')), undefined);
  const unavailable = new Proxy({}, { get() { throw new Error('unexpected upload or database access'); } });
  const params = { config, session: { id: 'session', contextToken: 'context' }, client: unavailable, database: unavailable, role: 'family' };
  const reply = await handleFileCommand({ ...params, command: { name: '/file', args: [link] } });
  assert.match(reply, /只允许/);
  await handleAssistantFileActions({ ...params, rawReply: `[[send_file path="${link}"]]` });
});
