// app/routes/app.bulk-discount.$batchId.progress.jsx
//
// Reads from the in-memory tracker (bulkJobProgress.server.js) — no
// GraphQL call at all for an in-flight job. Falls back to the metafield
// registry only if there's no in-memory entry (batch already finished
// and page reloaded later, or server restarted mid-job).

import { authenticate } from "../shopify.server";
import { getBatchRecord } from "../models/bulkBatch.server";
import { getProgress, getCsvContent } from "../models/bulkJobProgress.server";

export const loader = async ({ request, params }) => {
  const inMemoryProgress = getProgress(params.batchId);

  if (inMemoryProgress) {
    return Response.json({
      progress: inMemoryProgress,
      csvContent: inMemoryProgress.status === "complete" ? getCsvContent(params.batchId) : null,
    });
  }

  // No in-memory entry. Check whether it's a finished batch already
  // sitting in the registry.
  const { admin } = await authenticate.admin(request);
  const batch = await getBatchRecord(admin, params.batchId);

  if (batch) {
    return Response.json({
      progress: { status: "complete", completed: batch.count, total: batch.count, errors: [] },
      csvContent: batch.lastCsvContent || null,
    });
  }

  // Genuinely unknown — could be a job whose process restarted mid-run.
  // Report "processing" with no numbers rather than a hard error.
  return Response.json({
    progress: { status: "processing", completed: 0, total: 0, errors: [] },
    csvContent: null,
  });
};