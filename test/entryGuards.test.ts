import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const ENTRY_MODULES = [
  'src/main.ts',
  ...fs.readdirSync(path.join(repoRoot, 'bin')).map((f) => `bin/${f}`),
];

function runSandboxed(t: TestContext, args: string[], extraEnv: Record<string, string> = {}, timeout = 15_000) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'entry-guard-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const res = spawnSync(process.execPath, args, {
    cwd: tmp,
    encoding: 'utf8',
    timeout,
    killSignal: 'SIGKILL',
    // dotenv keeps variables already set, so an entry that does start can't reach the live
    // Redis or port, even from the live checkout
    env: { HOME: tmp, PATH: '', REDIS_URL: 'redis://127.0.0.1:1', AGENT_RUNNER_PORT: '1', ...extraEnv },
  });
  return { tmp, res };
}

describe('entry modules', () => {
  for (const rel of ENTRY_MODULES) {
    it(`${rel} does nothing when imported`, (t) => {
      const href = new URL(rel, `file://${repoRoot}`).href;
      const { tmp, res } = runSandboxed(t, ['--input-type=module', '-e', `await import(${JSON.stringify(href)})`]);
      assert.equal(res.status, 0, res.stderr);
      assert.equal(res.stdout, '');
      assert.equal(res.stderr, '');
      assert.deepEqual(fs.readdirSync(tmp), []);
    });
  }

  it('bin/agent-cli.ts runs its command when started with node', (t) => {
    const { res } = runSandboxed(t, [path.join(repoRoot, 'bin/agent-cli.ts'), 'help']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /^agent-cli: observability for agent-runner/);
  });

  it('src/main.ts starts when PM2 loads it with import() from its CommonJS wrapper', (t) => {
    const main = path.join(repoRoot, 'src/main.ts');
    const { res } = runSandboxed(
      t,
      ['-e', "import(require('url').pathToFileURL(process.env.pm_exec_path))"],
      { pm_exec_path: main }
    );
    assert.match(res.stderr, /agent-runner redis: connect ECONNREFUSED 127\.0\.0\.1:1/);
  });

  it('src/main.ts starts when PM2 names it through a symlink', (t) => {
    const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'entry-guard-link-'));
    t.after(() => fs.rmSync(linkDir, { recursive: true, force: true }));
    const link = path.join(linkDir, 'main.ts');
    fs.symlinkSync(path.join(repoRoot, 'src/main.ts'), link);
    const { res } = runSandboxed(
      t,
      ['-e', "import(require('url').pathToFileURL(process.env.pm_exec_path))"],
      { pm_exec_path: link }
    );
    assert.match(res.stderr, /agent-runner redis: connect ECONNREFUSED 127\.0\.0\.1:1/);
  });

  it('src/main.ts stays idle under another PM2 app', (t) => {
    const href = new URL('src/main.ts', `file://${repoRoot}`).href;
    const { res } = runSandboxed(t, ['--input-type=module', '-e', `await import(${JSON.stringify(href)})`], {
      pm_exec_path: path.join(repoRoot, 'bin/agent-cli.ts'),
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stderr, '');
  });
});
