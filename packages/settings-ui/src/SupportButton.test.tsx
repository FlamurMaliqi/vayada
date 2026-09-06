import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SupportButton } from "./SupportButton";

const submit = async () => ({ status: "accepted", reference: "support-test" });

afterEach(() => vi.unstubAllEnvs());

describe("SupportButton placement", () => {
  it("preserves the floating default for existing consumers", () => {
    vi.stubEnv("NEXT_PUBLIC_AUTHKIT_LOGIN_ENABLED", "true");
    const markup = renderToStaticMarkup(<SupportButton product="booking-admin" submit={submit} />);

    expect(markup).toContain("fixed bottom-4 right-4 z-40 px-3 py-2 shadow-sm");
    expect(markup).toContain(">Help / Report a bug</button>");
  });

  it("offers compact in-flow Help with its full accessible name", () => {
    vi.stubEnv("NEXT_PUBLIC_AUTHKIT_LOGIN_ENABLED", "true");
    const markup = renderToStaticMarkup(
      <SupportButton product="pms" submit={submit} placement="header" />,
    );

    expect(markup).not.toContain("fixed");
    expect(markup).toContain("min-h-11 min-w-11 shrink-0");
    expect(markup).toContain('aria-label="Help / Report a bug"');
    expect(markup).toContain(">Help</button>");
    expect(markup).toContain('aria-label="Help and bug reports"');
  });
});
