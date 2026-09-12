// Background job registry for shell_exec_async / shell_job.

import { startCommand } from './exec.js';

let counter = 0;

export class JobManager {
  constructor(cfg) {
    this.cfg = cfg;
    this.jobs = new Map();
  }

  start(opts) {
    this.sweep();
    const live = [...this.jobs.values()].filter((j) => j.run.running).length;
    if (live >= this.cfg.maxJobs) {
      throw new Error(
        `Too many live jobs (${live}/${this.cfg.maxJobs}). Kill some with shell_job action="kill".`,
      );
    }

    const id = `job${++counter}`;
    const run = startCommand(this.cfg, { ...opts, keepStdinOpen: opts.interactive === true });
    const job = { id, name: opts.name || null, run, createdAt: Date.now() };
    this.jobs.set(id, job);
    // Prevent unhandled rejections; failures surface via run.error instead.
    run.done.catch(() => {});
    return job;
  }

  get(id) {
    const job = this.jobs.get(id);
    if (!job) {
      const ids = [...this.jobs.keys()];
      throw new Error(
        `Unknown job_id "${id}".` + (ids.length ? ` Known: ${ids.join(', ')}` : ' No jobs exist.'),
      );
    }
    return job;
  }

  list() {
    this.sweep();
    return [...this.jobs.values()];
  }

  remove(id) {
    const job = this.get(id);
    if (job.run.running) job.run.kill('SIGKILL');
    this.jobs.delete(id);
    return job;
  }

  killAll(signal = 'SIGTERM') {
    let n = 0;
    for (const job of this.jobs.values()) {
      if (job.run.running) {
        job.run.kill(signal);
        n++;
      }
    }
    return n;
  }

  /** Forget finished jobs older than jobRetentionMs so the map cannot grow forever. */
  sweep() {
    const cutoff = Date.now() - this.cfg.jobRetentionMs;
    for (const [id, job] of this.jobs) {
      if (!job.run.running && job.run.endedAt < cutoff) this.jobs.delete(id);
    }
  }

  /**
   * Read a job's output from `offset` onwards. When `waitMs` > 0 and there is
   * nothing new yet, block until output arrives or the job ends — that turns
   * polling loops into a single MCP call.
   */
  async read(id, { offset = 0, waitMs = 0, stream = 'combined' } = {}) {
    const job = this.get(id);
    const run = job.run;
    const deadline = Date.now() + waitMs;
    while (run[stream].length <= offset && run.running && Date.now() < deadline) {
      await run.waitForChange(Math.min(500, deadline - Date.now()));
    }
    const text = run[stream].slice(Math.max(0, Math.min(offset, run[stream].length)));
    return { job, text, nextOffset: run[stream].length, stream };
  }
}
