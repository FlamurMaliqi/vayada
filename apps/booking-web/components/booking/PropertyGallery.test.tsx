/** @vitest-environment jsdom */

import type { ComponentProps } from "react";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import deMessages from "../../messages/de.json";
import enMessages from "../../messages/en.json";
import PropertyGallery from "./PropertyGallery";

vi.mock("next/image", () => ({
  default: ({ fill, priority, quality, ...props }: ImageProps) => {
    void fill;
    void priority;
    void quality;
    return createElement("img", props);
  },
}));

type ImageProps = ComponentProps<"img"> & {
  fill?: boolean;
  priority?: boolean;
  quality?: number;
};

describe("PropertyGallery", () => {
  let root: Root | null = null;

  beforeEach(() => {
    document.body.innerHTML = '<button id="behind">Behind modal</button><div id="root"></div>';
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    document.body.innerHTML = "";
  });

  it("does not render a trigger when the property has no gallery photos", () => {
    expect(renderGalleryToMarkup("en", [])).toBe("");
  });

  it("deduplicates and caps the guest-facing gallery at ten photos", () => {
    const images = Array.from({ length: 12 }, (_, index) =>
      index === 11
        ? "https://cdn.vayada.com/gallery-1.webp"
        : `https://cdn.vayada.com/gallery-${index + 1}.webp`,
    );

    const markup = renderGalleryToMarkup("en", images);

    expect(markup).toContain("View photos (10)");
    expect(markup).toContain('aria-haspopup="dialog"');
  });

  it("renders guest controls in the requested locale", () => {
    expect(renderGalleryToMarkup("de", ["https://cdn.vayada.com/gallery.webp"])).toContain(
      "Fotos ansehen (1)",
    );
  });

  it("keeps keyboard focus inside the open modal", () => {
    renderInteractiveGallery();
    const trigger = button("View photos (2)");
    act(() => trigger.click());

    const close = button("Close our photo gallery");
    const next = button("Next photo of our property");
    expect(document.activeElement).toBe(close);

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(document.activeElement).toBe(next);

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
      );
    });
    expect(document.activeElement).toBe(close);
    expect(document.activeElement).not.toBe(document.querySelector("#behind"));
  });

  function renderInteractiveGallery() {
    const container = document.querySelector("#root");
    if (!(container instanceof HTMLElement)) throw new Error("Missing test root");
    root = createRoot(container);
    act(() => {
      root?.render(
        <NextIntlClientProvider locale="en" messages={enMessages}>
          <PropertyGallery
            hotelName="Hotel Alpenrose"
            images={[
              "https://cdn.vayada.com/gallery-1.webp",
              "https://cdn.vayada.com/gallery-2.webp",
            ]}
          />
        </NextIntlClientProvider>,
      );
    });
  }
});

function renderGalleryToMarkup(locale: "de" | "en", images: string[]) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "de" ? deMessages : enMessages}>
      <PropertyGallery hotelName="Hotel Alpenrose" images={images} />
    </NextIntlClientProvider>,
  );
}

function button(label: string): HTMLButtonElement {
  const element = Array.from(document.querySelectorAll("button")).find(
    (candidate) =>
      candidate.textContent === label || candidate.getAttribute("aria-label") === label,
  );
  if (!(element instanceof HTMLButtonElement)) throw new Error(`Missing button: ${label}`);
  return element;
}
