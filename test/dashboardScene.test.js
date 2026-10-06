import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HELPER_KEEP_MS, MAIL_KEEP_MS, PILE_MAX, jobWorker, reduceScene, restingState } from '../dashboard/scene.js';

const NOW = Date.parse('2026-09-26T12:00:00Z');
const iso = (ms) => new Date(NOW + ms).toISOString();

/** A minimal OfficeSnapshot, with `over` on top. @returns {any} */
function snap(over = {}) {
  return {
    version: 1,
    at: iso(0),
    activeRun: null,
    active: [],
    queue: [],
    pauses: { restart: null, general: null, workspaces: [] },
    cron: null,
    lock: null,
    history: [],
    spend: { today: { runs: 0, costUsd: 0, tokens: 0 }, week: { runs: 0, costUsd: 0, tokens: 0 } },
    workspaces: ['bot', 'chess-trainer', 'dots'],
    ...over,
  };
}

const up = { up: true, now: NOW, config: {} };
const pause = (ms, reason = 'r') => ({ reason, pausedAt: iso(-60_000), until: iso(ms) });

describe('office scene: visitors', () => {
  const session = (id, extra = {}) => ({ id, workspaceAlias: 'bot', cwd: '/p/bot', branch: 'main', state: 'working', activity: 'Bash: npm test', subagents: 0, since: iso(-60_000), lastEntryAt: iso(-1000), ...extra });

  it('seats each session in its workspace cubicle, oldest first, or in the Freeform room outside every workspace', () => {
    const scene = reduceScene(snap({ sessions: [session('a'), session('b', { workspaceAlias: 'dots' }), session('c', { workspaceAlias: null, cwd: '/home/a/notes' }), session('d', { workspaceAlias: 'gone' }), session('e')] }), null, up);
    assert.deepEqual(scene.sessions.map((s) => [s.id, s.place]), [
      ['a', { room: 'cubicle', alias: 'bot', session: 'a' }],
      ['b', { room: 'cubicle', alias: 'dots', session: 'b' }],
      ['c', { room: 'freeform', session: 'c' }],
      ['d', { room: 'freeform', session: 'd' }],
      ['e', { room: 'cubicle', alias: 'bot', session: 'e' }],
    ]);
    assert.deepEqual(scene.cubicles.map((c) => [c.alias, c.sessions]), [['bot', ['a', 'e']], ['chess-trainer', []], ['dots', ['b']]]);
    assert.equal(scene.sessions[2].repo, 'notes');
    assert.equal(scene.sessions[0].repo, 'bot');
  });

  it("types with the current tool's tag while working, and waits with no tag", () => {
    const scene = reduceScene(snap({ sessions: [session('a'), session('b', { activity: 'writing…' }), session('c', { activity: 'Read: /x.js' }), session('d', { state: 'waiting' })] }), null, up);
    assert.deepEqual(scene.sessions.map((s) => [s.state, s.tool]), [['working', 'Bash'], ['working', 'write'], ['working', 'Read'], ['waiting', null]]);
  });

  it('keeps the subagent count and when the session opened, and no text', () => {
    const [s] = reduceScene(snap({ sessions: [session('a', { subagents: 3 })] }), null, up).sessions;
    assert.equal(s.subagents, 3);
    assert.equal(s.since, NOW - 60_000);
    assert.deepEqual(Object.keys(s).sort(), ['activity', 'branch', 'id', 'place', 'repo', 'since', 'state', 'subagents', 'tool']);
  });

  it('has no visitors without sessions, from an older feed, or from junk', () => {
    assert.deepEqual(reduceScene(snap(), null, up).sessions, []);
    assert.deepEqual(reduceScene(snap({ sessions: [] }), null, up).sessions, []);
    assert.deepEqual(reduceScene(snap({ sessions: [null, { id: 3 }, { id: 'x', state: 'odd' }] }), null, up).sessions, []);
  });

  it("doesn't add a desk for a job room's session, nor recruit residents for subagents", () => {
    const scene = reduceScene(snap({ sessions: [session('a', { subagents: 2 })] }), null, up);
    assert.deepEqual(scene.helpers, []);
  });
});

describe('office scene: cubicles', () => {
  it('gives every allowlisted workspace a cubicle named by its alias', () => {
    const scene = reduceScene(snap(), null, up);
    assert.deepEqual(
      scene.cubicles.map((c) => [c.alias, c.name]),
      [
        ['bot', 'bot'],
        ['chess-trainer', 'chess-trainer'],
        ['dots', 'dots'],
      ]
    );
  });

  it('renames and reorders cubicles from the config, and keeps the rest after them', () => {
    const config = { cubicles: [{ alias: 'dots', name: 'Accounting' }, { alias: 'gone', name: 'Old' }, { alias: 'bot' }] };
    const scene = reduceScene(snap(), null, { ...up, config });
    assert.deepEqual(
      scene.cubicles.map((c) => [c.alias, c.name]),
      [
        ['dots', 'Accounting'],
        ['bot', 'bot'],
        ['chess-trainer', 'chess-trainer'],
      ]
    );
  });

  it('shrugs off a broken config', () => {
    for (const config of [null, undefined, 'x', { cubicles: 'x' }, { cubicles: [null, 3, { name: 'no alias' }] }]) {
      assert.equal(reduceScene(snap(), null, { ...up, config }).cubicles.length, 3, JSON.stringify(config));
    }
  });
});

describe('office scene: office states', () => {
  it('is lit while the runner is up', () => {
    const scene = reduceScene(snap(), null, up);
    assert.equal(scene.dark, false);
    assert.equal(scene.backInFive, false);
    assert.ok(scene.cubicles.every((c) => !c.doNotDisturb));
  });

  it('goes dark when the runner is down, keeping the floor it last saw', () => {
    const lit = reduceScene(snap(), null, up);
    const dark = reduceScene(snap(), lit, { ...up, up: false });
    assert.equal(dark.dark, true);
    assert.deepEqual(
      dark.cubicles.map((c) => c.alias),
      lit.cubicles.map((c) => c.alias)
    );
    assert.equal(reduceScene(snap(), dark, up).dark, false);
  });

  it('lets pauses run out while the runner is down', () => {
    const paused = snap({ pauses: { restart: null, general: pause(60_000), workspaces: [{ alias: 'dots', ...pause(60_000) }] } });
    const before = reduceScene(paused, reduceScene(paused, null, up), { ...up, up: false });
    assert.equal(before.backInFive, true);
    const after = reduceScene(paused, before, { ...up, up: false, now: NOW + 61_000 });
    assert.equal(after.dark, true);
    assert.equal(after.backInFive, false);
    assert.ok(after.cubicles.every((c) => !c.doNotDisturb));
    assert.equal(after.queueRoom.countdownMs, null);
  });

  it('is dark with an empty floor when the runner was never seen', () => {
    const scene = reduceScene(null, null, { ...up, up: false });
    assert.equal(scene.dark, true);
    assert.deepEqual(scene.cubicles, []);
  });

  it('hangs BACK IN 5 on the door during a general pause, until it ends', () => {
    const paused = snap({ pauses: { restart: null, general: pause(60_000), workspaces: [] } });
    assert.equal(reduceScene(paused, null, up).backInFive, true);
    // expired, though the next snapshot hasn't said so yet
    assert.equal(reduceScene(paused, null, { ...up, now: NOW + 61_000 }).backInFive, false);
    assert.equal(reduceScene(snap(), reduceScene(paused, null, up), up).backInFive, false);
  });

  it('hangs Do not disturb on a paused workspace, until it ends', () => {
    const paused = snap({ pauses: { restart: null, general: null, workspaces: [{ alias: 'chess-trainer', ...pause(60_000) }] } });
    const dnd = (scene) => scene.cubicles.filter((c) => c.doNotDisturb).map((c) => c.alias);
    assert.deepEqual(dnd(reduceScene(paused, null, up)), ['chess-trainer']);
    assert.deepEqual(dnd(reduceScene(paused, null, { ...up, now: NOW + 61_000 })), []);
    assert.deepEqual(dnd(reduceScene(snap(), reduceScene(paused, null, up), up)), []);
  });
});

describe('office scene: queue room', () => {
  const cron = (over = {}) => ({ alive: true, pid: 1, intervalMs: 600_000, lastTickStartedAt: iso(-60_000), lastTickEndedAt: iso(-50_000), outcome: null, nextTickAt: iso(540_000), ...over });

  it("counts down to the feed's next cron tick", () => {
    assert.equal(reduceScene(snap({ cron: cron() }), null, up).queueRoom.countdownMs, 540_000);
    assert.equal(reduceScene(snap({ cron: cron() }), null, { ...up, now: NOW + 40_000 }).queueRoom.countdownMs, 500_000);
  });

  it('holds at zero once the tick is due', () => {
    assert.equal(reduceScene(snap({ cron: cron({ nextTickAt: iso(-5_000) }) }), null, up).queueRoom.countdownMs, 0);
  });

  it('hides the countdown when the cron is off, dead or has no next tick', () => {
    for (const c of [null, cron({ alive: false, nextTickAt: null }), cron({ nextTickAt: null })]) {
      assert.equal(reduceScene(snap({ cron: c }), null, up).queueRoom.countdownMs, null, JSON.stringify(c));
    }
  });

  it('puts one letter on the mail cart per queued request, oldest first', () => {
    const queue = [
      { id: 'q1', kind: 'freeform', label: 'say hi', queuedAt: iso(-2000) },
      { id: 'q2', kind: 'issue', label: 'issue bot#7', queuedAt: iso(-1000) },
    ];
    assert.deepEqual(reduceScene(snap({ queue }), null, up).queueRoom.letters, [
      { id: 'q1', label: 'say hi' },
      { id: 'q2', label: 'issue bot#7' },
    ]);
    assert.deepEqual(reduceScene(snap(), null, up).queueRoom.letters, []);
  });
});

/** An OfficeRun, `over` on top. @returns {any} */
function run(over = {}) {
  return {
    runId: 'r1',
    kind: 'issue',
    trigger: 'manual',
    label: 'issue dots#7',
    workspaceAlias: 'dots',
    issueNumber: 7,
    room: null,
    health: 'running',
    phase: 'agent',
    model: 'claude-x',
    turns: 0,
    outputTokens: 0,
    contextTokens: 0,
    lastActivity: null,
    startedAt: iso(-1_000),
    elapsedMs: 1_000,
    agentPid: 42,
    ...over,
  };
}

const running = (over = {}) => {
  const r = run(over);
  return snap({ activeRun: r, active: [r] });
};

/** Reduce a sequence of snapshots, each at its `now`, returning every scene. @param {Array<[any, number]>} steps */
function play(steps) {
  const scenes = [];
  let prev = null;
  for (const [s, now] of steps) scenes.push((prev = reduceScene(s, prev, { ...up, now })));
  return scenes;
}

describe('office scene: a run starting', () => {
  it('puts the worker in the right room, delivered the right way, for each trigger and kind', () => {
    const cases = [
      [{ kind: 'issue', trigger: 'cron', workspaceAlias: 'chess-trainer' }, { room: 'cubicle', alias: 'chess-trainer' }, 'envelope'],
      [{ kind: 'issue', trigger: 'manual', workspaceAlias: 'dots' }, { room: 'cubicle', alias: 'dots' }, 'phone'],
      [{ kind: 'freeform', trigger: 'manual', workspaceAlias: null, issueNumber: null }, { room: 'freeform' }, 'phone'],
      [{ kind: 'joplin', trigger: 'manual', workspaceAlias: null, issueNumber: null }, { room: 'joplin' }, 'phone'],
    ];
    for (const [over, place, by] of cases) {
      const scene = reduceScene(running(over), null, up);
      assert.deepEqual(scene.run?.place, place, JSON.stringify(over));
      assert.equal(scene.run?.delivery.by, by, JSON.stringify(over));
    }
  });

  it("times the delivery from the run's start, so a page opened mid-run doesn't replay it", () => {
    const scene = reduceScene(running({ startedAt: iso(-600_000), elapsedMs: 600_000 }), null, up);
    assert.equal(scene.run?.delivery.at, NOW - 600_000);
  });

  it('sends an issue run for a workspace without a cubicle to the Freeform room', () => {
    assert.deepEqual(reduceScene(running({ workspaceAlias: 'gone' }), null, up).run?.place, { room: 'freeform' });
  });

  it('has no worker while idle', () => {
    assert.equal(reduceScene(snap(), null, up).run, null);
  });

  it('keeps the worker in place while the runner is down', () => {
    const lit = reduceScene(running(), null, up);
    const dark = reduceScene(running(), lit, { ...up, up: false });
    assert.equal(dark.dark, true);
    assert.deepEqual(dark.run?.place, lit.run?.place);
  });
});

describe('office scene: a freeform run finding its workspace', () => {
  const freeform = (over = {}) => running({ kind: 'freeform', workspaceAlias: null, issueNumber: null, inferredWorkspace: null, ...over });

  it('starts in the Freeform room, then picks up their papers and walks to the cubicle once it is inferred', () => {
    const [before, after, later] = play([
      [freeform({ turns: 10 }), NOW],
      [freeform({ turns: 12, inferredWorkspace: 'bot' }), NOW + 5_000],
      [freeform({ turns: 15, inferredWorkspace: 'bot' }), NOW + 9_000],
    ]);
    assert.deepEqual(before.run?.place, { room: 'freeform' });
    assert.equal(before.run?.moved, null);
    assert.deepEqual(after.run?.place, { room: 'cubicle', alias: 'bot' });
    assert.deepEqual(after.run?.moved, { from: { room: 'freeform' }, since: NOW + 5_000 });
    // the walk keeps its start, and the pile comes along
    assert.deepEqual(later.run?.moved, after.run?.moved);
    assert.equal(after.run?.pile, before.run?.pile);
  });

  it('stays in the Freeform room while no workspace is inferred, or its workspace has no cubicle', () => {
    assert.deepEqual(reduceScene(freeform(), null, up).run?.place, { room: 'freeform' });
    assert.deepEqual(reduceScene(freeform({ inferredWorkspace: 'gone' }), null, up).run?.place, { room: 'freeform' });
  });

  it("sits straight at the cubicle when the page opens after the move (no walk it didn't see)", () => {
    const scene = reduceScene(freeform({ inferredWorkspace: 'dots' }), null, up);
    assert.deepEqual(scene.run?.place, { room: 'cubicle', alias: 'dots' });
    assert.equal(scene.run?.moved, null);
  });

  it("clears the cubicle's last outcome, and puts the run's own outcome there when it ends", () => {
    const history = [row({ runId: 'b1', workspaceAlias: 'bot', result: 'merged' })];
    const working = reduceScene(snap({ ...freeform({ inferredWorkspace: 'bot' }), history }), null, up);
    assert.deepEqual(working.outcomes, []);
    const ended = reduceScene(snap({ history: [row({ runId: 'f1', kind: 'freeform', workspaceAlias: null, issueNumber: null, inferredWorkspace: 'bot', result: null, prUrl: null }), ...history] }), working, up);
    assert.deepEqual(
      ended.outcomes.map((o) => [o.place, o.runId]),
      [[{ room: 'cubicle', alias: 'bot' }, 'f1']]
    );
  });
});

describe('office scene: working', () => {
  it('types at the desk during the agent phase, with the last activity in a speech bubble', () => {
    const scene = reduceScene(running({ lastActivity: 'Bash: npm test' }), null, up);
    assert.equal(scene.run?.work, 'typing');
    assert.equal(scene.run?.bubble, 'Bash: npm test');
  });

  it('shortens the bubble and tidies it for the pixel font', () => {
    const long = `Bash: ${'x'.repeat(200)}`;
    const bubble = reduceScene(running({ lastActivity: long }), null, up).run?.bubble ?? '';
    assert.ok(bubble.length <= 48 && bubble.endsWith('...'), bubble);
    assert.equal(reduceScene(running({ lastActivity: 'writing…' }), null, up).run?.bubble, 'writing...');
    assert.equal(reduceScene(running({ lastActivity: 'Bash: a\n  b' }), null, up).run?.bubble, 'Bash: a b');
    assert.equal(reduceScene(running({ lastActivity: null }), null, up).run?.bubble, null);
  });

  it('grows the paper pile with turns and elapsed time', () => {
    const pile = (over, now = NOW) => reduceScene(running(over), null, { ...up, now }).run?.pile ?? -1;
    assert.equal(pile({ turns: 0, elapsedMs: 0 }), 0);
    assert.ok(pile({ turns: 20, elapsedMs: 0 }) > pile({ turns: 5, elapsedMs: 0 }));
    assert.ok(pile({ turns: 0, elapsedMs: 20 * 60_000 }) > pile({ turns: 0, elapsedMs: 60_000 }));
    // only the snapshot's own progress counts: a stale snapshot doesn't grow the pile on redraw
    assert.equal(pile({ turns: 0, elapsedMs: 0 }, NOW + 20 * 60_000), 0);
  });

  it('caps the pile, so a very long run is visibly high but stays on the desk', () => {
    const top = reduceScene(running({ turns: 10_000, elapsedMs: 10 * 3_600_000 }), null, up).run?.pile ?? 0;
    assert.equal(top, PILE_MAX);
    assert.ok(reduceScene(running({ turns: 40, elapsedMs: 40 * 60_000 }), null, up).run?.pile >= PILE_MAX / 2);
  });

  it("never shrinks the pile during a run (the autofix pass counts its turns from zero), and starts a new run's from scratch", () => {
    const [a, b, c] = play([
      [running({ turns: 30, elapsedMs: 0 }), NOW],
      [running({ turns: 1, elapsedMs: 0 }), NOW],
      [running({ runId: 'r2', turns: 1, elapsedMs: 0 }), NOW],
    ]);
    assert.ok(a.run.pile > 0);
    assert.equal(b.run.pile, a.run.pile);
    assert.equal(c.run.pile, 0);
  });
});

describe('office scene: post-run', () => {
  const agent = running({ phase: 'agent', lastActivity: 'Edit: a.js' });
  const post = running({ phase: 'post-run', lastActivity: 'Edit: a.js' });
  const autofix = running({ phase: 'agent', lastActivity: 'Edit: b.js' });

  it("brings the boss to the worker's desk for the review, and hides the bubble", () => {
    const [a, b] = play([
      [agent, NOW],
      [post, NOW + 5_000],
    ]);
    assert.equal(a.boss.at, null);
    assert.equal(b.run.work, 'reviewed');
    assert.equal(b.run.bubble, null);
    assert.deepEqual(b.boss, { at: { room: 'cubicle', alias: 'dots' }, from: null, since: NOW + 5_000 });
  });

  it('has the worker scribble during the autofix, with the boss still watching', () => {
    const [, b, c] = play([
      [agent, NOW],
      [post, NOW + 5_000],
      [autofix, NOW + 9_000],
    ]);
    assert.equal(c.run.work, 'scribbling');
    assert.equal(c.run.bubble, 'Edit: b.js');
    // the boss doesn't walk in again
    assert.deepEqual(c.boss, b.boss);
  });

  it('sends the boss back to their office when the run ends', () => {
    const [, , c] = play([
      [agent, NOW],
      [post, NOW + 5_000],
      [snap(), NOW + 20_000],
    ]);
    assert.equal(c.run, null);
    assert.deepEqual(c.boss, { at: null, from: { room: 'cubicle', alias: 'dots' }, since: NOW + 20_000 });
  });

  it('sends the boss back when the next run starts straight away', () => {
    const [, , c] = play([
      [agent, NOW],
      [post, NOW + 5_000],
      [running({ runId: 'r2', kind: 'freeform', workspaceAlias: null }), NOW + 20_000],
    ]);
    assert.equal(c.run.work, 'typing');
    assert.deepEqual(c.boss, { at: null, from: { room: 'cubicle', alias: 'dots' }, since: NOW + 20_000 });
  });

  it("puts the boss straight at the desk when the page opens mid-review (no walk it didn't see)", () => {
    const scene = reduceScene(post, reduceScene(null, null, { ...up, up: false }), up);
    assert.deepEqual(scene.boss, { at: { room: 'cubicle', alias: 'dots' }, from: null, since: 0 });
  });

  it("keeps the boss in their office through a freeform or Joplin run's post-run (it has no review)", () => {
    for (const kind of ['freeform', 'joplin']) {
      const other = { kind, workspaceAlias: null, issueNumber: null };
      const scenes = play([
        [running(other), NOW],
        [running({ ...other, phase: 'post-run' }), NOW + 5_000],
        [snap(), NOW + 9_000],
      ]);
      for (const s of scenes) assert.deepEqual(s.boss, { at: null, from: null, since: 0 }, kind);
      assert.equal(scenes[1].run.work, 'typing', kind);
    }
  });
});

/** A finished run, as the office feed's history carries it. @returns {any} */
const row = (over = {}) => ({
  runId: 'h1',
  kind: 'issue',
  trigger: 'cron',
  label: 'issue bot#3',
  workspaceAlias: 'bot',
  issueNumber: 3,
  room: null,
  startedAt: iso(-20 * 60_000),
  endedAt: iso(-60_000),
  durationMs: 19 * 60_000,
  outcome: 'success',
  result: 'merged',
  prUrl: 'https://github.com/o/bot/pull/9',
  model: null,
  turns: 10,
  costUsd: 1,
  tokens: 100,
  ...over,
});

describe('office scene: outcomes', () => {
  it('maps every outcome and result the runner records to a resting state', () => {
    const cases = [
      [{ outcome: 'success', result: 'merged' }, 'stamped'],
      [{ outcome: 'success', result: 'pr_open' }, 'folder'],
      [{ outcome: 'success', result: 'pushed' }, 'folder'],
      [{ outcome: 'success', result: 'no_changes' }, 'shrug'],
      [{ outcome: 'success', result: 'failed' }, 'injured'],
      [{ outcome: 'timeout', result: 'timeout' }, 'asleep'],
      [{ outcome: 'failed', result: 'failed' }, 'injured'],
      [{ outcome: 'spawn_error', result: 'failed' }, 'injured'],
      [{ outcome: 'stopped', result: 'failed' }, 'home'],
      [{ outcome: 'limited', result: 'failed' }, 'asleep'],
      [{ outcome: 'limited', result: 'limited' }, 'asleep'],
      [{ outcome: 'interrupted', result: null }, 'dizzy'],
      // freeform, Joplin and scheduled jobs have no pipeline result
      [{ outcome: 'success', result: null }, 'stamped'],
      [{ outcome: 'failed', result: null }, 'injured'],
      [{ outcome: 'spawn_error', result: null }, 'injured'],
      [{ outcome: 'timeout', result: null }, 'asleep'],
      [{ outcome: 'stopped', result: null }, 'home'],
      [{ outcome: 'limited', result: null }, 'asleep'],
      // something newer than this page: neutral
      [{ outcome: 'success', result: 'launched' }, 'idle'],
      [{ outcome: 'exploded', result: null }, 'idle'],
    ];
    for (const [over, state] of cases) assert.equal(restingState(row(over)), state, JSON.stringify(over));
  });

  it("puts each room's latest run in it, and nothing where no run has ended", () => {
    const history = [
      row({ runId: 'b2', workspaceAlias: 'bot', result: 'no_changes' }),
      row({ runId: 'b1', workspaceAlias: 'bot', result: 'merged', endedAt: iso(-3_600_000) }),
      row({ runId: 'f1', kind: 'freeform', workspaceAlias: null, issueNumber: null, result: null, outcome: 'timeout', prUrl: null }),
      row({ runId: 'j1', kind: 'joplin', workspaceAlias: null, issueNumber: null, result: null, outcome: 'stopped', prUrl: null }),
      row({ runId: 's1', kind: 'job', trigger: 'schedule', workspaceAlias: null, room: 'dots', result: null }),
    ];
    const scene = reduceScene(snap({ history }), null, up);
    assert.deepEqual(
      scene.outcomes.map((o) => [o.place, o.runId, o.state]),
      [
        [{ room: 'cubicle', alias: 'bot' }, 'b2', 'shrug'],
        [{ room: 'freeform' }, 'f1', 'asleep'],
        [{ room: 'joplin' }, 'j1', 'home'],
      ]
    );
  });

  it('carries what the hover shows: the outcome, when it ended and the PR link', () => {
    const [o] = reduceScene(snap({ history: [row({ result: 'pr_open' })] }), null, up).outcomes;
    assert.equal(o.label, 'issue bot#3');
    assert.equal(o.outcome, 'PR open');
    assert.equal(o.recorded, 'success, pr_open');
    assert.equal(o.endedAt, NOW - 60_000);
    assert.equal(o.prUrl, 'https://github.com/o/bot/pull/9');
  });

  it('describes every state for the hover, with the raw outcome for the fallback', () => {
    assert.equal(reduceScene(snap({ history: [row()] }), null, up).outcomes[0].outcome, 'merged');
    assert.equal(reduceScene(snap({ history: [row({ outcome: 'interrupted', result: null })] }), null, up).outcomes[0].outcome, 'interrupted by a restart');
    assert.equal(reduceScene(snap({ history: [row({ outcome: 'exploded', result: null })] }), null, up).outcomes[0].outcome, 'exploded');
  });

  it('keeps the recorded outcome and result apart from the words, so rows sharing a state differ', () => {
    const [pushed] = reduceScene(snap({ history: [row({ result: 'pushed' })] }), null, up).outcomes;
    const [open] = reduceScene(snap({ history: [row({ result: 'pr_open' })] }), null, up).outcomes;
    assert.equal(pushed.state, open.state);
    assert.equal(pushed.recorded, 'success, pushed');
    assert.equal(open.recorded, 'success, pr_open');
    assert.equal(reduceScene(snap({ history: [row({ outcome: 'stopped', result: null })] }), null, up).outcomes[0].recorded, 'stopped');
  });

  it('stamps a short run quickly, and a long one with papers to the out tray', () => {
    const quick = reduceScene(snap({ history: [row({ durationMs: 60_000 })] }), null, up).outcomes[0];
    const long = reduceScene(snap({ history: [row()] }), null, up).outcomes[0];
    assert.equal(quick.quick, true);
    assert.equal(long.quick, false);
  });

  it('clears a room once its next run starts there, and keeps the others', () => {
    const history = [row({ runId: 'b1' }), row({ runId: 'c1', workspaceAlias: 'chess-trainer', result: 'pr_open' })];
    const scene = reduceScene(snap({ ...running({ workspaceAlias: 'bot' }), history }), null, up);
    assert.deepEqual(
      scene.outcomes.map((o) => o.runId),
      ['c1']
    );
  });

  it('shows the last outcomes after a reload and while the runner is down', () => {
    const history = [row()];
    const fresh = reduceScene(snap({ history }), null, up);
    assert.equal(fresh.outcomes.length, 1);
    const dark = reduceScene(snap({ history }), fresh, { ...up, up: false });
    assert.equal(dark.outcomes.length, 1);
  });

  it('puts an issue run whose workspace has no cubicle in the Freeform room', () => {
    const [o] = reduceScene(snap({ history: [row({ workspaceAlias: 'gone' })] }), null, up).outcomes;
    assert.deepEqual(o.place, { room: 'freeform' });
  });
});

describe('office scene: pending issues', () => {
  const item = (number) => ({ number, title: `Task ${number}`, url: `https://github.com/o/bot/issues/${number}` });
  /** @param {string} alias @param {any} over */
  const repo = (alias, over = {}) => ({
    alias,
    repo: `o/${alias}`,
    scannedAt: iso(-60_000),
    stale: false,
    runnable: [],
    blocked: [],
    parked: [],
    readyForHuman: [],
    needsTriage: 0,
    needsInfo: 0,
    ...over,
  });
  const issues = (...repos) => ({ scannedAt: iso(-60_000), repos });

  it('puts runnable issues in the cubicle in-tray, then blocked ones with a padlock', () => {
    const scene = reduceScene(snap({ issues: issues(repo('bot', { runnable: [item(3), item(8)], blocked: [item(5)] })) }), null, up);
    assert.deepEqual(scene.cubicles[0].inTray, [
      { number: 3, title: 'Task 3', blocked: false },
      { number: 8, title: 'Task 8', blocked: false },
      { number: 5, title: 'Task 5', blocked: true },
    ]);
    assert.deepEqual(scene.cubicles[1].inTray, []);
  });

  it('puts ready-for-human issues on a sticky note, and leaves triage counts out of the scene', () => {
    const scene = reduceScene(snap({ issues: issues(repo('dots', { readyForHuman: [item(4)], needsTriage: 3, needsInfo: 1 })) }), null, up);
    const dots = scene.cubicles.find((c) => c.alias === 'dots');
    assert.deepEqual(dots?.sticky, [{ number: 4, title: 'Task 4' }]);
    assert.deepEqual(dots?.inTray, []);
  });

  it("puts each parked PR on the boss's desk", () => {
    const parked = { ...item(5), prUrl: 'https://github.com/o/bot/pull/9' };
    const scene = reduceScene(snap({ issues: issues(repo('bot', { parked: [parked] })) }), null, up);
    assert.deepEqual(scene.parked, [{ alias: 'bot', number: 5, title: 'Task 5', prUrl: 'https://github.com/o/bot/pull/9' }]);
  });

  it("takes the issue being worked out of its cubicle's in-tray", () => {
    const activeRun = { runId: 'r1', kind: 'issue', trigger: 'cron', label: 'x', workspaceAlias: 'bot', inferredWorkspace: null, issueNumber: 3, room: null, health: 'running', phase: 'agent', turns: 0, elapsedMs: 0, lastActivity: null, startedAt: iso(-1000) };
    const scene = reduceScene(snap({ activeRun, active: [activeRun], issues: issues(repo('bot', { runnable: [item(3), item(8)] })) }), null, up);
    assert.deepEqual(scene.cubicles[0].inTray.map((l) => l.number), [8]);
  });

  it('shows nothing before the first scan, and keeps stale data on show', () => {
    const none = reduceScene(snap(), null, up);
    assert.deepEqual(none.cubicles.map((c) => [c.inTray, c.sticky]), [[[], []], [[], []], [[], []]]);
    assert.deepEqual(none.parked, []);
    const stale = reduceScene(snap({ issues: issues(repo('bot', { stale: true, runnable: [item(1)] })) }), null, up);
    assert.equal(stale.cubicles[0].inTray.length, 1);
  });

  describe('mail', () => {
    const tray = (bot = [], dots = []) => snap({ issues: issues(repo('bot', { runnable: bot.map(item) }), repo('dots', { runnable: dots.map(item) })) });

    it("hands out nothing the page found when it opened, nor before the first scan", () => {
      const [none, first, again] = play([
        [snap(), NOW],
        [tray([1, 2], [3]), NOW + 1000],
        [tray([1, 2], [3]), NOW + 2000],
      ]);
      assert.deepEqual([none.mail, none.trayKnown], [[], null]);
      assert.deepEqual(first.mail, []);
      assert.deepEqual(first.trayKnown, { bot: [1, 2], 'chess-trainer': [], dots: [3] });
      assert.deepEqual(again.mail, []);
    });

    it('makes a round of the letters that turn up, by cubicle in order, and keeps it MAIL_KEEP_MS', () => {
      const [, round, later, gone] = play([
        [tray([1], []), NOW],
        [tray([1, 4], [5, 6]), NOW + 1000],
        [tray([1, 4], [5, 6]), NOW + 2000],
        [tray([1, 4], [5, 6]), NOW + 1000 + MAIL_KEEP_MS],
      ]);
      assert.deepEqual(round.mail, [{ id: `mail-${NOW + 1000}`, at: NOW + 1000, drops: [{ alias: 'bot', numbers: [4] }, { alias: 'dots', numbers: [5, 6] }] }]);
      assert.deepEqual(later.mail, round.mail, 'one round, not one a scene');
      assert.deepEqual(gone.mail, []);
    });

    it('makes a new round for each new batch', () => {
      const scenes = play([
        [tray([1]), NOW],
        [tray([1, 2]), NOW + 1000],
        [tray([1, 2, 3]), NOW + 5000],
      ]);
      assert.deepEqual(scenes[2].mail.map((m) => m.drops), [[{ alias: 'bot', numbers: [2] }], [{ alias: 'bot', numbers: [3] }]]);
    });

    it("doesn't hand out a letter coming back from the desk, or one blocked or unblocked", () => {
      const working = { ...tray([1]), activeRun: run({ workspaceAlias: 'bot', issueNumber: 9 }), active: [run({ workspaceAlias: 'bot', issueNumber: 9 })] };
      const blocked = snap({ issues: issues(repo('bot', { runnable: [item(1)], blocked: [item(9)] }), repo('dots')) });
      const scenes = play([
        [working, NOW],
        [tray([1, 9]), NOW + 1000],
        [blocked, NOW + 2000],
      ]);
      assert.deepEqual(scenes.map((sc) => sc.mail), [[], [], []]);
    });
  });
});

describe('office scene: subagent helpers', () => {
  const sub = (id, activity = null) => ({ id, description: `Task ${id}`, type: 'general-purpose', activity });
  const withSubs = (...subagents) => running({ subagents });

  it('calls a colleague over for each subagent, in the lowest free slot', () => {
    const [, one, two, three] = play([
      [running(), NOW],
      [withSubs(sub('a')), NOW + 1000],
      [withSubs(sub('a', 'Bash: ls'), sub('b')), NOW + 2000],
      [withSubs(sub('b')), NOW + 3000],
    ]);
    assert.deepEqual(one.helpers, [{ id: 'a', description: 'Task a', activity: null, slot: 0, place: { room: 'cubicle', alias: 'dots' }, since: NOW + 1000, until: null }]);
    assert.deepEqual(two.helpers.map((h) => [h.id, h.slot, h.activity]), [['a', 0, 'Bash: ls'], ['b', 1, null]]);
    // a's done: it walks back in its slot, and b keeps its own
    assert.deepEqual(three.helpers.map((h) => [h.id, h.slot, h.until]), [['a', 0, NOW + 3000], ['b', 1, null]]);
  });

  it('keeps a done one for its walk back, then lets the slot go', () => {
    const scenes = play([
      [withSubs(sub('a')), NOW],
      [withSubs(sub('a')), NOW + 1000],
      [running(), NOW + 2000],
      [withSubs(sub('c')), NOW + 3000],
      [withSubs(sub('c')), NOW + 2000 + HELPER_KEEP_MS],
    ]);
    assert.deepEqual(scenes[3].helpers.map((h) => [h.id, h.slot]), [['a', 0], ['c', 1]], 'a still walking back');
    assert.deepEqual(scenes[4].helpers.map((h) => h.id), ['c']);
  });

  it('has those already helping when the page opens already there', () => {
    assert.equal(reduceScene(withSubs(sub('a')), null, up).helpers[0].since, 0);
  });

  it('sends everyone back when the run moves on to post-run or ends', () => {
    const [, post] = play([
      [withSubs(sub('a')), NOW],
      [running({ phase: 'post-run', subagents: [sub('a')] }), NOW + 1000],
    ]);
    assert.equal(post.helpers[0].until, NOW + 1000);
    const [, ended] = play([
      [withSubs(sub('a')), NOW],
      [snap(), NOW + 1000],
    ]);
    assert.equal(ended.helpers[0].until, NOW + 1000);
  });
});

describe('office scene: scheduled jobs', () => {
  const RA = 'Research & Archives';
  const jobs = [
    { name: 'cleanup_agent', room: RA, at: '02:00', nextDueAt: iso(3_600_000) },
    { name: 'report_agent', room: RA, at: '02:30', nextDueAt: iso(5_400_000) },
    { name: 'backup', room: 'bot', at: '03:00', nextDueAt: iso(7_200_000) },
  ];
  /** A running job: `over` on top of an OfficeRun. */
  const jobRun = (over = {}) => ({
    ...run({ runId: 'j1', kind: 'job', trigger: 'schedule', label: 'scheduled job cleanup_agent', workspaceAlias: null, issueNumber: null, room: RA, jobName: 'cleanup_agent', phase: 'job', model: null, ...over }),
  });
  const jobSnap = (over = {}) => snap({ jobs, ...over });
  const runningJob = (over = {}) => {
    const r = jobRun(over);
    return jobSnap({ activeRun: r, active: [r] });
  };

  it('gives each job room a cubicle after the workspaces, with a desk per job, even if it is no workspace', () => {
    const scene = reduceScene(jobSnap(), null, up);
    assert.deepEqual(
      scene.cubicles.map((c) => [c.alias, c.name, c.workspace, c.jobs.map((j) => j.name)]),
      [
        ['bot', 'bot', true, []],
        ['chess-trainer', 'chess-trainer', true, []],
        ['dots', 'dots', true, []],
        [RA, RA, false, ['cleanup_agent', 'report_agent']],
        ['bot#scripts', 'bot scripts', false, ['backup']],
      ]
    );
  });

  it("puts a room's clerk jobs (plain scripts) in a scripts room of its own, after the job rooms", () => {
    const at = (name) => ({ name, room: RA, at: '02:00', nextDueAt: iso(1000) });
    const scene = reduceScene(snap({ jobs: [at('cleanup_agent'), at('dashboard_export'), at('report_agent'), at('cron_digest')] }), null, up);
    assert.deepEqual(scene.cubicles.slice(3).map((c) => [c.alias, c.name, c.workspace, c.jobs.map((j) => j.name)]), [
      [RA, RA, false, ['cleanup_agent', 'report_agent']],
      [`${RA}#scripts`, `${RA} scripts`, false, ['dashboard_export', 'cron_digest']],
    ]);
    // a room with only scripts gets no empty cubicle of its own
    const only = reduceScene(snap({ jobs: [at('cron_digest')] }), null, up);
    assert.deepEqual(only.cubicles.slice(3).map((c) => c.alias), [`${RA}#scripts`]);
    // and a script runs at its desk there
    const r = run({ runId: 'j2', kind: 'job', trigger: 'schedule', label: 'scheduled job cron_digest', workspaceAlias: null, issueNumber: null, room: RA, jobName: 'cron_digest', phase: 'job', model: null });
    const running = reduceScene(snap({ jobs: [at('cron_digest')], activeRun: r, active: [r] }), null, up);
    assert.deepEqual(running.run?.place, { room: 'cubicle', alias: `${RA}#scripts`, job: 'cron_digest' });
  });

  it("puts a job room named after a workspace's department sign in that workspace's cubicle", () => {
    const config = { cubicles: [{ alias: 'dots', name: 'Sales' }] };
    const scene = reduceScene(snap({ jobs: [{ name: 'report_agent', room: 'Sales', at: '02:30', nextDueAt: iso(1000) }] }), null, { ...up, config });
    assert.deepEqual(scene.cubicles.map((c) => [c.alias, c.jobs.map((j) => j.name)]), [
      ['dots', ['report_agent']],
      ['bot', []],
      ['chess-trainer', []],
    ]);
  });

  it('gives each job its own worker: a janitor for cleanup, an analyst for insight or report, else a clerk', () => {
    assert.equal(jobWorker('cleanup_agent'), 'janitor');
    assert.equal(jobWorker('report_agent'), 'analyst');
    assert.equal(jobWorker('weekly-insight'), 'analyst');
    assert.equal(jobWorker('backup'), 'clerk');
    const ra = reduceScene(jobSnap(), null, up).cubicles[3];
    assert.deepEqual(ra.jobs, [
      { name: 'cleanup_agent', worker: 'janitor', at: '02:00', nextDueAt: NOW + 3_600_000 },
      { name: 'report_agent', worker: 'analyst', at: '02:30', nextDueAt: NOW + 5_400_000 },
    ]);
  });

  it('has no job rooms when there are no jobs, or the feed is older than the job config', () => {
    assert.ok(reduceScene(snap(), null, up).cubicles.every((c) => c.workspace && !c.jobs.length));
    assert.equal(reduceScene(snap({ jobs: undefined }), null, up).cubicles.length, 3);
  });

  it("delivers a due job by envelope to its worker's desk in its room", () => {
    const scene = reduceScene(runningJob(), null, up);
    assert.deepEqual(scene.run?.place, { room: 'cubicle', alias: RA, job: 'cleanup_agent' });
    assert.equal(scene.run?.delivery.by, 'envelope');
    assert.equal(scene.run?.worker, 'janitor');
    assert.equal(scene.run?.work, 'typing');
  });

  it('puts a queued job on the mail cart as a letter', () => {
    const queue = [{ id: 'q1', kind: 'job', label: 'scheduled job report_agent', queuedAt: iso(-1000) }];
    assert.deepEqual(reduceScene(jobSnap({ queue }), null, up).queueRoom.letters, [{ id: 'q1', label: 'scheduled job report_agent' }]);
  });

  it('grows the pile with elapsed time alone (a job has no turns)', () => {
    const [a, b] = play([
      [runningJob({ elapsedMs: 0 }), NOW],
      [runningJob({ elapsedMs: 9 * 60_000 }), NOW + 9 * 60_000],
    ]);
    assert.equal(a.run?.pile, 0);
    assert.equal(b.run?.pile, 3);
  });

  it("shows the latest line of the job's output in the bubble, from its live log", () => {
    const log = { runId: 'j1', lines: ['Starting cleanup', 'Deleted 12 rows', '  '] };
    const scene = reduceScene(runningJob(), null, { ...up, log });
    assert.equal(scene.run?.bubble, 'Deleted 12 rows');
    assert.equal(scene.run?.activity, 'Deleted 12 rows');
    // another run's log (the last one's, before this one's arrives) says nothing
    assert.equal(reduceScene(runningJob(), null, { ...up, log: { runId: 'old', lines: ['old news'] } }).run?.bubble, null);
    assert.equal(reduceScene(runningJob(), null, up).run?.bubble, null);
  });

  it('puts a job whose config is gone in the Freeform room', () => {
    const scene = reduceScene(runningJob({ jobName: 'retired', room: 'Nowhere' }), null, up);
    assert.deepEqual(scene.run?.place, { room: 'freeform' });
    assert.equal(scene.run?.worker, 'clerk');
  });

  it("keeps each job room's last outcome, in the shared states, at the job's desk", () => {
    const job = (over) => row({ kind: 'job', trigger: 'schedule', workspaceAlias: null, issueNumber: null, room: RA, result: null, prUrl: null, ...over });
    const cases = [
      ['success', 'stamped'],
      ['failed', 'injured'],
      ['stopped', 'home'],
      ['interrupted', 'dizzy'],
      ['timeout', 'asleep'],
    ];
    for (const [outcome, state] of cases) {
      const [o] = reduceScene(jobSnap({ history: [job({ jobName: 'report_agent', outcome })] }), null, up).outcomes;
      assert.deepEqual([o.place, o.state], [{ room: 'cubicle', alias: RA, job: 'report_agent' }, state], outcome);
    }
    // one outcome per room: its latest run's, whichever job it was
    const history = [job({ runId: 'c2', jobName: 'cleanup_agent', outcome: 'failed' }), job({ runId: 'r1', jobName: 'report_agent' })];
    assert.deepEqual(
      reduceScene(jobSnap({ history }), null, up).outcomes.map((o) => o.runId),
      ['c2']
    );
  });

  it("clears the room's last outcome while a job runs there", () => {
    const history = [row({ kind: 'job', trigger: 'schedule', workspaceAlias: null, issueNumber: null, room: RA, jobName: 'report_agent', result: null, prUrl: null })];
    const r = jobRun();
    assert.deepEqual(reduceScene(jobSnap({ activeRun: r, active: [r], history }), null, up).outcomes, []);
  });

  it('never brings the boss over for a job', () => {
    const scenes = play([
      [runningJob(), NOW],
      [jobSnap(), NOW + 5_000],
    ]);
    for (const sc of scenes) assert.equal(sc.boss.at, null);
  });
});
