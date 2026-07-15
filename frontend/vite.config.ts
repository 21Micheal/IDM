import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@/": path.resolve(__dirname, "./src") + "/",
    },
  },
  // PDF.js worker is a large binary — exclude from dep pre-bundling
  // so Vite handles it as a plain asset URL via import.meta.url
  // Added 'recharts' to include to ensure Vite pre-bundles it correctly
  optimizeDeps: {
    include: ["recharts"],
    exclude: ["pdfjs-dist"],
  },
  build: {
    rollupOptions: {
      // Keep the PDF.js worker in its own chunk so it isn't inlined
      output: {
        manualChunks(id) {
          if (id.includes("pdfjs-dist")) {
            return "pdfjs";
          }
          if (id.includes("node_modules")) {
            // ── Heavy, page-specific libraries ──────────────────────────────
            // These are only used by a handful of lazy routes. Keeping each in
            // its own chunk means the dashboard / first paint no longer pays
            // for them — they load on demand with the page that needs them.
            // (Previously they were swept into the catch-all `vendor` chunk,
            // which `zustand` forced to load eagerly on every page.)
            // pdf-lib ships its bulk in separate scoped packages
            // (@pdf-lib/standard-fonts is ~97kB gz alone) and pulls in `pako`.
            // Match all of them — `/pdf-lib/` alone misses the `@pdf-lib/*`
            // scope and strands them in the eager catch-all vendor.
            if (
              id.includes("/pdf-lib/") ||
              id.includes("@pdf-lib/") ||
              id.includes("/pako/")
            ) {
              return "pdf-lib-vendor";          // DocumentViewer, PDF editor
            }
            if (id.includes("@dnd-kit")) {
              return "dnd-vendor";              // Workflow builder, signature placement
            }
            if (id.includes("@radix-ui")) {
              return "radix-vendor";            // Dialog/modal primitives
            }
            // react-dropzone + its runtime deps (file-selector / attr-accept).
            if (
              id.includes("/react-dropzone/") ||
              id.includes("/file-selector/") ||
              id.includes("/attr-accept/")
            ) {
              return "dropzone-vendor";         // Upload / bulk-scan pages
            }

            if (
              id.includes("/react/") ||
              id.includes("/react-dom/") ||
              id.includes("/react-router") ||
              id.includes("/scheduler/") ||
              id.includes("@remix-run/router") ||
              id.includes("/loose-envify/") ||
              id.includes("/js-tokens/")
            ) {
              return "framework-vendor";
            }
            if (id.includes("@tanstack/react-query")) {
              return "query-vendor";
            }
            // sonner + react-toastify are only used by the (lazy) template
            // pages — keep them out of the eagerly-loaded catch-all vendor.
            if (id.includes("/sonner/") || id.includes("/react-toastify/")) {
              return "toast-vendor";
            }
            // recharts pulls in lodash + helpers; route them all to the charts
            // chunk so they load lazily with the Analytics page only, instead
            // of being stranded (and eagerly loaded) in the catch-all vendor.
            if (
              id.includes("recharts") ||
              id.includes("d3-") ||
              id.includes("/lodash/") ||
              id.includes("/react-smooth/") ||
              id.includes("/victory-vendor/") ||
              id.includes("/decimal.js-light/")
            ) {
              return "charts-vendor";
            }
            if (
              id.includes("react-hook-form") ||
              id.includes("@hookform/resolvers") ||
              id.includes("/zod/")
            ) {
              return "forms-vendor";
            }
            if (id.includes("/axios/")) {
              return "network-vendor";
            }
            if (id.includes("/lucide-react/")) {
              return "icons-vendor";
            }
            if (
              id.includes("/clsx/") ||
              id.includes("/tailwind-merge/") ||
              id.includes("/date-fns/")
            ) {
              return "ui-vendor";
            }
            return "vendor";
          }
        },
      },
    },
  },
  server: {
    host: "0.0.0.0",
    port: 3000,
    allowedHosts: [
      "localhost",
      "127.0.0.1",
      ".ngrok-free.dev",
      "superaesthetically-semicylindric-gidget.ngrok-free.dev",
    ],
    historyApiFallback: true,
    proxy: {
      "/api": {
        target: "http://backend:8000",
        changeOrigin: true,
      },
      "/media": {
        target: "http://backend:8000",
        changeOrigin: true,
      },
    },
  },
});
