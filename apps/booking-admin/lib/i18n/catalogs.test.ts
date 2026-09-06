import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { SUPPORTED_LANGUAGES } from "./languages";
import { SEARCH_ENTRIES } from "../../components/layout/navigationSearchEntries";
import en from "../../messages/en.json";

const root = resolve(import.meta.dirname, "../../..");
const placeholders = (value: string) =>
  Array.from(value.matchAll(/\{\w+\}/g))
    .map(([token]) => token)
    .sort();

describe("admin translation catalogs", () => {
  it("covers every search entry label", () => {
    for (const entry of SEARCH_ENTRIES) expect(en).toHaveProperty(entry[4]!);
  });

  it("covers target reservation and payment states", () => {
    for (const state of [
      "pending",
      "confirmed",
      "cancelled",
      "declined",
      "no_show",
      "completed",
      "expired",
      "in_house",
      "checked_in",
      "checked_out",
    ])
      expect(en).toHaveProperty(`reservations.status.${state}`);
    for (const state of [
      "pending",
      "unpaid",
      "authorized",
      "partially_paid",
      "paid",
      "failed",
      "refunded",
      "waived",
    ])
      expect(en).toHaveProperty(`reservations.paymentStatus.${state}`);
  });
  for (const { code } of SUPPORTED_LANGUAGES) {
    it(`${code} has every message and preserves interpolation parameters`, () => {
      const catalog = JSON.parse(
        readFileSync(resolve(root, `booking-admin/messages/${code}.json`), "utf8"),
      );
      expect(Object.keys(catalog).sort()).toEqual(Object.keys(en).sort());
      for (const [key, message] of Object.entries(en)) {
        expect(catalog[key], key).toBeTruthy();
        expect(placeholders(catalog[key]), key).toEqual(placeholders(message));
      }
    });
  }

  it("covers literal translation keys in active admin and shared components", () => {
    const files: string[] = [];
    function walk(dir: string) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "setup") continue; // Canonical setup redirects to Marketplace.
        const path = resolve(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.tsx$/.test(path) && !path.includes(".test.")) files.push(path);
      }
    }
    walk(resolve(root, "booking-admin/app"));
    walk(resolve(root, "booking-admin/components"));
    for (const file of [
      "product-onboarding/src/AddonEditor.tsx",
      "product-onboarding/src/SharedSignupPage.tsx",
      "product-onboarding/src/BookingPagePreview.tsx",
      "settings-ui/src/SupportButton.tsx",
      "feature-hub/src/FeatureHubPage.tsx",
    ]) {
      files.push(resolve(root, "../packages", file));
    }
    const missing: string[] = [];
    for (const file of files) {
      const source = ts.createSourceFile(
        file,
        readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      const visit = (node: ts.Node) => {
        if (
          ts.isCallExpression(node) &&
          node.expression.getText(source) === "t" &&
          node.arguments[0] &&
          ts.isStringLiteral(node.arguments[0])
        ) {
          const key = node.arguments[0].text;
          if (!(key in en)) missing.push(`${file}: ${key}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(missing).toEqual([]);
  });
});
