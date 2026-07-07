import { firstSearchParam, safeRelativeReturnTo } from "@vayada/product-onboarding/returnTo";
import { LoginContent } from "./LoginContent";

type LoginPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = (await searchParams) ?? {};
  const returnTo = safeRelativeReturnTo(params.returnTo, "/dashboard");
  const authError = firstSearchParam(params.auth_error);
  return (
    <LoginContent
      returnTo={returnTo}
      resumeSession={firstSearchParam(params.auth) === "callback"}
      authError={authError}
    />
  );
}
