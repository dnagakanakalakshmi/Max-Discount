// app/models/bulkJobProgress.server.js
//
// Lightweight, in-memory, per-process progress tracking for bulk discount
// generation jobs. Deliberately NOT backed by the metafield registry or a
// database — the previous approach called updateBatchRecord() (a full
// read-modify-write of the ENTIRE shop-level batch registry metafield,
// not just this batch) once per chunk. At ~383 chunks for a 1915-coupon
// batch, each one shipping a growing JSON payload, that was enough CPU +
// GraphQL overhead to starve the event loop on a throttled instance
// (Render free tier) — the loop wasn't crashing, it just never got enough
// scheduler time to make forward progress. Polling reads were ALSO
// hitting the same expensive full-registry fetch every 2 seconds,
// compounding it further.
//
// This module replaces all of that for the *in-flight* phase: progress
// lives in a plain in-memory Map, updated synchronously (no I/O, no JSON
// serialization of unrelated data) as each chunk completes. The metafield
// registry is touched exactly ONCE per job — at the very end, via the
// existing addBatchRecord() — which is the only point where durability
// actually matters (a finished batch needs to survive forever; in-flight
// progress only needs to survive the next 2-second poll).
//
// Known tradeoff, accepted deliberately: if the server process restarts
// mid-job, the in-memory entry for that job is lost. The coupons already
// created on Shopify are NOT lost — only the *progress display* resets.
// The /progress route treats a missing entry as "still processing"
// rather than an error, so the polling UI doesn't break; it just won't
// show numeric progress for that case.

const jobs = new Map();

/**
 * Call once when a batch starts generating.
 */
export function startJob(batchId, total) {
  jobs.set(batchId, {
    status: "processing",
    completed: 0,
    total,
    errors: [],
    csvContent: null,
    startedAt: Date.now(),
  });
}

/**
 * Call after each chunk finishes. Cheap, synchronous, no I/O.
 */
export function updateJobProgress(batchId, { completed, newErrors = [] }) {
  const job = jobs.get(batchId);
  if (!job) return;

  job.completed = completed;
  if (newErrors.length) {
    job.errors.push(...newErrors);
  }
}

/**
 * Call once when the job finishes (success or otherwise).
 */
export function completeJob(batchId, { csvContent }) {
  const job = jobs.get(batchId);
  if (!job) return;

  job.status = "complete";
  job.completed = job.total;
  job.csvContent = csvContent;
}

export function failJob(batchId, errorMessage) {
  const job = jobs.get(batchId);
  if (!job) return;

  job.status = "error";
  job.errors.push(errorMessage);
}

/**
 * Read current progress. Returns null if no in-memory entry exists
 * (job not started in this process, or process restarted since it
 * started) — caller decides how to present that.
 */
export function getProgress(batchId) {
  const job = jobs.get(batchId);
  if (!job) return null;

  return {
    status: job.status,
    completed: job.completed,
    total: job.total,
    errors: job.errors,
  };
}

export function getCsvContent(batchId) {
  return jobs.get(batchId)?.csvContent || null;
}

/**
 * Optional housekeeping: drop completed job entries after a while so the
 * Map doesn't grow unbounded over the life of the process. Not critical
 * at typical usage volumes, but cheap to do. Call this periodically if
 * you want (e.g. from a setInterval in shopify.server.js), or just leave
 * it — even a few thousand completed entries is a trivial amount of memory.
 */
export function pruneCompletedJobs(olderThanMs = 30 * 60 * 1000) {
  const now = Date.now();
  for (const [batchId, job] of jobs.entries()) {
    if (job.status !== "processing" && now - job.startedAt > olderThanMs) {
      jobs.delete(batchId);
    }
  }
}