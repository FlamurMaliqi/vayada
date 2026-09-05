import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { InvoiceList, PaymentChoice, PlanCard } from "./BillingSettingsUi";

describe("BillingSettingsUi", () => {
  it("renders the required current-plan and switch copy", () => {
    const current = renderToStaticMarkup(
      createElement(PlanCard, {
        title: "Commission",
        label: "Percentage per direct booking",
        price: "5%",
        priceSuffix: "per direct booking",
        description: "",
        benefits: ["No monthly fee. Pay only when you earn"],
        current: true,
        onSwitch: vi.fn(),
      }),
    );
    const available = renderToStaticMarkup(
      createElement(PlanCard, {
        title: "Fixed Fee",
        label: "Flat monthly subscription",
        price: "$60.00",
        priceSuffix: "per month",
        description: "At 7 active rooms. Base + per-extra-room pricing.",
        benefits: ["0% commission on direct bookings"],
        current: false,
        onSwitch: vi.fn(),
      }),
    );

    expect(current).toContain("CURRENT");
    expect(current).toContain("Your current plan");
    expect(available).toContain("Switch now");
    expect(available).toContain("Flat monthly subscription");
  });

  it("renders the exact payment and empty-invoice guidance", () => {
    const payment = renderToStaticMarkup(
      createElement(PaymentChoice, {
        selected: true,
        icon: () => createElement("span"),
        title: "Credit / debit card",
        description: "Charged automatically on the 1st of each month.",
        onClick: vi.fn(),
      }),
    );
    const invoices = renderToStaticMarkup(createElement(InvoiceList, { invoices: [] }));

    expect(payment).toContain("Credit / debit card");
    expect(payment).toContain("Charged automatically on the 1st of each month.");
    expect(payment).toContain('tabindex="0"');
    expect(invoices).toContain(
      "Your first invoice will appear here after your first billing cycle.",
    );
  });
});
