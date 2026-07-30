import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import tailwindcss from "@tailwindcss/vite";

// Plain client-side SPA build (no SSR/Nitro). Output goes to dist/, ready for
// any static host (Cloudflare Pages, Vercel static, etc). functions/api/
// (Cloudflare Pages Functions) handle the few things that need a service-role key.
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
    tailwindcss(),
  ],
  build: {
    outDir: "dist",
  },
});