import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const compiler = path.join(root, 'node_modules/typescript/bin/tsc');
if (!fs.existsSync(compiler)) {
  console.error('Dependencies missing. Run pnpm install --frozen-lockfile before verification. Existing dist is NOT tested.');
  process.exit(1);
}
function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run([compiler, '-p', 'apps/server/tsconfig.json', '--noEmit']);
fs.rmSync(path.join(root, 'dist/apps/server'), { recursive: true, force: true });
run([compiler, '-p', 'apps/server/tsconfig.json', '--noEmitOnError']);
const requested = process.argv.slice(2);
const tests = requested.length ? requested : fs.readdirSync(path.join(root, 'tests'))
  .filter(name => name.endsWith('.test.mjs')).sort().map(name => `tests/${name}`);
run(['--test', ...tests]);
if (requested.length === 0) run(['scripts/smoke.mjs']);
