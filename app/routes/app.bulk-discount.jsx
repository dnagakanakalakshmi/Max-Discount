// app/routes/bulk-discount.jsx
import { useEffect, useState } from "react";
import { useFetcher, useLoaderData, useSearchParams, Link } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate, unauthenticated } from "../shopify.server";
import {
  startJob,
  updateJobProgress,
  completeJob,
  failJob,
} from "../models/bulkJobProgress.server";
import {
  getBatchRecord,
  addBatchRecord,
  updateBatchRecord,
} from "../models/bulkBatch.server";

const CONFIG_NAMESPACE = "$app";
const CONFIG_KEY = "config";
const MAX_COUPONS = 4000;

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  const response = await admin.graphql(
    `#graphql
      query DiscountFunctions {
        shopifyFunctions(first: 25, apiType: "discount") {
          nodes {
            id
            title
            apiType
          }
        }
      }`,
  );
  const responseJson = await response.json();
  const functions = responseJson.data.shopifyFunctions.nodes;
  const selectedFunctionId = findDefaultFunction(functions)?.id || "";

  // Customer segments, needed for the "specific customer segments" eligibility option.
  const segmentsResponse = await admin.graphql(
    `#graphql
      query DiscountSegments {
        segments(first: 100) {
          nodes {
            id
            name
          }
        }
      }`,
  );
  const segmentsJson = await segmentsResponse.json();
  const segments = segmentsJson.data?.segments?.nodes || [];

  // If we're editing an existing batch (?batchId=...), load its stored
  // template so the form can be prefilled below.
  const url = new URL(request.url);
  const batchId = url.searchParams.get("batchId");
  const editingBatch = batchId ? await getBatchRecord(admin, batchId) : null;

  return {
    functions,
    selectedFunctionId,
    segments,
    editingBatch,
  };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();

  const intent = formData.get("intent")?.toString() || "create";
  const functionId = requiredString(formData, "functionId");

  // Parse the discount configuration once - it will be the same for all coupons
  const baseDiscount = parseBulkDiscountConfig(formData);

  if (intent === "update") {
    return updateExistingBatch({ admin, formData, functionId, baseDiscount, shop: session.shop });
  }

  return createNewBatch({ admin, formData, functionId, baseDiscount, shop: session.shop });
};

async function createNewBatch({ admin, formData, functionId, baseDiscount, shop }) {
  const numberOfCoupons = Number(formData.get("numberOfCoupons"));
  const prefix = formData.get("prefix")?.toString().trim().toUpperCase() || "";
  const batchName = prefix || `Batch ${new Date().toLocaleDateString()}`;

  if (!numberOfCoupons || numberOfCoupons < 1 || numberOfCoupons > MAX_COUPONS) {
    throw new Response(`Number of coupons must be between 1 and ${MAX_COUPONS}`, { status: 400 });
  }

  const batchId = generateBatchId();
  const couponCodes = generateUniqueCouponCodes(prefix, numberOfCoupons);

  startJob(batchId, numberOfCoupons);

  runBulkGeneration({ shop, batchId, couponCodes, baseDiscount, functionId, batchName, prefix }).catch(
    (err) => {
      console.error(`Bulk generation failed for batch ${batchId}:`, err);
      failJob(batchId, err?.message || "Unknown error during generation");
    },
  );

  return {
    batchId,
    started: true,
    totalRequested: numberOfCoupons,
  };
}


const CONCURRENCY = 5; // tune this — see notes below


async function runBulkGeneration({ shop, batchId, couponCodes, baseDiscount, functionId, batchName, prefix }) {
  const { admin } = await unauthenticated.admin(shop);

  const createdDiscounts = [];
  const errors = [];
  const csvRows = [];

  for (let i = 0; i < couponCodes.length; i += CONCURRENCY) {
    const chunk = couponCodes.slice(i, i + CONCURRENCY);

    const results = await Promise.allSettled(
      chunk.map((code) => createSingleCoupon({ admin, code, baseDiscount, functionId })),
    );

    const newErrors = [];
    for (const result of results) {
      if (result.status === "fulfilled" && result.value.success) {
        createdDiscounts.push(result.value.created);
        csvRows.push(buildCsvRow(result.value.created));
      } else {
        const message =
          result.status === "fulfilled" ? result.value.error : result.reason?.message || "Unknown error";
        newErrors.push(message);
      }
    }
    errors.push(...newErrors);

    const completed = Math.min(i + CONCURRENCY, couponCodes.length);

    // Cheap in-memory update — replaces the old per-chunk updateBatchRecord() call.
    updateJobProgress(batchId, { completed, newErrors });
  }

  const csvContent = generateCSV(csvRows);
  const allDiscountIds = createdDiscounts.map((d) => d.id);

  // The ONE metafield write for this entire job.
  await addBatchRecord(admin, {
    batchId,
    name: batchName,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    prefix,
    count: allDiscountIds.length,
    discountIds: allDiscountIds,
    template: { ...baseDiscount, functionId },
    couponCodes,
    nextIndex: couponCodes.length,
    progress: { status: "complete", completed: couponCodes.length, total: couponCodes.length, errors },
    lastCsvContent: csvContent,
  });

  completeJob(batchId, { csvContent });
}

async function createSingleCoupon({ admin, code, baseDiscount, functionId }) {
  const discount = { ...baseDiscount, code, title: code };
  const config = { discounts: [toFunctionDiscount(discount)] };

  const mutation = `#graphql
    mutation CreateBulkDiscountCode($codeAppDiscount: DiscountCodeAppInput!) {
      discountCodeAppCreate(codeAppDiscount: $codeAppDiscount) {
        codeAppDiscount {
          discountId
          codes(first: 1) {
            nodes { code }
          }
        }
        userErrors { field message }
      }
    }`;

  const response = await admin.graphql(mutation, {
    variables: {
      codeAppDiscount: buildCodeAppDiscountInput({ discount, functionId, config }),
    },
  });
  const responseJson = await response.json();

  // Defensive: a throttled/malformed response may not have .data at all
  if (!responseJson.data) {
    const message = responseJson.errors?.[0]?.message || "Request failed (no data returned)";
    return { success: false, error: `${code}: ${message}` };
  }

  const payload = responseJson.data.discountCodeAppCreate;

  if (payload.userErrors.length) {
    return {
      success: false,
      error: `${code}: ${payload.userErrors.map((e) => e.message).join("; ")}`,
    };
  }

  // We trim the GraphQL selection set to reduce query cost, so we build
  // the full coupon object from our own `discount` input rather than the
  // (intentionally minimal) response — the only server-confirmed value we
  // actually need back is the discountId and the final code.
  const created = formatActionCoupon(
    {
      discountId: payload.codeAppDiscount.discountId,
      codes: payload.codeAppDiscount.codes,
    },
    discount,
  );

  return { success: true, created };
}

async function updateExistingBatch({ admin, formData, functionId, baseDiscount }) {
  const batchId = requiredString(formData, "batchId");
  const prefix = formData.get("prefix")?.toString().trim().toUpperCase() || "";
  const batchName = prefix || undefined; // falls back to existingBatch.name below if empty

  const existingBatch = await getBatchRecord(admin, batchId);
  if (!existingBatch) {
    throw new Response("Batch not found.", { status: 404 });
  }

  const errors = [];
  const updatedDiscounts = [];

  for (const discountId of existingBatch.discountIds) {
    // Codes/titles are intentionally left untouched on update — only the
    // shared template fields (value, eligibility, dates, etc.) change.
    const discount = { ...baseDiscount };

    const config = {
      discounts: [toFunctionDiscount(discount)],
    };

    const mutation = `#graphql
      mutation UpdateBulkDiscountCode($id: ID!, $codeAppDiscount: DiscountCodeAppInput!) {
        discountCodeAppUpdate(id: $id, codeAppDiscount: $codeAppDiscount) {
          codeAppDiscount {
            discountId
            title
          }
          userErrors {
            field
            message
          }
        }
      }`;

    const response = await admin.graphql(mutation, {
      variables: {
        id: discountId,
        codeAppDiscount: buildCodeAppDiscountInput({
          discount,
          functionId,
          config,
          isUpdate: true,
        }),
      },
    });

    const responseJson = await response.json();
    const payload = responseJson.data.discountCodeAppUpdate;

    if (payload.userErrors.length) {
      errors.push(
        ...payload.userErrors.map((error) => `${discountId}: ${error.message}`),
      );
    } else {
      updatedDiscounts.push(payload.codeAppDiscount.discountId);
    }
  }

  await updateBatchRecord(admin, batchId, {
    name: batchName || existingBatch.name,
    updatedAt: new Date().toISOString(),
    template: { ...baseDiscount, functionId },
  });

  return {
    intent: "update",
    batchId,
    updatedCount: updatedDiscounts.length,
    totalRequested: existingBatch.discountIds.length,
    errors,
  };
}

function generateBatchId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID
  return `batch_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function buildCsvRow(created) {
  return {
    code: created.code,
    discountType: created.discountType,
    discountValue: created.discountValue,
    maxDiscountAmount: created.maxDiscountAmount ?? '',
    usageLimit: created.usageLimit || "Unlimited",
    appliesTo: formatAppliesToForCSV(created.appliesTo),
    minimumRequirement: formatMinimumRequirementForCSV(created.minimumRequirement),
    customerEligibility: formatCustomerEligibilityForCSV(created.customerEligibility),
    appliesOncePerCustomer: created.appliesOncePerCustomer ? "Yes" : "No",
    purchaseType: formatPurchaseTypeForCSV(created),
    recurringPaymentLimit: formatRecurringCycleLimitForCSV(created),
    tags: (created.tags || []).join("; "),
    combinesWithProduct: created.combinesWith.productDiscounts ? "Yes" : "No",
    combinesWithOrder: created.combinesWith.orderDiscounts ? "Yes" : "No",
    combinesWithShipping: created.combinesWith.shippingDiscounts ? "Yes" : "No",
    startsAt: created.startsAt ? new Date(created.startsAt).toLocaleString() : "Immediate",
    endsAt: created.endsAt ? new Date(created.endsAt).toLocaleString() : "Never",
    status: created.status,
    discountId: created.id,
  };
}

function generateUniqueCouponCodes(prefix, count) {
  const codes = new Set();

  while (codes.size < count) {
    const randomString = generateRandomString(8);
    const code = prefix ? `${prefix}-${randomString}` : randomString;
    codes.add(code);
  }

  return Array.from(codes);
}

function generateRandomString(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function generateCSV(rows) {
  if (rows.length === 0) return '';

  const headers = [
    'Coupon Code',
    'Discount Type',
    'Discount Value',
    'Max Discount Amount',
    'Usage Limit',
    'Applies To',
    'Minimum Requirement',
    'Customer Eligibility',
    'Applies Once Per Customer',
    'Purchase Type',
    'Recurring Payment Limit',
    'Tags',
    'Combines With Product Discounts',
    'Combines With Order Discounts',
    'Combines With Shipping Discounts',
    'Start Date',
    'End Date',
    'Status',
    'Discount ID'
  ];

  const csvRows = [headers.join(',')];

  for (const row of rows) {
    const values = headers.map(header => {
      // Map header to the actual key in the row object
      let value;
      switch(header) {
        case 'Coupon Code':
          value = row.code || '';
          break;
        case 'Discount Type':
          value = row.discountType || '';
          break;
        case 'Discount Value':
          value = row.discountValue || '';
          break;
        case 'Max Discount Amount':
          value = row.maxDiscountAmount || '';
          break;
        case 'Usage Limit':
          value = row.usageLimit || '';
          break;
        case 'Applies To':
          value = row.appliesTo || '';
          break;
        case 'Minimum Requirement':
          value = row.minimumRequirement || '';
          break;
        case 'Customer Eligibility':
          value = row.customerEligibility || '';
          break;
        case 'Applies Once Per Customer':
          value = row.appliesOncePerCustomer || '';
          break;
        case 'Purchase Type':
          value = row.purchaseType || '';
          break;
        case 'Recurring Payment Limit':
          value = row.recurringPaymentLimit || '';
          break;
        case 'Tags':
          value = row.tags || '';
          break;
        case 'Combines With Product Discounts':
          value = row.combinesWithProduct || '';
          break;
        case 'Combines With Order Discounts':
          value = row.combinesWithOrder || '';
          break;
        case 'Combines With Shipping Discounts':
          value = row.combinesWithShipping || '';
          break;
        case 'Start Date':
          value = row.startsAt || '';
          break;
        case 'End Date':
          value = row.endsAt || '';
          break;
        case 'Status':
          value = row.status || '';
          break;
        case 'Discount ID':
          value = row.discountId || '';
          break;
        default:
          value = '';
      }

      // Escape commas and quotes
      if (typeof value === 'string' && (value.includes(',') || value.includes('"') || value.includes('\n'))) {
        value = `"${value.replace(/"/g, '""')}"`;
      }
      return value;
    });
    csvRows.push(values.join(','));
  }

  return csvRows.join('\n');
}

function formatAppliesToForCSV(appliesTo) {
  if (!appliesTo || appliesTo.mode === 'all') return 'All Products';
  if (appliesTo.mode === 'products') return `Specific Products (${appliesTo.resources?.length || 0})`;
  if (appliesTo.mode === 'collections') return `Specific Collections (${appliesTo.resources?.length || 0})`;
  return 'All Products';
}

function formatMinimumRequirementForCSV(minReq) {
  if (!minReq || minReq.mode === 'none') return 'None';
  if (minReq.mode === 'quantity') return `Minimum ${minReq.value} items`;
  if (minReq.mode === 'amount') return `Minimum $${minReq.value}`;
  return 'None';
}

function formatCustomerEligibilityForCSV(eligibility) {
  if (!eligibility || eligibility.mode === 'all') return 'All Customers';
  if (eligibility.mode === 'segments') return `Specific Segments (${eligibility.segmentIds?.length || 0})`;
  if (eligibility.mode === 'customers') return `Specific Customers (${eligibility.customerIds?.length || 0})`;
  return 'All Customers';
}

function formatPurchaseTypeForCSV(coupon) {
  const oneTime = Boolean(coupon.appliesOnOneTimePurchase);
  const subscription = Boolean(coupon.appliesOnSubscription);

  if (oneTime && subscription) return 'One-time & Subscription';
  if (subscription) return 'Subscription only';
  if (oneTime) return 'One-time only';
  return 'One-time & Subscription';
}

function formatRecurringCycleLimitForCSV(coupon) {
  if (!coupon.appliesOnSubscription) return 'N/A';

  const limit = coupon.recurringCycleLimit;
  if (limit === null || limit === undefined || limit === 0) return 'All recurring payments';
  if (limit === 1) return 'First payment only';
  return `First ${limit} payments`;
}

function buildCodeAppDiscountInput({ discount, functionId, config, isUpdate = false }) {
  return {
    // Codes can't be changed via discountCodeAppUpdate, and on update we
    // deliberately don't touch code/title anyway (see updateExistingBatch).
    ...(isUpdate ? {} : { code: discount.code, title: discount.title }),
    functionId,

    discountClasses: ["ORDER"],
    appliesOncePerCustomer: discount.appliesOncePerCustomer,
    combinesWith: {
      orderDiscounts: discount.combinesWith.orderDiscounts,
      productDiscounts: discount.combinesWith.productDiscounts,
      shippingDiscounts: discount.combinesWith.shippingDiscounts,
    },
    customerSelection: buildCustomerSelectionInput(discount.customerEligibility),
    startsAt: discount.startsAt || new Date().toISOString(),
    endsAt: discount.endsAt,
    usageLimit: discount.usageLimit,
    appliesOnOneTimePurchase: discount.appliesOnOneTimePurchase,
    appliesOnSubscription: discount.appliesOnSubscription,
    // Only send recurringCycleLimit when the discount actually applies to
    // subscriptions; the field defaults to 1 on Shopify's side otherwise.
    ...(discount.appliesOnSubscription && discount.recurringCycleLimit !== null
      ? { recurringCycleLimit: discount.recurringCycleLimit }
      : {}),
    tags: discount.tags,

    metafields: [
      {
        namespace: CONFIG_NAMESPACE,
        key: CONFIG_KEY,
        type: "json",
        value: JSON.stringify(config),
      },
      // Must exactly match shopify.extension.toml's
      // [extensions.input.variables] namespace/key. See the same fix
      // applied in app._index.jsx for the single-discount flow — this
      // file needs the identical write, once per coupon in the batch.
      {
        namespace: "$app",
        key: "collection-ids",
        type: "json",
        value: JSON.stringify({
          collectionIds:
            discount.appliesTo?.mode === "collections"
              ? discount.appliesTo.resources.map((r) => r.id)
              : [],
        }),
      },
    ],
  };
}

function buildCustomerSelectionInput(customerEligibility) {
  if (customerEligibility.mode === "segments") {
    return {
      customerSegments: { add: customerEligibility.segmentIds },
    };
  }

  if (customerEligibility.mode === "customers") {
    return {
      customers: { add: customerEligibility.customerIds },
    };
  }

  return { all: true };
}

export default function BulkDiscount() {
  const { selectedFunctionId, segments, editingBatch } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const [searchParams] = useSearchParams();
  const batchId = searchParams.get("batchId");
  const isEditing = Boolean(editingBatch);

  const [formData, setFormData] = useState(() =>
    createInitialFormData(editingBatch),
  );
  const isSubmitting = fetcher.state === "submitting";
  const hasFunction = Boolean(selectedFunctionId);
  const errors = fetcher.data?.errors || [];
  const generatedCount = fetcher.data?.count || 0;
  const updatedCount = fetcher.data?.updatedCount || 0;
  const totalRequested = fetcher.data?.totalRequested || 0;
  const csvContent = fetcher.data?.csvContent || '';
  const isUpdateResult = fetcher.data?.intent === "update";

  // Defensive defaults: guards against stale/partial state shapes (e.g. from
  // hot-reload preserving an older formData shape) so a missing key never
  // crashes the render.
  const purchaseType = formData.purchaseType || "both";
  const recurringPaymentLimit = formData.recurringPaymentLimit || { mode: "all", value: "" };
  const tags = formData.tags ?? "";

  const [customerSearch, setCustomerSearch] = useState({
    rowId: null,
    query: "",
    results: [],
    loading: false
  });
  const [progress, setProgress] = useState(null);

  useEffect(() => {
    if (fetcher.data?.started && fetcher.data?.batchId) {
      const pollBatchId = fetcher.data.batchId;
      const interval = setInterval(async () => {
        const res = await fetch(`/app/bulk-discount/${pollBatchId}/progress`, {
          headers: {
            Authorization: `Bearer ${await shopify.idToken()}`,
          },
        });
        const data = await res.json();
        setProgress(data.progress);

        if (data.progress.status === "complete") {
          clearInterval(interval);
          shopify.toast.show(`${data.progress.completed} coupons generated successfully`);
          if (data.csvContent) {
            const safeName = (formData.prefix || "batch").replace(/[^a-z0-9-]+/gi, "-");
            downloadCSV(
              data.csvContent,
              `bulk-discounts-${safeName}-${new Date().toISOString().slice(0, 10)}.csv`
            );
          }
        }
      }, 2000);

      return () => clearInterval(interval);
    }
  }, [fetcher.data]);

  useEffect(() => {
    if (isUpdateResult && updatedCount > 0) {
      shopify.toast.show(`${updatedCount} coupon${updatedCount > 1 ? 's' : ''} updated successfully`);
    }
  }, [isUpdateResult, updatedCount, shopify]);

  useEffect(() => {
    if (errors.length > 0) {
      shopify.toast.show(`${errors.length} error${errors.length > 1 ? 's' : ''} occurred during generation`, {
        tone: 'critical'
      });
    }
  }, [errors, shopify]);

  const updateFormData = (field, value) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  const pickResources = async (resourceType) => {
    const initialSelectionIds = formData.appliesTo.resources.map((r) => ({ id: r.id }));
    const selection = await shopify.resourcePicker({
      type: resourceType,
      multiple: true,
      selectionIds: initialSelectionIds,
    });

    if (!selection) return;

    const picked = selection.map((item) => ({
      id: item.id,
      title: item.title || item.handle,
    }));

    updateFormData('appliesTo', {
      mode: resourceType === "product" ? "products" : "collections",
      resources: picked,
    });
  };

  const searchCustomers = async (query) => {
    setCustomerSearch({ rowId: 'main', query, results: [], loading: true });

    if (!query.trim()) {
      setCustomerSearch({ rowId: 'main', query, results: [], loading: false });
      return;
    }

    const response = await fetch(`/app/customer-search?q=${encodeURIComponent(query)}`);
    const data = await response.json();
    setCustomerSearch({ rowId: 'main', query, results: data.customers || [], loading: false });
  };

  const addCustomer = (customer) => {
    const currentIds = formData.customerEligibility.customerIds || [];
    if (currentIds.includes(customer.id)) return;

    updateFormData('customerEligibility', {
      ...formData.customerEligibility,
      mode: "customers",
      customerIds: [...currentIds, customer.id],
      customerLabels: [...(formData.customerEligibility.customerLabels || []), customer],
    });
  };

  const removeCustomer = (customerId) => {
    const currentIds = formData.customerEligibility.customerIds || [];
    if (!currentIds.includes(customerId)) return;

    updateFormData('customerEligibility', {
      ...formData.customerEligibility,
      customerIds: currentIds.filter((id) => id !== customerId),
      customerLabels: (formData.customerEligibility.customerLabels || []).filter(
        (c) => c.id !== customerId,
      ),
    });
  };

  const downloadCSV = (csv, filename) => {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const resetForm = () => {
    setFormData(createInitialFormData(isEditing ? editingBatch : null));
  };

  return (
    <s-page inlineSize="base">
      <s-section>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <s-text variant="headingLg">
            {isEditing ? `Edit Batch: ${editingBatch.name}` : 'Bulk Discount Generation'}
          </s-text>
          <Link to="/app">
            <s-button variant="primary" icon="arrow-left">Go to dashboard</s-button>
          </Link>
        </div>

        {isEditing && (
          <s-banner tone="info" heading="Editing an existing batch">
            <s-text>
              Updating shared settings will apply to all {editingBatch.count}{" "}
              existing coupon codes in this batch. Codes themselves won't
              change.
            </s-text>
          </s-banner>
        )}

        <fetcher.Form method="post">
          <s-stack direction="block" gap="base">
            {!hasFunction && (
              <s-banner tone="critical" heading="Discount Function not found">
                Deploy the max-discount Function extension, then reload this
                page to create coupons.
              </s-banner>
            )}

            {/* {errors.length > 0 && (
              <s-banner tone="critical" heading={isUpdateResult ? "Some coupons were not updated" : "Some coupons were not created"}>
                <s-unordered-list>
                  {errors.map((error) => (
                    <s-list-item key={error}>{error}</s-list-item>
                  ))}
                </s-unordered-list>
              </s-banner>
            )}

            {!isUpdateResult && generatedCount > 0 && (
              <s-banner tone="success" heading={`${generatedCount} of ${totalRequested} coupons generated successfully`}>
                <s-text>
                  CSV file has been downloaded automatically. View it anytime
                  from{" "}
                  <Link to="/app/bulk-discount-sets">Bulk Discount Sets</Link>.
                </s-text>
              </s-banner>
            )} */}

            {/* ✅ ADD the new progress banners HERE, in that same spot */}
            {progress?.status === "processing" && (
              <s-banner tone="info" heading="Generating coupons…">
                <s-text>
                  {progress.completed} of {progress.total} created
                  {progress.errors?.length > 0 ? ` (${progress.errors.length} errors so far)` : ""}
                </s-text>
              </s-banner>
            )}

            {progress?.status === "complete" && (
              <s-banner tone="success" heading={`${progress.completed} of ${progress.total} coupons generated successfully`}>
                <s-text>
                  CSV file has been downloaded automatically. View it anytime from{" "}
                  <Link to="/app/bulk-discount-sets">Bulk Discount Sets</Link>.
                </s-text>
              </s-banner>
            )}

            {isUpdateResult && updatedCount > 0 && (
              <s-banner tone="success" heading={`${updatedCount} of ${totalRequested} coupons updated successfully`}>
                <s-text>Shared settings have been applied to this batch.</s-text>
              </s-banner>
            )}

            <input type="hidden" name="functionId" value={selectedFunctionId} />
            <input type="hidden" name="intent" value={isEditing ? "update" : "create"} />
            {isEditing && <input type="hidden" name="batchId" value={batchId} />}

            {/* Bulk Generation Specific Fields */}
            <s-card>
              <s-stack direction="block" gap="base">
                <s-text variant="headingSm">
                  {isEditing ? "Batch Details" : "Bulk Generation Settings"}
                </s-text>

                {!isEditing && (
                  <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                    <s-box inlineSize="49%">
                      <s-number-field
                        label="Number of coupons to generate"
                        name="numberOfCoupons"
                        min={1}
                        max={MAX_COUPONS}
                        step={1}
                        value={formData.numberOfCoupons}
                        onChange={(e) => updateFormData('numberOfCoupons', e.target.value)}
                        required
                        helpText={`Maximum ${MAX_COUPONS} coupons`}
                      />
                    </s-box>
                    <s-box inlineSize="50%">
                      <s-text-field
                        label="Coupon prefix"
                        name="prefix"
                        placeholder="SUMMER"
                        value={formData.prefix}
                        onChange={(e) => updateFormData('prefix', e.target.value)}
                        helpText="Optional: Prefix for all coupon codes"
                      />
                    </s-box>
                  </s-stack>
                )}

              </s-stack>
            </s-card>

            {/* Main Discount Configuration */}
            <s-card>
              <s-stack direction="block" gap="base">
                <s-text variant="headingSm">Discount Configuration</s-text>

                {/* --- Value --- */}
                <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                  <s-box inlineSize="49%">
                    <s-select
                      label="Discount type"
                      name="discountType"
                      value={formData.discountType}
                      onChange={(e) => updateFormData('discountType', e.target.value)}
                      required
                    >
                      <s-option value="percentage">Percentage off</s-option>
                      <s-option value="fixed">Flat amount off</s-option>
                      <s-option value="free_shipping">Free shipping</s-option>
                    </s-select>
                  </s-box>
                  {formData.discountType !== "free_shipping" && (
                    <s-box inlineSize="50%">
                      <s-number-field
                        label="Discount value"
                        name="discountValue"
                        min={0.01}
                        step={0.01}
                        placeholder="10"
                        value={formData.discountValue}
                        onChange={(e) => updateFormData('discountValue', e.target.value)}
                        required
                      />
                    </s-box>
                  )}
                </s-stack>

                {formData.discountType !== "free_shipping" && (
                  <s-money-field
                    label="Maximum discount amount"
                    name="maxDiscountAmount"
                    min={0.01}
                    max={999999}
                    placeholder="100"
                    value={formData.maxDiscountAmount}
                    onChange={(e) => updateFormData('maxDiscountAmount', e.target.value)}
                    required
                  />
                )}

                {/* --- Applies to + Purchase type --- */}
                <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                  <s-box inlineSize="50%">
                    <s-select
                      label="Applies to"
                      name="appliesToMode"
                      value={formData.appliesTo.mode}
                      onChange={(e) =>
                        updateFormData('appliesTo', {
                          mode: e.target.value,
                          resources: [],
                        })
                      }
                    >
                      <s-option value="all">All products</s-option>
                      <s-option value="products">Specific products</s-option>
                      <s-option value="collections">Specific collections</s-option>
                    </s-select>
                  </s-box>
                  <s-box inlineSize="49%">
                    <s-select
                      label="Purchase type"
                      name="purchaseType"
                      value={purchaseType}
                      onChange={(e) => updateFormData('purchaseType', e.target.value)}
                    >
                      <s-option value="one_time">One-time purchase</s-option>
                      <s-option value="subscription">Subscription</s-option>
                      <s-option value="both">Both</s-option>
                    </s-select>
                  </s-box>
                </s-stack>

                {formData.appliesTo.mode !== "all" && (
                  <s-stack direction="block" gap="tight">
                    <s-button
                      type="button"
                      variant="secondary"
                      onClick={() =>
                        pickResources(
                          formData.appliesTo.mode === "products" ? "product" : "collection",
                        )
                      }
                    >
                      {formData.appliesTo.resources.length > 0
                        ? `${formData.appliesTo.resources.length} selected — change`
                        : `Browse ${formData.appliesTo.mode}`}
                    </s-button>
                    {formData.appliesTo.resources.length > 0 && (
                      <s-text tone="subdued">
                        {formData.appliesTo.resources.map((r) => r.title).join(", ")}
                      </s-text>
                    )}
                    <input
                      type="hidden"
                      name="appliesToIds"
                      value={formData.appliesTo.resources.map((r) => r.id).join(",")}
                    />
                    <input
                      type="hidden"
                      name="appliesToTitles"
                      value={formData.appliesTo.resources.map((r) => r.title).join("||")}
                    />
                  </s-stack>
                )}

                {/* --- Minimum requirement + Customer eligibility --- */}
                <s-stack direction="inline" gap="base" alignItems="start">
                  <s-box inlineSize="50%">
                    <s-stack direction="block" gap="tight">
                      <s-select
                        label="Minimum purchase requirement"
                        name="minimumRequirementMode"
                        value={formData.minimumRequirement.mode}
                        onChange={(e) =>
                          updateFormData('minimumRequirement', {
                            mode: e.target.value,
                            value: "",
                          })
                        }
                      >
                        <s-option value="none">None</s-option>
                        <s-option value="quantity">Minimum quantity of items</s-option>
                        <s-option value="amount">Minimum purchase amount</s-option>
                      </s-select>

                      {formData.minimumRequirement.mode === "quantity" && (
                        <s-number-field
                          label="Minimum quantity"
                          name="minimumRequirementValue"
                          min={1}
                          step={1}
                          value={formData.minimumRequirement.value}
                          onChange={(e) =>
                            updateFormData('minimumRequirement', {
                              ...formData.minimumRequirement,
                              value: e.target.value,
                            })
                          }
                        />
                      )}
                      {formData.minimumRequirement.mode === "amount" && (
                        <s-money-field
                          label="Minimum purchase amount"
                          name="minimumRequirementValue"
                          min={0.01}
                          value={formData.minimumRequirement.value}
                          onChange={(e) =>
                            updateFormData('minimumRequirement', {
                              ...formData.minimumRequirement,
                              value: e.target.value,
                            })
                          }
                        />
                      )}
                    </s-stack>
                  </s-box>

                  <s-box inlineSize="49%">
                    <s-stack direction="block" gap="tight">
                      <s-select
                        label="Customer eligibility"
                        name="customerEligibilityMode"
                        value={formData.customerEligibility.mode}
                        onChange={(e) =>
                          updateFormData('customerEligibility', {
                            mode: e.target.value,
                            segmentIds: [],
                            customerIds: [],
                            customerLabels: [],
                          })
                        }
                      >
                        <s-option value="all">All customers</s-option>
                        <s-option value="segments">Specific customer segments</s-option>
                        <s-option value="customers">Specific customers</s-option>
                      </s-select>

                      {formData.customerEligibility.mode === "segments" && (
                        <s-stack direction="block" gap="tight">
                          {segments.length === 0 ? (
                            <s-text tone="subdued">No customer segments found.</s-text>
                          ) : (
                            segments.map((segment) => {
                              const checked = formData.customerEligibility.segmentIds.includes(segment.id);
                              return (
                                <s-checkbox
                                  key={segment.id}
                                  label={segment.name}
                                  checked={checked}
                                  onChange={(e) => {
                                    const segmentIds = e.target.checked
                                      ? [...formData.customerEligibility.segmentIds, segment.id]
                                      : formData.customerEligibility.segmentIds.filter((id) => id !== segment.id);
                                    updateFormData('customerEligibility', {
                                      ...formData.customerEligibility,
                                      segmentIds,
                                    });
                                  }}
                                />
                              );
                            })
                          )}
                          <input
                            type="hidden"
                            name="customerSegmentIds"
                            value={formData.customerEligibility.segmentIds.join(",")}
                          />
                        </s-stack>
                      )}

                      {formData.customerEligibility.mode === "customers" && (
                        <s-stack direction="block" gap="base">
                          {formData.customerEligibility.customerLabels.length > 0 && (
                            <s-stack direction="block" gap="tight">
                              <s-text variant="bodySm" tone="subdued">
                                Selected customers ({formData.customerEligibility.customerLabels.length})
                              </s-text>
                              <s-stack direction="inline" gap="tight">
                                {formData.customerEligibility.customerLabels.map((c) => (
                                  <s-box
                                    key={c.id}
                                    padding="tight"
                                    borderRadius="base"
                                    borderWidth="base"
                                    borderColor="base"
                                    background="subdued"
                                  >
                                    <s-stack direction="inline" gap="tight" alignItems="center">
                                      <s-text variant="bodySm">{c.displayName}</s-text>
                                      <s-button
                                        type="button"
                                        variant="tertiary"
                                        icon="x"
                                        accessibilityLabel={`Remove ${c.displayName}`}
                                        onClick={() => removeCustomer(c.id)}
                                      ></s-button>
                                    </s-stack>
                                  </s-box>
                                ))}
                              </s-stack>
                            </s-stack>
                          )}

                          <s-text-field
                            label="Search customers"
                            placeholder="Search by name or email"
                            value={customerSearch.rowId === 'main' ? customerSearch.query : ""}
                            onChange={(e) => searchCustomers(e.target.value)}
                          />

                          {customerSearch.rowId === 'main' && customerSearch.query.trim() && (
                            <s-box
                              borderWidth="base"
                              borderColor="base"
                              borderRadius="base"
                              padding="tight"
                            >
                              {customerSearch.loading ? (
                                <s-box padding="base">
                                  <s-text tone="subdued">Searching…</s-text>
                                </s-box>
                              ) : customerSearch.results.length === 0 ? (
                                <s-box padding="base">
                                  <s-text tone="subdued">No customers found.</s-text>
                                </s-box>
                              ) : (
                                <s-stack direction="block" gap="none">
                                  {customerSearch.results.map((c) => {
                                    const alreadyAdded = formData.customerEligibility.customerIds.includes(c.id);
                                    return (
                                      <s-box
                                        key={c.id}
                                        padding="tight"
                                        borderBlockEnd="base"
                                      >
                                        <s-stack
                                          direction="inline"
                                          justifyContent="space-between"
                                          alignItems="center"
                                        >
                                          <s-stack direction="block" gap="none">
                                            <s-text variant="bodySm" fontWeight="medium">
                                              {c.displayName}
                                            </s-text>
                                            <s-text variant="bodySm" tone="subdued">
                                              {c.email}
                                            </s-text>
                                          </s-stack>
                                          <s-button
                                            type="button"
                                            variant="secondary"
                                            disabled={alreadyAdded}
                                            onClick={() => addCustomer(c)}
                                          >
                                            {alreadyAdded ? "Added" : "Add"}
                                          </s-button>
                                        </s-stack>
                                      </s-box>
                                    );
                                  })}
                                </s-stack>
                              )}
                            </s-box>
                          )}

                          <input
                            type="hidden"
                            name="customerIds"
                            value={formData.customerEligibility.customerIds.join(",")}
                          />
                        </s-stack>
                      )}
                    </s-stack>
                  </s-box>
                </s-stack>

                {(purchaseType === "subscription" || purchaseType === "both") && (
                  <s-stack direction="block" gap="tight">
                    <s-select
                      label="Recurring payments options"
                      name="recurringPaymentLimitMode"
                      value={recurringPaymentLimit.mode}
                      onChange={(e) =>
                        updateFormData('recurringPaymentLimit', {
                          mode: e.target.value,
                          value: "",
                        })
                      }
                      helpText="Includes payment on first order."
                    >
                      <s-option value="all">Discount applies to all recurring payments</s-option>
                      <s-option value="first">Limit discount to the first payment</s-option>
                      <s-option value="limited">Limit discount to multiple recurring payments</s-option>
                    </s-select>

                    {recurringPaymentLimit.mode === "limited" && (
                      <s-number-field
                        label="Multiple payments limit"
                        name="recurringPaymentLimitValue"
                        min={1}
                        step={1}
                        placeholder="1"
                        value={recurringPaymentLimit.value}
                        onChange={(e) =>
                          updateFormData('recurringPaymentLimit', {
                            ...recurringPaymentLimit,
                            value: e.target.value,
                          })
                        }
                      />
                    )}
                  </s-stack>
                )}

                {/* --- Total usage limit + Tags --- */}
                <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                  <s-box inlineSize="50%">
                    <s-number-field
                      label="Total usage limit per coupon"
                      name="usageLimit"
                      min={1}
                      step={1}
                      inputMode="numeric"
                      value={formData.usageLimit}
                      onChange={(e) => updateFormData('usageLimit', e.target.value)}
                      helpText="Leave empty for unlimited usage"
                    />
                  </s-box>
                  <s-box inlineSize="49%">
                    <s-text-field
                      label="Tags"
                      name="tags"
                      placeholder="loyalty, vip, summer-sale"
                      value={tags}
                      onChange={(e) => updateFormData('tags', e.target.value)}
                      helpText="Optional: Comma-separated keywords"
                    />
                  </s-box>
                </s-stack>

                <s-checkbox
                  label="Limit to one use per customer"
                  name="appliesOncePerCustomer"
                  checked={formData.appliesOncePerCustomer}
                  onChange={(e) =>
                    updateFormData('appliesOncePerCustomer', e.target.checked)
                  }
                />

                {/* --- Combinations --- */}
                <s-text variant="bodyMd" fontWeight="medium">Combinations</s-text>
                <s-checkbox
                  label="Combines with product discounts"
                  name="combinesWithProduct"
                  checked={formData.combinesWith.productDiscounts}
                  onChange={(e) =>
                    updateFormData('combinesWith', {
                      ...formData.combinesWith,
                      productDiscounts: e.target.checked,
                    })
                  }
                />
                <s-checkbox
                  label="Combines with order discounts"
                  name="combinesWithOrder"
                  checked={formData.combinesWith.orderDiscounts}
                  onChange={(e) =>
                    updateFormData('combinesWith', {
                      ...formData.combinesWith,
                      orderDiscounts: e.target.checked,
                    })
                  }
                />
                <s-checkbox
                  label="Combines with shipping discounts"
                  name="combinesWithShipping"
                  checked={formData.combinesWith.shippingDiscounts}
                  onChange={(e) =>
                    updateFormData('combinesWith', {
                      ...formData.combinesWith,
                      shippingDiscounts: e.target.checked,
                    })
                  }
                />

                {/* --- Active dates --- */}
                <s-stack direction="inline" gap="base">
                  <s-box inlineSize="50%">
                    <s-date-field
                      label="Start date"
                      name="startsAtDate"
                      value={formData.startsAtDate}
                      onChange={(e) => updateFormData('startsAtDate', e.target.value)}
                    />
                  </s-box>
                  <s-box inlineSize="50%">
                    <s-text-field
                      label="Start time"
                      type="time"
                      name="startsAtTime"
                      value={formData.startsAtTime}
                      onChange={(e) => updateFormData('startsAtTime', e.target.value)}
                    />
                  </s-box>
                </s-stack>

                <s-stack direction="inline" gap="base">
                  <s-box inlineSize="50%">
                    <s-date-field
                      label="End date"
                      name="endsAt"
                      value={formData.endsAt}
                      onChange={(e) => updateFormData('endsAt', e.target.value)}
                    />
                  </s-box>
                  <s-box inlineSize="50%">
                    <s-text-field
                      label="End time"
                      type="time"
                      name="endsAtTime"
                      value={formData.endsAtTime}
                      onChange={(e) => updateFormData('endsAtTime', e.target.value)}
                      disabled={!formData.endsAt}
                    />
                  </s-box>
                </s-stack>
              </s-stack>
            </s-card>

            {/* Action Buttons */}
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-button
                variant="primary"
                type="submit"
                disabled={!hasFunction}
                {...(isSubmitting ? { loading: true } : {})}
              >
                {isSubmitting
                  ? (isEditing ? 'Updating...' : 'Generating...')
                  : (isEditing ? 'Update Batch' : 'Generate Bulk Discounts')}
              </s-button>

              {!isEditing && (
                <s-button
                  type="button"
                  variant="secondary"
                  onClick={resetForm}
                >
                  Reset Form
                </s-button>
              )}

              {isEditing && (
                <Link to="/app/bulk-discount-sets">
                  <s-button type="button" variant="secondary">
                    Cancel
                  </s-button>
                </Link>
              )}
            </s-stack>
          </s-stack>
        </fetcher.Form>
      </s-section>
    </s-page>
  );
}

function findDefaultFunction(functions) {
  return (
    functions.find((shopifyFunction) =>
      shopifyFunction.title.toLowerCase().includes("max"),
    ) || functions[0]
  );
}

function parseBulkDiscountConfig(formData) {
  const discountType = formData.get("discountType")?.toString().trim() || "percentage";
  const isFreeShipping = discountType === "free_shipping";

  const discountValue = isFreeShipping ? 0 : Number(formData.get("discountValue"));
  const maxDiscountAmount = isFreeShipping ? null : Number(formData.get("maxDiscountAmount"));
  const usageLimit = normalizeUsageLimit(formData.get("usageLimit"));
  const startsAt = normalizeStartDateTime(
    formData.get("startsAtDate"),
    formData.get("startsAtTime")
  );
  const endsAt = normalizeEndDateTime(
    formData.get("endsAt"),
    formData.get("endsAtTime")
  );

  if (!["percentage", "fixed", "free_shipping"].includes(discountType)) {
    throw new Response("Choose percentage, fixed, or free shipping.", {
      status: 400,
    });
  }

  if (!isFreeShipping) {
    if (!Number.isFinite(discountValue) || discountValue <= 0) {
      throw new Response("Discount value must be greater than 0.", {
        status: 400,
      });
    }

    if (discountType === "percentage" && discountValue > 100) {
      throw new Response("Percentage cannot be more than 100%.", {
        status: 400,
      });
    }

    if (!Number.isFinite(maxDiscountAmount) || maxDiscountAmount <= 0) {
      throw new Response("Maximum discount amount must be greater than 0.", {
        status: 400,
      });
    }
  }

  const appliesTo = normalizeAppliesTo(
    formData.get("appliesToMode"),
    formData.get("appliesToIds"),
    formData.get("appliesToTitles")
  );
  const minimumRequirement = normalizeMinimumRequirement(
    formData.get("minimumRequirementMode"),
    formData.get("minimumRequirementValue")
  );
  const customerEligibility = normalizeCustomerEligibility(
    formData.get("customerEligibilityMode"),
    formData.get("customerSegmentIds"),
    formData.get("customerIds")
  );
  const purchaseType = normalizePurchaseType(formData.get("purchaseType"));
  const recurringCycleLimit = normalizeRecurringCycleLimit(
    purchaseType,
    formData.get("recurringPaymentLimitMode"),
    formData.get("recurringPaymentLimitValue")
  );
  const tags = normalizeTags(formData.get("tags"));

  return {
    discountType,
    discountValue,
    maxDiscountAmount,
    usageLimit,
    endsAt,
    startsAt,
    appliesOncePerCustomer: formData.get("appliesOncePerCustomer") === "on",
    combinesWith: {
      productDiscounts: formData.get("combinesWithProduct") === "on",
      orderDiscounts: formData.get("combinesWithOrder") === "on",
      shippingDiscounts: formData.get("combinesWithShipping") === "on",
    },
    appliesTo,
    minimumRequirement,
    customerEligibility,
    appliesOnOneTimePurchase: purchaseType.oneTime,
    appliesOnSubscription: purchaseType.subscription,
    recurringCycleLimit,
    tags,
  };
}

function normalizePurchaseType(purchaseTypeRaw) {
  const mode = purchaseTypeRaw?.toString().trim() || "both";

  if (!["one_time", "subscription", "both"].includes(mode)) {
    throw new Response("Invalid purchase type selection.", { status: 400 });
  }

  return {
    oneTime: mode === "one_time" || mode === "both",
    subscription: mode === "subscription" || mode === "both",
  };
}

function normalizeRecurringCycleLimit(purchaseType, mode, value) {
  // Only meaningful when the discount applies to subscriptions at all.
  if (!purchaseType.subscription) {
    return null;
  }

  const normalizedMode = mode?.toString().trim() || "all";

  if (!["all", "first", "limited"].includes(normalizedMode)) {
    throw new Response("Invalid recurring payment limit selection.", {
      status: 400,
    });
  }

  // 0 = applies to every recurring payment indefinitely.
  if (normalizedMode === "all") {
    return 0;
  }

  // 1 = applies to the first payment only (includes the first order, per Shopify's semantics).
  if (normalizedMode === "first") {
    return 1;
  }

  const numericValue = Number(value);

  if (!Number.isInteger(numericValue) || numericValue < 1) {
    throw new Response(
      "Multiple payments limit must be a whole number of 1 or more.",
      { status: 400 },
    );
  }

  return numericValue;
}

function normalizeTags(tagsRaw) {
  const raw = tagsRaw?.toString().trim() || "";
  if (!raw) {
    return [];
  }

  return raw
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function normalizeAppliesTo(mode, idsCsv, titlesDelimited) {
  const normalizedMode = mode?.toString().trim() || "all";
 
  if (!["all", "products", "collections"].includes(normalizedMode)) {
    throw new Response("Invalid 'applies to' selection.", { status: 400 });
  }
 
  if (normalizedMode === "all") {
    return { mode: "all", resources: [] };
  }
 
  const ids = (idsCsv?.toString() || "").split(",").filter(Boolean);
  const titles = (titlesDelimited?.toString() || "").split("||").filter((_, i) => i < ids.length);
 
  if (ids.length === 0) {
    throw new Response(`Select at least one ${normalizedMode.slice(0, -1)}.`, {
      status: 400,
    });
  }
 
  return {
    mode: normalizedMode,
    resources: ids.map((id, i) => ({ id, title: titles[i] || id })),
  };
}

function normalizeMinimumRequirement(mode, value) {
  const normalizedMode = mode?.toString().trim() || "none";

  if (!["none", "quantity", "amount"].includes(normalizedMode)) {
    throw new Response("Invalid minimum requirement selection.", { status: 400 });
  }

  if (normalizedMode === "none") {
    return { mode: "none", value: null };
  }

  const numericValue = Number(value);

  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    throw new Response("Minimum requirement value must be greater than 0.", {
      status: 400,
    });
  }

  return { mode: normalizedMode, value: numericValue };
}

function normalizeCustomerEligibility(mode, segmentIdsCsv, customerIdsCsv) {
  const normalizedMode = mode?.toString().trim() || "all";

  if (!["all", "segments", "customers"].includes(normalizedMode)) {
    throw new Response("Invalid customer eligibility selection.", { status: 400 });
  }

  if (normalizedMode === "segments") {
    const segmentIds = (segmentIdsCsv?.toString() || "").split(",").filter(Boolean);
    if (segmentIds.length === 0) {
      throw new Response("Select at least one customer segment.", { status: 400 });
    }
    return { mode: "segments", segmentIds, customerIds: [] };
  }

  if (normalizedMode === "customers") {
    const customerIds = (customerIdsCsv?.toString() || "").split(",").filter(Boolean);
    if (customerIds.length === 0) {
      throw new Response("Select at least one customer.", { status: 400 });
    }
    return { mode: "customers", segmentIds: [], customerIds };
  }

  return { mode: "all", segmentIds: [], customerIds: [] };
}

function toFunctionDiscount(discount) {
  return {
    title: discount.title,
    discountType: discount.discountType,
    discountValue: discount.discountValue,
    maxDiscountAmount: discount.maxDiscountAmount,
    appliesTo: discount.appliesTo,
    minimumRequirement: discount.minimumRequirement,
    customerEligibility: discount.customerEligibility,
  };
}

function formatActionCoupon(codeAppDiscount, discountConfig) {
  return {
    id: codeAppDiscount.discountId,
    code: codeAppDiscount.codes.nodes[0]?.code || discountConfig.code,
    title: codeAppDiscount.title,
    status: codeAppDiscount.status,
    startsAt: discountConfig.startsAt,
    endsAt: codeAppDiscount.endsAt || discountConfig.endsAt,
    usageLimit: codeAppDiscount.usageLimit || discountConfig.usageLimit,
    appliesOncePerCustomer:
      codeAppDiscount.appliesOncePerCustomer ?? discountConfig.appliesOncePerCustomer,
    combinesWith: codeAppDiscount.combinesWith || discountConfig.combinesWith,
    discountType: discountConfig.discountType,
    discountValue: discountConfig.discountValue,
    maxDiscountAmount: discountConfig.maxDiscountAmount,
    appliesTo: discountConfig.appliesTo,
    minimumRequirement: discountConfig.minimumRequirement,
    customerEligibility: discountConfig.customerEligibility,
    appliesOnOneTimePurchase:
      codeAppDiscount.appliesOnOneTimePurchase ?? discountConfig.appliesOnOneTimePurchase,
    appliesOnSubscription:
      codeAppDiscount.appliesOnSubscription ?? discountConfig.appliesOnSubscription,
    recurringCycleLimit:
      codeAppDiscount.recurringCycleLimit ?? discountConfig.recurringCycleLimit,
    tags: codeAppDiscount.tags || discountConfig.tags,
  };
}

function normalizeUsageLimit(value) {
  const rawValue = value?.toString().trim();

  if (!rawValue) {
    return null;
  }

  const usageLimit = Number(rawValue);

  if (!Number.isInteger(usageLimit) || usageLimit <= 0) {
    throw new Response("Usage limit must be a positive whole number.", {
      status: 400,
    });
  }

  return usageLimit;
}

function normalizeStartDateTime(dateValue, timeValue) {
  const rawDate = dateValue?.toString().trim();

  if (!rawDate) {
    return null;
  }

  const time = timeValue?.toString().trim() || "00:00";
  return new Date(`${rawDate}T${time}:00.000Z`).toISOString();
}

function normalizeEndDateTime(dateValue, timeValue) {
  const rawDate = dateValue?.toString().trim();

  if (!rawDate) {
    return null;
  }

  const time = timeValue?.toString().trim() || "23:59";
  return new Date(`${rawDate}T${time}:59.000Z`).toISOString();
}

function requiredString(formData, key) {
  const value = formData.get(key)?.toString().trim();

  if (!value) {
    throw new Response(`${key} is required`, { status: 400 });
  }

  return value;
}

function createInitialFormData(editingBatch) {
  if (editingBatch) {
    const t = editingBatch.template || {};
    return {
      numberOfCoupons: editingBatch.count || 10,
      prefix: editingBatch.prefix || "",
      discountType: t.discountType || "percentage",
      discountValue: t.discountValue ?? "",
      maxDiscountAmount: t.maxDiscountAmount ?? "",
      usageLimit: t.usageLimit ?? "",
      endsAt: formatDateForInput(t.endsAt),
      endsAtTime: formatTimeForInput(t.endsAt) || "23:59",
      startsAtDate: formatDateForInput(t.startsAt) || formatDateForInput(new Date().toISOString()),
      startsAtTime: formatTimeForInput(t.startsAt) || formatTimeForInput(new Date().toISOString()),
      appliesOncePerCustomer: t.appliesOncePerCustomer || false,
      combinesWith: {
        orderDiscounts: t.combinesWith?.orderDiscounts ?? true,
        productDiscounts: t.combinesWith?.productDiscounts ?? true,
        shippingDiscounts: t.combinesWith?.shippingDiscounts ?? true,
      },
      // Resource titles aren't stored in the template (only IDs), so the
      // "Browse products/collections" picker will show a count but not
      // titles until the user re-opens the picker — acceptable trade-off
      // for avoiding a live lookup on every page load.
      appliesTo: {
        mode: t.appliesTo?.mode || "all",
        resources: t.appliesTo?.resources || [],
      },
      minimumRequirement: {
        mode: t.minimumRequirement?.mode || "none",
        value: t.minimumRequirement?.value ?? "",
      },
      customerEligibility: {
        mode: t.customerEligibility?.mode || "all",
        segmentIds: t.customerEligibility?.segmentIds || [],
        customerIds: t.customerEligibility?.customerIds || [],
        customerLabels: [],
      },
      purchaseType: t.appliesOnSubscription && t.appliesOnOneTimePurchase
        ? "both"
        : t.appliesOnSubscription
          ? "subscription"
          : "one_time",
      recurringPaymentLimit: {
        mode:
          t.recurringCycleLimit === 1
            ? "first"
            : t.recurringCycleLimit && t.recurringCycleLimit > 1
              ? "limited"
              : "all",
        value: t.recurringCycleLimit && t.recurringCycleLimit > 1 ? t.recurringCycleLimit : "",
      },
      tags: (t.tags || []).join(", "),
    };
  }

  return {
    numberOfCoupons: 10,
    prefix: "",
    discountType: "percentage",
    discountValue: "",
    maxDiscountAmount: "",
    usageLimit: "",
    endsAt: "",
    endsAtTime: "23:59",
    startsAtDate: formatDateForInput(new Date().toISOString()),
    startsAtTime: formatTimeForInput(new Date().toISOString()),
    appliesOncePerCustomer: false,
    combinesWith: {
      orderDiscounts: true,
      productDiscounts: true,
      shippingDiscounts: true,
    },
    appliesTo: { mode: "all", resources: [] },
    minimumRequirement: { mode: "none", value: "" },
    customerEligibility: {
      mode: "all",
      segmentIds: [],
      customerIds: [],
      customerLabels: [],
    },
    purchaseType: "both",
    recurringPaymentLimit: { mode: "all", value: "" },
    tags: "",
  };
}

function formatDateForInput(value) {
  if (!value) {
    return "";
  }
  return value.slice(0, 10);
}

function formatTimeForInput(value) {
  if (!value) {
    return "";
  }
  return value.slice(11, 16);
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};