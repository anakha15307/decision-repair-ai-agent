import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3"],
  poweredByHeader: false,
  outputFileTracingRoot: process.cwd(),
};

export default nextConfig;
