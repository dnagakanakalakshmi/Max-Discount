// app/routes/app.customer-search.jsx
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim();

  if (!q) return { customers: [] };

  const response = await admin.graphql(
    `#graphql
      query SearchCustomers($query: String!) {
        customers(first: 10, query: $query) {
          nodes {
            id
            displayName
            email
          }
        }
      }`,
    { variables: { query: q } },
  );
  const json = await response.json();

  return { customers: json.data?.customers?.nodes || [] };
};