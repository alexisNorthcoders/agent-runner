import { readFile } from 'fs/promises';
import { isAbsolute } from 'path';
import { OWNER } from './outbox.js';

/**
 * Scheduled jobs: commands the runner runs once a day at a fixed UTC time, in place of crontab
 * lines. A due job joins the run queue as a `job` request and runs as-is under the lock (src/jobProcess.js),
 * without a preamble or post-run.
 *
 * - **Config**: a JSON array in `SCHEDULED_JOBS_FILE` (default `scheduled-jobs.json` in the repo),
 *   re-read on every tick, so an edit applies without a restart. A missing file means no jobs.
 * - **Once a day**: `agent-runner:jobs:last-fired` (hash job name → UTC date `YYYY-MM-DD`) records the
 *   day a job last joined the queue, so it fires at most once a day, even across restarts. A job
 *   whose time passed while the runner was down fires on the first tick after startup that day.
 * - A job with no record yet (just added to the config) is recorded when first seen: for today
 *   without running if its time has already passed (its first run is tomorrow), else for yesterday
 *   (it runs today). That keeps a job moved over from crontab from running twice on the day it's moved.
 *
 * @typedef {{
 *   name: string,
 *   room: string,
 *   cwd: string,
 *   command: string,
 *   at: string,
 *   logFile?: string,
 *   env?: Record<string, string>,
 *   timeoutMinutes?: number,
 * }} ScheduledJob
 *   `at` is the daily time, `HH:MM` UTC. `logFile` gets the command's stdout and stderr appended,
 *   like `>> file 2>&1`. `env` is added to the runner's environment.
 */

export const JOBS_LAST_FIRED_KEY = 'agent-runner:jobs:last-fired';
export const JOB_TICK_MS = 30_000;
export const MAX_JOB_TIMEOUT_MINUTES = 60;
/** A job's timeout unless it sets `timeoutMinutes`: crontab had none, but a hung job mustn't hold the lock for good. */
export const DEFAULT_JOB_TIMEOUT_MINUTES = 60;

const NAME_RE = /^[a-zA-Z0-9_.-]+$/;
const AT_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** UTC date `YYYY-MM-DD` of `ms`. @param {number} ms */
export const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

const DAY_MS = 864e5;

/** The time `job` is due on the UTC day of `ms`. @param {Pick<ScheduledJob, 'at'>} job @param {number} ms */
export function dueTimeOn(job, ms) {
  const [h, m] = job.at.split(':').map(Number);
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, m);
}

/**
 * Validate the parsed config file. Bad entries are dropped, each with an error.
 * @param {unknown} raw
 * @returns {{ jobs: ScheduledJob[], errors: string[] }}
 */
export function parseJobs(raw) {
  if (!Array.isArray(raw)) return { jobs: [], errors: ['the config must be a JSON array of jobs'] };
  /** @type {ScheduledJob[]} */
  const jobs = [];
  const errors = [];
  const names = new Set();
  raw.forEach((j, i) => {
    const where = `job ${typeof j?.name === 'string' && j.name ? `"${j.name}"` : `#${i + 1}`}`;
    const bad = (why) => errors.push(`${where}: ${why}`);
    if (!j || typeof j !== 'object' || Array.isArray(j)) return bad('not an object');
    if (typeof j.name !== 'string' || !NAME_RE.test(j.name)) return bad('name must be letters, digits, _ . -');
    if (names.has(j.name)) return bad('duplicate name');
    if (typeof j.room !== 'string' || !j.room.trim()) return bad('room is required');
    if (typeof j.cwd !== 'string' || !isAbsolute(j.cwd)) return bad('cwd must be an absolute path');
    if (typeof j.command !== 'string' || !j.command.trim()) return bad('command is required');
    if (typeof j.at !== 'string' || !AT_RE.test(j.at)) return bad('at must be HH:MM (UTC)');
    if (j.logFile != null && (typeof j.logFile !== 'string' || !isAbsolute(j.logFile))) return bad('logFile must be an absolute path');
    if (j.env != null && (typeof j.env !== 'object' || Array.isArray(j.env) || Object.values(j.env).some((v) => typeof v !== 'string'))) {
      return bad('env must map names to strings');
    }
    if (j.timeoutMinutes != null && !(typeof j.timeoutMinutes === 'number' && j.timeoutMinutes > 0 && j.timeoutMinutes <= MAX_JOB_TIMEOUT_MINUTES)) {
      return bad(`timeoutMinutes must be a number from 1 to ${MAX_JOB_TIMEOUT_MINUTES}`);
    }
    names.add(j.name);
    /** @type {ScheduledJob} */
    const job = { name: j.name, room: j.room.trim(), cwd: j.cwd, command: j.command.trim(), at: j.at };
    if (j.logFile != null) job.logFile = j.logFile;
    if (j.env != null) job.env = { ...j.env };
    if (j.timeoutMinutes != null) job.timeoutMinutes = j.timeoutMinutes;
    jobs.push(job);
  });
  return { jobs, errors };
}

/**
 * Read and validate the config file. A missing file is no jobs; an unreadable or invalid one is an error.
 * @param {string} file
 * @returns {Promise<{ jobs: ScheduledJob[], errors: string[] }>}
 */
export async function loadJobsFile(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return { jobs: [], errors: [] };
    return { jobs: [], errors: [`cannot read ${file}: ${e?.message || e}`] };
  }
  try {
    return parseJobs(JSON.parse(text));
  } catch (e) {
    return { jobs: [], errors: [`${file} is not valid JSON (${e?.message || e})`] };
  }
}

/**
 * What to do with each job now, given the day each last fired.
 * @param {ScheduledJob[]} jobs
 * @param {number} now
 * @param {Map<string, string>} lastFired job name → UTC day
 * @returns {{ due: ScheduledJob[], adopt: Map<string, string> }}
 *   `due` fire now. `adopt` records new jobs without running them: job name → the day to record.
 */
export function decideJobs(jobs, now, lastFired) {
  const today = utcDay(now);
  const due = [];
  /** @type {Map<string, string>} */
  const adopt = new Map();
  for (const job of jobs) {
    const early = now < dueTimeOn(job, now);
    if (!lastFired.has(job.name)) adopt.set(job.name, early ? utcDay(now - DAY_MS) : today);
    else if (!early && lastFired.get(job.name) !== today) due.push(job);
  }
  return { due, adopt };
}

/**
 * @param {{
 *   store: import('./redisStore.js').Store,
 *   loadJobs: () => Promise<{ jobs: ScheduledJob[], errors: string[] }>,
 *   submitJob: (job: ScheduledJob) => Promise<{ accepted: boolean, reply: string }>,
 *   outbox: Pick<ReturnType<typeof import('./outbox.js').createOutbox>, 'send'>,
 *   now?: () => number,
 *   intervalMs?: number,
 *   logger?: Pick<Console, 'error' | 'warn' | 'info'>,
 * }} deps
 *   `submitJob` starts the job or queues it; `accepted: false` means it was neither (the queue is full).
 */
export function createJobScheduler({ store, loadJobs, submitJob, outbox, now = Date.now, intervalMs = JOB_TICK_MS, logger = console }) {
  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  /** @type {Promise<void> | null} */
  let ticking = null;
  let lastConfigErrors = '';

  /** @param {string} text */
  const tellOwner = (text) => outbox.send({ replyTo: OWNER, text }).catch((err) => logger.error('scheduled jobs: outbox write failed:', err?.message || err));

  async function lastFired() {
    return new Map(Object.entries(await store.hashGetAll(JOBS_LAST_FIRED_KEY)));
  }

  async function tickOnce() {
    const { jobs, errors } = await loadJobs();
    // told once per change, not every tick
    const errText = errors.join('\n');
    if (errText !== lastConfigErrors) {
      lastConfigErrors = errText;
      if (errText) {
        logger.error(`scheduled jobs: config errors:\n${errText}`);
        await tellOwner(`Scheduled jobs config has errors; these jobs are skipped:\n${errText}`);
      }
    }
    if (!jobs.length) return;
    const t = now();
    const today = utcDay(t);
    const fired = await lastFired();
    const { due, adopt } = decideJobs(jobs, t, fired);
    for (const [name, day] of adopt) {
      await store.hashSet(JOBS_LAST_FIRED_KEY, name, day);
      if (day === today) logger.info(`scheduled jobs: new job ${name} is past its time today; its first run is tomorrow`);
    }
    for (const job of due) {
      // recorded before it's submitted, so a restart can never fire it twice
      await store.hashSet(JOBS_LAST_FIRED_KEY, job.name, today);
      let r;
      try {
        r = await submitJob(job);
      } catch (err) {
        r = { accepted: false, reply: err?.message || String(err) };
      }
      if (r.accepted) {
        logger.info(`scheduled jobs: ${job.name}: ${r.reply}`);
        continue;
      }
      // try again next tick
      const prev = fired.get(job.name);
      if (prev) await store.hashSet(JOBS_LAST_FIRED_KEY, job.name, prev);
      else await store.hashDelete(JOBS_LAST_FIRED_KEY, job.name);
      logger.warn(`scheduled jobs: ${job.name} could not be queued: ${r.reply}`);
    }
  }

  /** One pass: fire the jobs that are due. Never throws; overlapping calls share a pass. */
  function tick() {
    ticking ??= tickOnce()
      .catch((err) => logger.error('scheduled jobs: tick failed:', err?.message || err))
      .finally(() => {
        ticking = null;
      });
    return ticking;
  }

  return {
    tick,
    /** Tick now (catching up on a job missed while the runner was down), then every `intervalMs`. */
    async start() {
      await tick();
      timer = setInterval(tick, intervalMs);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
