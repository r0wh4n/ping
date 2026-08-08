import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      // mcp.theping.chat/ → the MCP route, so the clean endpoint is
      // https://mcp.theping.chat (also always works at https://theping.chat/mcp).
      {
        source: "/",
        has: [{ type: "host", value: "mcp.theping.chat" }],
        destination: "/mcp",
      },
    ];
  },
};

export default nextConfig;
