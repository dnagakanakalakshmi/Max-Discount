import { useLoaderData, Link, useFetcher, useNavigate } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { useEffect, useState, useRef } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  reconcileBatchRegistry,
  fetchLiveDiscounts,
  deleteBatch,
  generateCSVFromLiveDiscounts,
} from "../models/bulkBatch.server";

const PAGE_SIZE = 5;

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

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  const response = await admin.graphql(
    `#graphql
      query DashboardData {
        discountNodes(first: 100) {
          nodes {
            id
            discount {
              __typename
              ... on DiscountCodeApp {
                title
                status
                endsAt
                usageLimit
                codes(first: 1) {
                  nodes { code }
                }
              }
            }
            metafield(namespace: "$app", key: "config") {
              namespace
              key
              value
              jsonValue
            }
          }
        }
      }`,
  );

  const responseJson = await response.json();
  const batches = await reconcileBatchRegistry(admin);
  const bulkDiscountIds = new Set(batches.flatMap((b) => b.discountIds));

  const coupons = formatCoupons(
    responseJson.data.discountNodes.nodes.filter(
      (node) => !bulkDiscountIds.has(node.id)
    )
  );

  return {
    coupons,
    batches: batches.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
  };
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent")?.toString();

  if (intent === "deleteCoupon") {
    const discountId = formData.get("discountId")?.toString().trim();
    const response = await admin.graphql(
      `#graphql
        mutation DeleteDiscountCode($id: ID!) {
          discountCodeDelete(id: $id) {
            deletedCodeDiscountId
            userErrors { field message }
          }
        }`,
      { variables: { id: discountId } }
    );
    const json = await response.json();
    const payload = json.data.discountCodeDelete;
    if (payload.userErrors.length) {
      return { errors: payload.userErrors.map((e) => e.message) };
    }
    return { deletedCoupon: true, deletedDiscountId: payload.deletedCodeDiscountId };
  }

  if (intent === "bulkDeleteCoupons") {
    const ids = formData.get("discountIds")?.toString().split(",").filter(Boolean) || [];
    const errors = [];
    const deletedIds = [];
    for (const discountId of ids) {
      const response = await admin.graphql(
        `#graphql
          mutation DeleteDiscountCode($id: ID!) {
            discountCodeDelete(id: $id) {
              deletedCodeDiscountId
              userErrors { field message }
            }
          }`,
        { variables: { id: discountId } }
      );
      const json = await response.json();
      const payload = json.data.discountCodeDelete;
      if (payload.userErrors.length) {
        errors.push(...payload.userErrors.map((e) => e.message));
      } else {
        deletedIds.push(payload.deletedCodeDiscountId);
      }
    }
    return { intent: "bulkDeleteCoupons", deletedIds, errors };
  }

  if (intent === "bulkDeleteBatches") {
    const ids = formData.get("batchIds")?.toString().split(",").filter(Boolean) || [];
    const errors = [];
  
    const BATCH_DELETE_CONCURRENCY = 2; // each deleteBatch() already runs 8-wide internally
  
    for (let i = 0; i < ids.length; i += BATCH_DELETE_CONCURRENCY) {
      const chunk = ids.slice(i, i + BATCH_DELETE_CONCURRENCY);
  
      const results = await Promise.allSettled(
        chunk.map((batchId) => deleteBatch(admin, batchId)),
      );
  
      results.forEach((result, idx) => {
        if (result.status === "fulfilled" && result.value.errors?.length) {
          errors.push(...result.value.errors);
        } else if (result.status === "rejected") {
          errors.push(`${chunk[idx]}: ${result.reason?.message || "Unknown error"}`);
        }
      });
    }
  
    return { intent: "bulkDeleteBatches", errors };
  }

  if (intent === "exportBatch") {
    const batchId = formData.get("batchId")?.toString().trim();
    const batches = await reconcileBatchRegistry(admin);
    const batch = batches.find((b) => b.batchId === batchId);
    if (!batch) throw new Response("Batch not found.", { status: 404 });
    const liveDiscounts = await fetchLiveDiscounts(admin, batch.discountIds);
    const csvContent = generateCSVFromLiveDiscounts(batch, liveDiscounts);
    return {
      intent: "exportBatch",
      csvContent,
      filename: `bulk-discounts-${batch.name.replace(/[^a-z0-9-]+/gi, "-")}-${new Date().toISOString().slice(0, 10)}.csv`,
    };
  }

  if (intent === "deleteBatch") {
    const batchId = formData.get("batchId")?.toString().trim();
    await deleteBatch(admin, batchId);
    return { intent: "deleteBatch", batchId };
  }

  return { errors: ["Unknown intent"] };
};

export default function Dashboard() {
  const data = useLoaderData();
  const coupons = data?.coupons ?? [];
  const batches = data?.batches ?? [];

  const fetcher = useFetcher();
  const shopify = useAppBridge();

  // ── Tab state ─────────────────────────────────────────────────────────────
  // 0 = Discount Coupons (default), 1 = Bulk Discount Batches
  const [activeTab, setActiveTab] = useState(0);

  // ── Coupon table state ────────────────────────────────────────────────────
  const [couponSearch, setCouponSearch] = useState("");
  const [couponPage, setCouponPage] = useState(0);
  const [couponSort, setCouponSort] = useState({ col: null, dir: "asc" });
  const [selectedCoupons, setSelectedCoupons] = useState(new Set());
  const [deletingCouponId, setDeletingCouponId] = useState(null);

  // ── Batch table state ─────────────────────────────────────────────────────
  const [batchSearch, setBatchSearch] = useState("");
  const [batchPage, setBatchPage] = useState(0);
  const [batchSort, setBatchSort] = useState({ col: null, dir: "asc" });
  const [selectedBatches, setSelectedBatches] = useState(new Set());
  const [pendingBatchId, setPendingBatchId] = useState(null);
  const [pendingAction, setPendingAction] = useState(null);

  // ── Pending delete targets (drive which modal is open + what it deletes) ──
  const [couponToDelete, setCouponToDelete] = useState(null); // { id, code }
  const [batchToDelete, setBatchToDelete] = useState(null); // { batchId, name }
  const [bulkCouponDeletePending, setBulkCouponDeletePending] = useState(false);
  const [bulkBatchDeletePending, setBulkBatchDeletePending] = useState(false);

  const isBusy = fetcher.state !== "idle";

  // ── Search field refs (to read value from s-search-field events) ──────────
  const couponSearchRef = useRef(null);
  const batchSearchRef = useRef(null);

  // ── Derived coupon data ───────────────────────────────────────────────────
  const filteredCoupons = coupons
    .filter((c) => {
      const q = couponSearch.toLowerCase();
      return (
        c.code?.toLowerCase().includes(q) ||
        c.status?.toLowerCase().includes(q) ||
        c.discountType?.toLowerCase().includes(q)
      );
    })
    .sort((a, b) => {
      if (!couponSort.col) return 0;
      const dir = couponSort.dir === "asc" ? 1 : -1;
      const av = a[couponSort.col] ?? "";
      const bv = b[couponSort.col] ?? "";
      return av < bv ? -dir : av > bv ? dir : 0;
    });

  const couponTotalPages = Math.ceil(filteredCoupons.length / PAGE_SIZE);
  const paginatedCoupons = filteredCoupons.slice(
    couponPage * PAGE_SIZE,
    couponPage * PAGE_SIZE + PAGE_SIZE
  );

  // ── Derived batch data ────────────────────────────────────────────────────
  const filteredBatches = batches
    .filter((b) => {
      const q = batchSearch.toLowerCase();
      return (
        b.name?.toLowerCase().includes(q) ||
        b.prefix?.toLowerCase().includes(q)
      );
    })
    .sort((a, b) => {
      if (!batchSort.col) return 0;
      const dir = batchSort.dir === "asc" ? 1 : -1;
      const av = a[batchSort.col] ?? "";
      const bv = b[batchSort.col] ?? "";
      return av < bv ? -dir : av > bv ? dir : 0;
    });

  const batchTotalPages = Math.ceil(filteredBatches.length / PAGE_SIZE);
  const paginatedBatches = filteredBatches.slice(
    batchPage * PAGE_SIZE,
    batchPage * PAGE_SIZE + PAGE_SIZE
  );

  // ── Sort toggle helper ────────────────────────────────────────────────────
  const toggleSort = (currentSort, setSort, col) => {
    setSort((prev) =>
      prev.col === col
        ? { col, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { col, dir: "asc" }
    );
  };

  // ── Coupon selection helpers ──────────────────────────────────────────────
  const toggleCoupon = (id) => {
    setSelectedCoupons((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleAllCoupons = () => {
    if (selectedCoupons.size === paginatedCoupons.length) {
      setSelectedCoupons(new Set());
    } else {
      setSelectedCoupons(new Set(paginatedCoupons.map((c) => c.id)));
    }
  };

  // ── Batch selection helpers ───────────────────────────────────────────────
  const toggleBatch = (id) => {
    setSelectedBatches((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleAllBatches = () => {
    if (selectedBatches.size === paginatedBatches.length) {
      setSelectedBatches(new Set());
    } else {
      setSelectedBatches(new Set(paginatedBatches.map((b) => b.batchId)));
    }
  };

  // ── Actions ───────────────────────────────────────────────────────────────
  // Each of these now just opens the relevant <s-modal> by setting state —
  // the actual fetcher.submit happens from the modal's primary action once
  // the merchant confirms (see modals rendered at the bottom of this file).
  const requestDeleteCoupon = (coupon) => {
    setCouponToDelete(coupon);
    document.getElementById("delete-coupon-modal")?.showOverlay();
  };

  const confirmDeleteCoupon = () => {
    if (!couponToDelete) return;
    setDeletingCouponId(couponToDelete.id);
    const fd = new FormData();
    fd.append("intent", "deleteCoupon");
    fd.append("discountId", couponToDelete.id);
    fetcher.submit(fd, { method: "post" });
  };

  const requestBulkDeleteCoupons = () => {
    setBulkCouponDeletePending(true);
    document.getElementById("bulk-delete-coupons-modal")?.showOverlay();
  };

  const confirmBulkDeleteCoupons = () => {
    const fd = new FormData();
    fd.append("intent", "bulkDeleteCoupons");
    fd.append("discountIds", [...selectedCoupons].join(","));
    fetcher.submit(fd, { method: "post" });
  };

  const requestBulkDeleteBatches = () => {
    setBulkBatchDeletePending(true);
    document.getElementById("bulk-delete-batches-modal")?.showOverlay();
  };

  const confirmBulkDeleteBatches = () => {
    const fd = new FormData();
    fd.append("intent", "bulkDeleteBatches");
    fd.append("batchIds", [...selectedBatches].join(","));
    fetcher.submit(fd, { method: "post" });
  };

  const handleExport = (batchId) => {
    setPendingBatchId(batchId);
    setPendingAction("export");
    const fd = new FormData();
    fd.append("intent", "exportBatch");
    fd.append("batchId", batchId);
    fetcher.submit(fd, { method: "post" });
  };

  const requestDeleteBatch = (batchId, name) => {
    setBatchToDelete({ batchId, name });
    document.getElementById("delete-batch-modal")?.showOverlay();
  };

  const confirmDeleteBatch = () => {
    if (!batchToDelete) return;
    setPendingBatchId(batchToDelete.batchId);
    setPendingAction("delete");
    const fd = new FormData();
    fd.append("intent", "deleteBatch");
    fd.append("batchId", batchToDelete.batchId);
    fetcher.submit(fd, { method: "post" });
  };

  // ── Effects ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (fetcher.data?.deletedCoupon) {
      shopify.toast.show("Coupon deleted");
      setDeletingCouponId(null);
      setCouponToDelete(null);
      document.getElementById("delete-coupon-modal")?.hideOverlay();
    }
  }, [fetcher.data?.deletedCoupon, shopify]);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.intent === "bulkDeleteCoupons") {
      shopify.toast.show(`${fetcher.data.deletedIds?.length || 0} coupon(s) deleted`);
      setSelectedCoupons(new Set());
      setBulkCouponDeletePending(false);
      document.getElementById("bulk-delete-coupons-modal")?.hideOverlay();
    }
  }, [fetcher.state, fetcher.data, shopify]);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.intent === "bulkDeleteBatches") {
      shopify.toast.show("Selected batches deleted");
      setSelectedBatches(new Set());
      setBulkBatchDeletePending(false);
      document.getElementById("bulk-delete-batches-modal")?.hideOverlay();
    }
  }, [fetcher.state, fetcher.data, shopify]);

  useEffect(() => {
    if (
      fetcher.state === "idle" &&
      fetcher.data?.intent === "exportBatch" &&
      fetcher.data?.csvContent
    ) {
      downloadCSV(fetcher.data.csvContent, fetcher.data.filename);
      shopify.toast.show("CSV exported");
      setPendingAction(null);
      setPendingBatchId(null);
    }
  }, [fetcher.state, fetcher.data, shopify]);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.intent === "deleteBatch") {
      shopify.toast.show("Batch deleted");
      setPendingAction(null);
      setPendingBatchId(null);
      setBatchToDelete(null);
      document.getElementById("delete-batch-modal")?.hideOverlay();
    }
  }, [fetcher.state, fetcher.data, shopify]);

  // Reset page to 0 when search changes
  useEffect(() => { setCouponPage(0); }, [couponSearch]);
  useEffect(() => { setBatchPage(0); }, [batchSearch]);

  // ── Sort indicator helper ─────────────────────────────────────────────────
  const sortIcon = (sort, col) => {
    if (sort.col !== col) return " ↕";
    return sort.dir === "asc" ? " ↑" : " ↓";
  };

  return (
    <s-page inlineSize="base">

      {/* ── Tab switcher ─────────────────────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          gap: "4px",
          borderBottom: "1px solid var(--p-color-border, #e1e3e5)",
          marginBottom: "16px",
        }}
        role="tablist"
        aria-label="Discount views"
      >
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 0}
          onClick={() => setActiveTab(0)}
          style={{
            appearance: "none",
            background: "none",
            border: "none",
            cursor: "pointer",
            padding: "10px 4px",
            marginRight: "20px",
            fontSize: "14px",
            fontWeight: activeTab === 0 ? 600 : 400,
            color: activeTab === 0 ? "var(--p-color-text, #1a1a1a)" : "var(--p-color-text-subdued, #6b6b6b)",
            borderBottom: activeTab === 0 ? "2px solid var(--p-color-border-emphasis, #1a1a1a)" : "2px solid transparent",
          }}
        >
          Discount Coupons{coupons.length ? ` (${coupons.length})` : ""}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 1}
          onClick={() => setActiveTab(1)}
          style={{
            appearance: "none",
            background: "none",
            border: "none",
            cursor: "pointer",
            padding: "10px 4px",
            fontSize: "14px",
            fontWeight: activeTab === 1 ? 600 : 400,
            color: activeTab === 1 ? "var(--p-color-text, #1a1a1a)" : "var(--p-color-text-subdued, #6b6b6b)",
            borderBottom: activeTab === 1 ? "2px solid var(--p-color-border-emphasis, #1a1a1a)" : "2px solid transparent",
          }}
        >
          Bulk Discount Batches{batches.length ? ` (${batches.length})` : ""}
        </button>
      </div>

      {/* ── Discount Coupons ────────────────────────────────────────── */}
      {activeTab === 0 && (
        <s-section>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
            <s-text variant="headingMd">Discount Coupons</s-text>
            <s-stack direction="inline" gap="base">
              {selectedCoupons.size > 0 && (
                <s-button
                  variant="secondary"
                  tone="critical"
                  disabled={isBusy}
                  onClick={requestBulkDeleteCoupons}
                >
                  Delete selected ({selectedCoupons.size})
                </s-button>
              )}
              <Link to="/app/create-coupon">
                <s-button variant="primary">Create Coupon</s-button>
              </Link>
              {coupons.length > PAGE_SIZE && (
                <Link to="/app/discounts">
                  <s-button variant="secondary">View All ({coupons.length})</s-button>
                </Link>
              )}
            </s-stack>
          </div>

          {coupons.length === 0 ? (
            <s-banner heading="No coupons yet">
              <s-text>Create your first max discount coupon using the button above.</s-text>
            </s-banner>
          ) : (
            <s-table
              paginate={filteredCoupons.length > PAGE_SIZE}
              hasPreviousPage={couponPage > 0}
              hasNextPage={couponPage < couponTotalPages - 1}
              onNextpage={() => setCouponPage((p) => p + 1)}
              onPreviouspage={() => setCouponPage((p) => p - 1)}
              loading={isBusy && deletingCouponId !== null}
            >
              {/* Search filter slot */}
              <s-search-field
                slot="filters"
                label="Search coupons"
                labelAccessibilityVisibility="exclusive"
                placeholder="Search by code, status, type..."
                onInput={(e) => setCouponSearch(e.target.value)}
              />

              <s-table-header-row>
                {/* Select all checkbox */}
                <s-table-header>
                  <s-checkbox
                    checked={
                      paginatedCoupons.length > 0 &&
                      selectedCoupons.size === paginatedCoupons.length
                    }
                    onChange={toggleAllCoupons}
                    label="Select all"
                    labelAccessibilityVisibility="exclusive"
                  />
                </s-table-header>
                <s-table-header
                  listSlot="primary"
                  style={{ cursor: "pointer" }}
                  onClick={() => toggleSort(couponSort, setCouponSort, "code")}
                >
                  Code{sortIcon(couponSort, "code")}
                </s-table-header>
                <s-table-header
                  listSlot="labeled"
                  style={{ cursor: "pointer" }}
                  onClick={() => toggleSort(couponSort, setCouponSort, "discountType")}
                >
                  Discount{sortIcon(couponSort, "discountType")}
                </s-table-header>
                <s-table-header listSlot="labeled" format="currency">Max Cap</s-table-header>
                <s-table-header
                  listSlot="inline"
                  style={{ cursor: "pointer" }}
                  onClick={() => toggleSort(couponSort, setCouponSort, "status")}
                >
                  Status{sortIcon(couponSort, "status")}
                </s-table-header>
                <s-table-header listSlot="labeled" format="numeric">Usage Limit</s-table-header>
                <s-table-header
                  listSlot="labeled"
                  style={{ cursor: "pointer" }}
                  onClick={() => toggleSort(couponSort, setCouponSort, "endsAt")}
                >
                  End Date{sortIcon(couponSort, "endsAt")}
                </s-table-header>
                <s-table-header listSlot="labeled">Actions</s-table-header>
              </s-table-header-row>

              <s-table-body>
                {paginatedCoupons.length === 0 ? (
                  <s-table-row>
                    <s-table-cell>No coupons match your search.</s-table-cell>
                    <s-table-cell></s-table-cell>
                    <s-table-cell></s-table-cell>
                    <s-table-cell></s-table-cell>
                    <s-table-cell></s-table-cell>
                    <s-table-cell></s-table-cell>
                    <s-table-cell></s-table-cell>
                    <s-table-cell></s-table-cell>
                  </s-table-row>
                ) : (
                  paginatedCoupons.map((coupon) => (
                    <s-table-row key={coupon.id}>
                      <s-table-cell>
                        <s-checkbox
                          checked={selectedCoupons.has(coupon.id)}
                          onChange={() => toggleCoupon(coupon.id)}
                          label={`Select ${coupon.code}`}
                          labelAccessibilityVisibility="exclusive"
                        />
                      </s-table-cell>
                      <s-table-cell>{coupon.code}</s-table-cell>
                      <s-table-cell>
                        {coupon.discountType === "percentage"
                          ? `${coupon.discountValue}%`
                          : coupon.discountType === "free_shipping"
                          ? "Free Shipping"
                          : `$${coupon.discountValue}`}
                      </s-table-cell>
                      <s-table-cell>
                        {coupon.maxDiscountAmount ? `$${coupon.maxDiscountAmount}` : "—"}
                      </s-table-cell>
                      <s-table-cell>
                        <s-badge
                          tone={
                            coupon.status === "ACTIVE"
                              ? "success"
                              : coupon.status === "EXPIRED"
                              ? "critical"
                              : "neutral"
                          }
                        >
                          {coupon.status}
                        </s-badge>
                      </s-table-cell>
                      <s-table-cell>{coupon.usageLimit || "No limit"}</s-table-cell>
                      <s-table-cell>
                        {formatDateForDisplay(coupon.endsAt) || "No end date"}
                      </s-table-cell>
                      <s-table-cell>
                        <s-stack direction="inline" gap="base">
                          <Link to={`/app/create-coupon?edit=${coupon.id}`}>
                            <s-button variant="secondary">Edit</s-button>
                          </Link>
                          <s-button
                            variant="secondary"
                            tone="critical"
                            disabled={deletingCouponId === coupon.id}
                            {...(deletingCouponId === coupon.id ? { loading: true } : {})}
                            onClick={() => requestDeleteCoupon(coupon)}
                          >
                            Delete
                          </s-button>
                        </s-stack>
                      </s-table-cell>
                    </s-table-row>
                  ))
                )}
              </s-table-body>
            </s-table>
          )}

          {filteredCoupons.length > PAGE_SIZE && (
            <div style={{ marginTop: "8px" }}>
              <s-text tone="subdued" variant="bodySm">
                Showing {couponPage * PAGE_SIZE + 1}–{Math.min((couponPage + 1) * PAGE_SIZE, filteredCoupons.length)} of {filteredCoupons.length} coupons
              </s-text>
            </div>
          )}
        </s-section>
      )}

      {/* ── Bulk Discount Batches ───────────────────────────────────────── */}
      {activeTab === 1 && (
        <s-section>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
            <s-text variant="headingMd">Bulk Discount Batches</s-text>
            <s-stack direction="inline" gap="base">
              {selectedBatches.size > 0 && (
                <s-button
                  variant="secondary"
                  tone="critical"
                  disabled={isBusy}
                  onClick={requestBulkDeleteBatches}
                >
                  Delete selected ({selectedBatches.size})
                </s-button>
              )}
              <Link to="/app/bulk-discount">
                <s-button variant="primary">Create Batch</s-button>
              </Link>
              {batches.length > PAGE_SIZE && (
                <Link to="/app/bulk-discount-sets">
                  <s-button variant="secondary">View All ({batches.length})</s-button>
                </Link>
              )}
            </s-stack>
          </div>

          {batches.length === 0 ? (
            <s-banner heading="No bulk batches yet">
              <s-text>Generate a batch of coupons using the button above.</s-text>
            </s-banner>
          ) : (
            <s-table
              paginate={filteredBatches.length > PAGE_SIZE}
              hasPreviousPage={batchPage > 0}
              hasNextPage={batchPage < batchTotalPages - 1}
              onNextpage={() => setBatchPage((p) => p + 1)}
              onPreviouspage={() => setBatchPage((p) => p - 1)}
              loading={isBusy && pendingAction !== "export"}
            >
              {/* Search filter slot */}
              <s-search-field
                slot="filters"
                label="Search batches"
                labelAccessibilityVisibility="exclusive"
                placeholder="Search by name or prefix..."
                onInput={(e) => setBatchSearch(e.target.value)}
              />

              <s-table-header-row>
                <s-table-header>
                  <s-checkbox
                    checked={
                      paginatedBatches.length > 0 &&
                      selectedBatches.size === paginatedBatches.length
                    }
                    onChange={toggleAllBatches}
                    label="Select all"
                    labelAccessibilityVisibility="exclusive"
                  />
                </s-table-header>
                <s-table-header
                  listSlot="primary"
                  style={{ cursor: "pointer" }}
                  onClick={() => toggleSort(batchSort, setBatchSort, "name")}
                >
                  Name{sortIcon(batchSort, "name")}
                </s-table-header>
                <s-table-header
                  listSlot="labeled"
                  style={{ cursor: "pointer" }}
                  onClick={() => toggleSort(batchSort, setBatchSort, "createdAt")}
                >
                  Created{sortIcon(batchSort, "createdAt")}
                </s-table-header>
                <s-table-header listSlot="labeled" format="numeric">Coupons</s-table-header>
                <s-table-header listSlot="labeled">Prefix</s-table-header>
                <s-table-header listSlot="labeled">Value</s-table-header>
                <s-table-header listSlot="labeled">Actions</s-table-header>
              </s-table-header-row>

              <s-table-body>
                {paginatedBatches.length === 0 ? (
                  <s-table-row>
                    <s-table-cell>No batches match your search.</s-table-cell>
                    <s-table-cell></s-table-cell>
                    <s-table-cell></s-table-cell>
                    <s-table-cell></s-table-cell>
                    <s-table-cell></s-table-cell>
                    <s-table-cell></s-table-cell>
                  </s-table-row>
                ) : (
                  paginatedBatches.map((batch) => {
                    const isExporting =
                      isBusy && pendingBatchId === batch.batchId && pendingAction === "export";
                    const isDeleting =
                      isBusy && pendingBatchId === batch.batchId && pendingAction === "delete";
                    return (
                      <s-table-row key={batch.batchId}>
                        <s-table-cell>
                          <s-checkbox
                            checked={selectedBatches.has(batch.batchId)}
                            onChange={() => toggleBatch(batch.batchId)}
                            label={`Select ${batch.name}`}
                            labelAccessibilityVisibility="exclusive"
                          />
                        </s-table-cell>
                        <s-table-cell>{batch.name}</s-table-cell>
                        <s-table-cell>
                          {new Date(batch.createdAt).toLocaleDateString()}
                        </s-table-cell>
                        <s-table-cell>{batch.count}</s-table-cell>
                        <s-table-cell>{batch.prefix || "—"}</s-table-cell>
                        <s-table-cell>{formatBatchValue(batch.template)}</s-table-cell>
                        <s-table-cell>
                          <s-stack direction="inline" gap="base">
                            <s-button
                              variant="secondary"
                              disabled={isBusy && !isExporting}
                              {...(isExporting ? { loading: true } : {})}
                              onClick={() => handleExport(batch.batchId)}
                            >
                              Export
                            </s-button>
                            <Link to={`/app/bulk-discount?batchId=${batch.batchId}`}>
                              <s-button variant="secondary" disabled={isBusy}>Edit</s-button>
                            </Link>
                            <s-button
                              variant="secondary"
                              tone="critical"
                              disabled={isBusy && !isDeleting}
                              {...(isDeleting ? { loading: true } : {})}
                              onClick={() => requestDeleteBatch(batch.batchId, batch.name)}
                            >
                              Delete
                            </s-button>
                          </s-stack>
                        </s-table-cell>
                      </s-table-row>
                    );
                  })
                )}
              </s-table-body>
            </s-table>
          )}

          {filteredBatches.length > PAGE_SIZE && (
            <div style={{ marginTop: "8px" }}>
              <s-text tone="subdued" variant="bodySm">
                Showing {batchPage * PAGE_SIZE + 1}–{Math.min((batchPage + 1) * PAGE_SIZE, filteredBatches.length)} of {filteredBatches.length} batches
              </s-text>
            </div>
          )}
        </s-section>
      )}

      {/* ── Delete confirmation modals ──────────────────────────────────── */}
      {/* Single coupon delete */}
      <s-modal id="delete-coupon-modal" heading="Delete discount code?">
        <s-stack gap="base">
          <s-text>
            Are you sure you want to delete{" "}
            {couponToDelete?.code ? `"${couponToDelete.code}"` : "this discount code"}?
          </s-text>
          <s-text tone="caution">This action cannot be undone.</s-text>
        </s-stack>
        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          {...(deletingCouponId ? { loading: true } : {})}
          onClick={confirmDeleteCoupon}
        >
          Delete
        </s-button>
        <s-button
          slot="secondary-actions"
          variant="secondary"
          commandFor="delete-coupon-modal"
          command="--hide"
          disabled={Boolean(deletingCouponId)}
        >
          Cancel
        </s-button>
      </s-modal>

      {/* Bulk coupon delete */}
      <s-modal id="bulk-delete-coupons-modal" heading="Delete selected coupons?">
        <s-stack gap="base">
          <s-text>
            Are you sure you want to delete {selectedCoupons.size} selected coupon
            {selectedCoupons.size === 1 ? "" : "s"}?
          </s-text>
          <s-text tone="caution">This action cannot be undone.</s-text>
        </s-stack>
        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          {...(bulkCouponDeletePending && isBusy ? { loading: true } : {})}
          onClick={confirmBulkDeleteCoupons}
        >
          Delete {selectedCoupons.size > 0 ? `(${selectedCoupons.size})` : ""}
        </s-button>
        <s-button
          slot="secondary-actions"
          variant="secondary"
          commandFor="bulk-delete-coupons-modal"
          command="--hide"
          disabled={bulkCouponDeletePending && isBusy}
        >
          Cancel
        </s-button>
      </s-modal>

      {/* Single batch delete */}
      <s-modal id="delete-batch-modal" heading="Delete batch?">
        <s-stack gap="base">
          <s-text>
            Delete {batchToDelete?.name ? `"${batchToDelete.name}"` : "this batch"}? This
            permanently removes all its coupon codes.
          </s-text>
          <s-text tone="caution">This action cannot be undone.</s-text>
        </s-stack>
        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          {...(pendingAction === "delete" && isBusy ? { loading: true } : {})}
          onClick={confirmDeleteBatch}
        >
          Delete batch
        </s-button>
        <s-button
          slot="secondary-actions"
          variant="secondary"
          commandFor="delete-batch-modal"
          command="--hide"
          disabled={pendingAction === "delete" && isBusy}
        >
          Cancel
        </s-button>
      </s-modal>

      {/* Bulk batch delete */}
      <s-modal id="bulk-delete-batches-modal" heading="Delete selected batches?">
        <s-stack gap="base">
          <s-text>
            Delete {selectedBatches.size} selected batch
            {selectedBatches.size === 1 ? "" : "es"}? This permanently removes every
            coupon code in each selected batch.
          </s-text>
          <s-text tone="caution">This action cannot be undone.</s-text>
        </s-stack>
        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          {...(bulkBatchDeletePending && isBusy ? { loading: true } : {})}
          onClick={confirmBulkDeleteBatches}
        >
          Delete {selectedBatches.size > 0 ? `(${selectedBatches.size})` : ""}
        </s-button>
        <s-button
          slot="secondary-actions"
          variant="secondary"
          commandFor="bulk-delete-batches-modal"
          command="--hide"
          disabled={bulkBatchDeletePending && isBusy}
        >
          Cancel
        </s-button>
      </s-modal>

    </s-page>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatCoupons(nodes) {
  return nodes
    .map((node) => {
      const discount = node.discount;
      if (discount.__typename !== "DiscountCodeApp") return null;
      const configDiscount = firstConfiguredDiscount(readMetafieldJson(node.metafield));
      const fallbackConfig = parseDiscountTitle(discount.title);
      const displayConfig = configDiscount || fallbackConfig;
      if (!displayConfig) return null;
      return {
        id: node.id,
        code: discount.codes.nodes[0]?.code || "",
        title: discount.title,
        status: discount.status,
        endsAt: discount.endsAt,
        usageLimit: discount.usageLimit,
        discountType: displayConfig?.discountType || "",
        discountValue: displayConfig?.discountValue || "",
        maxDiscountAmount: displayConfig?.maxDiscountAmount || "",
      };
    })
    .filter(Boolean);
}

function readMetafieldJson(metafield) {
  if (!metafield) return null;
  if (metafield.jsonValue) return metafield.jsonValue;
  if (!metafield.value) return null;
  try { return JSON.parse(metafield.value); } catch { return null; }
}

function firstConfiguredDiscount(config) {
  if (!config || typeof config !== "object") return null;
  if (Array.isArray(config.discounts)) return config.discounts[0] || null;
  if (config.discountType && config.discountValue && config.maxDiscountAmount) return config;
  return null;
}

function parseDiscountTitle(title) {
  const pct = title.match(/^(\d+(?:\.\d+)?)%\s+off\s+up\s+to\s+(\d+(?:\.\d+)?)/i);
  if (pct) return { discountType: "percentage", discountValue: Number(pct[1]), maxDiscountAmount: Number(pct[2]) };
  const fixed = title.match(/^(\d+(?:\.\d+)?)\s+off\s+up\s+to\s+(\d+(?:\.\d+)?)/i);
  if (fixed) return { discountType: "fixed", discountValue: Number(fixed[1]), maxDiscountAmount: Number(fixed[2]) };
  return null;
}

function formatDateForDisplay(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("en-IN", {
    year: "numeric", month: "short", day: "numeric",
  }).format(new Date(value));
}

function formatBatchValue(template) {
  if (!template) return "—";
  if (template.discountType === "free_shipping") return "Free Shipping";
  if (template.discountType === "percentage") return `${template.discountValue}%`;
  if (template.discountType === "fixed") return `$${template.discountValue}`;
  return "—";
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};