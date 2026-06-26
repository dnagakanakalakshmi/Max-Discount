import { useEffect, useState } from "react";
import { useFetcher, useLoaderData, Link } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

const CONFIG_NAMESPACE = "$app";
const CONFIG_KEY = "config";

// Add these helper functions here
function readMetafieldJson(metafield) {
  if (!metafield) {
    return null;
  }

  if (metafield.jsonValue) {
    return metafield.jsonValue;
  }

  if (!metafield.value) {
    return null;
  }

  try {
    return JSON.parse(metafield.value);
  } catch {
    return null;
  }
}

function parseDiscountTitle(title) {
  const percentageMatch = title.match(/^(\d+(?:\.\d+)?)%\s+off\s+up\s+to\s+(\d+(?:\.\d+)?)/i);

  if (percentageMatch) {
    return {
      discountType: "percentage",
      discountValue: Number(percentageMatch[1]),
      maxDiscountAmount: Number(percentageMatch[2]),
    };
  }

  const fixedMatch = title.match(/^(\d+(?:\.\d+)?)\s+off\s+up\s+to\s+(\d+(?:\.\d+)?)/i);

  if (fixedMatch) {
    return {
      discountType: "fixed",
      discountValue: Number(fixedMatch[1]),
      maxDiscountAmount: Number(fixedMatch[2]),
    };
  }

  return null;
}

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const editId = url.searchParams.get("edit");

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


  // If editing, fetch the coupon data
  let editData = null;
  if (editId) {
    const discountResponse = await admin.graphql(
      `#graphql
        query GetDiscount($id: ID!) {
          discountNode(id: $id) {
            id
            discount {
              __typename
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
                tags
                combinesWith {
                  orderDiscounts
                  productDiscounts
                  shippingDiscounts
                }
                appDiscountType {
                  functionId
                }
                codes(first: 1) {
                  nodes {
                    code
                  }
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
        }`,
      {
        variables: { id: editId },
      }
    );

    const discountJson = await discountResponse.json();
    const node = discountJson.data.discountNode;
    
    if (node && node.discount.__typename === "DiscountCodeApp") {
      // Parse the config from metafield
      const config = readMetafieldJson(node.metafield);
      const discountConfig = config?.discounts?.[0] || null;
      
      // Parse the title as fallback
      const fallbackConfig = parseDiscountTitle(node.discount.title);
      const displayConfig = discountConfig || fallbackConfig;

      // Determine purchase type
      const appliesOnOneTime = node.discount.appliesOnOneTimePurchase ?? true;
      const appliesOnSubscription = node.discount.appliesOnSubscription ?? false;
      let purchaseType = "both";
      if (appliesOnOneTime && !appliesOnSubscription) purchaseType = "one_time";
      else if (!appliesOnOneTime && appliesOnSubscription) purchaseType = "subscription";
      else if (appliesOnOneTime && appliesOnSubscription) purchaseType = "both";

      editData = {
        id: node.id,
        code: node.discount.codes.nodes[0]?.code || "",
        title: node.discount.title,
        status: node.discount.status,
        startsAt: node.discount.startsAt,
        endsAt: node.discount.endsAt,
        usageLimit: node.discount.usageLimit,
        appliesOncePerCustomer: node.discount.appliesOncePerCustomer || false,
        combinesWith: {
          orderDiscounts: node.discount.combinesWith?.orderDiscounts ?? true,
          productDiscounts: node.discount.combinesWith?.productDiscounts ?? true,
          shippingDiscounts: node.discount.combinesWith?.shippingDiscounts ?? true,
        },
        discountType: displayConfig?.discountType || "percentage",
        discountValue: displayConfig?.discountValue || "",
        maxDiscountAmount: displayConfig?.maxDiscountAmount || "",
        appliesTo: normalizeAppliesToForEdit(displayConfig?.appliesTo),
        minimumRequirement: displayConfig?.minimumRequirement || { mode: "none", value: "" },
        purchaseType: purchaseType,
        recurringCycleLimit: node.discount.recurringCycleLimit || 0,
        tags: (node.discount.tags || []).join(", "),
        // For customer eligibility, we need to parse from the config if available
        customerEligibility: displayConfig?.customerEligibility || { 
          mode: "all", 
          segmentIds: [], 
          customerIds: [],
          customerLabels: []
        },
      };
    }
  }

  return {
    functions,
    selectedFunctionId,
    segments,
    editData,
    isEditing: !!editId,
  };
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();

  const intent = formData.get("intent")?.toString() || "create";

  const functionId = requiredString(formData, "functionId");
  const discounts = parseFormDiscounts(formData);
  const createdDiscounts = [];
  const errors = [];

  for (const discount of discounts) {
    const config = {
      discounts: [toFunctionDiscount(discount)],
    };

    const mutation =
      intent === "update"
        ? `#graphql
          mutation UpdateMaxDiscountCode($id: ID!, $codeAppDiscount: DiscountCodeAppInput!) {
            discountCodeAppUpdate(id: $id, codeAppDiscount: $codeAppDiscount) {
              codeAppDiscount {
                discountId
                title
                status
                usageLimit
                endsAt
                appliesOncePerCustomer
                appliesOnOneTimePurchase
                appliesOnSubscription
                recurringCycleLimit
                tags
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
              userErrors {
                field
                message
              }
            }
          }`
        : `#graphql
          mutation CreateMaxDiscountCode($codeAppDiscount: DiscountCodeAppInput!) {
            discountCodeAppCreate(codeAppDiscount: $codeAppDiscount) {
              codeAppDiscount {
                discountId
                title
                status
                appliesOncePerCustomer
                appliesOnOneTimePurchase
                appliesOnSubscription
                recurringCycleLimit
                tags
                combinesWith {
                  orderDiscounts
                  productDiscounts
                  shippingDiscounts
                }
                appDiscountType {
                  functionId
                }
                codes(first: 5) {
                  nodes {
                    code
                  }
                }
              }
              userErrors {
                field
                message
              }
            }
          }`;

    const response = await admin.graphql(mutation, {
      variables: {
        ...(intent === "update"
          ? { id: requiredString(formData, "discountId") }
          : {}),
        codeAppDiscount: buildCodeAppDiscountInput({
          discount,
          functionId,
          config,
        }),
      },
    });

    const responseJson = await response.json();
    const payload =
      intent === "update"
        ? responseJson.data.discountCodeAppUpdate
        : responseJson.data.discountCodeAppCreate;

    if (payload.userErrors.length) {
      errors.push(
        ...payload.userErrors.map((error) => `${discount.code}: ${error.message}`),
      );
    } else {
      createdDiscounts.push(formatActionCoupon(payload.codeAppDiscount, discount));
    }
  }

  return {
    discounts: createdDiscounts,
    discount: createdDiscounts[0],
    errors,
    intent,
  };
};

function buildCodeAppDiscountInput({ discount, functionId, config }) {
  const isFreeShipping = discount.discountType === "free_shipping";
  return {
    code: discount.code,
    title: discount.title,
    functionId,

    // Native fields — supported directly by DiscountCodeAppInput.
    discountClasses: isFreeShipping ? ["SHIPPING"] : ["ORDER"],
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

    // Everything below has no native slot on DiscountCodeAppInput (applies-to,
    // minimum requirement, free-shipping flag, discount math) so it's passed
    // through to the Function via the config metafield instead.
    metafields: [
      {
        namespace: CONFIG_NAMESPACE,
        key: CONFIG_KEY,
        type: "json",
        value: JSON.stringify(config),
      },
      {
        namespace: CONFIG_NAMESPACE,
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

function normalizeAppliesToForEdit(appliesTo) {
  if (!appliesTo) {
    return { mode: "all", resources: [] };
  }
  if (Array.isArray(appliesTo.resources)) {
    return { mode: appliesTo.mode, resources: appliesTo.resources };
  }
  if (Array.isArray(appliesTo.ids)) {
    // legacy shape — no titles available, fall back to showing the ID
    return {
      mode: appliesTo.mode,
      resources: appliesTo.ids.map((id) => ({ id, title: id })),
    };
  }
  return { mode: "all", resources: [] };
}

export default function Index() {
  const { selectedFunctionId, segments, editData, isEditing } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  // Initialize with edit data if available, otherwise empty row
  const [discountRows, setDiscountRows] = useState(() => {
    if (editData) {
      return [{
        id: crypto.randomUUID(),
        code: editData.code || "",
        discountType: editData.discountType || "percentage",
        discountValue: editData.discountValue?.toString() || "",
        maxDiscountAmount: editData.maxDiscountAmount?.toString() || "",
        usageLimit: editData.usageLimit?.toString() || "",
        endsAt: editData.endsAt ? formatDateForInput(editData.endsAt) : "",
        endsAtTime: editData.endsAt ? formatTimeForInput(editData.endsAt) : "23:59",
        startsAt: editData.startsAt || "",
        startsAtDate: editData.startsAt ? formatDateForInput(editData.startsAt) : formatDateForInput(new Date().toISOString()),
        startsAtTime: editData.startsAt ? formatTimeForInput(editData.startsAt) : formatTimeForInput(new Date().toISOString()),
        appliesOncePerCustomer: editData.appliesOncePerCustomer ?? false,
        combinesWith: editData.combinesWith || {
          orderDiscounts: true,
          productDiscounts: true,
          shippingDiscounts: true,
        },
        appliesTo: editData.appliesTo || { mode: "all", resources: [] },
        minimumRequirement: editData.minimumRequirement || { mode: "none", value: "" },
        customerEligibility: editData.customerEligibility || {
          mode: "all",
          segmentIds: [],
          customerIds: [],
          customerLabels: [],
        },
        purchaseType: editData.purchaseType || "both",
        recurringPaymentLimit: editData.recurringCycleLimit !== undefined && editData.recurringCycleLimit !== null
          ? toRecurringPaymentLimitState(editData.recurringCycleLimit)
          : { mode: "all", value: "" },
        tags: editData.tags || "",
      }];
    }
    return [createDiscountRow()];
  });
  const [editingCoupon, setEditingCoupon] = useState(isEditing ? editData : null);
  const isSubmitting = fetcher.state === "submitting";
  const hasFunction = Boolean(selectedFunctionId);
  const createdDiscounts = fetcher.data?.discounts || [];
  const createdDiscount = fetcher.data?.discount || createdDiscounts[0];
  const errors = fetcher.data?.errors || [];

  useEffect(() => {
    if (createdDiscount?.id) {
      const message = fetcher.data?.intent === "update"
        ? "Discount code updated successfully"
        : `${createdDiscounts.length} coupon${createdDiscounts.length > 1 ? 's' : ''} created successfully`;

      shopify.toast.show(message);
    }
  }, [createdDiscount?.id, fetcher.data?.intent, shopify, createdDiscounts.length]);

  const addDiscountRow = () => {
    setDiscountRows((rows) => [...rows, createDiscountRow()]);
  };

  const removeDiscountRow = (rowId) => {
    setDiscountRows((rows) => rows.filter((row) => row.id !== rowId));
  };

  const updateDiscountRow = (rowId, patch) => {
    setDiscountRows((rows) =>
      rows.map((row) => (row.id === rowId ? { ...row, ...patch } : row)),
    );
  };

  const editCoupon = (coupon) => {
    setEditingCoupon(coupon);
    setDiscountRows([
      createDiscountRow({
        code: coupon.code,
        discountType: coupon.discountType,
        discountValue: coupon.discountValue,
        maxDiscountAmount: coupon.maxDiscountAmount,
        usageLimit: coupon.usageLimit || "",
        endsAt: formatDateForInput(coupon.endsAt),
        endsAtTime: formatTimeForInput(coupon.endsAt),
        startsAt: coupon.startsAt,
        startsAtDate: formatDateForInput(coupon.startsAt),
        startsAtTime: formatTimeForInput(coupon.startsAt),
        appliesOncePerCustomer: coupon.appliesOncePerCustomer,
        combinesWith: coupon.combinesWith,
        customerEligibility: coupon.customerEligibility,
        appliesTo: coupon.appliesTo,
        minimumRequirement: coupon.minimumRequirement,
        purchaseType: coupon.purchaseType,
        recurringPaymentLimit: coupon.recurringPaymentLimit,
        tags: (coupon.tags || []).join(", "),
      }),
    ]);
  };

  const cancelEdit = () => {
    setEditingCoupon(null);
    setDiscountRows([createDiscountRow()]);
  };

  const getButtonText = () => {
    if (editingCoupon) return "Update coupon";
    const count = discountRows.length;
    if (count === 1) return "Create Discount";
    return `Create ${count} Discounts`;
  };

  // Opens the native Shopify resource picker (App Bridge) for products or
  // collections, and stores the picked GIDs/titles on the given row.
  const pickResources = async (rowId, resourceType) => {
  
    const row = discountRows.find((r) => r.id === rowId);
    const initialSelectionIds = row.appliesTo.resources.map((r) => ({ id: r.id }));
    const selection = await shopify.resourcePicker({
      type: resourceType, // "product" or "collection"
      multiple: true,
      selectionIds: initialSelectionIds, 
    });

    if (!selection) return;

    const picked = selection.map((item) => ({
      id: item.id,
      title: item.title || item.handle,
    }));

    updateDiscountRow(rowId, {
      appliesTo: {
        mode: resourceType === "product" ? "products" : "collections",
        resources: picked,
      },
    });
  };

  // WITH this — App Bridge has no customer resource picker, so we search via our own action/loader instead.
  const [customerSearch, setCustomerSearch] = useState({ rowId: null, query: "", results: [], loading: false });

  const searchCustomers = async (rowId, query) => {
    setCustomerSearch({ rowId, query, results: [], loading: true });

    if (!query.trim()) {
      setCustomerSearch({ rowId, query, results: [], loading: false });
      return;
    }

    const response = await fetch(`/app/customer-search?q=${encodeURIComponent(query)}`);
  const data = await response.json();
    setCustomerSearch({ rowId, query, results: data.customers || [], loading: false });
  };

  const addCustomer = (rowId, customer) => {
    const row = discountRows.find((r) => r.id === rowId);
    if (row.customerEligibility.customerIds.includes(customer.id)) return;

    updateDiscountRow(rowId, {
      customerEligibility: {
        ...row.customerEligibility,
        mode: "customers",
        customerIds: [...row.customerEligibility.customerIds, customer.id],
        customerLabels: [...row.customerEligibility.customerLabels, customer],
      },
    });
  };

  const removeCustomer = (rowId, customerId) => {
    const row = discountRows.find((r) => r.id === rowId);
    const index = row.customerEligibility.customerIds.indexOf(customerId);
    if (index === -1) return;

    updateDiscountRow(rowId, {
      customerEligibility: {
        ...row.customerEligibility,
        customerIds: row.customerEligibility.customerIds.filter((id) => id !== customerId),
        customerLabels: row.customerEligibility.customerLabels.filter((c) => c.id !== customerId),
      },
    });
  };

  return (
    <s-page inlineSize="base">
      <s-section>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <s-text variant="headingMd">{editingCoupon ? "Edit coupon" : "Create coupons"}</s-text>
          <Link to="/app">
            <s-button variant="primary" icon="arrow-left">Go to dashboard</s-button>
          </Link>
        </div>

        <fetcher.Form method="post">
          <s-stack direction="block" gap="base">
            {!hasFunction && (
              <s-banner tone="critical" heading="Discount Function not found">
                Deploy the max-discount Function extension, then reload this
                page to create coupons.
              </s-banner>
            )}

            {errors.length > 0 && (
              <s-banner tone="critical" heading="Coupon was not created">
                <s-unordered-list>
                  {errors.map((error) => (
                    <s-list-item key={error}>{error}</s-list-item>
                  ))}
                </s-unordered-list>
              </s-banner>
            )}

            <input type="hidden" name="discountCount" value={discountRows.length} />
            <input type="hidden" name="functionId" value={selectedFunctionId} />
            <input type="hidden" name="intent" value={editingCoupon ? "update" : "create"} />
            {editingCoupon && (
              <input type="hidden" name="discountId" value={editingCoupon.id} />
            )}

            <s-stack direction="block" gap="base">
              {discountRows.map((row, index) => (
                <s-section key={row.id} heading={`Coupon ${index + 1}`} padding="base">
                  <s-stack direction="block" gap="base">
                    <s-text-field
                      label="Coupon code"
                      name={`discounts[${index}][code]`}
                      placeholder="SAVE10"
                      value={row.code}
                      onChange={(e) => updateDiscountRow(row.id, { code: e.target.value })}
                      required
                    />

                    {/* --- Value --- */}
                    <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                      <s-box inlineSize="50%">
                        <s-select
                          label="Discount type"
                          name={`discounts[${index}][discountType]`}
                          value={row.discountType}
                          onChange={(e) =>
                            updateDiscountRow(row.id, { discountType: e.target.value })
                          }
                          required
                        >
                          <s-option value="percentage">Percentage off</s-option>
                          <s-option value="fixed">Flat amount off</s-option>
                          <s-option value="free_shipping">Free shipping</s-option>
                        </s-select>
                      </s-box>
                      {row.discountType !== "free_shipping" && (
                        <s-box inlineSize="49%">
                          <s-number-field
                            label="Discount value"
                            name={`discounts[${index}][discountValue]`}
                            min={0.01}
                            step={0.01}
                            placeholder="10"
                            value={row.discountValue}
                            onChange={(e) =>
                              updateDiscountRow(row.id, { discountValue: e.target.value })
                            }
                            required
                          />
                        </s-box>
                      )}
                    </s-stack>

                    {row.discountType !== "free_shipping" && (
                      <s-money-field
                        label="Maximum discount amount"
                        name={`discounts[${index}][maxDiscountAmount]`}
                        min={0.01}
                        max={999999}
                        placeholder="100"
                        value={row.maxDiscountAmount}
                        onChange={(e) =>
                          updateDiscountRow(row.id, { maxDiscountAmount: e.target.value })
                        }
                        required
                      />
                    )}

                    {/* --- Applies to + Purchase type --- */}
                    <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                      <s-box inlineSize="50%">
                        <s-select
                          label="Applies to"
                          name={`discounts[${index}][appliesToMode]`}
                          value={row.appliesTo.mode}
                          onChange={(e) =>
                            updateDiscountRow(row.id, {
                              appliesTo: { mode: e.target.value, resources: [] },
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
                          name={`discounts[${index}][purchaseType]`}
                          value={row.purchaseType}
                          onChange={(e) =>
                            updateDiscountRow(row.id, { purchaseType: e.target.value })
                          }
                        >
                          <s-option value="both">One-time purchases and subscriptions</s-option>
                          <s-option value="one_time">One-time purchases only</s-option>
                          <s-option value="subscription">Subscriptions only</s-option>
                        </s-select>
                      </s-box>
                    </s-stack>

                    {row.appliesTo.mode !== "all" && (
                      <s-stack direction="block" gap="tight">
                        <s-button
                          type="button"
                          variant="secondary"
                          onClick={() =>
                            pickResources(
                              row.id,
                              row.appliesTo.mode === "products" ? "product" : "collection",
                            )
                          }
                        >
                          {row.appliesTo.resources.length > 0
                            ? `${row.appliesTo.resources.length} selected — change`
                            : `Browse ${row.appliesTo.mode}`}
                        </s-button>
                        {row.appliesTo.resources.length > 0 && (
                          <s-text tone="subdued">
                            {row.appliesTo.resources.map((r) => r.title).join(", ")}
                          </s-text>
                        )}
                        <input
                          type="hidden"
                          name={`discounts[${index}][appliesToIds]`}
                          value={row.appliesTo.resources.map((r) => r.id).join(",")}
                        />
                        <input
                          type="hidden"
                          name={`discounts[${index}][appliesToTitles]`}
                          value={row.appliesTo.resources.map((r) => r.title).join("||")}
                        />
                      </s-stack>
                    )}

                    {/* --- Minimum requirement + Customer eligibility --- */}
                    <s-stack direction="inline" gap="base" alignItems="start">
                      <s-box inlineSize="50%">
                        <s-stack direction="block" gap="tight">
                          <s-select
                            label="Minimum purchase requirement"
                            name={`discounts[${index}][minimumRequirementMode]`}
                            value={row.minimumRequirement.mode}
                            onChange={(e) =>
                              updateDiscountRow(row.id, {
                                minimumRequirement: { mode: e.target.value, value: "" },
                              })
                            }
                          >
                            <s-option value="none">None</s-option>
                            <s-option value="quantity">Minimum quantity of items</s-option>
                            <s-option value="amount">Minimum purchase amount</s-option>
                          </s-select>

                          {row.minimumRequirement.mode === "quantity" && (
                            <s-number-field
                              label="Minimum quantity"
                              name={`discounts[${index}][minimumRequirementValue]`}
                              min={1}
                              step={1}
                              value={row.minimumRequirement.value}
                              onChange={(e) =>
                                updateDiscountRow(row.id, {
                                  minimumRequirement: { ...row.minimumRequirement, value: e.target.value },
                                })
                              }
                            />
                          )}
                          {row.minimumRequirement.mode === "amount" && (
                            <s-money-field
                              label="Minimum purchase amount"
                              name={`discounts[${index}][minimumRequirementValue]`}
                              min={0.01}
                              value={row.minimumRequirement.value}
                              onChange={(e) =>
                                updateDiscountRow(row.id, {
                                  minimumRequirement: { ...row.minimumRequirement, value: e.target.value },
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
                            name={`discounts[${index}][customerEligibilityMode]`}
                            value={row.customerEligibility.mode}
                            onChange={(e) =>
                              updateDiscountRow(row.id, {
                                customerEligibility: {
                                  mode: e.target.value,
                                  segmentIds: [],
                                  customerIds: [],
                                  customerLabels: [],
                                },
                              })
                            }
                          >
                            <s-option value="all">All customers</s-option>
                            <s-option value="segments">Specific customer segments</s-option>
                            <s-option value="customers">Specific customers</s-option>
                          </s-select>

                          {row.customerEligibility.mode === "segments" && (
                            <s-stack direction="block" gap="tight">
                              {segments.length === 0 ? (
                                <s-text tone="subdued">No customer segments found.</s-text>
                              ) : (
                                segments.map((segment) => {
                                  const checked = row.customerEligibility.segmentIds.includes(segment.id);
                                  return (
                                    <s-checkbox
                                      key={segment.id}
                                      label={segment.name}
                                      checked={checked}
                                      onChange={(e) => {
                                        const segmentIds = e.target.checked
                                          ? [...row.customerEligibility.segmentIds, segment.id]
                                          : row.customerEligibility.segmentIds.filter((id) => id !== segment.id);
                                        updateDiscountRow(row.id, {
                                          customerEligibility: { ...row.customerEligibility, segmentIds },
                                        });
                                      }}
                                    />
                                  );
                                })
                              )}
                              <input
                                type="hidden"
                                name={`discounts[${index}][customerSegmentIds]`}
                                value={row.customerEligibility.segmentIds.join(",")}
                              />
                            </s-stack>
                          )}

                          {row.customerEligibility.mode === "customers" && (
                            <s-stack direction="block" gap="base">
                              {row.customerEligibility.customerLabels.length > 0 && (
                                <s-stack direction="block" gap="tight">
                                  <s-text variant="bodySm" tone="subdued">
                                    Selected customers ({row.customerEligibility.customerLabels.length})
                                  </s-text>
                                  <s-stack direction="inline" gap="tight">
                                    {row.customerEligibility.customerLabels.map((c) => (
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
                                            onClick={() => removeCustomer(row.id, c.id)}
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
                                value={customerSearch.rowId === row.id ? customerSearch.query : ""}
                                onChange={(e) => searchCustomers(row.id, e.target.value)}
                              />

                              {customerSearch.rowId === row.id && customerSearch.query.trim() && (
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
                                        const alreadyAdded = row.customerEligibility.customerIds.includes(c.id);
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
                                                onClick={() => addCustomer(row.id, c)}
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
                                name={`discounts[${index}][customerIds]`}
                                value={row.customerEligibility.customerIds.join(",")}
                              />
                              <input
                                type="hidden"
                                name={`discounts[${index}][customerLabels]`}
                                value={JSON.stringify(row.customerEligibility.customerLabels)}
                              />
                            </s-stack>
                          )}
                        </s-stack>
                      </s-box>
                    </s-stack>

                    {(row.purchaseType === "subscription" || row.purchaseType === "both") && (
                      <s-stack direction="block" gap="tight">
                        <s-select
                          label="Recurring payments options"
                          name={`discounts[${index}][recurringPaymentLimitMode]`}
                          value={row.recurringPaymentLimit.mode}
                          onChange={(e) =>
                            updateDiscountRow(row.id, {
                              recurringPaymentLimit: { mode: e.target.value, value: "" },
                            })
                          }
                          helpText="Includes payment on first order."
                        >
                          <s-option value="all">Discount applies to all recurring payments</s-option>
                          <s-option value="first">Limit discount to the first payment</s-option>
                          <s-option value="limited">Limit discount to multiple recurring payments</s-option>
                        </s-select>

                        {row.recurringPaymentLimit.mode === "limited" && (
                          <s-number-field
                            label="Multiple payments limit"
                            name={`discounts[${index}][recurringPaymentLimitValue]`}
                            min={1}
                            step={1}
                            placeholder="1"
                            value={row.recurringPaymentLimit.value}
                            onChange={(e) =>
                              updateDiscountRow(row.id, {
                                recurringPaymentLimit: {
                                  ...row.recurringPaymentLimit,
                                  value: e.target.value,
                                },
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
                          label="Total usage limit"
                          name={`discounts[${index}][usageLimit]`}
                          min={1}
                          step={1}
                          inputMode="numeric"
                          value={row.usageLimit}
                          onChange={(e) => updateDiscountRow(row.id, { usageLimit: e.target.value })}
                        />
                      </s-box>
                      <s-box inlineSize="49%">
                        <s-text-field
                          label="Tags"
                          name={`discounts[${index}][tags]`}
                          placeholder="loyalty, vip, summer-sale"
                          value={row.tags}
                          onChange={(e) => updateDiscountRow(row.id, { tags: e.target.value })}
                          helpText="Optional: Comma-separated keywords"
                        />
                      </s-box>
                    </s-stack>

                    <s-checkbox
                      label="Limit to one use per customer"
                      name={`discounts[${index}][appliesOncePerCustomer]`}
                      checked={row.appliesOncePerCustomer}
                      onChange={(e) =>
                        updateDiscountRow(row.id, { appliesOncePerCustomer: e.target.checked })
                      }
                    />

                    {/* --- Combinations --- */}
                    <s-text variant="bodyMd" fontWeight="medium">Combinations</s-text>
                    <s-checkbox
                      label="Combines with product discounts"
                      name={`discounts[${index}][combinesWithProduct]`}
                      checked={row.combinesWith.productDiscounts}
                      onChange={(e) =>
                        updateDiscountRow(row.id, {
                          combinesWith: { ...row.combinesWith, productDiscounts: e.target.checked },
                        })
                      }
                    />
                    <s-checkbox
                      label="Combines with order discounts"
                      name={`discounts[${index}][combinesWithOrder]`}
                      checked={row.combinesWith.orderDiscounts}
                      onChange={(e) =>
                        updateDiscountRow(row.id, {
                          combinesWith: { ...row.combinesWith, orderDiscounts: e.target.checked },
                        })
                      }
                    />
                    <s-checkbox
                      label="Combines with shipping discounts"
                      name={`discounts[${index}][combinesWithShipping]`}
                      checked={row.combinesWith.shippingDiscounts}
                      onChange={(e) =>
                        updateDiscountRow(row.id, {
                          combinesWith: { ...row.combinesWith, shippingDiscounts: e.target.checked },
                        })
                      }
                    />

                    {/* --- Active dates --- */}
                    <s-box inlineSize="50%">
                      <s-date-field
                        label="Start date"
                        name={`discounts[${index}][startsAtDate]`}
                        value={row.startsAtDate}
                        onChange={(e) => updateDiscountRow(row.id, { startsAtDate: e.target.value })}
                      />
                    </s-box>
                    <s-box inlineSize="49%">
                      <s-text-field
                        label="Start time"
                        type="time"
                        name={`discounts[${index}][startsAtTime]`}
                        value={row.startsAtTime}
                        onChange={(e) => updateDiscountRow(row.id, { startsAtTime: e.target.value })}
                      />
                    </s-box>

                    <s-box inlineSize="50%">
                      <s-date-field
                        label="End date"
                        name={`discounts[${index}][endsAt]`}
                        value={row.endsAt}
                        onChange={(e) => updateDiscountRow(row.id, { endsAt: e.target.value })}
                      />
                    </s-box>
                    <s-box inlineSize="49%">
                      <s-text-field
                        label="End time"
                        type="time"
                        name={`discounts[${index}][endsAtTime]`}
                        value={row.endsAtTime}
                        onChange={(e) => updateDiscountRow(row.id, { endsAtTime: e.target.value })}
                        disabled={!row.endsAt}
                      />
                    </s-box>

                    {!editingCoupon && discountRows.length > 1 && (
                      <s-button
                        type="button"
                        variant="secondary"
                        tone="critical"
                        onClick={() => removeDiscountRow(row.id)}
                      >
                        Remove discount
                      </s-button>
                    )}
                  </s-stack>
                </s-section>
              ))}
            </s-stack>

            <s-stack direction="inline" justifyContent="space-between" alignItems="center">
              <s-button
                variant="primary"
                type="submit"
                disabled={!hasFunction}
                {...(isSubmitting ? { loading: true } : {})}
              >
                {getButtonText()}
              </s-button>

              {!editingCoupon && (
                <s-button type="button" variant="primary" onClick={addDiscountRow}>
                  + Add another coupon
                </s-button>
              )}
              {editingCoupon && (
                <s-button type="button" variant="secondary" onClick={cancelEdit}>
                  Cancel edit
                </s-button>
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

function parseFormDiscounts(formData) {
  const discountCount = Number(formData.get("discountCount"));

  if (!Number.isInteger(discountCount) || discountCount <= 0) {
    throw new Response("Add at least one discount coupon.", { status: 400 });
  }

  return Array.from({ length: discountCount }, (_, index) =>
    normalizeDiscount(
      {
        code: formData.get(`discounts[${index}][code]`),
        discountType: formData.get(`discounts[${index}][discountType]`),
        discountValue: formData.get(`discounts[${index}][discountValue]`),
        maxDiscountAmount: formData.get(`discounts[${index}][maxDiscountAmount]`),
        usageLimit: formData.get(`discounts[${index}][usageLimit]`),
        appliesOncePerCustomer: formData.get(`discounts[${index}][appliesOncePerCustomer]`),
        combinesWithProduct: formData.get(`discounts[${index}][combinesWithProduct]`),
        combinesWithOrder: formData.get(`discounts[${index}][combinesWithOrder]`),
        combinesWithShipping: formData.get(`discounts[${index}][combinesWithShipping]`),
        appliesToMode: formData.get(`discounts[${index}][appliesToMode]`),
        appliesToIds: formData.get(`discounts[${index}][appliesToIds]`),
        appliesToTitles: formData.get(`discounts[${index}][appliesToTitles]`),
        minimumRequirementMode: formData.get(`discounts[${index}][minimumRequirementMode]`),
        minimumRequirementValue: formData.get(`discounts[${index}][minimumRequirementValue]`),
        customerEligibilityMode: formData.get(`discounts[${index}][customerEligibilityMode]`),
        customerSegmentIds: formData.get(`discounts[${index}][customerSegmentIds]`),
        customerIds: formData.get(`discounts[${index}][customerIds]`),
        customerLabels: formData.get(`discounts[${index}][customerLabels]`),
        endsAt: formData.get(`discounts[${index}][endsAt]`),
        endsAtTime: formData.get(`discounts[${index}][endsAtTime]`),
        startsAtDate: formData.get(`discounts[${index}][startsAtDate]`),
        startsAtTime: formData.get(`discounts[${index}][startsAtTime]`),
        purchaseType: formData.get(`discounts[${index}][purchaseType]`),
        recurringPaymentLimitMode: formData.get(`discounts[${index}][recurringPaymentLimitMode]`),
        recurringPaymentLimitValue: formData.get(`discounts[${index}][recurringPaymentLimitValue]`),
        tags: formData.get(`discounts[${index}][tags]`),
      },
      `Coupon ${index + 1}`,
    ),
  );
}

function normalizeDiscount(rawDiscount, label) {
  const code = rawDiscount.code?.toString().trim().toUpperCase();
  const discountType = rawDiscount.discountType?.toString().trim();
  const isFreeShipping = discountType === "free_shipping";

  const discountValue = isFreeShipping ? 0 : Number(rawDiscount.discountValue);
  const maxDiscountAmount = isFreeShipping ? null : Number(rawDiscount.maxDiscountAmount);

  const usageLimit = normalizeUsageLimit(rawDiscount.usageLimit, label);
  const startsAt = normalizeStartDateTime(rawDiscount.startsAtDate, rawDiscount.startsAtTime);
  const endsAt = normalizeEndDateTime(rawDiscount.endsAt, rawDiscount.endsAtTime);

  if (!code) {
    throw new Response(`${label}: code is required.`, { status: 400 });
  }

  if (!["percentage", "fixed", "free_shipping"].includes(discountType)) {
    throw new Response(`${label}: choose percentage, fixed, or free shipping.`, {
      status: 400,
    });
  }

  if (!isFreeShipping) {
    if (!Number.isFinite(discountValue) || discountValue <= 0) {
      throw new Response(`${label}: discountValue must be greater than 0.`, {
        status: 400,
      });
    }

    if (discountType === "percentage" && discountValue > 100) {
      throw new Response(`${label}: percentage cannot be more than 100%.`, {
        status: 400,
      });
    }

    if (!Number.isFinite(maxDiscountAmount) || maxDiscountAmount <= 0) {
      throw new Response(`${label}: maxDiscountAmount must be greater than 0.`, {
        status: 400,
      });
    }
  }

  const appliesTo = normalizeAppliesTo(rawDiscount.appliesToMode, rawDiscount.appliesToIds, rawDiscount.appliesToTitles, label);
  const minimumRequirement = normalizeMinimumRequirement(
    rawDiscount.minimumRequirementMode,
    rawDiscount.minimumRequirementValue,
    label,
  );
  const customerEligibility = normalizeCustomerEligibility(
    rawDiscount.customerEligibilityMode,
    rawDiscount.customerSegmentIds,
    rawDiscount.customerIds,
    rawDiscount.customerLabels,
    label,
  );
  const purchaseType = normalizePurchaseType(rawDiscount.purchaseType, label);
  const recurringCycleLimit = normalizeRecurringCycleLimit(
    purchaseType,
    rawDiscount.recurringPaymentLimitMode,
    rawDiscount.recurringPaymentLimitValue,
    label,
  );
  const tags = normalizeTags(rawDiscount.tags);

  return {
    code,
    discountType,
    discountValue,
    maxDiscountAmount,
    usageLimit,
    endsAt,
    startsAt,
    title: code,
    appliesOncePerCustomer: rawDiscount.appliesOncePerCustomer === "on",
    combinesWith: {
      productDiscounts: rawDiscount.combinesWithProduct === "on",
      orderDiscounts: rawDiscount.combinesWithOrder === "on",
      shippingDiscounts: rawDiscount.combinesWithShipping === "on",
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

function normalizePurchaseType(purchaseTypeRaw, label) {
  const mode = purchaseTypeRaw?.toString().trim() || "both";

  if (!["one_time", "subscription", "both"].includes(mode)) {
    throw new Response(`${label}: invalid purchase type selection.`, { status: 400 });
  }

  return {
    oneTime: mode === "one_time" || mode === "both",
    subscription: mode === "subscription" || mode === "both",
  };
}

function normalizeRecurringCycleLimit(purchaseType, mode, value, label) {
  // Only meaningful when the discount applies to subscriptions at all.
  if (!purchaseType.subscription) {
    return null;
  }

  const normalizedMode = mode?.toString().trim() || "all";

  if (!["all", "first", "limited"].includes(normalizedMode)) {
    throw new Response(`${label}: invalid recurring payment limit selection.`, {
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
      `${label}: multiple payments limit must be a whole number of 1 or more.`,
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


function normalizeAppliesTo(mode, idsCsv, titlesDelimited, label) {
  const normalizedMode = mode?.toString().trim() || "all";

  if (!["all", "products", "collections"].includes(normalizedMode)) {
    throw new Response(`${label}: invalid "applies to" selection.`, { status: 400 });
  }

  if (normalizedMode === "all") {
    return { mode: "all", resources: [] };
  }

  const ids = (idsCsv?.toString() || "").split(",").filter(Boolean);
  const titles = (titlesDelimited?.toString() || "").split("||").filter((_, i) => i < ids.length);

  if (ids.length === 0) {
    throw new Response(`${label}: select at least one ${normalizedMode.slice(0, -1)}.`, {
      status: 400,
    });
  }

  return {
    mode: normalizedMode,
    resources: ids.map((id, i) => ({ id, title: titles[i] || id })),
  };
}

function normalizeMinimumRequirement(mode, value, label) {
  const normalizedMode = mode?.toString().trim() || "none";

  if (!["none", "quantity", "amount"].includes(normalizedMode)) {
    throw new Response(`${label}: invalid minimum requirement selection.`, { status: 400 });
  }

  if (normalizedMode === "none") {
    return { mode: "none", value: null };
  }

  const numericValue = Number(value);

  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    throw new Response(`${label}: minimum requirement value must be greater than 0.`, {
      status: 400,
    });
  }

  return { mode: normalizedMode, value: numericValue };
}

function normalizeCustomerEligibility(mode, segmentIdsCsv, customerIdsCsv, customerLabelsJson, label) {
  const normalizedMode = mode?.toString().trim() || "all";

  if (!["all", "segments", "customers"].includes(normalizedMode)) {
    throw new Response(`${label}: invalid customer eligibility selection.`, { status: 400 });
  }

  if (normalizedMode === "segments") {
    const segmentIds = (segmentIdsCsv?.toString() || "").split(",").filter(Boolean);
    if (segmentIds.length === 0) {
      throw new Response(`${label}: select at least one customer segment.`, { status: 400 });
    }
    return { mode: "segments", segmentIds, customerIds: [], customerLabels: [] };
  }

  if (normalizedMode === "customers") {
    const customerIds = (customerIdsCsv?.toString() || "").split(",").filter(Boolean);
    if (customerIds.length === 0) {
      throw new Response(`${label}: select at least one customer.`, { status: 400 });
    }

    let customerLabels = [];
    try {
      customerLabels = JSON.parse(customerLabelsJson?.toString() || "[]");
    } catch {
      customerLabels = [];
    }

    return { mode: "customers", segmentIds: [], customerIds, customerLabels };
  }

  return { mode: "all", segmentIds: [], customerIds: [], customerLabels: [] };
}

// Builds the Function config payload. Shopify's discountCodeAppCreate has no
// native concept of "applies to products/collections" or "minimum requirement"
// for app-based discounts — your Function extension must read these values out
// of the metafield itself and apply the logic in its run() implementation.
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

function createDiscountRow(values = {}) {
  return {
    id: crypto.randomUUID(),
    code: values.code || "",
    discountType: values.discountType || "percentage",
    discountValue: values.discountValue?.toString() || "",
    maxDiscountAmount: values.maxDiscountAmount?.toString() || "",
    usageLimit: values.usageLimit?.toString() || "",
    endsAt: values.endsAt || "",
    endsAtTime: values.endsAtTime || "23:59",
    startsAt: values.startsAt || "",
    startsAtDate: values.startsAtDate || formatDateForInput(new Date().toISOString()),
    startsAtTime: values.startsAtTime || formatTimeForInput(new Date().toISOString()),
    appliesOncePerCustomer: values.appliesOncePerCustomer ?? false,
    combinesWith: values.combinesWith || {
      orderDiscounts: true,
      productDiscounts: true,
      shippingDiscounts: true,
    },
    appliesTo: values.appliesTo || { mode: "all", resources: [] },
    minimumRequirement: values.minimumRequirement || { mode: "none", value: "" },
    customerEligibility: values.customerEligibility || {
      mode: "all",
      segmentIds: [],
      customerIds: [],
      customerLabels: [],
    },
    purchaseType: values.purchaseType || "both",
    recurringPaymentLimit: values.recurringPaymentLimit || { mode: "all", value: "" },
    tags: values.tags || "",
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
    purchaseType:
      (codeAppDiscount.appliesOnOneTimePurchase ?? discountConfig.appliesOnOneTimePurchase) &&
      (codeAppDiscount.appliesOnSubscription ?? discountConfig.appliesOnSubscription)
        ? "both"
        : (codeAppDiscount.appliesOnSubscription ?? discountConfig.appliesOnSubscription)
          ? "subscription"
          : "one_time",
    recurringPaymentLimit: toRecurringPaymentLimitState(
      codeAppDiscount.recurringCycleLimit ?? discountConfig.recurringCycleLimit,
    ),
    tags: codeAppDiscount.tags || discountConfig.tags,
  };
}

// Converts the raw recurringCycleLimit integer (0 = all, 1 = first, N = limited)
// back into the { mode, value } shape the "Recurring payments options" select uses.
function toRecurringPaymentLimitState(recurringCycleLimit) {
  if (recurringCycleLimit === null || recurringCycleLimit === undefined || recurringCycleLimit === 0) {
    return { mode: "all", value: "" };
  }
  if (recurringCycleLimit === 1) {
    return { mode: "first", value: "" };
  }
  return { mode: "limited", value: recurringCycleLimit.toString() };
}

function normalizeUsageLimit(value, label) {
  const rawValue = value?.toString().trim();

  if (!rawValue) {
    return null;
  }

  const usageLimit = Number(rawValue);

  if (!Number.isInteger(usageLimit) || usageLimit <= 0) {
    throw new Response(`${label}: usage limit must be a positive whole number.`, {
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

function requiredString(formData, key) {
  const value = formData.get(key)?.toString().trim();

  if (!value) {
    throw new Response(`${key} is required`, { status: 400 });
  }

  return value;
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};