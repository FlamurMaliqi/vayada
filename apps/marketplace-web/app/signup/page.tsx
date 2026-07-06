import { firstSearchParam } from "@vayada/hotel-setup-wizard/returnTo";
import { SignupContent } from "./SignupContent";

type SignupIntent = "creator" | "hotel";

type SignUpPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function SignUpPage({ searchParams }: SignUpPageProps) {
  const params = (await searchParams) ?? {};
  const intent = signupIntent(firstSearchParam(params.type));
  return <SignupContent intent={intent} />;
}

function signupIntent(value: string | undefined): SignupIntent | null {
  if (value === "creator" || value === "hotel") return value;
  return null;
}
