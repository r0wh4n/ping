import type { NextConfig } from "next";

const SUPA = "https://wsdslkxdoqwspjfozwvl.supabase.co";
const SUPA_WSS = "wss://wsdslkxdoqwspjfozwvl.supabase.co";

// CSP scoped to what the app actually loads: same-origin code + fonts (next/font
// self-hosts), Supabase for API/realtime(wss)/storage, blob/data for local media
// previews and voice/video. 'unsafe-inline' covers the theme script, JSON-LD, and
// the /mcp page's inline handlers; no 'unsafe-eval'. User content is already
// escaped, so this is defense-in-depth.
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${SUPA}`,
  `media-src 'self' blob: ${SUPA}`,
  "font-src 'self' data:",
  `connect-src 'self' ${SUPA} ${SUPA_WSS}`,
  "worker-src 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "upgrade-insecure-requests",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "geolocation=(), browsing-topics=()" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
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
