import { useEffect, useState } from "react";
import { useFetcher, useLoaderData, useNavigate, Link } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { reconcileBatchRegistry } from "../models/bulkBatch.server";

const CONFIG_NAMESPACE = "$app";
const CONFIG_KEY = "config";

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
        discountNodes(first: 100) {
          nodes {
            id
            discount {
              __typename
              ... on DiscountCodeApp {
                title
                status
                startsAt
                endsAt
                usageLimit
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
        }
      }`,
  );
  const responseJson = await response.json();
  const functions = responseJson.data.shopifyFunctions.nodes;
  const selectedFunctionId = findDefaultFunction(functions)?.id || "";

  const batches = await reconcileBatchRegistry(admin);
  const bulkDiscountIds = new Set(batches.flatMap((b) => b.discountIds));

  return {
    functions,
    selectedFunctionId,
    coupons: formatCoupons(
      responseJson.data.discountNodes.nodes.filter(
        (node) => !bulkDiscountIds.has(node.id)
      )
    ),
  };
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  
  const intent = formData.get("intent")?.toString() || "create";

  // Handle delete intent
  if (intent === "delete") {
    const discountId = requiredString(formData, "discountId");
    
    const mutation = `#graphql
      mutation DeleteDiscountCode($id: ID!) {
        discountCodeDelete(id: $id) {
          deletedCodeDiscountId
          userErrors {
            field
            message
          }
        }
      }`;

    const response = await admin.graphql(mutation, {
      variables: { id: discountId },
    });

    const responseJson = await response.json();
    const payload = responseJson.data.discountCodeDelete;

    if (payload.userErrors.length) {
      return {
        errors: payload.userErrors.map((error) => error.message),
        deleted: false,
      };
    }

    return {
      deleted: true,
      deletedDiscountId: payload.deletedCodeDiscountId,
      errors: [],
    };
  }

  // Handle edit - redirect to create page with edit mode
  if (intent === "edit") {
    const discountId = requiredString(formData, "discountId");
    // Redirect to create page with edit parameters
    return { redirectTo: `/app?edit=${discountId}` };
  }

  return { errors: ["Invalid action"] };
};

export default function Discounts() {
  const { coupons, selectedFunctionId } = useLoaderData();
  const navigate = useNavigate();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const [deletingCouponId, setDeletingCouponId] = useState(null);
  const deleted = fetcher.data?.deleted;
  const deletedDiscountId = fetcher.data?.deletedDiscountId;
  const errors = fetcher.data?.errors || [];
  
  // Remove deleted coupon from the list
  const tableCoupons = deleted && deletedDiscountId
    ? coupons.filter(c => c.id !== deletedDiscountId)
    : coupons;

  useEffect(() => {
    if (deleted) {
      shopify.toast.show("Discount code deleted successfully");
      setDeletingCouponId(null);
    }
    if (errors.length > 0) {
      shopify.toast.show("Failed to delete discount code", { isError: true });
      setDeletingCouponId(null);
    }
  }, [deleted, errors, shopify]);

  const deleteCoupon = (couponId) => {
    if (window.confirm("Are you sure you want to delete this discount code?")) {
      setDeletingCouponId(couponId);
      const formData = new FormData();
      formData.append("intent", "delete");
      formData.append("discountId", couponId);
      fetcher.submit(formData, { method: "post" });
    }
  };

  const editCoupon = (couponId) => {
    // Navigate to create page with edit parameter
    navigate(`/app/create-coupon?edit=${couponId}`);
  };

  return (
    <s-page heading="Discount Coupons" inlineSize="base">
      <s-section>
        <s-stack direction="horizontal" gap="base" alignment="center">
          <s-text>Create new discount coupons</s-text>
          <Link to="/app">
            <s-button variant="secondary">← Dashboard</s-button>
          </Link>
          <Link to="/app/create-coupon">
            <s-button variant="primary">Create Coupon</s-button>
          </Link>
        </s-stack>
      </s-section>

      <s-section heading="All Coupons">
        {tableCoupons.length === 0 ? (
          <s-box padding="base" background="subdued">
            <s-text>No app-created max discount coupons yet.</s-text>
          </s-box>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Code</s-table-header>
              <s-table-header>Discount</s-table-header>
              <s-table-header>Max cap</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Usage limit</s-table-header>
              <s-table-header>End date</s-table-header>
              <s-table-header>Actions</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {tableCoupons.map((coupon) => (
                <s-table-row key={coupon.id}>
                  <s-table-cell>{coupon.code}</s-table-cell>
                  <s-table-cell>
                    {coupon.discountType === "percentage"
                      ? `${coupon.discountValue}%`
                      : coupon.discountValue}
                  </s-table-cell>
                  <s-table-cell>{coupon.maxDiscountAmount}</s-table-cell>
                  <s-table-cell>{coupon.status}</s-table-cell>
                  <s-table-cell>{coupon.usageLimit || "No limit"}</s-table-cell>
                  <s-table-cell>
                    {formatDateForDisplay(coupon.endsAt) || "No end date"}
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="base">
                      <s-button
                        type="button"
                        variant="secondary"
                        onClick={() => editCoupon(coupon.id)}
                      >
                        Edit
                      </s-button>
                      <s-button
                        type="button"
                        variant="secondary"
                        tone="critical"
                        onClick={() => deleteCoupon(coupon.id)}
                        disabled={deletingCouponId === coupon.id}
                        {...(deletingCouponId === coupon.id ? { loading: true } : {})}
                      >
                        Delete
                      </s-button>
                    </s-stack>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
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

function formatCoupons(nodes) {
  return nodes
    .map((node) => {
      const discount = node.discount;
      
      // Only process DiscountCodeApp types
      if (discount.__typename !== "DiscountCodeApp") {
        return null;
      }

      const configDiscount = firstConfiguredDiscount(readMetafieldJson(node.metafield));
      const fallbackConfig = parseDiscountTitle(discount.title);
      const displayConfig = configDiscount || fallbackConfig;

      if (!displayConfig) {
        return null;
      }

      return {
        id: node.id,
        code: discount.codes.nodes[0]?.code || "",
        title: discount.title,
        status: discount.status,
        startsAt: discount.startsAt,
        endsAt: discount.endsAt,
        usageLimit: discount.usageLimit,
        discountType: displayConfig?.discountType || "",
        discountValue: displayConfig?.discountValue || "",
        maxDiscountAmount: displayConfig?.maxDiscountAmount || "",
      };
    })
    .filter(Boolean);
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

function firstConfiguredDiscount(config) {
  if (!config || typeof config !== "object") {
    return null;
  }

  if (Array.isArray(config.discounts)) {
    return config.discounts[0] || null;
  }

  if (config.discountType && config.discountValue && config.maxDiscountAmount) {
    return config;
  }

  return null;
}

function formatDateForDisplay(value) {
  if (!value) {
    return "";
  }

  return new Intl.DateTimeFormat("en-IN", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(value));
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