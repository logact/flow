/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['better-sqlite3', 'pdfjs-dist', '@napi-rs/canvas', 'tesseract.js'],
};

export default nextConfig;
