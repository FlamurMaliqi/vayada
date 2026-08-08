/** @type {import('next').NextConfig} */
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
  output: "standalone",
  allowedDevOrigins: ["127.0.0.1", ...(authPublicHostname ? [authPublicHostname] : [])],
  transpilePackages: ["@vayada/feature-hub"],
  turbopack: {
    root: path.join(__dirname, "../.."),
  },
};

module.exports = nextConfig;
