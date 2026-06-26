import {DiscountClass} from '../generated/api';

/**
 * @typedef {import("../generated/api").CartInput} RunInput
 * @typedef {import("../generated/api").CartDeliveryOptionsDiscountsGenerateRunResult} CartDeliveryOptionsDiscountsGenerateRunResult
 */

/**
 * @param {RunInput} input
 * @returns {CartDeliveryOptionsDiscountsGenerateRunResult}
 */
export function cartDeliveryOptionsDiscountsGenerateRun(input) {
  if (
    !input.cart.deliveryGroups.length ||
    !input.discount.discountClasses.includes(DiscountClass.Shipping)
  ) {
    return {operations: []};
  }

  const configurations = normalizeConfigurations(input.discount.metafield?.jsonValue);
  const freeShippingConfig = configurations.find(
    (configuration) => configuration.discountType === 'free_shipping',
  );

  if (!freeShippingConfig) {
    return {operations: []};
  }

  return {
    operations: [
      {
        deliveryDiscountsAdd: {
          candidates: input.cart.deliveryGroups.map((group) => ({
            message: freeShippingConfig.title || 'Free shipping',
            targets: [
              {
                deliveryGroup: {
                  id: group.id,
                },
              },
            ],
            value: {
              percentage: {
                value: 100,
              },
            },
          })),
        },
      },
    ],
  };
}

function normalizeConfigurations(rawConfiguration) {
  if (!rawConfiguration || typeof rawConfiguration !== 'object') {
    return [];
  }

  const rawDiscounts = Array.isArray(rawConfiguration.discounts)
    ? rawConfiguration.discounts
    : [rawConfiguration];

  return rawDiscounts
    .filter((discount) => discount && typeof discount === 'object')
    .map((discount) => ({
      discountType: discount.discountType,
      title: typeof discount.title === 'string' ? discount.title.trim() : '',
    }));
}