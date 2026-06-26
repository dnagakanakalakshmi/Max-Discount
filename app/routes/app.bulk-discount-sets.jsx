// app/routes/bulk-discount.sets.jsx
import { useEffect, useState } from "react";
import { useFetcher, useLoaderData, useNavigate, Link } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  reconcileBatchRegistry,
  fetchLiveDiscounts,
  deleteBatch,
  generateCSVFromLiveDiscounts
} from "../models/bulkBatch.server";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const batches = await reconcileBatchRegistry(admin); 

  return {
    batches: batches.sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
    ),
  };
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const batchId = formData.get("batchId")?.toString();

  if (!batchId) {
    throw new Response("batchId is required", { status: 400 });
  }

  if (intent === "delete") {
    const { errors } = await deleteBatch(admin, batchId);
    return { intent: "delete", batchId, errors };
  }

  if (intent === "export") {
    const batches = await reconcileBatchRegistry(admin);
    const batch = batches.find((b) => b.batchId === batchId);
    if (!batch) {
      throw new Response("Batch not found.", { status: 404 });
    }

    const liveDiscounts = await fetchLiveDiscounts(admin, batch.discountIds);
    const csvContent = generateCSVFromLiveDiscounts(batch, liveDiscounts);

    return {
      intent: "export",
      batchId,
      csvContent,
      filename: `bulk-discounts-${batch.name.replace(/[^a-z0-9-]+/gi, "-")}-${new Date()
        .toISOString()
        .slice(0, 10)}.csv`,
    };
  }

  throw new Response("Unknown intent", { status: 400 });
};

export default function BulkDiscountSets() {
  const { batches } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const navigate = useNavigate();
  const [pendingBatchId, setPendingBatchId] = useState(null);
  const [pendingAction, setPendingAction] = useState(null);

  const isBusy = fetcher.state !== "idle";

  const handleExport = (batchId) => {
    setPendingBatchId(batchId);
    setPendingAction("export");
    fetcher.submit({ intent: "export", batchId }, { method: "post" });
  };

  const handleDelete = (batchId, name) => {
    const confirmed = window.confirm(
      `Delete "${name}"? This permanently removes all of its coupon codes from Shopify.`,
    );
    if (!confirmed) return;

    setPendingBatchId(batchId);
    setPendingAction("delete");
    fetcher.submit({ intent: "delete", batchId }, { method: "post" });
  };

  // Handle export completion: trigger the CSV download once it comes back.
  useEffect(() => {
    if (
      fetcher.state === "idle" &&
      fetcher.data?.intent === "export" &&
      fetcher.data?.batchId === pendingBatchId &&
      pendingAction === "export"
    ) {
      downloadCSV(fetcher.data.csvContent, fetcher.data.filename);
      shopify.toast.show("CSV exported");
      setPendingAction(null);
      setPendingBatchId(null);
    }
  }, [fetcher.state, fetcher.data, pendingBatchId, pendingAction, shopify]);

  useEffect(() => {
    if (
      fetcher.state === "idle" &&
      fetcher.data?.intent === "delete" &&
      fetcher.data?.batchId === pendingBatchId &&
      pendingAction === "delete"
    ) {
      const errorCount = fetcher.data.errors?.length || 0;
      shopify.toast.show(
        errorCount > 0 ? `Batch deleted with ${errorCount} error(s)` : "Batch deleted",
        errorCount > 0 ? { tone: "critical" } : undefined,
      );
      setPendingAction(null);
      setPendingBatchId(null);
    }
  }, [fetcher.state, fetcher.data, pendingBatchId, pendingAction, shopify]);

  return (
    <s-page inlineSize="base">
      <s-section>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "16px",
          }}
        >
          <s-text variant="headingLg">Bulk Discount Sets</s-text>
          <Link to="/app">
            <s-button variant="secondary">← Dashboard</s-button>
          </Link>
          <Link to="/app/bulk-discount">
            <s-button variant="primary">Create New Batch</s-button>
          </Link>
        </div>

        {batches.length === 0 ? (
          <s-banner heading="No bulk sets yet">
            <s-text>
              Generate a batch of coupons from the{" "}
              <Link to="/app/bulk-discount">Bulk Discount Generation</Link>{" "}
              page and it will show up here.
            </s-text>
          </s-banner>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Name</s-table-header>
              <s-table-header>Created</s-table-header>
              <s-table-header>Coupons</s-table-header>
              <s-table-header>Prefix</s-table-header>
              <s-table-header>Actions</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {batches.map((batch) => {
                const isThisExporting =
                  isBusy && pendingBatchId === batch.batchId && pendingAction === "export";
                const isThisDeleting =
                  isBusy && pendingBatchId === batch.batchId && pendingAction === "delete";

                return (
                  <s-table-row key={batch.batchId}>
                    <s-table-cell>{batch.name}</s-table-cell>
                    <s-table-cell>
                      {new Date(batch.createdAt).toLocaleString()}
                    </s-table-cell>
                    <s-table-cell>{batch.count}</s-table-cell>
                    <s-table-cell>{batch.prefix || "—"}</s-table-cell>
                    <s-table-cell>
                      <s-stack direction="inline" gap="tight">
                        <s-button
                          variant="secondary"
                          {...(isThisExporting ? { loading: true } : {})}
                          disabled={isBusy && !isThisExporting}
                          onClick={() => handleExport(batch.batchId)}
                        >
                          Export
                        </s-button>
                        <s-button
                          variant="secondary"
                          disabled={isBusy}
                          onClick={() =>
                            navigate(`/app/bulk-discount?batchId=${batch.batchId}`)
                          }
                        >
                          Edit
                        </s-button>
                        <s-button
                          variant="secondary"
                          tone="critical"
                          {...(isThisDeleting ? { loading: true } : {})}
                          disabled={isBusy && !isThisDeleting}
                          onClick={() => handleDelete(batch.batchId, batch.name)}
                        >
                          Delete
                        </s-button>
                      </s-stack>
                    </s-table-cell>
                  </s-table-row>
                );
              })}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}

function downloadCSV(csv, filename) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.setAttribute("href", url);
  link.setAttribute("download", filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};