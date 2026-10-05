import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createJobScheduler, decideJobs, JOBS_LAST_FIRED_KEY, jobSchedule, loadJobsFile, nextDueAt, parseJobs } from '../src/scheduledJobs.js';
import { createOutbox, OUTBOX_KEY } from '../src/outbox.js';
import { createMemoryStore } from './helpers/memoryStore.js';

const cleanup = { name: 'cleanup_agent', room: 'reddit-bot', cwd: '/home/u/reddit-bot', command: 'npm run cleanup_agent', at: '02:00', logFile: '/home/u/reddit-bot/reports/cron-cleanup.log' };
const report = { name: 'report_agent', room: 'reddit-bot', cwd: '/home/u/reddit-bot', command: 'npm run report_agent', at: '02:30' };

const at = (iso) => Date.parse(iso);

describe('scheduled jobs: config', () => {
  it('accepts valid jobs', () => {
    const { jobs, errors } = parseJobs([cleanup, { ...report, env: { CLAUDE_AGENT_BIN: '/bin/claude' }, timeoutMinutes: 45 }]);
    assert.deepEqual(errors, []);
    assert.deepEqual(jobs, [cleanup, { ...report, env: { CLAUDE_AGENT_BIN: '/bin/claude' }, timeoutMinutes: 45 }]);
  });

  it('drops bad jobs, each with a reason, and keeps the rest', () => {
    const { jobs, errors } = parseJobs([
      cleanup,
      { ...report, at: '2:30' },
      { ...report, name: 'rel', cwd: 'reddit-bot' },
      { ...cleanup },
      { ...report, name: 'x', logFile: 'out.log' },
      { ...report, name: 'y', room: '' },
      { ...report, name: 'z', timeoutMinutes: 600 },
      'nope',
    ]);
    assert.deepEqual(jobs.map((j) => j.name), ['cleanup_agent']);
    assert.deepEqual(errors, [
      'job "report_agent": at must be HH:MM (UTC)',
      'job "rel": cwd must be an absolute path',
      'job "cleanup_agent": duplicate name',
      'job "x": logFile must be an absolute path',
      'job "y": room is required',
      'job "z": timeoutMinutes must be a number from 1 to 60',
      'job #8: not an object',
    ]);
  });

  it('reads the file: missing is no jobs, bad JSON is an error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jobs-'));
    assert.deepEqual(await loadJobsFile(join(dir, 'none.json')), { jobs: [], errors: [] });
    await writeFile(join(dir, 'bad.json'), '{');
    assert.match((await loadJobsFile(join(dir, 'bad.json'))).errors[0], /not valid JSON/);
    await writeFile(join(dir, 'ok.json'), JSON.stringify([cleanup]));
    assert.deepEqual((await loadJobsFile(join(dir, 'ok.json'))).jobs, [cleanup]);
  });
});

describe('scheduled jobs: when a job is due', () => {
  const fired = (m) => new Map(Object.entries(m));

  it('is due from its UTC time until it has fired that day', () => {
    assert.deepEqual(decideJobs([cleanup], at('2026-09-26T01:59:59Z'), fired({ cleanup_agent: '2026-09-25' })).due, []);
    assert.deepEqual(decideJobs([cleanup], at('2026-09-26T02:00:00Z'), fired({ cleanup_agent: '2026-09-25' })).due, [cleanup]);
    assert.deepEqual(decideJobs([cleanup], at('2026-09-26T13:00:00Z'), fired({ cleanup_agent: '2026-09-20' })).due, [cleanup]);
    assert.deepEqual(decideJobs([cleanup], at('2026-09-26T02:30:00Z'), fired({ cleanup_agent: '2026-09-26' })).due, []);
  });

  it('a new job is recorded without running: for today if past its time, else for yesterday', () => {
    assert.deepEqual(decideJobs([cleanup], at('2026-09-26T10:00:00Z'), fired({})), { due: [], adopt: new Map([['cleanup_agent', '2026-09-26']]) });
    assert.deepEqual(decideJobs([cleanup], at('2026-09-26T01:00:00Z'), fired({})), { due: [], adopt: new Map([['cleanup_agent', '2026-09-25']]) });
  });
});

describe('scheduled jobs: next due time', () => {
  const t = (iso) => new Date(at(iso)).toISOString();

  it("is today's time until it has fired today, then tomorrow's", () => {
    assert.equal(nextDueAt(cleanup, at('2026-09-26T01:00:00Z'), '2026-09-25'), t('2026-09-26T02:00:00Z'));
    assert.equal(nextDueAt(cleanup, at('2026-09-26T03:00:00Z'), '2026-09-26'), t('2026-09-27T02:00:00Z'));
  });

  it("stays today's (now past) while a due job waits to fire", () => {
    assert.equal(nextDueAt(cleanup, at('2026-09-26T03:00:00Z'), '2026-09-25'), t('2026-09-26T02:00:00Z'));
  });

  it('follows the scheduler for a job with no record yet: today before its time, else tomorrow', () => {
    assert.equal(nextDueAt(cleanup, at('2026-09-26T01:00:00Z'), undefined), t('2026-09-26T02:00:00Z'));
    assert.equal(nextDueAt(cleanup, at('2026-09-26T10:00:00Z'), undefined), t('2026-09-27T02:00:00Z'));
  });

  it("lists each configured job's name, room, time and next due time, for the office", async () => {
    const store = createMemoryStore();
    await store.hashSet(JOBS_LAST_FIRED_KEY, 'cleanup_agent', '2026-09-26');
    const list = await jobSchedule({ loadJobs: async () => ({ jobs: [cleanup, report], errors: [] }), store, now: () => at('2026-09-26T02:10:00Z') });
    assert.deepEqual(list, [
      { name: 'cleanup_agent', room: 'reddit-bot', at: '02:00', nextDueAt: t('2026-09-27T02:00:00Z') },
      { name: 'report_agent', room: 'reddit-bot', at: '02:30', nextDueAt: t('2026-09-26T02:30:00Z') },
    ]);
  });
});

function schedulerSetup({ jobs = [cleanup, report], errors = [], accept = true } = {}) {
  const store = createMemoryStore();
  let clock = at('2026-09-26T01:00:00Z');
  /** @type {any[]} */
  const submitted = [];
  let config = { jobs, errors };
  let accepting = accept;
  const scheduler = createJobScheduler({
    store,
    loadJobs: async () => config,
    submitJob: async (job) => {
      submitted.push(job.name);
      return accepting ? { accepted: true, reply: 'Queued' } : { accepted: false, reply: 'The queue is full' };
    },
    outbox: createOutbox({ store }),
    now: () => clock,
    logger: { error() {}, warn() {}, info() {} },
  });
  return {
    store,
    scheduler,
    submitted,
    outboxEntries: () => (store.streams.get(OUTBOX_KEY) ?? []).map((e) => e.fields),
    lastFired: () => store.hashGetAll(JOBS_LAST_FIRED_KEY),
    /** @param {string} iso */
    setClock: (iso) => void (clock = at(iso)),
    setConfig: (c) => void (config = { jobs: [], errors: [], ...c }),
    setAccepting: (a) => void (accepting = a),
  };
}

describe('scheduled jobs: the scheduler', () => {
  it('fires each job once, at its time', async () => {
    const s = schedulerSetup();
    await s.store.hashSet(JOBS_LAST_FIRED_KEY, 'cleanup_agent', '2026-09-25');
    await s.store.hashSet(JOBS_LAST_FIRED_KEY, 'report_agent', '2026-09-25');
    await s.scheduler.tick();
    assert.deepEqual(s.submitted, []);
    s.setClock('2026-09-26T02:00:10Z');
    await s.scheduler.tick();
    await s.scheduler.tick();
    assert.deepEqual(s.submitted, ['cleanup_agent']);
    s.setClock('2026-09-26T02:31:00Z');
    await s.scheduler.tick();
    assert.deepEqual(s.submitted, ['cleanup_agent', 'report_agent']);
    assert.deepEqual(await s.lastFired(), { cleanup_agent: '2026-09-26', report_agent: '2026-09-26' });
    s.setClock('2026-09-27T02:00:00Z');
    await s.scheduler.tick();
    assert.deepEqual(s.submitted, ['cleanup_agent', 'report_agent', 'cleanup_agent']);
  });

  it('does not fire again after a restart the same day, and catches up on one missed while down', async () => {
    const s = schedulerSetup();
    await s.store.hashSet(JOBS_LAST_FIRED_KEY, 'cleanup_agent', '2026-09-26');
    await s.store.hashSet(JOBS_LAST_FIRED_KEY, 'report_agent', '2026-09-25');
    s.setClock('2026-09-26T09:00:00Z');
    // a fresh scheduler over the same store: the runner restarted
    const restarted = createJobScheduler({
      store: s.store,
      loadJobs: async () => ({ jobs: [cleanup, report], errors: [] }),
      submitJob: async (job) => (s.submitted.push(job.name), { accepted: true, reply: 'Started' }),
      outbox: createOutbox({ store: s.store }),
      now: () => at('2026-09-26T09:00:00Z'),
      logger: { error() {}, warn() {}, info() {} },
    });
    await restarted.start();
    restarted.stop();
    assert.deepEqual(s.submitted, ['report_agent']);
  });

  it('a new job added after its time runs from tomorrow', async () => {
    const s = schedulerSetup();
    s.setClock('2026-09-26T10:00:00Z');
    await s.scheduler.tick();
    assert.deepEqual(s.submitted, []);
    assert.deepEqual(await s.lastFired(), { cleanup_agent: '2026-09-26', report_agent: '2026-09-26' });
    s.setClock('2026-09-27T02:00:00Z');
    await s.scheduler.tick();
    assert.deepEqual(s.submitted, ['cleanup_agent']);
  });

  it('a new job added before its time runs today', async () => {
    const s = schedulerSetup();
    await s.scheduler.tick();
    s.setClock('2026-09-26T02:00:00Z');
    await s.scheduler.tick();
    assert.deepEqual(s.submitted, ['cleanup_agent']);
  });

  it('retries next tick when the queue is full', async () => {
    const s = schedulerSetup({ jobs: [cleanup], accept: false });
    await s.store.hashSet(JOBS_LAST_FIRED_KEY, 'cleanup_agent', '2026-09-25');
    s.setClock('2026-09-26T02:00:00Z');
    await s.scheduler.tick();
    assert.deepEqual(await s.lastFired(), { cleanup_agent: '2026-09-25' });
    s.setAccepting(true);
    await s.scheduler.tick();
    assert.deepEqual(s.submitted, ['cleanup_agent', 'cleanup_agent']);
    assert.deepEqual(await s.lastFired(), { cleanup_agent: '2026-09-26' });
  });

  it('tells owner about config errors once per change', async () => {
    const s = schedulerSetup({ jobs: [], errors: ['job "x": room is required'] });
    await s.scheduler.tick();
    await s.scheduler.tick();
    assert.equal(s.outboxEntries().length, 1);
    assert.equal(s.outboxEntries()[0].replyTo, 'owner');
    assert.match(s.outboxEntries()[0].text, /room is required/);
    s.setConfig({ errors: [] });
    await s.scheduler.tick();
    s.setConfig({ errors: ['job "x": room is required'] });
    await s.scheduler.tick();
    assert.equal(s.outboxEntries().length, 2);
  });
});

describe('scheduled jobs: weekly and monthly', () => {
  const weekly = { ...report, name: 'insight_week', at: '03:00', weekday: 1 }; // Monday
  const monthly = { ...report, name: 'insight_month', at: '03:15', monthDay: 1 };
  const t = (iso) => new Date(iso).toISOString();

  it('accepts weekday or monthDay and rejects both or out-of-range values', () => {
    const { jobs, errors } = parseJobs([
      weekly,
      monthly,
      { ...report, name: 'a', weekday: 1, monthDay: 1 },
      { ...report, name: 'b', weekday: 7 },
      { ...report, name: 'c', weekday: 1.5 },
      { ...report, name: 'd', monthDay: 29 },
      { ...report, name: 'e', monthDay: 0 },
      { ...report, name: 'f', weekday: '1' },
    ]);
    assert.deepEqual(jobs, [weekly, monthly]);
    assert.equal(errors.length, 6);
    assert.match(errors[0], /not both/);
  });

  it('fires only on its weekday', () => {
    const fired = new Map([['insight_week', '2026-09-20']]);
    assert.equal(decideJobs([weekly], at('2026-09-29T04:00:00Z'), fired).due.length, 0); // Tuesday
    assert.equal(decideJobs([weekly], at('2026-09-28T02:00:00Z'), fired).due.length, 0); // Monday, early
    assert.deepEqual(decideJobs([weekly], at('2026-09-28T03:00:00Z'), fired).due, [weekly]);
    assert.equal(decideJobs([weekly], at('2026-09-28T03:00:30Z'), new Map([['insight_week', '2026-09-28']])).due.length, 0);
  });

  it('fires only on its day of the month', () => {
    const fired = new Map([['insight_month', '2026-09-01']]);
    assert.equal(decideJobs([monthly], at('2026-10-02T04:00:00Z'), fired).due.length, 0);
    assert.deepEqual(decideJobs([monthly], at('2026-10-01T03:15:00Z'), fired).due, [monthly]);
  });

  it('adopts a new job on a day it does not run as seen today', () => {
    const { due, adopt } = decideJobs([weekly], at('2026-09-29T01:00:00Z'), new Map());
    assert.deepEqual(due, []);
    assert.equal(adopt.get('insight_week'), '2026-09-29');
  });

  it('computes the next due time on a matching day', () => {
    assert.equal(nextDueAt(weekly, at('2026-09-29T01:00:00Z'), '2026-09-28'), t('2026-10-05T03:00:00Z'));
    assert.equal(nextDueAt(weekly, at('2026-09-28T01:00:00Z'), '2026-09-21'), t('2026-09-28T03:00:00Z'));
    assert.equal(nextDueAt(weekly, at('2026-09-28T04:00:00Z'), undefined), t('2026-10-05T03:00:00Z'));
    assert.equal(nextDueAt(monthly, at('2026-10-01T03:20:00Z'), '2026-10-01'), t('2026-11-01T03:15:00Z'));
    assert.equal(nextDueAt(monthly, at('2026-10-15T00:00:00Z'), '2026-10-01'), t('2026-11-01T03:15:00Z'));
  });
});
