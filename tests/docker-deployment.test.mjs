import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const entrypoint = fileURLToPath(new URL('../infra/docker/entrypoint.sh', import.meta.url));
test('container entrypoint initializes persistent directories and preserves command arguments and exit status', { skip: process.platform === 'win32' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-container-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const personal = path.join(root, 'personal');
  fs.mkdirSync(personal); fs.writeFileSync(path.join(personal, 'auth.json'), 'unchanged');
  const data = path.join(root, 'data');
  const env = { ...process.env, DATA_DIR: data, HOME: path.join(data, 'home'), CODEX_HOME: personal };
  delete env.CODEX_CLI_HOME; delete env.CODEX_ADMIN_WORKSPACE; delete env.CODEX_FAMILY_WORKSPACE;
  const result = spawnSync('sh', [entrypoint, process.execPath, '-e',
    'console.log(JSON.stringify({home:process.env.CODEX_CLI_HOME,arg:process.argv[1]})); process.exit(7)', 'literal $argument with spaces'], { env, encoding: 'utf8' });
  assert.equal(result.status, 7, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { home: path.join(data, 'codex-home'), arg: 'literal $argument with spaces' });
  for (const name of ['home', 'codex-home', 'runtime/admin', 'runtime/family', 'inbox', 'office', 'outbox']) {
    assert.ok(fs.statSync(path.join(data, name)).isDirectory());
  }
  assert.equal(fs.readFileSync(path.join(personal, 'auth.json'), 'utf8'), 'unchanged');
});

test('container entrypoint fails before executing service when persistent path is invalid', { skip: process.platform === 'win32' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-container-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, 'not-a-directory'); fs.writeFileSync(data, 'file');
  const result = spawnSync('sh', [entrypoint, process.execPath, '-e', 'console.log("must not start")'], {
    encoding: 'utf8', env: { ...process.env, DATA_DIR: data, HOME: path.join(data, 'home'), CODEX_CLI_HOME: path.join(data, 'auth'), CODEX_ADMIN_WORKSPACE: path.join(data, 'admin'), CODEX_FAMILY_WORKSPACE: path.join(data, 'family') },
  });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout.includes('must not start'), false);
  assert.match(result.stderr, /Cannot initialize gateway directories/);
});

test('entrypoint configures normal startup, fails closed, and does not configure maintenance commands', { skip: process.platform === 'win32' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-auto-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  const calls = path.join(root, 'calls');
  fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CALLS"\ncase "$1" in *configure-codex.js) exit "${CONFIG_EXIT:-0}";; esac\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALLS: calls,
    DATA_DIR: path.join(root, 'data'), HOME: path.join(root, 'home'), CODEX_CLI_HOME: path.join(root, 'codex'),
    CODEX_ADMIN_WORKSPACE: path.join(root, 'admin'), CODEX_FAMILY_WORKSPACE: path.join(root, 'family'), GATEWAY_AUTO_CONFIGURE: '1', CODEX_CLI_AUTH_MODE: 'api_key', CODEX_CLI_API_KEY: 'test-key' };
  const run = (args, overrides = {}) => spawnSync('sh', [entrypoint, 'node', ...args], { env: { ...env, ...overrides }, encoding: 'utf8' });
  assert.equal(run(['dist/apps/server/index.js']).status, 0);
  assert.deepEqual(fs.readFileSync(calls, 'utf8').trim().split('\n'), [
    'dist/apps/server/configure-codex.js --apply --if-changed --quiet', 'dist/apps/server/index.js',
  ]);
  fs.writeFileSync(calls, '');
  assert.equal(run(['dist/apps/server/index.js'], { CONFIG_EXIT: '7' }).status, 1);
  assert.equal(fs.readFileSync(calls, 'utf8').includes('index.js'), false);
  fs.writeFileSync(calls, '');
  assert.equal(run(['dist/apps/server/index.js'], { CODEX_CLI_API_KEY: '' }).status, 0);
  assert.equal(fs.readFileSync(calls, 'utf8').includes('configure-codex'), false);
  const settingsDir = path.join(env.DATA_DIR, '.settings'); fs.mkdirSync(settingsDir);
  fs.writeFileSync(path.join(settingsDir, 'models.enc'), 'existing-dashboard-settings');
  fs.writeFileSync(calls, '');
  assert.equal(run(['dist/apps/server/index.js']).status, 0);
  assert.equal(fs.readFileSync(calls, 'utf8').includes('configure-codex'), false);
  fs.writeFileSync(calls, '');
  assert.equal(run(['dist/apps/server/backup.js']).status, 0);
  assert.equal(fs.readFileSync(calls, 'utf8').includes('configure-codex'), false);
  fs.writeFileSync(calls, '');
  assert.equal(run(['dist/apps/server/index.js'], { GATEWAY_AUTO_CONFIGURE: '0' }).status, 0);
  assert.equal(fs.readFileSync(calls, 'utf8').includes('configure-codex'), false);
});

test('automatic Codex configuration is quiet, idempotent and follows explicit key/model changes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-config-idempotent-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'codex-home');
  const script = fileURLToPath(new URL('../dist/apps/server/configure-codex.js', import.meta.url));
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: root,
    CODEX_CLI_HOME: home, CODEX_CLI_AUTH_MODE: 'api_key', CODEX_CLI_API_KEY: 'test-$literal-key',
    CODEX_CLI_MODEL: 'test-model', CODEX_CLI_BASE_URL: 'https://example.invalid/v1' };
  const run = overrides => spawnSync(process.execPath, [script, '--apply', '--if-changed', '--quiet'], {
    cwd: root, env: { ...env, ...overrides }, encoding: 'utf8',
  });
  let result = run({}); assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, '');
  const files = fs.readdirSync(home);
  const mtime = fs.statSync(path.join(home, 'config.toml')).mtimeMs;
  result = run({}); assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readdirSync(home), files);
  assert.equal(fs.statSync(path.join(home, 'config.toml')).mtimeMs, mtime);
  result = run({ CODEX_CLI_API_KEY: 'changed-key', CODEX_CLI_MODEL: 'changed-model' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8')).OPENAI_API_KEY, 'changed-key');
  assert.match(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), /changed-model/);
  result = run({ CODEX_CLI_API_KEY: '' }); assert.equal(result.status, 1);
  assert.equal(result.stderr.includes('changed-key'), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8')).OPENAI_API_KEY, 'changed-key');
});
