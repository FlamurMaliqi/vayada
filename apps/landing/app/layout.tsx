import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { CookieConsentProvider } from "@/context/CookieConsentContext";
import { CookieBanner, CookieSettingsModal } from "@/components/consent";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
});

export const metadata: Metadata = {
  title: "Vayada - Direct growth for hotels and travel creators",
  description:
    "Booking Engine, PMS and Creator Marketplace for independent hotels and travel creators.",
  icons: {
    icon: [
      { url: "/vayada-logo.png" },
      { url: "/vayada-logo.png", sizes: "64x64", type: "image/png" },
    ],
    apple: [{ url: "/vayada-logo.png", sizes: "180x180", type: "image/png" }],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${inter.className} ${inter.variable}`}>
        <CookieConsentProvider>
          {children}
          <CookieBanner />
          <CookieSettingsModal />
        </CookieConsentProvider>
      </body>
    </html>
  );
}
