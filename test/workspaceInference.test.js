import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'fs/promises';
import { createStreamAccumulator } from '../src/agentBackend/claudeStreamParser.js';
import { createToolTouchReader, splitCommand } from '../src/agentBackend/claudeToolTouch.js';
import { canonicalPath, createWorkspaceInference, workspaceOfPaths } from '../src/workspaceInference.js';

const HOME = '/home/alexis';
const PROJECTS = `${HOME}/Projects`;
const WORKSPACES = [
  { alias: 'whatsapp-bot', root: `${PROJECTS}/WhatsappBot` },
  { alias: 'chess-trainer', root: `${PROJECTS}/chess-trainer` },
];

/** A filesystem where these directories exist, and `link` is a symlink to WhatsappBot. */
const EXISTING = new Set([HOME, PROJECTS, `${PROJECTS}/WhatsappBot`, `${PROJECTS}/WhatsappBot/src`, `${PROJECTS}/chess-trainer`, '/', '/home', '/tmp']);
const fakeRealpath = async (p) => {
  if (p === `${PROJECTS}/link`) return `${PROJECTS}/WhatsappBot`;
  if (EXISTING.has(p)) return p;
  throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
};

/** The touches a recorded stream-json run makes, fed through the Claude parser. @param {string} name */
async function touchesOf(name) {
  const touches = [];
  const acc = createStreamAccumulator({ cwd: PROJECTS, onTouch: (t) => touches.push(t) });
  acc.push(await readFile(new URL(`./fixtures/${name}`, import.meta.url)));
  acc.flush();
  return touches;
}

/** The workspace a recorded run is inferred to, and how often it was set. @param {string} name */
async function inferFixture(name) {
  const set = [];
  const inference = createWorkspaceInference({ workspaces: async () => WORKSPACES, onInferred: (a) => void set.push(a), realpath: fakeRealpath });
  let last;
  for (const t of await touchesOf(name)) last = inference.touch(t);
  await last;
  return set;
}

describe('claude tool touches', () => {
  it('reads edits and commands, not reads or searches', async () => {
    const touches = await touchesOf('freeform-edit.ndjson');
    assert.deepEqual(
      touches.map((t) => t.action),
      ['command', 'edit', 'command', 'edit']
    );
    assert.deepEqual(touches[1], { action: 'edit', paths: [`${PROJECTS}/WhatsappBot/src/commands.js`] });
  });

  it('a read-only run touches no workspace', async () => {
    const touches = await touchesOf('freeform-read-only.ndjson');
    // the one command lists ~/Projects/*/package.json
    assert.deepEqual(touches.map((t) => t.action), ['command']);
    assert.equal(await workspaceOfPaths(touches[0].paths, WORKSPACES, fakeRealpath), null);
  });

  it('follows cd into the next command, since the Bash tool keeps its directory', () => {
    const r = createToolTouchReader({ cwd: PROJECTS, home: HOME });
    assert.deepEqual(r.read('Bash', { command: 'cd WhatsappBot && git status' }), { action: 'command', paths: [PROJECTS, `${PROJECTS}/WhatsappBot`] });
    assert.deepEqual(r.read('Bash', { command: 'npm test' }), { action: 'command', paths: [`${PROJECTS}/WhatsappBot`] });
    assert.deepEqual(r.read('Bash', { command: 'cd' }), { action: 'command', paths: [`${PROJECTS}/WhatsappBot`, HOME] });
  });

  it('finds the paths a command targets: absolute, home, globbed, -C and --prefix', () => {
    const r = createToolTouchReader({ cwd: PROJECTS, home: HOME });
    const paths = (command) => r.read('Bash', { command })?.paths.slice(1);
    assert.deepEqual(paths('git -C chess-trainer log'), [`${PROJECTS}/chess-trainer`]);
    assert.deepEqual(paths('npm --prefix "WhatsappBot" test'), [`${PROJECTS}/WhatsappBot`]);
    assert.deepEqual(paths("sed -i 's/a/b/' '~/Projects/WhatsappBot/src/x.js'"), [`${PROJECTS}/WhatsappBot/src/x.js`]);
    assert.deepEqual(paths('rm $HOME/Projects/chess-trainer/src/*.tmp'), [`${PROJECTS}/chess-trainer/src`]);
    assert.deepEqual(paths('node x.js --out=/tmp/y > /tmp/log'), ['/tmp/y', '/tmp/log']);
    assert.deepEqual(paths('echo hi'), []);
  });

  it('reads Write, MultiEdit and NotebookEdit as edits, and nothing from other tools', () => {
    const r = createToolTouchReader({ cwd: PROJECTS, home: HOME });
    assert.equal(r.read('Write', { file_path: '/a/b' })?.action, 'edit');
    assert.equal(r.read('MultiEdit', { file_path: '/a/b', edits: [] })?.action, 'edit');
    assert.deepEqual(r.read('NotebookEdit', { notebook_path: '/a/n.ipynb' }), { action: 'edit', paths: ['/a/n.ipynb'] });
    for (const name of ['Read', 'Grep', 'Glob', 'WebFetch', 'TodoWrite']) assert.equal(r.read(name, { file_path: '/a/b', path: '/a' }), null);
  });

  it('splits a command into its simple commands', () => {
    assert.deepEqual(splitCommand('cd a && (npm test | tail); echo "x y"'), [['cd', 'a'], ['npm', 'test'], ['tail'], ['echo', 'x', 'y']]);
  });
});

describe('workspace inference', () => {
  it('an edit in an allowlisted repo sets the inferred workspace, once', async () => {
    // the later command and write in chess-trainer don't move it
    assert.deepEqual(await inferFixture('freeform-edit.ndjson'), ['whatsapp-bot']);
  });

  it('a run that only reads files has no inferred workspace', async () => {
    assert.deepEqual(await inferFixture('freeform-read-only.ndjson'), []);
  });

  it('a command run in a repo sets it before a later edit elsewhere', async () => {
    assert.deepEqual(await inferFixture('freeform-command.ndjson'), ['whatsapp-bot']);
  });

  it('compares realpaths, so a symlink into a repo counts, and a new file resolves through its directory', async () => {
    assert.equal(await canonicalPath(`${PROJECTS}/link/src/new/file.js`, fakeRealpath), `${PROJECTS}/WhatsappBot/src/new/file.js`);
    assert.equal(await workspaceOfPaths([`${PROJECTS}/link/new.js`], WORKSPACES, fakeRealpath), 'whatsapp-bot');
    // a sibling whose name starts with the root's isn't inside it
    assert.equal(await workspaceOfPaths([`${PROJECTS}/WhatsappBot-old/x`], WORKSPACES, fakeRealpath), null);
    assert.equal(await workspaceOfPaths([PROJECTS], WORKSPACES, fakeRealpath), null);
  });

  it('picks the deepest root when workspaces nest', async () => {
    const nested = [...WORKSPACES, { alias: 'bot-src', root: `${PROJECTS}/WhatsappBot/src` }];
    assert.equal(await workspaceOfPaths([`${PROJECTS}/WhatsappBot/src/a.js`], nested, fakeRealpath), 'bot-src');
  });

  it('keeps going when the allowlist lookup fails', async () => {
    const set = [];
    const warnings = [];
    let calls = 0;
    const inference = createWorkspaceInference({
      workspaces: async () => {
        calls += 1;
        if (calls === 1) throw new Error('bad map file');
        return WORKSPACES;
      },
      onInferred: (a) => void set.push(a),
      realpath: fakeRealpath,
      logger: { warn: (m) => warnings.push(m) },
    });
    await inference.touch({ action: 'edit', paths: [`${PROJECTS}/WhatsappBot/a`] });
    assert.deepEqual(warnings, ['workspace inference: bad map file']);
    await inference.touch({ action: 'edit', paths: ['/tmp/x'] });
    await inference.touch({ action: 'edit', paths: [`${PROJECTS}/chess-trainer/a`] });
    await inference.touch({ action: 'edit', paths: [`${PROJECTS}/WhatsappBot/a`] });
    assert.deepEqual(set, ['chess-trainer']);
    assert.equal(inference.inferred, 'chess-trainer');
    assert.equal(calls, 2);
  });
});
