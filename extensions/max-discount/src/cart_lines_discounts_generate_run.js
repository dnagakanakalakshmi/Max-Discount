import {
  DiscountClass,
  OrderDiscountSelectionStrategy,
} from '../generated/api';

/**
 * @typedef {import("../generated/api").CartInput} RunInput
 * @typedef {import("../generated/api").CartLinesDiscountsGenerateRunResult} CartLinesDiscountsGenerateRunResult
 */

/**
 * @param {RunInput} input
 * @returns {CartLinesDiscountsGenerateRunResult}
 */
export function cartLinesDiscountsGenerateRun(input) {

  if (!input.cart.lines.length || !input.discount.discountClasses.includes(DiscountClass.Order)) {
    return {operations: []};
  }


  const configurations = normalizeConfigurations(
    input.discount.metafield?.jsonValue,
  );

  if (!configurations.length) {
    return {operations: []};
  }

  const lines = annotateLines(input.cart.lines);

  const currencyCode = input.cart.cost.subtotalAmount.currencyCode;

  const candidates = configurations
    .map((configuration) => buildCandidate(configuration, lines, currencyCode))
    .filter(Boolean);


  if (!candidates.length) {
    return {operations: []};
  }


  return {
    operations: [
      {
        orderDiscountsAdd: {
          candidates,
          selectionStrategy: OrderDiscountSelectionStrategy.Maximum,
        },
      },
    ],
  };
}

// Pre-compute per-line data we need repeatedly: parsed cost and product id.
// Only ProductVariant merchandise has a `product` field in the union, so
// checking for `merchandise.product` directly is equivalent to checking
// __typename === 'ProductVariant', and doesn't depend on __typename being
// present in the resolved input (it isn't always echoed back, e.g. in some
// function-runner test payloads).
function annotateLines(rawLines) {
  return rawLines.map((line) => {
    const product = line.merchandise?.product ?? null;

    return {
      id: line.id,
      quantity: line.quantity,
      subtotal: parseMoney(line.cost.subtotalAmount.amount),
      productId: product?.id ?? null,
      inAnyCollection: Boolean(product?.inAnyCollection),
    };
  });
}

function buildCandidate(configuration, lines, currencyCode) {

  const qualifyingLines = selectQualifyingLines(configuration, lines);

  if (!qualifyingLines.length) {
    return null;
  }

  if (!meetsMinimumRequirement(configuration, qualifyingLines)) {
    return null;
  }

  const qualifyingSubtotal = qualifyingLines.reduce(
    (sum, line) => sum + line.subtotal,
    0,
  );

  const discountAmount = calculateDiscountAmount(configuration, qualifyingSubtotal);

  if (discountAmount <= 0) {
    return null;
  }

  // excludedCartLineIds = every line that is NOT a qualifying line, so the
  // discount only ever reduces the subtotal made up of qualifying lines.
  const qualifyingLineIds = new Set(qualifyingLines.map((line) => line.id));
  const excludedCartLineIds = lines
    .filter((line) => !qualifyingLineIds.has(line.id))
    .map((line) => line.id);

  const candidate = {
    message: buildMessage(configuration, discountAmount, currencyCode),
    targets: [
      {
        orderSubtotal: {
          excludedCartLineIds,
        },
      },
    ],
    value: {
      fixedAmount: {
        amount: discountAmount.toFixed(2),
      },
    },
  };


  return candidate;
}

// Filters lines down to the ones this configuration's "applies to" setting
// allows. mode "all" qualifies every line; "products"/"collections" qualify
// only lines whose product matches the stored resource ids.
function selectQualifyingLines(configuration, lines) {
  const appliesTo = configuration.appliesTo;

  if (!appliesTo || appliesTo.mode === 'all') {
    return lines;
  }

  if (appliesTo.mode === 'products') {
    const productIds = new Set(appliesTo.resourceIds);
    return lines.filter((line) => line.productId && productIds.has(line.productId));
  }

  if (appliesTo.mode === 'collections') {
    // inAnyCollection was resolved by Shopify against the $collectionIds
    // input query variable, which is populated from this discount's own
    // "$app:collection-ids" metafield — see shopify.extension.toml.
    return lines.filter((line) => line.inAnyCollection);
  }

  return lines;
}

// Checks the minimum purchase requirement against ONLY the qualifying lines,
// matching how Shopify's native "minimum requirement" semantics scope to the
// items the discount actually applies to.
function meetsMinimumRequirement(configuration, qualifyingLines) {
  const minimumRequirement = configuration.minimumRequirement;

  if (!minimumRequirement || minimumRequirement.mode === 'none') {
    return true;
  }

  if (minimumRequirement.mode === 'quantity') {
    const totalQuantity = qualifyingLines.reduce((sum, line) => sum + line.quantity, 0);
    return totalQuantity >= minimumRequirement.value;
  }

  if (minimumRequirement.mode === 'amount') {
    const totalAmount = qualifyingLines.reduce((sum, line) => sum + line.subtotal, 0);
    return totalAmount >= minimumRequirement.value;
  }

  return true;
}

function normalizeConfigurations(rawConfiguration) {
  if (!rawConfiguration || typeof rawConfiguration !== 'object') {
    return [];
  }

  const rawDiscounts = Array.isArray(rawConfiguration.discounts)
    ? rawConfiguration.discounts
    : [rawConfiguration];


  return rawDiscounts.map(normalizeConfiguration).filter(Boolean);
}

function normalizeConfiguration(rawDiscount) {
  if (!rawDiscount || typeof rawDiscount !== 'object') {
    return null;
  }

  const discountType = rawDiscount.discountType;
  const discountValue = parseMoney(rawDiscount.discountValue);
  const maxDiscountAmount = parseMoney(rawDiscount.maxDiscountAmount);


  if (!['percentage', 'fixed'].includes(discountType)) {
    return null;
  }
  if (discountValue <= 0) {
    return null;
  }
  if (maxDiscountAmount < 0) {
    return null;
  }


  return {
    discountType,
    discountValue,
    maxDiscountAmount,
    title: typeof rawDiscount.title === 'string' ? rawDiscount.title.trim() : '',
    appliesTo: normalizeAppliesTo(rawDiscount.appliesTo),
    minimumRequirement: normalizeMinimumRequirement(rawDiscount.minimumRequirement),
  };
}

function normalizeAppliesTo(rawAppliesTo) {
  if (!rawAppliesTo || typeof rawAppliesTo !== 'object') {
    return {mode: 'all', resourceIds: []};
  }

  const mode = rawAppliesTo.mode;

  if (mode !== 'products' && mode !== 'collections') {
    return {mode: 'all', resourceIds: []};
  }

  const resources = Array.isArray(rawAppliesTo.resources) ? rawAppliesTo.resources : [];
  const resourceIds = resources
    .map((resource) => (resource && typeof resource === 'object' ? resource.id : resource))
    .filter((id) => typeof id === 'string' && id.length > 0);

  if (!resourceIds.length) {
    return {mode: 'all', resourceIds: []};
  }

  return {mode, resourceIds};
}

function normalizeMinimumRequirement(rawMinimumRequirement) {
  if (!rawMinimumRequirement || typeof rawMinimumRequirement !== 'object') {
    return {mode: 'none', value: 0};
  }

  const mode = rawMinimumRequirement.mode;
  const value = parseMoney(rawMinimumRequirement.value);

  if ((mode !== 'quantity' && mode !== 'amount') || value <= 0) {
    return {mode: 'none', value: 0};
  }

  return {mode, value};
}

function calculateDiscountAmount(configuration, subtotal) {
  const rawDiscount =
    configuration.discountType === 'percentage'
      ? subtotal * (configuration.discountValue / 100)
      : configuration.discountValue;

  // 0 means "no cap" — only clamp against maxDiscountAmount when it's set.
  const candidates = [rawDiscount, subtotal];
  if (configuration.maxDiscountAmount > 0) {
    candidates.push(configuration.maxDiscountAmount);
  }

  return roundToCurrency(Math.min(...candidates));
}

function buildMessage(configuration, discountAmount, currencyCode) {
  const discountLabel =
    configuration.discountType === 'percentage'
      ? `${formatNumber(configuration.discountValue)}% off`
      : `${currencyCode} ${formatNumber(configuration.discountValue)} off`;
  const cappedLabel =
    configuration.maxDiscountAmount > 0
      ? ` up to ${currencyCode} ${formatNumber(configuration.maxDiscountAmount)}`
      : '';
  const appliedLabel = `applied ${currencyCode} ${formatNumber(discountAmount)}`;
  const baseMessage = configuration.title || `${discountLabel}${cappedLabel}`;

  return `${baseMessage} (${appliedLabel})`;
}

function parseMoney(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function roundToCurrency(value) {
  return Math.round(value * 100) / 100;
}

function formatNumber(value) {
  return roundToCurrency(value).toFixed(2).replace(/\.00$/, '');
}