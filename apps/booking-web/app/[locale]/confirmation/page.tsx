import type { Metadata } from "next";
import { notFound } from "next/navigation";

import BookingConfirmationPageClient from "../booking/[reference]/BookingConfirmationPageClient";

export const metadata: Metadata = {
  referrer: "no-referrer",
  robots: {
    index: false,
    follow: false,
  },
};

export default async function PaymentConfirmationPage({
  searchParams,
}: {
  searchParams: Promise<{ booking?: string; email?: string; token?: string }>;
}) {
  const { booking, email, token } = await searchParams;
  if (!booking) notFound();
  return (
    <BookingConfirmationPageClient reference={booking} emailParam={email} tokenParam={token} />
  );
}
