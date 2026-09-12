import path from 'path';
import type { NextConfig } from 'next';

const imageRemotePatterns: NonNullable<NonNullable<NextConfig['images']>['remotePatterns']> = [
  {
    protocol: 'https',
    hostname: '**.supabase.co',
    pathname: '/storage/v1/object/public/**',
  },
];

// Self-hosted Supabase: allow the custom domain for storage image optimization.
// Supports both "https://supabase.example.com" and bare "supabase.example.com".
if (process.env.SUPABASE_URL) {
  try {
    const parsed = new URL(
      process.env.SUPABASE_URL.startsWith('http')
        ? process.env.SUPABASE_URL
        : `https://${process.env.SUPABASE_URL}`,
    );
    imageRemotePatterns.push({
      protocol: (parsed.protocol.replace(':', '') as 'http' | 'https') || 'https',
      hostname: parsed.hostname,
      pathname: '/storage/v1/object/public/**',
    });
  } catch {
    // Invalid SUPABASE_URL — skip adding remote pattern
  }
}

const nextConfig: NextConfig = {
  // Webwow: emit a standalone server bundle (`.next/standalone/server.js`) so slim
  // Docker images are possible. The shipped Dockerfile still runs `next start` with
  // the full node_modules because knex + ts-node are needed at container start for
  // migrations; Next then logs a one-line "next start does not work with output:
  // standalone" warning, which is harmless in that setup.
  output: 'standalone',
  trailingSlash: false,
  staticPageGenerationTimeout: 120,
  experimental: {
    proxyClientMaxBodySize: '500mb',
    // Webwow: route handlers share the Server Actions body limit — raised so
    // Webflow ZIP exports (tens of MB) can be uploaded to the importer.
    serverActions: {
      bodySizeLimit: '100mb',
    },
  },
  images: {
    remotePatterns: imageRemotePatterns,
  },

  // Ensure sharp works properly in serverless environments (Vercel)
  // Also externalize Knex database drivers (we only use PostgreSQL)
  // This works for both webpack and Turbopack
  serverExternalPackages: [
    'sharp',
    'oracledb',
    'mysql',
    'mysql2',
    'sqlite3',
    'better-sqlite3',
    'tedious',
    'pg-query-stream',
  ],

  // Turbopack configuration
  // Map unused database drivers to stub modules (we only use PostgreSQL)
  // This prevents Turbopack from trying to resolve packages that aren't installed
  turbopack: {
    // Webwow: pin the workspace root to this directory so Turbopack never picks a
    // lockfile in a parent directory (e.g. when the repo lives inside another project).
    root: path.resolve(__dirname),
    resolveAlias: {
      // Map unused database drivers to stub module to prevent resolution errors
      'oracledb': './lib/stubs/db-driver-stub.ts',
      'mysql': './lib/stubs/db-driver-stub.ts',
      'mysql2': './lib/stubs/db-driver-stub.ts',
      'sqlite3': './lib/stubs/db-driver-stub.ts',
      'better-sqlite3': './lib/stubs/db-driver-stub.ts',
      'tedious': './lib/stubs/db-driver-stub.ts',
      'pg-query-stream': './lib/stubs/db-driver-stub.ts',
    },
  },

  // Webwow: the previous fork served the builder under /webwow. The builder now
  // keeps upstream's /ycode prefix (fewer merge conflicts); old bookmarks and
  // links are redirected permanently.
  async redirects() {
    return [
      {
        source: '/webwow/:path*',
        destination: '/ycode/:path*',
        permanent: true,
      },
    ];
  },

  async headers() {
    return [
      {
        // Asset proxy: immutable caching (content-addressed by hash)
        source: '/a/:path*',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=31536000, immutable',
          },
        ],
      },
      {
        // Apply to public pages ONLY (exclude /ycode/*, /_next/*, /a/*)
        // NOTE: Do NOT set Cache-Control here. Vercel recommends letting
        // ISR manage cache headers automatically so per-URL cache-tag
        // tracking works for selective revalidateTag invalidations.
        // Manual s-maxage breaks per-URL purging on catch-all routes.
        source: '/:path((?!ycode|_next|a/).*)*',
        headers: [
          {
            // Open the TLS connection to fonts.gstatic.com while the document
            // is still streaming so woff2 binaries can be fetched the moment
            // the inlined @font-face rules are parsed. Sending this as a
            // response header (vs. <link rel=preconnect> in <head>) lets the
            // browser act on it before parsing the document.
            key: 'Link',
            value: '<https://fonts.gstatic.com>; rel=preconnect; crossorigin',
          },
        ],
      },
    ];
  },

  webpack: (config, { isServer }) => {
    if (isServer) {
      // Ignore optional dependencies that Knex tries to load
      // We only use PostgreSQL, so we don't need these drivers
      config.externals = config.externals || [];
      config.externals.push({
        'oracledb': 'commonjs oracledb',
        'mysql': 'commonjs mysql',
        'mysql2': 'commonjs mysql2',
        'sqlite3': 'commonjs sqlite3',
        'better-sqlite3': 'commonjs better-sqlite3',
        'tedious': 'commonjs tedious',
        'pg-query-stream': 'commonjs pg-query-stream',
      });
    }

    // Suppress Knex migration warnings (we don't use migrations in Next.js runtime)
    config.ignoreWarnings = [
      ...(config.ignoreWarnings || []),
      {
        module: /node_modules\/knex\/lib\/migrations\/util\/import-file\.js/,
        message: /Critical dependency: the request of a dependency is an expression/,
      },
    ];

    return config;
  },
};

export default nextConfig;
