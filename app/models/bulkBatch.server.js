// app/models/bulkBatch.server.js
//
// Persistence for "bulk discount sets" using a single shop-level metafield
// as a lightweight registry. Each entry stores enough to list the batch,
// re-export a fresh CSV, and prefill the bulk form for editing — without a
// database. The actual discount codes/config live on Shopify's discounts
// themselves (queried live by GID when needed); this registry just tracks
// *which* discount GIDs belong to *which* batch.

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
const GRAPHQL_BATCH_LIMIT = 250;

/**
 * @typedef {Object} BulkBatchRecord
 * @property {string} batchId
 * @property {string} name
 * @property {string} createdAt - ISO timestamp
 * @property {string} updatedAt - ISO timestamp
 * @property {string} prefix
 * @property {number} count - number of coupons successfully created
 * @property {string[]} discountIds - Shopify GIDs, one per coupon
 * @property {object} template - the shared discount config (everything
 *   except code/title), reused to prefill the edit form and to drive
 *   discountCodeAppUpdate calls.
 */


/**
 * Re-validates every batch's discountIds against live Shopify data and
 * shrinks discountIds/count to match reality whenever some were deleted
 * directly in Shopify Admin (outside this app). Mirrors the same
 * "Shopify is the source of truth" approach used by the single-discount
 * list page (app/routes/discounts.jsx), adapted for batches: the registry
 * itself still has to be kept (batch name/prefix/template can't be
 * reconstructed from Shopify alone), but membership in it is corrected
 * against live data on every load.
 *
 * Batches that end up with zero surviving discounts are dropped entirely,
 * matching how discounts.jsx simply omits anything no longer returned by
 * Shopify rather than showing an empty/orphaned row.
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

  // One nodes() query across every discountId referenced by any batch,
  // rather than one query per batch.
  const allDiscountIds = [...new Set(batches.flatMap((b) => b.discountIds))];
  const liveDiscounts = await fetchLiveDiscounts(admin, allDiscountIds);

  // fetchLiveDiscounts returns null for any id that no longer resolves
  // (deleted directly in Shopify Admin) — see its own doc comment.
  const liveIds = new Set(
    allDiscountIds.filter((id, index) => liveDiscounts[index] !== null),
  );

  let changed = false;
  const reconciled = [];

  for (const batch of batches) {
    const survivingIds = batch.discountIds.filter((id) => liveIds.has(id));

    if (survivingIds.length === batch.discountIds.length) {
      // Nothing deleted externally — keep as-is.
      reconciled.push(batch);
      continue;
    }

    changed = true;

    if (survivingIds.length === 0) {
      // Every coupon in this batch was deleted outside the app — drop the
      // whole batch record, same as discounts.jsx simply omitting it.
      continue;
    }

    reconciled.push({
      ...batch,
      discountIds: survivingIds,
      count: survivingIds.length,
      updatedAt: new Date().toISOString(),
    });
  }

  if (changed) {
    await writeBatchRegistry(admin, shopId, reconciled);
  }

  return reconciled;
}

export function generateCSVFromLiveDiscounts(batch, liveDiscounts) {
  const template = batch.template || {};

  // These columns are shared across every coupon in the batch (they come
  // from the stored template, not from Shopify — DiscountCodeApp doesn't
  // expose discount type/value/applies-to/min requirement/eligibility/tags
  // as queryable fields; that data lives in our own function-config
  // metafield instead).
  const appliesToText = formatAppliesToForCSV(template.appliesTo);
  const minimumRequirementText = formatMinimumRequirementForCSV(template.minimumRequirement);
  const customerEligibilityText = formatCustomerEligibilityForCSV(template.customerEligibility);
  const tagsText = (template.tags || []).join("; ");
  const discountTypeText = template.discountType || "";
  const discountValueText = template.discountType === "free_shipping" ? "" : template.discountValue ?? "";

  const headers = [
    "Coupon Code",
    "Discount Type",
    "Discount Value",
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

  const rows = liveDiscounts.map((discount, index) => {
    if (!discount) {
      // Discount was removed/changed outside the app; keep the row so the
      // export still lines up with the original batch size, flagged clearly.
      return [
        batch.discountIds[index],
        discountTypeText,
        discountValueText,
        "",
        appliesToText,
        minimumRequirementText,
        customerEligibilityText,
        "",
        "",
        "",
        tagsText,
        "", "", "",
        "", "",
        "NOT FOUND",
        batch.discountIds[index],
      ];
    }

    const purchaseType =
      discount.appliesOnOneTimePurchase && discount.appliesOnSubscription
        ? "One-time & Subscription"
        : discount.appliesOnSubscription
          ? "Subscription only"
          : "One-time only";

    const recurringLimit = !discount.appliesOnSubscription
      ? "N/A"
      : discount.recurringCycleLimit === 0 || discount.recurringCycleLimit == null
        ? "All recurring payments"
        : discount.recurringCycleLimit === 1
          ? "First payment only"
          : `First ${discount.recurringCycleLimit} payments`;

    return [
      discount.code || "",
      discountTypeText,
      discountValueText,
      discount.usageLimit ?? "Unlimited",
      appliesToText,
      minimumRequirementText,
      customerEligibilityText,
      discount.appliesOncePerCustomer ? "Yes" : "No",
      purchaseType,
      recurringLimit,
      tagsText,
      discount.combinesWith?.productDiscounts ? "Yes" : "No",
      discount.combinesWith?.orderDiscounts ? "Yes" : "No",
      discount.combinesWith?.shippingDiscounts ? "Yes" : "No",
      discount.startsAt ? new Date(discount.startsAt).toLocaleString() : "Immediate",
      discount.endsAt ? new Date(discount.endsAt).toLocaleString() : "Never",
      discount.status || "",
      discount.id || "",
    ];
  });

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
  const next = [...batches, record];
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
 * Fetches live status/usage for every discount in a batch, in the same
 * order as the stored discountIds. Entries that fail to resolve (e.g. the
 * discount was deleted directly in Shopify admin) come back as null so
 * callers can filter/flag them instead of the whole export failing.
 */
export async function fetchLiveDiscounts(admin, discountIds) {
  if (!discountIds.length) return [];

  // If we have 250 or fewer, query directly
  if (discountIds.length <= GRAPHQL_BATCH_LIMIT) {
    return await fetchDiscountsBatch(admin, discountIds);
  }

  // Split into batches of 250
  const batches = [];
  for (let i = 0; i < discountIds.length; i += GRAPHQL_BATCH_LIMIT) {
    batches.push(discountIds.slice(i, i + GRAPHQL_BATCH_LIMIT));
  }


  // Execute all batches and combine results
  const allResults = [];
  const batchPromises = batches.map((batch, index) => {
    return fetchDiscountsBatch(admin, batch)
      .then(results => {
        return results;
      })
      .catch(error => {
        console.error(`Batch ${index + 1}/${batches.length} failed:`, error.message);
        // Return nulls for failed batch to maintain array position
        return batch.map(() => null);
      });
  });

  // Wait for all batches to complete
  const batchResults = await Promise.all(batchPromises);
  
  // Flatten results
  for (const results of batchResults) {
    allResults.push(...results);
  }

  return allResults;
}

// Add near the other exports

export async function updateBatchProgress(admin, batchId, progress) {
  // progress: { status: "processing" | "complete" | "error", completed, total, errors }
  await updateBatchRecord(admin, batchId, {
    progress,
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Internal helper to execute a single batch of up to 250 discount IDs
 */
async function fetchDiscountsBatch(admin, discountIds) {
  if (!discountIds.length) return [];

  const response = await admin.graphql(
    `#graphql
      query BulkBatchLiveDiscounts($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on DiscountCodeNode {
            id
            codeDiscount {
              ... on DiscountCodeApp {
                title
                status
                startsAt
                endsAt
                usageLimit
                appliesOncePerCustomer
                appliesOnOneTimePurchase
                appliesOnSubscription
                recurringCycleLimit
                combinesWith {
                  orderDiscounts
                  productDiscounts
                  shippingDiscounts
                }
                codes(first: 1) {
                  nodes {
                    code
                  }
                }
              }
            }
          }
        }
      }`,
    { variables: { ids: discountIds } },
  );

  const json = await response.json();
  const nodes = json.data?.nodes || [];

  // Map results, returning null for missing nodes
  return nodes.map((node) => {
    if (!node || !node.codeDiscount) return null;
    const cd = node.codeDiscount;
    return {
      id: node.id,
      title: cd.title,
      status: cd.status,
      startsAt: cd.startsAt,
      endsAt: cd.endsAt,
      usageLimit: cd.usageLimit,
      appliesOncePerCustomer: cd.appliesOncePerCustomer,
      appliesOnOneTimePurchase: cd.appliesOnOneTimePurchase,
      appliesOnSubscription: cd.appliesOnSubscription,
      recurringCycleLimit: cd.recurringCycleLimit,
      combinesWith: cd.combinesWith,
      code: cd.codes?.nodes?.[0]?.code || null,
      tags: [],
    };
  });
}
/**
 * Deletes every discount in a batch, then removes the batch record itself.
 * Returns per-discount errors (if any) so the caller can surface partial
 * failures instead of silently dropping the registry entry.
 */
export async function deleteBatch(admin, batchId) {
  const batch = await getBatchRecord(admin, batchId);
  if (!batch) {
    throw new Response("Batch not found.", { status: 404 });
  }

  const errors = [];

  for (const discountId of batch.discountIds) {
    const response = await admin.graphql(
      `#graphql
        mutation DeleteBulkBatchDiscount($id: ID!) {
          discountCodeDelete(id: $id) {
            deletedCodeDiscountId
            userErrors {
              field
              message
            }
          }
        }`,
      { variables: { id: discountId } },
    );

    const json = await response.json();
    const userErrors = json.data?.discountCodeDelete?.userErrors || [];
    if (userErrors.length) {
      errors.push(`${discountId}: ${userErrors.map((e) => e.message).join("; ")}`);
    }
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