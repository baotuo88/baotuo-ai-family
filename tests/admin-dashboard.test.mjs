import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import { loadConfig } from '../dist/apps/server/config/load-config.js';
import { ModelSettingsStore, applyModelSettings, SettingsBusyError } from '../dist/apps/server/settings/model-settings.js';
import { routeHttpRequest } from '../dist/apps/server/http/routes.js';
import { renderAdminPage } from '../dist/apps/server/http/admin-page.js';
import { createBackup, restoreBackup } from '../dist/apps/server/storage/backup.js';
import { AppDatabase } from '../dist/apps/server/storage/database.js';

const require = createRequire(import.meta.url);
const factory = require.resolve('../dist/apps/server/codex/factory.js');
const created = [];
require.cache[factory] = { id: factory, filename: factory, loaded: true, exports: {
  createCodexBackend: config => { const backend = { config, disposed: false, dispose() { this.disposed = true; }, clearSession() {}, cancel() {} }; created.push(backend); return backend; },
} };
const { WechatWorker } = require('../dist/apps/server/transport/ilink/worker.js');
const value = { baseUrl: 'https://example.invalid/v1', apiKey: 'dashboard-secret-key', model: 'test-model', reasoningEffort: 'high', backend: 'api' };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-dashboard-'));
  const config = loadConfig(); config.server.dataDir = root; config.server.adminToken = 'a'.repeat(40);
  config.codex.admin.workspace = path.join(root, 'admin'); config.codex.family.workspace = path.join(root, 'family');
  const settings = new ModelSettingsStore(root, config);
  const database = new AppDatabase(path.join(root, 'test.sqlite')); database.initialize();
  const worker = new WechatWorker({ config, database, settings });
  t.after(async () => { await worker.stop(); database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, config, settings, database, worker };
}
async function call(f, method, url, body, headers = {}, override = {}) {
  const request = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  request.method = method; request.url = url;
  request.headers = { authorization: `Bearer ${'a'.repeat(40)}`, 'content-type': 'application/json', 'x-gateway-request': 'dashboard', ...headers };
  if (override.socket) request.socket = override.socket;
  const response = { status: 0, body: '', headers: {}, setHeader(k, v) { this.headers[k] = v; }, writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); }, end(body) { this.body = body; } };
  await routeHttpRequest({ ...f, request, response, loginManager: {}, startedAt: '',
    saveModelSettings: (role, value) => f.worker.saveModelSettings(role, value), ...override });
  return response;
}

test('settings encrypt keys, survive restart and never expose them in public views', t => {
  const f = fixture(t);
  f.settings.save('family', f.settings.prepare('family', value));
  const file = path.join(f.root, '.settings/models.enc');
  assert.equal(fs.readFileSync(file).includes(Buffer.from(value.apiKey)), false);
  assert.equal(JSON.stringify(f.settings.view()).includes(value.apiKey), false);
  assert.equal(f.settings.view().roles.family.hasApiKey, true);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(f.root, '.settings/key')).mode & 0o777, 0o600);
  }
  const reopened = new ModelSettingsStore(f.root, f.config);
  assert.equal(reopened.get('family').apiKey, value.apiKey);
  assert.equal(reopened.prepare('family', { ...value, apiKey: '' }).apiKey, value.apiKey);
  assert.equal(reopened.prepare('family', { ...value, apiKey: 'rotated' }).apiKey, 'rotated');
  const runtime = applyModelSettings(f.config.codex.family, reopened.get('family'));
  assert.equal(runtime.envOverrides.OPENAI_API_KEY, value.apiKey);
  assert.equal(runtime.apiModel, value.model);
  assert.equal(runtime.acpWorkspaceIsolation, true);
  fs.writeFileSync(file, 'corrupted');
  assert.throws(() => new ModelSettingsStore(f.root, f.config), /Cannot read model settings/);
});

test('settings validate URL, model, reasoning, backend and credentials without leaking input', t => {
  const { settings } = fixture(t);
  for (const change of [{ baseUrl: 'file:///etc/passwd' }, { baseUrl: 'https://user:secret@example.com' },
    { baseUrl: 'https://example.com/?key=secret' }, { apiKey: '' }, { apiKey: 'a\nb' },
    { model: '' }, { backend: 'cli' }, { reasoningEffort: 'invalid' }]) {
    assert.throws(() => settings.prepare('family', { ...value, ...change }));
  }
  assert.equal(settings.get('family'), undefined);
});

test('dashboard and model endpoints are authenticated; HTML is nonce-protected and script parses', async t => {
  const f = fixture(t);
  for (const url of ['/', '/admin', '/api/settings/models', '/api/settings/models/test', '/api/contacts']) {
    const response = await call(f, 'GET', url, undefined, { authorization: '' }); assert.equal(response.status, url === '/' || url === '/admin' ? 302 : 401, url);
  }
  const response = await call(f, 'GET', '/admin'); assert.equal(response.status, 200);
  assert.match(response.body, /家庭 AI · 管理后台/);
  assert.match(response.headers['Content-Security-Policy'], /frame-ancestors 'none'/);
  const script = response.body.match(/<script nonce="([^"]+)">([\s\S]*?)<\/script>/);
  assert.ok(script); assert.ok(response.headers['Content-Security-Policy'].includes(script[1]));
  new vm.Script(script[2]);
  assert.notEqual(renderAdminPage().csp, renderAdminPage().csp);
  assert.equal(response.body.includes('localStorage'), false);
  assert.equal(response.body.includes('innerHTML'), false);
});

test('management login uses a standalone page and issues an expiring HttpOnly session', async t => {
  const f = fixture(t);
  const loginPage = await call(f, 'GET', '/admin/login', undefined, { authorization: '' });
  assert.equal(loginPage.status, 200);
  assert.match(loginPage.body, /管理员登录/);
  assert.match(loginPage.body, /autocomplete="current-password"/);

  const invalid = await call(f, 'POST', '/api/auth/login', { username: 'admin', token: 'wrong' }, { authorization: '' });
  assert.equal(invalid.status, 401);
  const crossOrigin = await call(f, 'POST', '/api/auth/login', { username: 'admin', token: 'a'.repeat(40) }, {
    authorization: '', origin: 'https://evil.test', host: 'localhost',
  });
  assert.equal(crossOrigin.status, 403);

  const login = await call(f, 'POST', '/api/auth/login', { username: 'admin', token: 'a'.repeat(40), next: '//evil.test' }, { authorization: '' });
  assert.equal(login.status, 200);
  assert.equal(JSON.parse(login.body).next, '/admin');
  assert.match(login.headers['Set-Cookie'], /HttpOnly/);
  assert.match(login.headers['Set-Cookie'], /SameSite=Strict/);
  const cookie = login.headers['Set-Cookie'].split(';', 1)[0];

  const dashboard = await call(f, 'GET', '/admin', undefined, { authorization: '', cookie });
  assert.equal(dashboard.status, 200);
  const loggedOut = await call(f, 'POST', '/api/auth/logout', {}, { authorization: '', cookie });
  assert.equal(loggedOut.status, 200);
  assert.match(loggedOut.headers['Set-Cookie'], /Max-Age=0/);
  const denied = await call(f, 'GET', '/admin', undefined, { authorization: '', cookie });
  assert.equal(denied.status, 302);
});

test('management login rate limits repeated failures by client address', async t => {
  const f = fixture(t);
  const socket = { remoteAddress: '198.51.100.42' };
  for (let attempt = 0; attempt < 7; attempt += 1) {
    const response = await call(f, 'POST', '/api/auth/login', { username: 'admin', token: 'wrong' }, { authorization: '' }, { socket });
    assert.equal(response.status, 401);
  }
  const blocked = await call(f, 'POST', '/api/auth/login', { username: 'admin', token: 'wrong' }, { authorization: '' }, { socket });
  assert.equal(blocked.status, 429);
  assert.match(blocked.headers['Retry-After'], /\d+/);
  const validWhileBlocked = await call(f, 'POST', '/api/auth/login', { username: 'admin', token: 'a'.repeat(40) }, { authorization: '' }, { socket });
  assert.equal(validWhileBlocked.status, 429);

  const otherClient = await call(f, 'POST', '/api/auth/login', { username: 'admin', token: 'a'.repeat(40) }, { authorization: '' }, {
    socket: { remoteAddress: '198.51.100.43' },
  });
  assert.equal(otherClient.status, 200);
});

test('model changes reject CSRF and active tasks, apply atomically when idle, and preserve keys', async t => {
  const f = fixture(t), body = { role: 'family', ...value };
  assert.equal((await call(f, 'POST', '/api/settings/models', body, { 'x-gateway-request': '' })).status, 403);
  assert.equal((await call(f, 'POST', '/api/settings/models', body, { origin: 'https://evil.test', host: 'localhost' })).status, 401);
  f.worker.scheduledJobs.add(1);
  assert.equal((await call(f, 'POST', '/api/settings/models', body)).status, 409);
  assert.equal(f.settings.get('family'), undefined);
  f.worker.scheduledJobs.clear();
  const previous = f.worker.codexBackends['family-api'];
  let response = await call(f, 'POST', '/api/settings/models', body);
  assert.equal(response.status, 200); assert.equal(response.body.includes(value.apiKey), false);
  assert.equal(previous.disposed, true);
  assert.equal(f.worker.codexBackends['family-api'].config.apiKey, value.apiKey);
  response = await call(f, 'POST', '/api/settings/models', { ...body, apiKey: '', model: 'new-model' });
  assert.equal(response.status, 200); assert.equal(f.settings.get('family').apiKey, value.apiKey);
  assert.equal(f.worker.buildRuntimeCodexConfig('family').apiModel, 'new-model');
  assert.throws(() => f.worker.getBackendForTurn({ role: 'family', userText: '运行命令', attachments: [] }), /纯 API/);
});

test('API test uses candidate settings, sanitizes failure and never saves credentials', async t => {
  const f = fixture(t), original = global.fetch;
  t.after(() => { global.fetch = original; });
  global.fetch = async () => new Response('upstream echoed ' + value.apiKey, { status: 401 });
  const response = await call(f, 'POST', '/api/settings/models/test', { role: 'family', ...value });
  assert.equal(response.status, 200); assert.equal(JSON.parse(response.body).ok, false);
  assert.equal(response.body.includes(value.apiKey), false); assert.equal(f.settings.get('family'), undefined);
});

test('model list endpoint returns only sanitized model ids and preserves saved credentials', async t => {
  const f = fixture(t), original = global.fetch;
  f.settings.save('family', f.settings.prepare('family', value));
  global.fetch = async url => {
    assert.equal(String(url), 'https://example.invalid/v1/models');
    return new Response(JSON.stringify({ data: [{ id: 'zeta' }, { id: 'alpha' }, { id: 'alpha' }, { name: 'ignored' }] }), { status: 200 });
  };
  t.after(() => { global.fetch = original; });
  const response = await call(f, 'POST', '/api/settings/models/list', { role: 'family', baseUrl: value.baseUrl, apiKey: '' });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body).models, ['alpha', 'zeta']);
  assert.equal(response.body.includes(value.apiKey), false);
  assert.equal(f.settings.get('family').apiKey, value.apiKey);
});

test('admin dashboard displays model-list detail errors', async t => {
  const f = fixture(t);
  const page = await call(f, 'GET', '/admin');
  assert.equal(page.status, 200);
  assert.match(page.body, /data\.detail \|\| data\.message \|\| data\.error/);
});

test('failed persistence does not replace live backends or expose candidate credentials', async t => {
  const f = fixture(t), previous = f.worker.codexBackends.admin;
  const original = f.settings.save;
  f.settings.save = () => { throw new Error('disk unavailable'); };
  assert.throws(() => f.worker.saveModelSettings('admin', value), /disk unavailable/);
  assert.equal(f.worker.codexBackends.admin, previous);
  assert.equal(previous.disposed, false); assert.equal(f.settings.get('admin'), undefined);
  assert.equal(created.at(-1).disposed, true);
  f.settings.save = original;
});

test('dashboard overrides environment and database model/provider routes consistently after restart', async t => {
  const f = fixture(t);
  f.worker.saveModelSettings('admin', { ...value, backend: 'acp' });
  f.config.codex.admin.apiKey = 'environment-key';
  f.config.codex.admin.apiModel = 'environment-model';
  const reopened = new ModelSettingsStore(f.root, f.config);
  const other = new WechatWorker({ config: f.config, database: f.database, settings: reopened });
  try {
    assert.equal(other.buildRuntimeCodexConfig('admin').apiKey, value.apiKey);
    assert.equal(other.codexBackends.admin.config.apiModel, value.model);
    assert.equal(other.codexBackends.admin.config.roleOverrides.model, value.model);
  } finally { await other.stop(); }
});

test('recent contacts are captured transactionally and exposed without message content', async t => {
  const f = fixture(t);
  f.database.receiveInboundBatch('account', 'cursor', [{ wechatAccountId: 'account', contactId: '<b>contact</b>',
    text: 'secret message', sourceMessageId: 'm', attachments: [], contextToken: 'private', mediaSummary: '', receivedAt: new Date().toISOString() }]);
  const result = await call(f, 'GET', '/api/contacts');
  assert.equal(result.status, 200); assert.equal(result.body.includes('secret message'), false);
  assert.equal(JSON.parse(result.body).contacts[0].contact_id, '<b>contact</b>');
});


test('backup and restore retain encrypted settings and the matching key', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-settings-backup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, 'data'), backup = path.join(root, 'backup');
  const config = loadConfig();
  const db = new AppDatabase(path.join(data, 'weixin-household-gateway.sqlite')); db.initialize();
  const settings = new ModelSettingsStore(data, config); settings.save('family', value);
  try { createBackup(data, backup); } finally { db.close(); }
  settings.save('family', { ...value, apiKey: 'changed' });
  restoreBackup(backup, data);
  assert.equal(new ModelSettingsStore(data, config).get('family').apiKey, value.apiKey);
});

test('dashboard login routes create, poll and return QR images behind management authentication', async t => {
  const f = fixture(t); let selectedRole;
  const loginManager = {
    create: async role => { selectedRole = role; return { id: 'login-id', role, status: 'waiting' }; },
    serializeById: id => id === 'login-id' ? { id, status: 'confirmed', accountId: 'account' } : undefined,
    getQrCodeBuffer: id => id === 'login-id' ? Buffer.from('test-png') : undefined,
  };
  const start = await call(f, 'POST', '/api/logins', { role: 'admin' }, {}, { loginManager });
  assert.equal(start.status, 201); assert.equal(selectedRole, 'admin');
  const poll = await call(f, 'GET', '/api/logins/login-id', undefined, {}, { loginManager });
  assert.equal(JSON.parse(poll.body).login.status, 'confirmed');
  const qr = await call(f, 'GET', '/api/logins/login-id/qrcode.png', undefined, {}, { loginManager });
  assert.equal(qr.status, 200); assert.equal(qr.body.toString(), 'test-png');
  assert.equal((await call(f, 'GET', '/api/logins/login-id/qrcode.png', undefined, { authorization: '' }, { loginManager })).status, 401);
});
