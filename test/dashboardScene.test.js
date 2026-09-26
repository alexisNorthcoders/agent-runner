import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PILE_MAX, reduceScene, restingState } from '../dashboard/scene.js';

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
    assert.equal(after.reception.countdownMs, null);
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

describe('office scene: reception', () => {
  const cron = (over = {}) => ({ alive: true, pid: 1, intervalMs: 600_000, lastTickStartedAt: iso(-60_000), lastTickEndedAt: iso(-50_000), outcome: null, nextTickAt: iso(540_000), ...over });

  it("counts down to the feed's next cron tick", () => {
    assert.equal(reduceScene(snap({ cron: cron() }), null, up).reception.countdownMs, 540_000);
    assert.equal(reduceScene(snap({ cron: cron() }), null, { ...up, now: NOW + 40_000 }).reception.countdownMs, 500_000);
  });

  it('holds at zero once the tick is due', () => {
    assert.equal(reduceScene(snap({ cron: cron({ nextTickAt: iso(-5_000) }) }), null, up).reception.countdownMs, 0);
  });

  it('hides the countdown when the cron is off, dead or has no next tick', () => {
    for (const c of [null, cron({ alive: false, nextTickAt: null }), cron({ nextTickAt: null })]) {
      assert.equal(reduceScene(snap({ cron: c }), null, up).reception.countdownMs, null, JSON.stringify(c));
    }
  });

  it('puts one letter on the mail cart per queued request, oldest first', () => {
    const queue = [
      { id: 'q1', kind: 'freeform', label: 'say hi', queuedAt: iso(-2000) },
      { id: 'q2', kind: 'issue', label: 'issue bot#7', queuedAt: iso(-1000) },
    ];
    assert.deepEqual(reduceScene(snap({ queue }), null, up).reception.letters, [
      { id: 'q1', label: 'say hi' },
      { id: 'q2', label: 'issue bot#7' },
    ]);
    assert.deepEqual(reduceScene(snap(), null, up).reception.letters, []);
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
      [{ kind: 'freeform', trigger: 'manual', workspaceAlias: null, issueNumber: null }, { room: 'annex' }, 'phone'],
      [{ kind: 'joplin', trigger: 'manual', workspaceAlias: null, issueNumber: null }, { room: 'library' }, 'phone'],
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

  it('sends an issue run for a workspace without a cubicle to the Annex', () => {
    assert.deepEqual(reduceScene(running({ workspaceAlias: 'gone' }), null, up).run?.place, { room: 'annex' });
  });

  it('has no worker while idle, or for a scheduled job (their rooms come later)', () => {
    assert.equal(reduceScene(snap(), null, up).run, null);
    assert.equal(reduceScene(running({ kind: 'job', trigger: 'schedule', room: 'reddit-bot', workspaceAlias: null }), null, up).run, null);
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

  it('starts in the Annex, then picks up their papers and walks to the cubicle once it is inferred', () => {
    const [before, after, later] = play([
      [freeform({ turns: 10 }), NOW],
      [freeform({ turns: 12, inferredWorkspace: 'bot' }), NOW + 5_000],
      [freeform({ turns: 15, inferredWorkspace: 'bot' }), NOW + 9_000],
    ]);
    assert.deepEqual(before.run?.place, { room: 'annex' });
    assert.equal(before.run?.moved, null);
    assert.deepEqual(after.run?.place, { room: 'cubicle', alias: 'bot' });
    assert.deepEqual(after.run?.moved, { from: { room: 'annex' }, since: NOW + 5_000 });
    // the walk keeps its start, and the pile comes along
    assert.deepEqual(later.run?.moved, after.run?.moved);
    assert.equal(after.run?.pile, before.run?.pile);
  });

  it('stays in the Annex while no workspace is inferred, or its workspace has no cubicle', () => {
    assert.deepEqual(reduceScene(freeform(), null, up).run?.place, { room: 'annex' });
    assert.deepEqual(reduceScene(freeform({ inferredWorkspace: 'gone' }), null, up).run?.place, { room: 'annex' });
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
      [{ outcome: 'interrupted', result: null }, 'dizzy'],
      // freeform, Joplin and scheduled jobs have no pipeline result
      [{ outcome: 'success', result: null }, 'stamped'],
      [{ outcome: 'failed', result: null }, 'injured'],
      [{ outcome: 'spawn_error', result: null }, 'injured'],
      [{ outcome: 'timeout', result: null }, 'asleep'],
      [{ outcome: 'stopped', result: null }, 'home'],
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
        [{ room: 'annex' }, 'f1', 'asleep'],
        [{ room: 'library' }, 'j1', 'home'],
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

  it('puts an issue run whose workspace has no cubicle in the Annex', () => {
    const [o] = reduceScene(snap({ history: [row({ workspaceAlias: 'gone' })] }), null, up).outcomes;
    assert.deepEqual(o.place, { room: 'annex' });
  });
});
