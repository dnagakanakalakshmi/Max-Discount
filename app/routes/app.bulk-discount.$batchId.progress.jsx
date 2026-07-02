// app/routes/app.bulk-discount.$batchId.progress.jsx
//
// Reads from the in-memory tracker (bulkJobProgress.server.js) — no
// GraphQL call at all for an in-flight job. Falls back to the metafield
// registry only if there's no in-memory entry (batch already finished
// and page reloaded later, or server restarted mid-job).
//
// CSV delivery: when status=complete, getCsvContent() returns the string
// that was stashed on the job entry just before completeJob() was called.
// The client downloads it immediately on receiving this response. After
// pruneCompletedJobs() runs (or the process restarts), getCsvContent()
// returns null — the client only needs it once, so this is fine. If the
// batch is already in the registry (reloaded page, restarted server),
// there is no cached CSV and the user is directed to re-export from the
// Bulk Discount Sets dashboard instead.

import { authenticate } from "../shopify.server";
import { getBatchRecord } from "../models/bulkBatch.server";
import { getProgress, getCsvContent } from "../models/bulkJobProgress.server";

export const loader = async ({ request, params }) => {
  const inMemoryProgress = getProgress(params.batchId);

  if (inMemoryProgress) {
    return Response.json({
      progress: inMemoryProgress,
      // CSV is only available on the first complete poll — after that it
      // may be pruned from memory, which is fine since the client already
      // downloaded it.
      csvContent: inMemoryProgress.status === "complete" ? getCsvContent(params.batchId) : null,
    });
  }

  // No in-memory entry. Check whether it's a finished batch already
  // sitting in the registry (page reload after completion, or server
  // restarted after the job finished).
  const { admin } = await authenticate.admin(request);
  const batch = await getBatchRecord(admin, params.batchId);

  if (batch) {
    // Batch is persisted but CSV is no longer in memory. Return complete
    // status with no CSV — the client banner will direct the user to
    // re-export from the Bulk Discount Sets dashboard.
    return Response.json({
      progress: { status: "complete", completed: batch.count, total: batch.count, errors: [] },
      csvContent: null,
    });
  }

  // Genuinely unknown — could be a job whose process restarted mid-run.
  // Report "processing" with no numbers rather than a hard error.
  return Response.json({
    progress: { status: "processing", completed: 0, total: 0, errors: [] },
    csvContent: null,
  });
};