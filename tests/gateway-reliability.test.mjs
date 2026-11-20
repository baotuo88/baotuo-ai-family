import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { AppDatabase } from '../dist/apps/server/storage/database.js';
import { createBackup, createEncryptedBackup, drillBackup, drillEncryptedBackup, restoreBackup, restoreEncryptedBackup, verifyBackup, verifyEncryptedBackup } from '../dist/apps/server/storage/backup.js';
import { acquireDataLock } from '../dist/apps/server/storage/data-lock.js';
import { authorizeManagement } from '../dist/apps/server/http/auth.js';
import { routeHttpRequest } from '../dist/apps/server/http/routes.js';
import { resolveRole } from '../dist/apps/server/router/resolve-role.js';
import { loadConfig } from '../dist/apps/server/config/load-config.js';
import { checkApiConnection } from '../dist/apps/server/codex/api-check.js';

const dbName = 'weixin-household-gateway.sqlite';
const repo = process.cwd();
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-reliability-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function message(id, account = 'account') {
  return { wechatAccountId: account, contactId: 'contact', text: 'hello', mediaSummary: '', attachments: [], contextToken: 'context', receivedAt: new Date().toISOString(), sourceMessageId: id };
}
function account(db) {
  db.saveAccount({ id: 'account', role: 'admin', authToken: 'test-token', uin: 'owner', status: 'active' });
}
function response() {
  return { headers: {}, code: 0, body: '', setHeader(k, v) { this.headers[k] = v; }, writeHead(code, headers) { this.code = code; Object.assign(this.headers, headers); }, end(body) { this.body = body; } };
}

test('batch reception deduplicates and rolls back messages with cursor on failure', t => {
  const db = new AppDatabase(path.join(fixture(t), dbName));
  try {
    db.initialize();
    db.receiveInboundBatch('account', 'cursor-1', [message('one'), message('one')]);
    assert.equal(db.listQueuedJobs().length, 1);
    assert.equal(db.getPollingCursor('account'), 'cursor-1');
    assert.throws(() => db.receiveInboundBatch('account', 'cursor-2', [message('two'), message('bad', 'other')]));
    assert.equal(db.listQueuedJobs().length, 1);
    assert.equal(db.getPollingCursor('account'), 'cursor-1');
  } finally { db.close(); }
});

test('restart preserves queued jobs and quarantines interrupted execution without replay', t => {
  const file = path.join(fixture(t), dbName);
  let db = new AppDatabase(file);
  db.initialize();
  db.receiveInboundBatch('account', 'cursor', [message('one'), message('two')]);
  const id = db.listQueuedJobs()[0].id;
  assert.equal(db.claimInboundJob(id), true);
  assert.equal(db.claimInboundJob(id), false);
  db.close();
  db = new AppDatabase(file);
  try {
    db.initialize();
    db.recoverInterruptedJobs();
    assert.deepEqual(db.listQueuedJobs().map(job => job.message.sourceMessageId), ['two']);
    assert.equal(db.listInboundJobStatus().find(job => job.id === id).status, 'needs_review');
    assert.equal(db.claimInboundJob(id), false);
    db.receiveInboundBatch('account', 'next', [message('one')]);
    assert.equal(db.listInboundJobStatus().length, 2);
  } finally { db.close(); }
});

test('admin requires both account role and explicit revocable contact authorization', t => {
  const db = new AppDatabase(path.join(fixture(t), dbName));
  try {
    db.initialize(); account(db);
    const role = () => resolveRole({ configuredRole: db.getAccountById('account').role, adminContactAllowed: db.isAdminContact('account', 'contact') }).role;
    assert.equal(role(), 'family');
    db.setAdminContact('account', 'contact', true);
    assert.equal(role(), 'admin');
    assert.equal(db.isAdminContact('other', 'contact'), false);
    db.updateAccountRole('account', 'family');
    assert.equal(role(), 'family');
    db.updateAccountRole('account', 'admin');
    db.setAdminContact('account', 'contact', false);
    assert.equal(role(), 'family');
  } finally { db.close(); }
});

test('management fails closed, supports bearer/browser basic and rejects cross-origin writes', () => {
  const token = 'a'.repeat(40);
  const check = (headers, key = token) => authorizeManagement({ headers }, response(), key);
  assert.equal(check({}), false);
  assert.equal(check({ authorization: `Bearer ${token}` }, ''), false);
  assert.equal(check({ authorization: `Bearer ${token}` }), true);
  assert.equal(check({ authorization: `Basic ${Buffer.from(`admin:${token}`).toString('base64')}` }), true);
  assert.equal(check({ authorization: `Bearer ${token}`, origin: 'https://evil.test', host: 'localhost:18080' }), false);
});

test('every management route is authenticated before database or login access', async () => {
  const config = loadConfig(); config.server.adminToken = 'a'.repeat(40);
  const unavailable = new Proxy({}, { get() { throw new Error('protected dependency accessed'); } });
  for (const [method, url] of [ ['GET','/api/accounts'], ['POST','/api/accounts/account/role'], ['POST','/api/logins'], ['GET','/api/logins/id/view'], ['GET','/api/logins/id/qrcode.png'], ['POST','/api/admin-contacts'], ['GET','/api/jobs'], ['GET','/readyz'] ]) {
    const res = response();
    await routeHttpRequest({ request: { method, url, headers: {} }, response: res, config, database: unavailable, loginManager: unavailable, startedAt: '' });
    assert.equal(res.code, 401, url);
  }
  const res = response();
  await routeHttpRequest({ request: { method: 'GET', url: '/healthz', headers: {} }, response: res, config, database: unavailable, loginManager: unavailable, startedAt: '' });
  assert.equal(res.code, 200);
});

test('configuration ignores inherited personal CODEX_HOME and apply preserves personal files', t => {
  const root = fixture(t);
  const personal = path.join(root, 'personal'); fs.mkdirSync(personal);
  fs.writeFileSync(path.join(personal, 'config.toml'), 'personal-config');
  fs.writeFileSync(path.join(personal, 'auth.json'), 'personal-auth');
  fs.writeFileSync(path.join(root, '.env'), 'CODEX_CLI_AUTH_MODE=api_key\nCODEX_CLI_API_KEY=sk-bot-test-key\n');
  const env = { ...process.env, CODEX_HOME: personal };
  for (const key of Object.keys(env)) if (key.startsWith('CODEX_') && key !== 'CODEX_HOME') delete env[key];
  const result = spawnSync(process.execPath, [path.join(repo, 'dist/apps/server/configure-codex.js'), '--apply'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(personal, 'config.toml'), 'utf8'), 'personal-config');
  assert.equal(fs.readFileSync(path.join(personal, 'auth.json'), 'utf8'), 'personal-auth');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'data/codex-home/auth.json'))).OPENAI_API_KEY, 'sk-bot-test-key');
  const script = `const {loadConfig}=require(${JSON.stringify(path.join(repo, 'dist/apps/server/config/load-config.js'))});console.log(loadConfig().codex.admin.codexHome)`;
  const check = spawnSync(process.execPath, ['-e', script], { cwd: root, env, encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
  assert.equal(fs.realpathSync(check.stdout.trim()), fs.realpathSync(path.join(root, 'data/codex-home')));
});

test('WAL backup verifies, restores exact data, preserves credentials and retains old directory', t => {
  const root = fixture(t), data = path.join(root, 'data'), backup = path.join(root, 'backup');
  const db = new AppDatabase(path.join(data, dbName));
  db.initialize(); account(db);
  db.receiveInboundBatch('account', 'cursor', [message('one')]);
  fs.mkdirSync(path.join(data, 'outbox')); fs.writeFileSync(path.join(data, 'outbox/report.txt'), 'report');
  fs.mkdirSync(path.join(data, 'codex-home')); fs.writeFileSync(path.join(data, 'codex-home/auth.json'), 'secret');
  try { createBackup(data, backup); } finally { db.close(); }
  assert.equal(fs.existsSync(path.join(backup, 'codex-home')), false);
  verifyBackup(backup);
  fs.writeFileSync(path.join(data, 'outbox/stale.txt'), 'stale');
  const previous = restoreBackup(backup, data);
  assert.ok(fs.existsSync(path.join(previous, 'outbox/stale.txt')));
  assert.equal(fs.existsSync(path.join(data, 'outbox/stale.txt')), false);
  assert.equal(fs.readFileSync(path.join(data, 'codex-home/auth.json'), 'utf8'), 'secret');
  const restored = new AppDatabase(path.join(data, dbName));
  try { restored.initialize(); assert.equal(restored.getPollingCursor('account'), 'cursor'); assert.equal(restored.listQueuedJobs().length, 1); }
  finally { restored.close(); }
});

test('restore drill restores into an isolated temporary directory and reports record counts', t => {
  const root = fixture(t), data = path.join(root, 'data'), backup = path.join(root, 'backup');
  const db = new AppDatabase(path.join(data, dbName)); db.initialize(); account(db);
  db.receiveInboundBatch('account', 'cursor', [message('drill-message')]);
  db.saveSession({ id: 'drill-session', wechatAccountId: 'account', contactId: 'contact', role: 'family', summaryText: '', status: 'active' });
  try { createBackup(data, backup); } finally { db.close(); }
  const tempEntriesBefore = new Set(fs.readdirSync(os.tmpdir()));
  assert.deepEqual(drillBackup(backup), { accounts: 1, sessions: 1, inboundJobs: 1 });
  assert.deepEqual(fs.readdirSync(data).sort(), [dbName]);
  const createdDrillDirs = fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('gateway-restore-drill-') && !tempEntriesBefore.has(name));
  assert.deepEqual(createdDrillDirs, []);
});

test('encrypted backups authenticate, verify, drill and restore with a separate passphrase', t => {
  const root = fixture(t), data = path.join(root, 'data'), backup = path.join(root, 'backup.enc');
  const restoreTarget = path.join(root, 'restored');
  const db = new AppDatabase(path.join(data, dbName)); db.initialize(); account(db);
  db.receiveInboundBatch('account', 'cursor', [message('encrypted-message')]);
  fs.mkdirSync(path.join(data, 'outbox'), { recursive: true });
  fs.writeFileSync(path.join(data, 'outbox', 'private-artifact.txt'), 'confidential-artifact-content');
  try { createEncryptedBackup(data, backup, 'separate-test-passphrase'); } finally { db.close(); }
  const encrypted = fs.readFileSync(backup);
  assert.equal(encrypted.includes(Buffer.from('confidential-artifact-content')), false);
  assert.equal(encrypted.includes(Buffer.from('private-artifact.txt')), true);
  assert.equal(verifyEncryptedBackup(backup, 'separate-test-passphrase').version, 1);
  assert.deepEqual(drillEncryptedBackup(backup, 'separate-test-passphrase'), { accounts: 1, sessions: 0, inboundJobs: 1 });
  assert.throws(() => verifyEncryptedBackup(backup, 'wrong-passphrase'));
  const corrupted = path.join(root, 'corrupted.enc');
  const corruptedBytes = Buffer.from(encrypted);
  corruptedBytes[corruptedBytes.length - 1] ^= 1;
  fs.writeFileSync(corrupted, corruptedBytes);
  assert.throws(() => verifyEncryptedBackup(corrupted, 'separate-test-passphrase'));
  const occupied = path.join(root, 'occupied.enc');
  fs.writeFileSync(occupied, 'keep-existing-backup');
  assert.throws(() => createEncryptedBackup(data, occupied, 'separate-test-passphrase'), /exist/i);
  assert.equal(fs.readFileSync(occupied, 'utf8'), 'keep-existing-backup');
  assert.throws(() => createEncryptedBackup(data, path.join(root, 'empty-key.enc'), ''), /must not be empty/);
  restoreEncryptedBackup(backup, restoreTarget, 'separate-test-passphrase');
  assert.equal(fs.readFileSync(path.join(restoreTarget, 'outbox', 'private-artifact.txt'), 'utf8'), 'confidential-artifact-content');
});

test('corrupt backups and live-service restores are rejected without modifying target', t => {
  const root = fixture(t), data = path.join(root, 'data'), backup = path.join(root, 'backup');
  const db = new AppDatabase(path.join(data, dbName)); db.initialize(); account(db); db.close();
  createBackup(data, backup);
  const release = acquireDataLock(data);
  try {
    assert.throws(() => acquireDataLock(data), /in use/);
    assert.throws(() => restoreBackup(backup, data), /in use/);
  } finally { release(); }
  const bytes = fs.readFileSync(path.join(data, dbName));
  fs.appendFileSync(path.join(backup, dbName), 'corrupt');
  assert.throws(() => verifyBackup(backup), /checksum/);
  assert.throws(() => restoreBackup(backup, data), /checksum/);
  assert.deepEqual(fs.readFileSync(path.join(data, dbName)), bytes);
});

test('backup refuses recursive output and symlink escape', t => {
  const root = fixture(t), data = path.join(root, 'data');
  const db = new AppDatabase(path.join(data, dbName)); db.initialize(); db.close();
  assert.throws(() => createBackup(data, path.join(data, 'backup')), /outside/);
  fs.symlinkSync(path.join(root, 'secret'), path.join(data, 'escape'));
  assert.throws(() => createBackup(data, path.join(root, 'backup')), /symbolic/);
});

test('API check uses backend fallback and never exposes provider errors or key', async () => {
  const original = globalThis.fetch;
  const config = { ...loadConfig().codex.family, apiBaseUrl: 'https://provider.test/v1', apiKey: 'sensitive-test-key' };
  const calls = [];
  globalThis.fetch = async url => {
    calls.push(String(url));
    return String(url).endsWith('/responses')
      ? new Response('{"error":{"message":"not found"}}', { status: 404 })
      : new Response('{"choices":[{"message":{"content":"doctor-ok"}}]}', { status: 200 });
  };
  try {
    assert.equal((await checkApiConnection(config)).ok, true);
    assert.ok(calls.some(url => url.endsWith('/responses')));
    assert.ok(calls.some(url => url.endsWith('/chat/completions')));
    globalThis.fetch = async () => new Response('{"error":{"message":"sensitive-test-key"}}', { status: 401 });
    const failed = await checkApiConnection(config);
    assert.equal(failed.ok, false);
    assert.equal(failed.detail.includes('sensitive-test-key'), false);
    assert.equal((await checkApiConnection({ ...config, apiKey: '' })).ok, false);
  } finally { globalThis.fetch = original; }
});

test('worker applies current authorization at execution and separates revoked admin history', async t => {
  // Substitute the external model factory only; exercise the actual worker, SQLite,
  // command routing, queue and session transitions without network/model credentials.
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const factoryPath = require.resolve('../dist/apps/server/codex/factory.js');
  const previousFactory = require.cache[factoryPath];
  require.cache[factoryPath] = { id: factoryPath, filename: factoryPath, loaded: true, exports: {
    createCodexBackend: () => ({ clearSession() {}, dispose() {}, cancel() {}, run() { throw new Error('unexpected model call'); } }),
  } };
  t.after(() => { if (previousFactory) require.cache[factoryPath] = previousFactory; else delete require.cache[factoryPath]; });
  const { WechatWorker } = require('../dist/apps/server/transport/ilink/worker.js');
  const root = fixture(t), config = loadConfig();
  config.server.dataDir = root;
  config.codex.admin.workspace = path.join(root, 'admin');
  config.codex.family.workspace = path.join(root, 'family');
  const db = new AppDatabase(path.join(root, dbName));
  const replies = [];
  const client = { async sendMessage(request) { replies.push(request.msg.item_list[0].text_item.text); return { ret: 0 }; } };
  try {
    db.initialize(); account(db); db.setAdminContact('account', 'contact', true);
    db.saveSession({ id: 'old-admin', wechatAccountId: 'account', contactId: 'contact', role: 'admin', summaryText: 'private-admin-history', memoryJson: '{"routeMode":"admin"}', lastActiveAt: new Date().toISOString() });
    const worker = new WechatWorker({ config, database: db });
    worker.running = true;
    const inbound = { ...message('revoke'), text: '/last' };
    db.receiveInboundBatch('account', 'cursor', [inbound]);
    const staleAdminAccount = db.getAccountById('account');
    db.updateAccountRole('account', 'family');
    worker.dispatchInboundMessage(staleAdminAccount, client, inbound, db.listQueuedJobs()[0].id);
    await Promise.all([...worker.inboundTasks]);
    const current = db.getSessionByPeer('account', 'contact');
    assert.equal(current.role, 'family');
    assert.notEqual(current.id, 'old-admin');
    assert.equal(current.summaryText, '');
    assert.equal(JSON.parse(current.memoryJson).routeMode, undefined);
    assert.equal(replies.join('').includes('private-admin-history'), false);
    assert.equal(replies.join('').includes('old-admin'), false);
    assert.equal(db.listInboundJobStatus()[0].status, 'succeeded');
    const escalation = { ...message('escalate'), text: '/mode admin' };
    db.receiveInboundBatch('account', 'cursor2', [escalation]);
    worker.dispatchInboundMessage(staleAdminAccount, client, escalation, db.listQueuedJobs()[0].id);
    await Promise.all([...worker.inboundTasks]);
    assert.equal(db.getSessionByPeer('account', 'contact').role, 'family');
    assert.match(replies.at(-1), /不能切到 admin/);
    worker.running = false;
    const stopped = { ...message('stopped'), text: '/time' };
    db.receiveInboundBatch('account', 'cursor3', [stopped]);
    worker.dispatchInboundMessage(staleAdminAccount, client, stopped, db.listQueuedJobs()[0].id);
    await Promise.all([...worker.inboundTasks]);
    assert.equal(db.listQueuedJobs().length, 1);
    await worker.stop();
  } finally { db.close(); }
});

test('backup under default data/backups location restores without replacing lock or credentials', t => {
  const data = path.join(fixture(t), 'data'), backup = path.join(data, 'backups', 'one');
  const db = new AppDatabase(path.join(data, dbName)); db.initialize(); account(db); db.close();
  createBackup(data, backup);
  restoreBackup(backup, data);
  verifyBackup(backup);
  const release = acquireDataLock(data); release();
  fs.writeFileSync(path.join(data, '.maintenance', 'restore-in-progress'), '{}');
  assert.throws(() => acquireDataLock(data), /Interrupted restore/);
});

test('JSON management payloads reject null, arrays and oversized bodies', async () => {
  const { Readable } = await import('node:stream');
  const { readJsonBody, InvalidJsonBodyError } = await import('../dist/apps/server/http/response.js');
  for (const value of ['null', '[]', '"string"', '{', 'x'.repeat(65537)]) {
    await assert.rejects(readJsonBody(Readable.from([Buffer.from(value)])), InvalidJsonBodyError);
  }
  assert.deepEqual(await readJsonBody(Readable.from([Buffer.from('{"role":"family"}')])), { role: 'family' });
});

test('failed execution is quarantined instead of retried or marked successful', async t => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  // Worker module was loaded with the test backend factory in the preceding test.
  const { WechatWorker } = require('../dist/apps/server/transport/ilink/worker.js');
  const root = fixture(t), config = loadConfig(); config.server.dataDir = root;
  const db = new AppDatabase(path.join(root, dbName));
  try {
    db.initialize(); account(db);
    const worker = new WechatWorker({ config, database: db });
    worker.running = true;
    let executions = 0;
    worker.handleInboundMessage = async () => { executions++; throw new Error('simulated task failure'); };
    const inbound = message('failed');
    db.receiveInboundBatch('account', 'cursor', [inbound]);
    const id = db.listQueuedJobs()[0].id;
    const prior = console.error; console.error = () => {};
    try {
      worker.dispatchInboundMessage(db.getAccountById('account'), {}, inbound, id);
      await Promise.all([...worker.inboundTasks]);
      worker.dispatchInboundMessage(db.getAccountById('account'), {}, inbound, id);
      await Promise.all([...worker.inboundTasks]);
    } finally { console.error = prior; }
    assert.equal(executions, 1);
    assert.equal(db.listInboundJobStatus()[0].status, 'needs_review');
    await worker.stop();
  } finally { db.close(); }
});

test('switching from admin to family creates a clean session and hides archived admin history', t => {
  return import('../dist/apps/server/commands/handlers.js').then(({ buildCommandReply, findPreviousSession }) => {
    const db = new AppDatabase(path.join(fixture(t), dbName));
    try {
      db.initialize(); account(db);
      const session = db.saveSession({ id: 'admin', wechatAccountId: 'account', contactId: 'contact', role: 'admin', summaryText: 'private', memoryJson: '{"routeMode":"admin","carryoverSummary":"private"}' });
      buildCommandReply({ command: { name: '/mode', args: ['family'] }, session, database: db, role: 'admin', accountRole: 'admin', sessionMemory: { routeMode: 'admin' }, account: db.getAccountById('account'), config: loadConfig() });
      const next = db.getSessionByPeer('account', 'contact');
      assert.notEqual(next.id, session.id);
      assert.equal(next.role, 'family');
      assert.equal(next.summaryText, '');
      assert.equal(findPreviousSession({ database: db, session: next }), undefined);
      assert.equal(db.getSessionById(session.id).role, 'admin');
    } finally { db.close(); }
  });
});
