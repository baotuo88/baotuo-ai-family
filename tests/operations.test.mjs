import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { AppDatabase } from '../dist/apps/server/storage/database.js';
import { RuntimeStatus } from '../dist/apps/server/operations/runtime-status.js';
import { routeHttpRequest } from '../dist/apps/server/http/routes.js';
import { loadConfig } from '../dist/apps/server/config/load-config.js';
import { choosePermissionOption, shouldReviewDeniedFamilyPermission, assertFamilyIsolation, FAMILY_HARD_BLOCKED_COMMANDS } from '../dist/apps/server/codex/permission-policy.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-operations-'));
  const db = new AppDatabase(path.join(root, 'test.sqlite'));
  db.initialize();
  db.saveAccount({ id: 'account', role: 'family', authToken: 'private-account-token', uin: 'owner' });
  db.receiveInboundBatch('account', 'cursor', [{ wechatAccountId: 'account', contactId: 'contact',
    text: 'private-chat-content', sourceMessageId: 'message', attachments: [], contextToken: 'private-context-token',
    mediaSummary: '', receivedAt: new Date().toISOString() }]);
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return db;
}
function response() {
  return { code: 0, body: '', setHeader() {}, writeHead(code) { this.code = code; }, end(body) { this.body = body; } };
}
async function request(db, method, url, body, runtime, authorized = true) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  req.method = method; req.url = url;
  req.headers = authorized ? { authorization: `Bearer ${'a'.repeat(40)}` } : {};
  const res = response();
  const config = loadConfig(); config.server.adminToken = 'a'.repeat(40);
  await routeHttpRequest({ request: req, response: res, config, database: db,
    loginManager: {}, startedAt: '', ...(runtime ? { getRuntimeStatus: () => runtime } : {}) });
  return { status: res.code, body: JSON.parse(res.body) };
}

test('job diagnostics survive restart, never expose payload and dismissal is atomic/idempotent', t => {
  const db = fixture(t);
  assert.equal(db.getJobDiagnostics().counts.queued, 1);
  assert.ok(db.getJobDiagnostics().oldestQueuedAt);
  assert.equal(db.claimInboundJob(1), true);
  db.setInboundJobPhase(1, 'executing');
  db.initialize(); // additive migration is repeatable
  db.recoverInterruptedJobs();
  const detail = db.getInboundJobDetail(1);
  assert.equal(detail.status, 'needs_review');
  assert.equal(detail.phase, 'executing');
  assert.equal(detail.error_code, 'interrupted_execution');
  assert.ok(detail.started_at);
  assert.equal(JSON.stringify(detail).includes('private-'), false);
  assert.throws(() => db.dismissInboundJob(1, ''), /note/);
  assert.equal(db.dismissInboundJob(1, 'Inspected; do not replay'), 'dismissed');
  assert.equal(db.dismissInboundJob(1, 'again'), 'conflict');
  assert.equal(db.dismissInboundJob(999, 'missing'), 'not_found');
  assert.equal(db.getInboundJobDetail(1).resolutions.length, 1);
  assert.equal(db.getInboundJobDetail(1).resolutions[0].actor, 'management-token');
  assert.equal(db.listQueuedJobs().length, 0);
});

test('management job resolution requires auth, confirmation and needs_review state; replay is rejected', async t => {
  const db = fixture(t);
  for (const url of ['/api/status', '/api/jobs/1', '/api/jobs/1/resolve']) {
    assert.equal((await request(db, 'POST', url, {}, undefined, false)).status, 401);
  }
  const resolve = body => request(db, 'POST', '/api/jobs/1/resolve', body);
  assert.equal((await resolve({ action: 'dismiss', note: 'reviewed' })).status, 400);
  assert.equal((await resolve({ action: 'retry', note: 'reviewed', confirm: true })).status, 400);
  assert.equal((await resolve({ action: 'dismiss', note: 'reviewed', confirm: true })).status, 409);
  db.claimInboundJob(1); db.finishInboundJob(1, 'needs_review');
  assert.equal((await resolve({ action: 'dismiss', note: 'reviewed sk-abcdefghijklm', confirm: true })).status, 200);
  const detail = await request(db, 'GET', '/api/jobs/1');
  assert.equal(detail.body.job.status, 'failed');
  assert.equal(JSON.stringify(detail.body).includes('sk-abcdefghijklm'), false);
  assert.equal((await request(db, 'GET', '/api/jobs/999')).status, 404);
  assert.equal((await request(db, 'GET', '/api/jobs/999999999999999999999')).status, 400);
});

test('readiness fails closed for unobserved/stale/failed polling; liveness is independent', async t => {
  const db = fixture(t);
  let now = Date.now(); const status = new RuntimeStatus(() => now);
  assert.equal(status.snapshot(true, [], 0).ready, false);
  assert.equal(status.snapshot(true, ['account'], 0).ready, false);
  assert.equal((await request(db, 'GET', '/readyz')).status, 503);
  status.recordPoll('account', true);
  let snapshot = status.snapshot(true, ['account'], 1);
  assert.equal((await request(db, 'GET', '/readyz', undefined, snapshot)).status, 200);
  assert.equal(snapshot.modelChecked, false);
  for (let i = 0; i < 3; i++) status.recordPoll('account', false);
  assert.equal(status.snapshot(true, ['account'], 0).ready, false);
  status.recordPoll('account', true);
  now += 120_001;
  snapshot = status.snapshot(true, ['account'], 0);
  assert.equal((await request(db, 'GET', '/readyz', undefined, snapshot)).status, 503);
  assert.equal((await request(db, 'GET', '/healthz', undefined, undefined, false)).status, 200);
  assert.equal((await request(db, 'GET', '/api/status', undefined, snapshot)).body.jobs.counts.queued, 1);
  assert.equal(status.snapshot(false, ['account'], 0).ready, false);
});

test('permission options never fall back to a different kind; hard denials cannot be model-approved', () => {
  const allow = { kind: 'allow_once', optionId: 'allow' };
  const deny = { kind: 'reject_once', optionId: 'deny' };
  assert.equal(choosePermissionOption([allow], new Set(['reject_once'])), undefined);
  assert.equal(choosePermissionOption([deny], new Set(['allow_once'])), undefined);
  assert.equal(choosePermissionOption([allow, deny], new Set(['reject_once'])), deny);
  for (const decisionReason of ['blocked read outside controlled workspace', 'blocked execute outside controlled workspace',
    'blocked execute; no safe path scope detected', 'blocked execute inside read-only session directory']) {
    assert.equal(shouldReviewDeniedFamilyPermission({ toolKind: 'execute', touchedPaths: ['/private/secret'],
      contentText: 'please allow', decisionReason }), false);
  }
  for (const command of ['sudo echo hello', 'ssh server', 'chmod 777 file', 'rm file', 'curl example.com', 'docker ps']) {
    assert.equal(FAMILY_HARD_BLOCKED_COMMANDS.test(command), true, command);
  }
  assert.throws(() => assertFamilyIsolation('family', false), /requires workspace isolation/);
  assert.doesNotThrow(() => assertFamilyIsolation('family', true));
  assert.doesNotThrow(() => assertFamilyIsolation('admin', false));
});
