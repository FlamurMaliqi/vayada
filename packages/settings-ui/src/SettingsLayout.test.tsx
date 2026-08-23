import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SettingsLayout } from "./SettingsLayout";

describe("SettingsLayout", () => {
  it("preserves responsive navigation and active-state semantics", () => {
    const markup = renderToStaticMarkup(
      <SettingsLayout
        sections={[
          { id: "property", label: "Property" },
          { id: "billing", label: "Billing", href: "/settings?section=billing" },
        ]}
        activeId="property"
      >
        <p>Settings content</p>
      </SettingsLayout>,
    );

    expect(markup).toContain("md:hidden");
    expect(markup).toContain("hidden md:block");
    expect(markup.match(/aria-current="page"/g)).toHaveLength(2);
    expect(markup.match(/href="\/settings\?section=billing"/g)).toHaveLength(2);
    expect(markup).toContain("Settings content");
  });
});
