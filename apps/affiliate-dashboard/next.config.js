/** @type {import('next').NextConfig} */ // VAY-423 e2e deploy test
const path = require("path");
const authPublicHostname = (() => {
  try {
    return process.env.AUTH_PUBLIC_ORIGIN ? new URL(process.env.AUTH_PUBLIC_ORIGIN).hostname : null;
  } catch {
    return null;
  }
})();
const nextConfig = {
  reactStrictMode: true,
  allowedDevOrigins: ["127.0.0.1", ...(authPublicHostname ? [authPublicHostname] : [])],
  output: "standalone",
  turbopack: {
    root: path.join(__dirname, "../.."),
  },
};

module.exports = nextConfig;
