import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const tsc = fileURLToPath(new URL('bin/tsc', import.meta.resolve('typescript/package.json')));

describe('dashboard typecheck', () => {
  it('loads only browser code, so Node globals in dashboard/ fail it', () => {
    const res = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.dashboard.json', '--listFilesOnly'], { cwd: repoRoot, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const loaded = res.stdout
      .split('\n')
      .filter((f) => f && !/[\\/]lib\.[\w.]+\.d\.ts$/.test(f))
      .map((f) => path.relative(repoRoot, f));
    assert.deepEqual(
      loaded.filter((f) => !f.startsWith('dashboard/')),
      ['src/officeWire.ts'],
      'import types from src/officeWire.ts only: anything else brings in @types/node'
    );
  });
});
