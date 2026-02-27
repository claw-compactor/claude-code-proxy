/** @type {import('next').NextConfig} */
const nextConfig = {
  // Server mode — needed for API routes (PG live data).
  // Static export disabled. Use `next start` in production.
  // No basePath when deployed directly on aimm-prod:3000
  images: { unoptimized: true },
};
export default nextConfig;
