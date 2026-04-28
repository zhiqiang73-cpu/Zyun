/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false, // dev-only: avoid double-fire of API routes during agent streaming
  experimental: {
    serverComponentsExternalPackages: ['@anthropic-ai/claude-agent-sdk', 'better-sqlite3'],
    serverActions: { bodySizeLimit: '4mb' },
  },
};

module.exports = nextConfig;
