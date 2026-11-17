/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: { agentUpgrade: 'security' },
  allowedDevOrigins: ['192.168.1.*'],
  serverExternalPackages: ['better-sqlite3', 'pdfjs-dist', '@napi-rs/canvas', 'tesseract.js'],
};

export default nextConfig;
