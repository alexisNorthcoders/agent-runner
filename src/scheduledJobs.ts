import { readFile } from 'fs/promises';
import { isAbsolute } from 'path';
import { OWNER } from './outbox.ts';
import { errorText, isRecord } from './narrow.ts';
import type { Store } from './redisStore.ts';
import type { createOutbox } from './outbox.ts';

/**
 * Scheduled jobs: commands the runner runs at a fixed UTC time, once a day or on a set weekday or day of the month, in place of crontab
 * lines. A due job joins the run queue as a `job` request and runs as-is under the lock (src/jobProcess.ts),
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
 */
/**
 * `at` is the time of day, `HH:MM` UTC. `weekday` (0–6, 0 = Sunday) or `monthDay` (1–28), never both,
 * limit the job to that UTC weekday or day of the month; without either it runs daily. `logFile` gets the command's stdout and stderr appended,
 * like `>> file 2>&1`. `env` is added to the runner's environment.
 */
export type ScheduledJob = {
  name: string;
  room: string;
  cwd: string;
  command: string;
  at: string;
  logFile?: string;
  env?: Record<string, string>;
  timeoutMinutes?: number;
  weekday?: number;
  monthDay?: number;
};

export const JOBS_LAST_FIRED_KEY = 'agent-runner:jobs:last-fired';
export const JOB_TICK_MS = 30_000;
export const MAX_JOB_TIMEOUT_MINUTES = 60;
/** A job's timeout unless it sets `timeoutMinutes`: crontab had none, but a hung job mustn't hold the lock for good. */
export const DEFAULT_JOB_TIMEOUT_MINUTES = 60;

const NAME_RE = /^[a-zA-Z0-9_.-]+$/;
const AT_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** UTC date `YYYY-MM-DD` of `ms`. */
export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const DAY_MS = 864e5;

/** Whether `job` runs at all on the UTC day of `ms`. */
export function runsOn(job: Pick<ScheduledJob, 'weekday' | 'monthDay'>, ms: number) {
  const d = new Date(ms);
  if (job.weekday != null) return d.getUTCDay() === job.weekday;
  if (job.monthDay != null) return d.getUTCDate() === job.monthDay;
  return true;
}

/** The time `job` is due on the UTC day of `ms`. */
export function dueTimeOn(job: Pick<ScheduledJob, 'at'>, ms: number) {
  const [h, m] = job.at.split(':').map(Number);
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, m);
}

const isInteger = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** `v` as a map of names to strings, or null when it isn't one. */
function stringMap(v: unknown): Record<string, string> | null {
  if (!isRecord(v)) return null;
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v)) {
    if (typeof x !== 'string') return null;
    out[k] = x;
  }
  return out;
}

/** One job of the config, or why it is invalid. `names`: the names already taken. */
export function parseJob(j: unknown, names: ReadonlySet<string> = new Set()): ScheduledJob | string {
  if (!isRecord(j)) return 'not an object';
  const { name, room, cwd, command, at, logFile, env, timeoutMinutes, weekday, monthDay } = j;
  if (typeof name !== 'string' || !NAME_RE.test(name)) return 'name must be letters, digits, _ . -';
  if (names.has(name)) return 'duplicate name';
  if (typeof room !== 'string' || !room.trim()) return 'room is required';
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) return 'cwd must be an absolute path';
  if (typeof command !== 'string' || !command.trim()) return 'command is required';
  if (typeof at !== 'string' || !AT_RE.test(at)) return 'at must be HH:MM (UTC)';
  if (logFile != null && (typeof logFile !== 'string' || !isAbsolute(logFile))) return 'logFile must be an absolute path';
  const envMap = env == null ? null : stringMap(env);
  if (env != null && !envMap) return 'env must map names to strings';
  if (timeoutMinutes != null && !(typeof timeoutMinutes === 'number' && timeoutMinutes > 0 && timeoutMinutes <= MAX_JOB_TIMEOUT_MINUTES)) {
    return `timeoutMinutes must be a number from 1 to ${MAX_JOB_TIMEOUT_MINUTES}`;
  }
  if (weekday != null && monthDay != null) return 'set weekday or monthDay, not both';
  if (weekday != null && !(isInteger(weekday) && weekday >= 0 && weekday <= 6)) return 'weekday must be an integer from 0 (Sunday) to 6';
  if (monthDay != null && !(isInteger(monthDay) && monthDay >= 1 && monthDay <= 28)) return 'monthDay must be an integer from 1 to 28';
  const job: ScheduledJob = { name, room: room.trim(), cwd, command: command.trim(), at };
  if (typeof logFile === 'string') job.logFile = logFile;
  if (envMap) job.env = envMap;
  if (typeof timeoutMinutes === 'number') job.timeoutMinutes = timeoutMinutes;
  if (isInteger(weekday)) job.weekday = weekday;
  if (isInteger(monthDay)) job.monthDay = monthDay;
  return job;
}

/**
 * Validate the parsed config file. Bad entries are dropped, each with an error.
 */
export function parseJobs(raw: unknown): { jobs: ScheduledJob[]; errors: string[] } {
  if (!Array.isArray(raw)) return { jobs: [], errors: ['the config must be a JSON array of jobs'] };
  const jobs: ScheduledJob[] = [];
  const errors: string[] = [];
  const names: Set<string> = new Set();
  raw.forEach((j: unknown, i) => {
    const name = isRecord(j) && typeof j.name === 'string' && j.name ? j.name : null;
    const job = parseJob(j, names);
    if (typeof job === 'string') {
      errors.push(`job ${name ? `"${name}"` : `#${i + 1}`}: ${job}`);
      return;
    }
    names.add(job.name);
    jobs.push(job);
  });
  return { jobs, errors };
}

/**
 * Read and validate the config file. A missing file is no jobs; an unreadable or invalid one is an error.
 */
export async function loadJobsFile(file: string): Promise<{ jobs: ScheduledJob[]; errors: string[] }> {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if (isRecord(e) && e.code === 'ENOENT') return { jobs: [], errors: [] };
    return { jobs: [], errors: [`cannot read ${file}: ${errorText(e)}`] };
  }
  try {
    return parseJobs(JSON.parse(text));
  } catch (e) {
    return { jobs: [], errors: [`${file} is not valid JSON (${errorText(e)})`] };
  }
}

/**
 * What to do with each job now, given the day each last fired.
 * @param lastFired job name → UTC day
 * @returns `due` fire now. `adopt` records new jobs without running them: job name → the day to record.
 */
export function decideJobs(jobs: ScheduledJob[], now: number, lastFired: Map<string, string>): { due: ScheduledJob[]; adopt: Map<string, string> } {
  const today = utcDay(now);
  const due = [];
  const adopt: Map<string, string> = new Map();
  for (const job of jobs) {
    // a day the job doesn't run on: nothing is due, and a new job is recorded as seen today
    if (!runsOn(job, now)) {
      if (!lastFired.has(job.name)) adopt.set(job.name, today);
      continue;
    }
    const early = now < dueTimeOn(job, now);
    if (!lastFired.has(job.name)) adopt.set(job.name, early ? utcDay(now - DAY_MS) : today);
    else if (!early && lastFired.get(job.name) !== today) due.push(job);
  }
  return { due, adopt };
}

/**
 * When `job` next joins the queue (ISO), as the scheduler decides it: today's time until it has
 * fired today (past, while it waits for the next tick), then tomorrow's. A job with no record yet
 * runs today only if its time hasn't passed (see `decideJobs`). Days the job doesn't run on are skipped.
 */
export function nextDueAt(job: Pick<ScheduledJob, 'at' | 'weekday' | 'monthDay'>, now: number, lastFiredDay: string | undefined) {
  const today = dueTimeOn(job, now);
  let day = lastFiredDay === utcDay(now) || (lastFiredDay == null && now >= today) ? 1 : 0;
  while (!runsOn(job, now + day * DAY_MS)) day++; // monthDay ≤ 28 and weekday ≤ 6 always match within 28 days
  return new Date(dueTimeOn(job, now + day * DAY_MS)).toISOString();
}

/** A configured job, for the office: no command, directory or env. */
export type JobScheduleEntry = { name: string; room: string; at: string; nextDueAt: string };

/**
 * The configured jobs and when each is next due, in config order.
 */
export async function jobSchedule({ loadJobs, store, now = Date.now }: { loadJobs: () => Promise<{ jobs: ScheduledJob[] }>; store: Pick<Store, 'hashGetAll'>; now?: () => number }): Promise<JobScheduleEntry[]> {
  const [{ jobs }, fired] = await Promise.all([loadJobs(), store.hashGetAll(JOBS_LAST_FIRED_KEY)]);
  const t = now();
  return jobs.map((j) => ({ name: j.name, room: j.room, at: j.at, nextDueAt: nextDueAt(j, t, fired[j.name]) }));
}

/** `submitJob` starts the job or queues it; `accepted: false` means it was neither (the queue is full). */
export function createJobScheduler({ store, loadJobs, submitJob, outbox, now = Date.now, intervalMs = JOB_TICK_MS, logger = console }: {
    store: Store;
    loadJobs: () => Promise<{ jobs: ScheduledJob[]; errors: string[] }>;
    submitJob: (job: ScheduledJob) => Promise<{ accepted: boolean; reply: string }>;
    outbox: Pick<ReturnType<typeof createOutbox>, 'send'>;
    now?: () => number;
    intervalMs?: number;
    logger?: Pick<Console, 'error' | 'warn' | 'info'>;
  }) {
  let timer: NodeJS.Timeout | null = null;
  let ticking: Promise<void> | null = null;
  let lastConfigErrors = '';

  const tellOwner = (text: string) => outbox.send({ replyTo: OWNER, text }).catch((err) => logger.error('scheduled jobs: outbox write failed:', errorText(err)));

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
        r = { accepted: false, reply: errorText(err) };
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
      .catch((err) => logger.error('scheduled jobs: tick failed:', errorText(err)))
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
