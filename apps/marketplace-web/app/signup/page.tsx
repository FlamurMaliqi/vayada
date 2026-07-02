import { headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  buildHostedSignupRedirectUrl,
  firstSearchParam,
  safeRelativeReturnTo,
} from "@vayada/hotel-setup-wizard/returnTo";

const AUTH_API_BASE_URL = process.env.NEXT_PUBLIC_AUTH_API_URL || process.env.NEXT_PUBLIC_API_URL;
const LOCAL_AUTH_API_BASE_URL = "https://api.localhost";

type SignupIntent = "creator" | "hotel";

type SignUpPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function SignUpPage({ searchParams }: SignUpPageProps) {
  const params = (await searchParams) ?? {};
  const intent = signupIntent(firstSearchParam(params.type));
  const returnTo = safeRelativeReturnTo(params.returnTo, "/marketplace");
  const headerList = await headers();
  const loginHint = firstSearchParam(params.login_hint);

  redirect(
    buildHostedSignupRedirectUrl({
      authApiBaseUrl: resolveAuthApiBaseUrl(),
      headers: headerList,
      surface: "marketplace-web",
      intent,
      fallbackOrigin: "https://app.vayada.com",
      returnTo,
      loginHint,
    }),
  );
}

function signupIntent(value: string | undefined): SignupIntent {
  return value === "hotel" ? "hotel" : "creator";
}

function resolveAuthApiBaseUrl(): string {
  if (AUTH_API_BASE_URL) return AUTH_API_BASE_URL;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "NEXT_PUBLIC_AUTH_API_URL or NEXT_PUBLIC_API_URL is required for hosted signup",
    );
  }
  return LOCAL_AUTH_API_BASE_URL;
}
