import type { NextConfig } from 'next';
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants';

export default function nextConfig(phase: string): NextConfig {
  return {
    agentRules: false,
    // Keep development manifests separate from production builds. Running
    // `next build` while `next dev` is open must not replace the dev router.
    distDir: phase === PHASE_DEVELOPMENT_SERVER ? '.next-dev' : '.next',
    output: 'standalone',
    reactStrictMode: true,
    // Multipart adds overhead to the media API's 25 MB file limit.
    experimental: { proxyClientMaxBodySize: '26mb' },
    async headers() {
      return [
        {
          source: '/(.*)',
          headers: [
            { key: 'X-Content-Type-Options', value: 'nosniff' },
            { key: 'X-Frame-Options', value: 'DENY' },
            { key: 'Referrer-Policy', value: 'same-origin' },
            {
              key: 'Permissions-Policy',
              value: 'camera=(), microphone=(), geolocation=()',
            },
          ],
        },
      ];
    },
  };
}
