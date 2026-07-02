import { headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  buildHostedSignupRedirectUrl,
  firstSearchParam,
  safeRelativeReturnTo,
} from "@vayada/hotel-setup-wizard/returnTo";

const AUTH_API_BASE_URL = process.env.NEXT_PUBLIC_AUTH_API_URL;
const LOCAL_AUTH_API_BASE_URL = "https://api.localhost";

type RegisterPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function RegisterPage({ searchParams }: RegisterPageProps) {
  const params = (await searchParams) ?? {};
  const returnTo = safeRelativeReturnTo(params.returnTo, "/dashboard");
  const headerList = await headers();
  const loginHint = firstSearchParam(params.login_hint);

  redirect(
    buildHostedSignupRedirectUrl({
      authApiBaseUrl: resolveAuthApiBaseUrl(),
      headers: headerList,
      surface: "pms-web",
      intent: "hotel",
      fallbackOrigin: "https://pms.vayada.com",
      returnTo,
      returnToFallback: "/dashboard",
      loginHint,
    }),
  );
}

function resolveAuthApiBaseUrl(): string {
  if (AUTH_API_BASE_URL) return AUTH_API_BASE_URL;
  if (process.env.NODE_ENV === "production") {
    throw new Error("NEXT_PUBLIC_AUTH_API_URL is required for hosted signup");
  }
  return LOCAL_AUTH_API_BASE_URL;
}
