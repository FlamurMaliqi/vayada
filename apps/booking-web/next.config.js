const path = require("path");
const createNextIntlPlugin = require("next-intl/plugin");
const isDevelopment = process.env.NODE_ENV === "development";
const bookingWebApiOrigin =
  process.env.BOOKING_WEB_API_URL ||
  process.env.NEXT_PUBLIC_BOOKING_WEB_API_URL ||
  "https://api.localhost";
const bookingApiOrigin =
  process.env.BOOKING_API_URL || process.env.NEXT_PUBLIC_API_URL || "https://api.booking.localhost";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  allowedDevOrigins: ["127.0.0.1", "hotel-alpenrose.booking.localhost", "*.booking.localhost"],
  turbopack: {
    root: path.join(__dirname, "../.."),
  },
  async rewrites() {
    return [
      {
        source: "/api/booking-web/:path*",
        destination: `${bookingWebApiOrigin}/api/booking-web/:path*`,
      },
      {
        source: "/api/hotels/:path*",
        destination: `${bookingApiOrigin}/api/hotels/:path*`,
      },
      {
        source: "/api/exchange-rates",
        destination: `${bookingApiOrigin}/api/exchange-rates`,
      },
    ];
  },
  images: {
    // The local media CDN uses portless HTTPS. Let the browser (which trusts
    // the portless CA) load it directly instead of proxying it through Node.
    unoptimized: isDevelopment,
    qualities: [75, 90],
    remotePatterns: [
      {
        protocol: "https",
        hostname: "api.vayada.com",
      },
      {
        protocol: "https",
        hostname: "**.amazonaws.com",
      },
      {
        protocol: "https",
        hostname: "images.unsplash.com",
      },
      {
        protocol: "https",
        hostname: "cdn.vayada.com",
      },
      {
        protocol: "http",
        hostname: "localhost",
      },
      ...(isDevelopment
        ? [
            {
              protocol: "https",
              hostname: "media.localhost",
            },
            {
              protocol: "https",
              hostname: "hotel.media.localhost",
            },
          ]
        : []),
    ],
  },
};

module.exports = withNextIntl(nextConfig);
