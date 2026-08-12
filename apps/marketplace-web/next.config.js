/** @type {import('next').NextConfig} */
const path = require("path");
const isDevelopment = process.env.NODE_ENV === "development";
const authPublicHostname = (() => {
  try {
    return process.env.AUTH_PUBLIC_ORIGIN ? new URL(process.env.AUTH_PUBLIC_ORIGIN).hostname : null;
  } catch {
    return null;
  }
})();
const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  allowedDevOrigins: ["127.0.0.1", ...(authPublicHostname ? [authPublicHostname] : [])],
  turbopack: {
    root: path.join(__dirname, "../.."),
  },
  images: {
    dangerouslyAllowLocalIP: isDevelopment,
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
      ...(isDevelopment
        ? [
            {
              protocol: "http",
              hostname: "localhost",
            },
            {
              protocol: "https",
              hostname: "media.localhost",
            },
          ]
        : []),
    ],
  },
};

module.exports = nextConfig;
