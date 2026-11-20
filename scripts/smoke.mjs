import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

// Fresh volume, isolated environment, no accounts and no upstream/model calls.
const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-smoke-'));
let child;
try {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  const token = 'smoke-test-management-token-not-a-real-secret';
  child = spawn(process.execPath, [path.join(root, 'dist/apps/server/index.js')], {
    cwd: temporary,
    env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '',
      HOME: temporary, USERPROFILE: temporary, HOST: '127.0.0.1', PORT: String(port),
      DATA_DIR: path.join(temporary, 'data'), GATEWAY_ADMIN_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const collect = chunk => { output = (output + chunk.toString()).slice(-16000); };
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  // Avoid an unhandled rejection if spawn fails during health polling.
  void exited.catch(() => {});
  const base = `http://127.0.0.1:${port}`;
  let healthy = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) break;
    try {
      const response = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(500) });
      healthy = response.status === 200;
      await response.arrayBuffer();
      if (healthy) break;
    } catch { /* startup not ready yet */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(healthy, `Fresh startup failed:\n${output}`);
  const denied = await fetch(`${base}/api/status`);
  assert.equal(denied.status, 401); await denied.arrayBuffer();
  const dashboard = await fetch(`${base}/admin`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(dashboard.status, 200);
  assert.match(await dashboard.text(), /管理后台/);
  const settings = await fetch(`${base}/api/settings/models`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(settings.status, 200);
  assert.equal((await settings.json()).roles.family.hasApiKey, false);
  const ready = await fetch(`${base}/readyz`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(ready.status, 503, 'No accounts must not report business readiness');
  const body = await ready.json();
  assert.equal(body.accounts, 0);
  child.kill('SIGTERM');
  let timer;
  const result = await Promise.race([exited, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Shutdown timed out')), 10000);
  })]).finally(() => clearTimeout(timer));
  assert.equal(result.code, 0, output);
  console.log('Fresh-volume startup, management auth, readiness and graceful shutdown passed.');
} finally {
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    const stopped = once(child, 'exit');
    child.kill('SIGKILL');
    await stopped;
  }
  fs.rmSync(temporary, { recursive: true, force: true });
}
