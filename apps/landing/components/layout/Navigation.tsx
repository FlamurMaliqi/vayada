"use client";

import { useRef } from "react";
import { ROUTES } from "@/lib/constants/routes";
import { Bars3Icon, XMarkIcon } from "@heroicons/react/24/outline";

const NAV_LINKS = [
  { label: "Hotel products", href: "/#products" },
  { label: "Browse hotel stays", href: ROUTES.PROPERTIES },
  { label: "Pricing", href: ROUTES.PRICING },
];

export default function Navigation() {
  const mobileMenu = useRef<HTMLDetailsElement>(null);
  const closeMobileMenu = () => {
    if (mobileMenu.current) mobileMenu.current.open = false;
  };

  return (
    <nav
      aria-label="Main navigation"
      className="fixed left-0 right-0 top-0 z-50 border-b border-border bg-white/90 backdrop-blur-xl"
    >
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex h-16 items-center justify-between">
          <a href={ROUTES.HOME} className="flex items-center">
            <span className="font-display text-lg font-semibold lowercase text-primary-500">
              vayada
            </span>
          </a>

          <div className="hidden items-center gap-8 md:flex">
            {NAV_LINKS.map((link) => (
              <a
                key={link.href}
                href={link.href}
                className="text-sm text-gray-500 transition-colors hover:text-ink"
              >
                {link.label}
              </a>
            ))}
          </div>

          <div className="hidden items-center gap-3 md:flex">
            <a
              href={ROUTES.LOGIN}
              className="px-3 py-2 text-sm text-gray-500 transition-colors hover:text-ink"
            >
              Log in
            </a>
            <a
              href={ROUTES.SIGNUP}
              className="inline-flex items-center rounded-full border border-primary-500 px-4 py-2 text-sm font-medium text-primary-600 transition-colors hover:bg-primary-50 active:translate-y-px"
            >
              Sign up
            </a>
          </div>

          <details ref={mobileMenu} className="group md:hidden">
            <summary className="list-none rounded-full p-2 text-gray-700 transition-colors hover:bg-gray-100">
              <span className="sr-only">Toggle menu</span>
              <Bars3Icon className="h-6 w-6 group-open:hidden" />
              <XMarkIcon className="hidden h-6 w-6 group-open:block" />
            </summary>
            <div
              id="mobile-navigation"
              className="absolute inset-x-0 top-16 space-y-2 border-b border-border bg-white px-4 py-4 shadow-soft"
            >
              {NAV_LINKS.map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  onClick={closeMobileMenu}
                  className="block px-2 py-2 text-sm text-gray-700 hover:text-ink"
                >
                  {link.label}
                </a>
              ))}
              <a
                href={ROUTES.LOGIN}
                onClick={closeMobileMenu}
                className="block px-2 py-2 text-sm text-gray-700 hover:text-ink"
              >
                Log in
              </a>
              <a
                href={ROUTES.SIGNUP}
                onClick={closeMobileMenu}
                className="mx-2 mt-2 flex items-center justify-center rounded-full border border-primary-500 px-5 py-2.5 text-sm font-medium text-primary-600 transition-colors hover:bg-primary-50"
              >
                Sign up
              </a>
            </div>
          </details>
        </div>
      </div>
    </nav>
  );
}
