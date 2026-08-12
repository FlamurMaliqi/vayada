import type { Route } from "@playwright/test";

export function corsHeaders(route: Route) {
  const origin = route.request().headers().origin ?? "http://127.0.0.1:3000";
  return {
    "access-control-allow-credentials": "true",
    "access-control-allow-headers": "authorization, content-type, x-vayada-csrf",
    "access-control-allow-methods": "GET, POST, PUT, PATCH, OPTIONS",
    "access-control-allow-origin": origin,
    "content-type": "application/json",
  };
}

export async function fulfillCorsPreflight(route: Route) {
  await route.fulfill({
    status: 204,
    headers: corsHeaders(route),
  });
}
