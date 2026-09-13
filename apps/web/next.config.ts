import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Next 16.3's CLI type-check path currently fails to parse TS 5.9 --showConfig
    // output in monorepos. Keep the stable compiler API until that upstream bug is fixed.
    useTypeScriptCli: false,
  },
  output: "standalone",
  poweredByHeader: false,
};

export default nextConfig;
