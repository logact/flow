/** @type {import('next').NextConfig} */
const nextConfig = {
  allowedDevOrigins: ['192.168.1.*'],
  serverExternalPackages: ['better-sqlite3', 'pdfjs-dist', '@napi-rs/canvas', 'tesseract.js'],
};

export default nextConfig;
