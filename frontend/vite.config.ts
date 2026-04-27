import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  // PDF.js worker is a large binary — exclude from dep pre-bundling
  // so Vite handles it as a plain asset URL via import.meta.url
  optimizeDeps: {
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
