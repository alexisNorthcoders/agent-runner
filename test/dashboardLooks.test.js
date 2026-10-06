import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HAIRS, SHIRTS, SKINS, STYLES, TEMPS, lookKey, looksFor, workerKeys } from '../dashboard/looks.js';

const aliases = ['agent-runner', 'bot', 'chess-trainer', 'dots', 'go-server', 'home-manuals', 'platformer', 'reddit-bot', 'reply-buddy', 'snake-colyseus', 'snake-lab', 'snake-phaser'];
const cubicles = [
  ...aliases.map((alias) => ({ alias, workspace: true, jobs: alias === 'reddit-bot' ? ['cleanup_agent', 'report_agent', 'insight_week', 'insight_month'].map((name) => ({ name })) : [] })),
  { alias: 'reddit-bot#scripts', workspace: false, jobs: [{ name: 'dashboard_export' }, { name: 'cron_digest' }] },
];

describe('worker looks', () => {
  it('has a worker for each resident, each job, the Freeform and Joplin rooms, and the temps', () => {
    const keys = workerKeys(cubicles);
    assert.equal(keys.length, aliases.length + 6 + 2 + TEMPS);
    assert.ok(keys.includes('temp:0') && keys.includes(`temp:${TEMPS - 1}`));
    assert.ok(keys.includes('ws:bot') && keys.includes('job:cron_digest') && keys.includes('room:freeform') && keys.includes('room:joplin'));
    assert.ok(!keys.includes('ws:reddit-bot#scripts'), 'a job room has no resident');
  });

  it('gives no two workers the same shirt and hair colour', () => {
    const looks = [...looksFor(workerKeys(cubicles)).values()];
    assert.equal(new Set(looks.map((l) => `${l.shirt} ${l.hair}`)).size, looks.length);
  });

  it('stays unique however crowded the office gets, up to every combination', () => {
    const keys = Array.from({ length: SHIRTS.length * HAIRS.length }, (_, i) => `ws:repo-${i}`);
    const looks = [...looksFor(keys).values()];
    assert.equal(new Set(looks.map((l) => `${l.shirt} ${l.hair}`)).size, keys.length);
  });

  it('mixes up skin, hair style, ties, glasses and beards', () => {
    const looks = [...looksFor(Array.from({ length: 60 }, (_, i) => `ws:repo-${i}`)).values()];
    assert.ok(new Set(looks.map((l) => l.skin)).size >= SKINS.length - 1);
    assert.ok(new Set(looks.map((l) => l.style)).size >= STYLES.length - 1);
    for (const has of [(l) => l.tie, (l) => !l.tie, (l) => l.glasses, (l) => l.beard]) assert.ok(looks.some(has));
  });

  it('is the same on every page, and a newcomer leaves the others as they were unless they clash', () => {
    const keys = workerKeys(cubicles);
    assert.deepEqual(looksFor(keys), looksFor([...keys].reverse()));
    const before = looksFor(keys);
    const after = looksFor([...keys, 'ws:newcomer']);
    const changed = keys.filter((k) => JSON.stringify(before.get(k)) !== JSON.stringify(after.get(k)));
    assert.ok(changed.length <= 1, `changed: ${changed}`);
  });

  it("dresses a place's worker as whoever works there", () => {
    assert.equal(lookKey({ room: 'cubicle', alias: 'bot' }), 'ws:bot');
    assert.equal(lookKey({ room: 'cubicle', alias: 'reddit-bot', job: 'cleanup_agent' }), 'job:cleanup_agent');
    assert.equal(lookKey({ room: 'freeform' }), 'room:freeform');
  });
});
