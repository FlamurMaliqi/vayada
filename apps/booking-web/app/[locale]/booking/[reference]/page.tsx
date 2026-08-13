import type { Metadata } from "next";
import BookingConfirmationPageClient from "./BookingConfirmationPageClient";

/**
 * VAY-664: Guest booking status/confirmation pages must never be indexed.
 * Enforced at the framework level here so it applies regardless of
 * whether the client component renders a meta tag.
 */
export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
  },
};

export default async function BookingConfirmationPage({
  params,
  searchParams,
}: {
  params: Promise<{ reference: string }>;
  searchParams: Promise<{ email?: string }>;
}) {
  const [{ reference }, { email }] = await Promise.all([params, searchParams]);
  return <BookingConfirmationPageClient reference={reference} emailParam={email} />;
}
