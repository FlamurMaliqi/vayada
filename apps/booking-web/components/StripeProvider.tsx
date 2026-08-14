"use client";

import { Elements } from "@stripe/react-stripe-js";
import stripeForAccount from "@/lib/stripe";

interface StripeProviderProps {
  clientSecret: string;
  stripeAccountId?: string | null;
  children: React.ReactNode;
}

export default function StripeProvider({
  clientSecret,
  stripeAccountId,
  children,
}: StripeProviderProps) {
  return (
    <Elements
      stripe={stripeForAccount(stripeAccountId)}
      options={{
        clientSecret,
        appearance: {
          theme: "stripe",
          variables: {
            colorPrimary: "#1a1a2e",
            borderRadius: "8px",
          },
        },
      }}
    >
      {children}
    </Elements>
  );
}
