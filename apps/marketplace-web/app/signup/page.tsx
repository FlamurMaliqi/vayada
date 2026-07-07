import { firstSearchParam } from "@vayada/product-onboarding/returnTo";
import { SignupContent } from "./SignupContent";

type SignUpPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function SignUpPage({ searchParams }: SignUpPageProps) {
  const params = (await searchParams) ?? {};
  return <SignupContent authError={firstSearchParam(params.auth_error)} />;
}
