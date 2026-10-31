/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  // Relative asset paths are only needed for the static export Anna serves;
  // in dev they break chunk loading and the page never hydrates.
  assetPrefix: process.env.NODE_ENV === "production" ? "./" : undefined,
  images: { unoptimized: true },
};

export default nextConfig;
