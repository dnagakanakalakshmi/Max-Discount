// app/models/bulkBatch.server.js
//
// Persistence for "bulk discount sets" using a single shop-level metafield
// as a lightweight registry. Each entry stores enough to list the batch,
// re-export a fresh CSV, and prefill the bulk form for editing — without a
// database.
//
// ── Architecture (post-migration) ───────────────────────────────────────
// Each batch is backed by ONE master DiscountCodeNode (created via
// discountCodeAppCreate) holding all the shared rules — discount type,
// value, dates, eligibility, combinesWith, usageLimit, etc. The N coupon
// codes for that batch are attached to that single master via
// discountRedeemCodeBulkAdd (chunked at 250/call), rather than each code
// living on its own separate DiscountCodeNode.
//
// This replaces the old discountIds: [] (one GID per coupon) with a single
// masterDiscountId: string. Confirmed behavior we're relying on:
//   - usageLimit set on the master applies INDEPENDENTLY to each redeem
//     code under it (not pooled across codes) — verified against Shopify
//     community/support guidance, matches the "usage limit per coupon"
//     framing already used in the UI.
//   - Update and delete become a single mutation against masterDiscountId
//     instead of a loop over N GIDs — this is what eliminates both the
//     sequential-update timeout risk and the Cloudflare 524 on batch
//     deletion that the old multi-GID model had.
//
// Per-code differences (different end dates/limits per individual coupon)
// are NOT supported under this model — confirmed not needed for this app.
//
// ── What is stored per batch record ─────────────────────────────────────
// Only the minimum needed to list, edit, and export a batch:
//   batchId, name, createdAt, updatedAt, prefix, count,
//   masterDiscountId, template
//
// Fields deliberately NOT stored:
//   - couponCodes[]  — at 1000+ codes this alone can push the metafield
//     over Shopify's size ceiling. Live codes are fetched on demand via
//     fetchLiveCodesForBatch at export time.
//   - nextIndex      — resume cursor for interrupted runs; not used in the
//     current flow (generation runs to completion or fails entirely).
//   - lastCsvContent — enormous at scale; regenerated from live codes
//     at export time via generateCSVFromLiveDiscounts.
//   - progress       — in-memory only (bulkJobProgress.server); does not
//     need to survive past the current process lifetime.

const REGISTRY_NAMESPACE = "$app";
const REGISTRY_KEY = "bulkBatches";
const REGISTRY_OWNER_QUERY = `#graphql
  query BulkBatchRegistry {
    shop {
      id
      metafield(namespace: "${REGISTRY_NAMESPACE}", key: "${REGISTRY_KEY}") {
        value
      }
    }
  }`;

// Shop metafields have a size ceiling; keeping only lightweight per-batch
// records (no per-coupon detail) keeps this comfortably under it even after
// many batches accumulate.
const MAX_BATCHES_RETAINED = 200;

// Shopify's discountRedeemCodeBulkAdd is officially documented as
// allowing up to 250 codes per call, but real-world usage reports the
// actual enforced limit is 100 per call, with a ceiling of ~30
// concurrent bulk-creation jobs active on a shop at once. We chunk at
// the more conservative confirmed number (100) rather than trust the
// docs page, since getting this wrong means real mutation failures on
// large batches, not just a suboptimal chunk size.
const REDEEM_CODE_CHUNK_SIZE = 100;

// How many codes to request per page when listing/exporting a master's
// redeem codes via its `codes` connection.
const CODES_PAGE_SIZE = 250;

/**
 * @typedef {Object} BulkBatchRecord
 * @property {string} batchId
 * @property {string} name
 * @property {string} createdAt - ISO timestamp
 * @property {string} updatedAt - ISO timestamp
 * @property {string} prefix
 * @property {number} count - number of coupon codes in this batch
 * @property {string} masterDiscountId - the single Shopify GID backing
 *   every code in this batch
 * @property {object} template - the shared discount config (everything
 *   except the per-code strings), reused to prefill the edit form and to
 *   drive discountCodeAppUpdate calls.
 */

/**
 * Re-validates every batch's masterDiscountId against live Shopify data
 * and drops any batch whose master discount no longer exists (deleted
 * directly in Shopify Admin, outside this app). Mirrors the same
 * "Shopify is the source of truth" approach used elsewhere in the app,
 * simplified considerably now that there's one ID to check per batch
 * instead of N.
 *
 * This intentionally only checks EXISTENCE of the master (one cheap
 * nodes() call covering every batch at once) — it does NOT refresh the
 * stored `count`, since getting a true live code count means paginating
 * each master's full `codes` connection, which is exactly the
 * paginate-on-demand cost generateCSVFromLiveDiscounts already pays at
 * export time. Doing that on every dashboard load for every batch would
 * reintroduce the kind of expensive-per-load cost this registry is
 * designed to avoid. `count` is treated as accurate-as-of-last-write;
 * the export flow is the place that always re-derives ground truth.
 *
 * Returns the corrected, already-persisted list of batches — callers
 * should use this return value, not a separate getBatchRegistry() call,
 * to avoid acting on stale pre-reconciliation data.
 */
export async function reconcileBatchRegistry(admin) {
  const { shopId, batches } = await getBatchRegistry(admin);

  if (!batches.length) {
    return [];
  }

  const liveMasters = await fetchLiveMasters(
    admin,
    batches.map((b) => b.masterDiscountId),
  );

  let changed = false;
  const reconciled = [];

  batches.forEach((batch, index) => {
    const live = liveMasters[index];

    if (!live) {
      // Master discount was deleted outside the app — drop the whole
      // batch record, since none of its codes can possibly still exist.
      changed = true;
      return;
    }

    reconciled.push(batch);
  });

  if (changed) {
    await writeBatchRegistry(admin, shopId, reconciled);
  }

  return reconciled;
}

/**
 * Generates a CSV export for a batch from live Shopify data. Shared
 * columns (discount type/value/eligibility/etc.) come from the stored
 * template and are repeated on every row; the per-row value is just the
 * code string itself, since codes no longer carry independent state.
 *
 * `liveStatus` is fetched fresh by the caller immediately before export
 * (see fetchLiveMasters) rather than read from the stored batch record —
 * status can change at any time (e.g. a discount expiring), and export
 * should always reflect what's true right now, not what was true at
 * generation/last-reconcile time.
 */
export function generateCSVFromLiveDiscounts(batch, liveCodes, liveStatus) {
  const template = batch.template || {};

  const appliesToText = formatAppliesToForCSV(template.appliesTo);
  const minimumRequirementText = formatMinimumRequirementForCSV(template.minimumRequirement);
  const customerEligibilityText = formatCustomerEligibilityForCSV(template.customerEligibility);
  const tagsText = (template.tags || []).join("; ");
  const discountTypeText = template.discountType || "";
  const discountValueText = template.discountType === "free_shipping" ? "" : template.discountValue ?? "";
  const maxDiscountAmountText = template.discountType === "free_shipping" ? "" : template.maxDiscountAmount ?? "";
  const usageLimitText = template.usageLimit ?? "Unlimited";

  const purchaseType =
    template.appliesOnOneTimePurchase && template.appliesOnSubscription
      ? "One-time & Subscription"
      : template.appliesOnSubscription
        ? "Subscription only"
        : "One-time only";

  const recurringLimit = !template.appliesOnSubscription
    ? "N/A"
    : template.recurringCycleLimit === 0 || template.recurringCycleLimit == null
      ? "All recurring payments"
      : template.recurringCycleLimit === 1
        ? "First payment only"
        : `First ${template.recurringCycleLimit} payments`;

  const headers = [
    "Coupon Code",
    "Discount Type",
    "Discount Value",
    "Max Discount Amount",
    "Usage Limit",
    "Applies To",
    "Minimum Requirement",
    "Customer Eligibility",
    "Applies Once Per Customer",
    "Purchase Type",
    "Recurring Payment Limit",
    "Tags",
    "Combines With Product Discounts",
    "Combines With Order Discounts",
    "Combines With Shipping Discounts",
    "Start Date",
    "End Date",
    "Status",
    "Discount ID",
  ];

  const sharedTail = [
    discountTypeText,
    discountValueText,
    maxDiscountAmountText,
    usageLimitText,
    appliesToText,
    minimumRequirementText,
    customerEligibilityText,
    template.appliesOncePerCustomer ? "Yes" : "No",
    purchaseType,
    recurringLimit,
    tagsText,
    template.combinesWith?.productDiscounts ? "Yes" : "No",
    template.combinesWith?.orderDiscounts ? "Yes" : "No",
    template.combinesWith?.shippingDiscounts ? "Yes" : "No",
    template.startsAt ? new Date(template.startsAt).toLocaleString() : "Immediate",
    template.endsAt ? new Date(template.endsAt).toLocaleString() : "Never",
  ];

  const rows = liveCodes.map((code) => [
    code,
    ...sharedTail,
    liveStatus || "UNKNOWN",
    batch.masterDiscountId,
  ]);

  const escape = (value) => {
    const str = String(value ?? "");
    if (str.includes(",") || str.includes('"') || str.includes("\n")) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  return [headers, ...rows].map((row) => row.map(escape).join(",")).join("\n");
}

export async function getBatchRegistry(admin) {
  const response = await admin.graphql(REGISTRY_OWNER_QUERY);
  const json = await response.json();
  const raw = json.data?.shop?.metafield?.value;
  const shopId = json.data?.shop?.id;

  if (!raw) {
    return { shopId, batches: [] };
  }

  try {
    const parsed = JSON.parse(raw);
    return { shopId, batches: Array.isArray(parsed.batches) ? parsed.batches : [] };
  } catch {
    // Corrupt/unexpected value — treat as empty rather than failing the page.
    return { shopId, batches: [] };
  }
}

async function writeBatchRegistry(admin, shopId, batches) {
  // Newest first, capped so the metafield can't grow unbounded over time.
  const trimmed = batches
    .slice()
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, MAX_BATCHES_RETAINED);

  const response = await admin.graphql(
    `#graphql
      mutation SetBulkBatchRegistry($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          userErrors {
            field
            message
          }
        }
      }`,
    {
      variables: {
        metafields: [
          {
            ownerId: shopId,
            namespace: REGISTRY_NAMESPACE,
            key: REGISTRY_KEY,
            type: "json",
            value: JSON.stringify({ batches: trimmed }),
          },
        ],
      },
    },
  );

  const json = await response.json();
  const userErrors = json.data?.metafieldsSet?.userErrors || [];
  if (userErrors.length) {
    throw new Response(
      `Failed to save batch registry: ${userErrors.map((e) => e.message).join("; ")}`,
      { status: 500 },
    );
  }
}

export async function addBatchRecord(admin, record) {
  const { shopId, batches } = await getBatchRegistry(admin);

  // Strip any large/transient fields before persisting. Callers may pass
  // them in without knowing they shouldn't be stored — normalise here so
  // the metafield stays lightweight regardless of what the caller sends.
  const { couponCodes, nextIndex, lastCsvContent, progress, ...lean } = record;

  const next = [...batches, lean];
  await writeBatchRegistry(admin, shopId, next);
}

export async function updateBatchRecord(admin, batchId, updates) {
  const { shopId, batches } = await getBatchRegistry(admin);
  const next = batches.map((batch) =>
    batch.batchId === batchId ? { ...batch, ...updates } : batch,
  );
  await writeBatchRegistry(admin, shopId, next);
}

export async function removeBatchRecord(admin, batchId) {
  const { shopId, batches } = await getBatchRegistry(admin);
  const next = batches.filter((batch) => batch.batchId !== batchId);
  await writeBatchRegistry(admin, shopId, next);
}

export async function getBatchRecord(admin, batchId) {
  const { batches } = await getBatchRegistry(admin);
  return batches.find((batch) => batch.batchId === batchId) || null;
}

/**
 * Fetches live existence + status for a list of master discount IDs, in
 * the same order as the input array. Entries that fail to resolve
 * (master deleted directly in Shopify admin) come back as null.
 *
 * This replaces the old fetchLiveDiscounts (which queried N discount GIDs
 * per batch) — now it's exactly one node per batch, since each batch has
 * exactly one master.
 */
export async function fetchLiveMasters(admin, masterDiscountIds) {
  if (!masterDiscountIds.length) return [];

  const response = await admin.graphql(
    `#graphql
      query BulkBatchLiveMasters($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on DiscountCodeNode {
            id
            codeDiscount {
              ... on DiscountCodeApp {
                status
              }
            }
          }
        }
      }`,
    { variables: { ids: masterDiscountIds } },
  );

  const json = await response.json();
  const nodes = json.data?.nodes || [];

  return nodes.map((node) => {
    if (!node || !node.codeDiscount) return null;
    return {
      id: node.id,
      status: node.codeDiscount.status,
    };
  });
}

/**
 * Fetches every redeem code string for a batch's master discount, paging
 * through the `codes` connection. Used for CSV export and for any
 * "show me every code in this batch" view.
 */
export async function fetchLiveCodesForBatch(admin, masterDiscountId) {
  const codes = [];
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const response = await admin.graphql(
      `#graphql
        query BulkBatchCodes($id: ID!, $first: Int!, $after: String) {
          node(id: $id) {
            ... on DiscountCodeNode {
              codeDiscount {
                ... on DiscountCodeApp {
                  codes(first: $first, after: $after) {
                    nodes { code }
                    pageInfo { hasNextPage endCursor }
                  }
                }
              }
            }
          }
        }`,
      { variables: { id: masterDiscountId, first: CODES_PAGE_SIZE, after: cursor } },
    );

    const json = await response.json();
    const connection = json.data?.node?.codeDiscount?.codes;

    if (!connection) {
      // Master doesn't exist or has no codes connection — stop paging.
      break;
    }

    codes.push(...connection.nodes.map((n) => n.code));
    hasNextPage = connection.pageInfo?.hasNextPage || false;
    cursor = connection.pageInfo?.endCursor || null;
  }

  return codes;
}

/**
 * Adds a list of coupon codes to an existing master discount, chunked at
 * REDEEM_CODE_CHUNK_SIZE per call, polling each chunk's bulk-creation job
 * until it's done. Returns any per-chunk errors collected along the way
 * (does not throw on partial failure — caller decides how to surface
 * it).
 *
 * This is the core of generation under the new model: the master
 * discount itself is created once (see app/routes/bulk-discount.jsx),
 * then this function is called with however many codes need to be added.
 */
export async function addRedeemCodesToMaster(admin, masterDiscountId, codes) {
  const errors = [];

  for (let i = 0; i < codes.length; i += REDEEM_CODE_CHUNK_SIZE) {
    const chunk = codes.slice(i, i + REDEEM_CODE_CHUNK_SIZE);

    const response = await admin.graphql(
      `#graphql
        mutation BulkAddRedeemCodes($discountId: ID!, $codes: [DiscountRedeemCodeInput!]!) {
          discountRedeemCodeBulkAdd(discountId: $discountId, codes: $codes) {
            bulkCreation {
              id
            }
            userErrors {
              code
              field
              message
            }
          }
        }`,
      {
        variables: {
          discountId: masterDiscountId,
          codes: chunk.map((code) => ({ code })),
        },
      },
    );

    const json = await response.json();
    const payload = json.data?.discountRedeemCodeBulkAdd;

    if (!payload) {
      errors.push(`Chunk starting at index ${i}: request failed (no data returned)`);
      continue;
    }

    if (payload.userErrors.length) {
      errors.push(
        ...payload.userErrors.map((e) => `Chunk starting at index ${i}: ${e.message}`),
      );
      continue;
    }

    const jobId = payload.bulkCreation?.id;
    if (!jobId) {
      errors.push(`Chunk starting at index ${i}: no bulkCreation id returned`);
      continue;
    }

    const jobResult = await pollBulkCreationJob(admin, jobId);

    if (jobResult.outcome === "FAILED") {
      errors.push(
        `Chunk starting at index ${i}: all ${jobResult.failedCount ?? chunk.length} codes failed to import`,
      );
    } else if (jobResult.outcome === "PARTIAL") {
      errors.push(
        `Chunk starting at index ${i}: ${jobResult.failedCount} of ${jobResult.codesCount} codes failed to import`,
      );
    } else if (jobResult.outcome === "TIMEOUT" || jobResult.outcome === "UNKNOWN") {
      errors.push(
        `Chunk starting at index ${i}: bulk creation job did not confirm completion (${jobResult.outcome})`,
      );
    }
    // outcome === "COMPLETED" -> no error, every code in this chunk imported successfully.
  }

  return { errors };
}

const POLL_INTERVAL_MS = 2000;
const POLL_MAX_ATTEMPTS = 30; // 60s ceiling per chunk before giving up

/**
 * Polls a discountRedeemCodeBulkCreation job until `done` is true, or
 * until POLL_MAX_ATTEMPTS is reached.
 *
 * NOTE on schema: there is no `status` enum field on this type, despite
 * what some Shopify docs snippets/examples suggest — confirmed against
 * the live schema. The real shape is a `done` boolean (false while
 * queued/running, true once finished) plus `codesCount`/`importedCount`/
 * `failedCount` to tell success from partial failure once done is true.
 */
async function pollBulkCreationJob(admin, jobId) {
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    const response = await admin.graphql(
      `#graphql
        query CheckBulkCreationJob($id: ID!) {
          discountRedeemCodeBulkCreation(id: $id) {
            id
            done
            codesCount
            importedCount
            failedCount
          }
        }`,
      { variables: { id: jobId } },
    );

    const json = await response.json();
    const job = json.data?.discountRedeemCodeBulkCreation;

    if (!job) {
      return { done: true, outcome: "UNKNOWN" };
    }

    if (job.done) {
      const outcome = job.failedCount > 0
        ? (job.importedCount > 0 ? "PARTIAL" : "FAILED")
        : "COMPLETED";
      return { ...job, outcome };
    }

    await sleep(POLL_INTERVAL_MS);
  }

  return { done: false, outcome: "TIMEOUT" };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Deletes a batch's master discount (which removes every redeem code
 * under it in one call) and then removes the batch record. Returns
 * per-attempt errors so the caller can surface partial failures instead
 * of silently dropping the registry entry.
 *
 * This replaces the old deleteBatch, which looped discountCodeDelete over
 * every discountId in the batch — that loop is exactly what produced the
 * Cloudflare 524 on large batches. Under the master model there's only
 * ever one ID to delete, so that failure mode no longer exists.
 */
export async function deleteBatch(admin, batchId) {
  const batch = await getBatchRecord(admin, batchId);
  if (!batch) {
    throw new Response("Batch not found.", { status: 404 });
  }

  const errors = [];

  const response = await admin.graphql(
    `#graphql
      mutation DeleteBulkBatchMaster($id: ID!) {
        discountCodeDelete(id: $id) {
          deletedCodeDiscountId
          userErrors {
            field
            message
          }
        }
      }`,
    { variables: { id: batch.masterDiscountId } },
  );

  const json = await response.json();
  const userErrors = json.data?.discountCodeDelete?.userErrors || [];
  if (userErrors.length) {
    errors.push(`${batch.masterDiscountId}: ${userErrors.map((e) => e.message).join("; ")}`);
  }

  await removeBatchRecord(admin, batchId);

  return { errors };
}

function formatAppliesToForCSV(appliesTo) {
  if (!appliesTo || appliesTo.mode === "all") return "All Products";
  if (appliesTo.mode === "products") return `Specific Products (${appliesTo.resources?.length || appliesTo.ids?.length || 0})`;
  if (appliesTo.mode === "collections") return `Specific Collections (${appliesTo.resources?.length || appliesTo.ids?.length || 0})`;
  return "All Products";
}

function formatMinimumRequirementForCSV(minReq) {
  if (!minReq || minReq.mode === "none") return "None";
  if (minReq.mode === "quantity") return `Minimum ${minReq.value} items`;
  if (minReq.mode === "amount") return `Minimum $${minReq.value}`;
  return "None";
}

function formatCustomerEligibilityForCSV(eligibility) {
  if (!eligibility || eligibility.mode === "all") return "All Customers";
  if (eligibility.mode === "segments") return `Specific Segments (${eligibility.segmentIds?.length || 0})`;
  if (eligibility.mode === "customers") return `Specific Customers (${eligibility.customerIds?.length || 0})`;
  return "All Customers";
}

export { REGISTRY_NAMESPACE, REGISTRY_KEY };