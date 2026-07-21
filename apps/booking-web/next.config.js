const path = require("path");
const createNextIntlPlugin = require("next-intl/plugin");
const isDevelopment = process.env.NODE_ENV === "development";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  allowedDevOrigins: ["127.0.0.1", "hotel-alpenrose.booking.localhost", "*.booking.localhost"],
  turbopack: {
    root: path.join(__dirname, "../.."),
  },
  images: {
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
          ]
        : []),
    ],
  },
};

module.exports = withNextIntl(nextConfig);
