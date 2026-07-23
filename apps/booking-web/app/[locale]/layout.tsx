import { hasLocale } from "next-intl";
import { getMessages, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { routing } from "@/i18n/routing";
import IntlProviderClient from "@/i18n/IntlProviderClient";
import Providers from "./providers";
import DomainNotConfigured from "@/components/DomainNotConfigured";
import { getRequestHost } from "@/lib/requestHost";
import { resolveSlugFromHost } from "@/lib/server/resolveSlug";

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;

  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }

  setRequestLocale(locale);

  const messages = await getMessages();

  const headersList = await headers();
  const hostname = getRequestHost(headersList);
  // `undefined` is dev-only — the HotelProvider's client effect resolves
  // the slug from ?slug=/localStorage so a single dev container can
  // serve any hotel. `null` is a real production miss → render the
  // Domain Not Configured page instead of falling through to a wrong
  // hotel (see VAY-394: the previous `hotel-alpenrose` fallback caused
  // guests to see "Hotel 'hotel-alpenrose' not found" on misconfigured
  // custom domains).
  const slug = await resolveSlugFromHost(hostname);

  if (slug === null) {
    return (
      <html lang={locale}>
        <body className="font-body">
          <DomainNotConfigured hostname={hostname} />
        </body>
      </html>
    );
  }

  return (
    <html lang={locale}>
      <body className="font-body">
        <IntlProviderClient locale={locale} messages={messages}>
          <Providers locale={locale} slug={slug}>
            {children}
          </Providers>
        </IntlProviderClient>
      </body>
    </html>
  );
}
