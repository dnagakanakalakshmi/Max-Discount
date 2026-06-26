import { authenticate } from "../shopify.server";
import { getBatchRecord } from "../models/bulkBatch.server";

export const loader = async ({ request, params }) => {
  const { admin } = await authenticate.admin(request);
  const batch = await getBatchRecord(admin, params.batchId);

  if (!batch) {
    return Response.json({ error: "Batch not found" }, { status: 404 });
  }

  return Response.json({
    progress: batch.progress || { status: "complete", completed: batch.count, total: batch.count, errors: [] },
    csvContent: batch.progress?.status === "complete" ? batch.lastCsvContent : null,
  });
};