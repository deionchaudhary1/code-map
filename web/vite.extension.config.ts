import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    react(),
    {
      name: "webview-external-graph-styles",
      transform(code, id) {
        if (/\/node_modules\/(force-graph|float-tooltip)\/dist\/[^/]+\.mjs$/.test(id)) {
          // The equivalent rules live in the linked webview stylesheet.
          return code.replace(/^styleInject\(css_\w+\);$/m, "");
        }
      },
    },
  ],
  resolve: {
    alias: {
      // The stock ELK bundle uses a simulated worker. Keep the shared layout
      // call sites and supply a real worker to the editor build.
      "elkjs/lib/elk.bundled.js": fileURLToPath(new URL("./src/extension/layoutWorker.ts", import.meta.url)),
    },
  },
  build: {
    outDir: fileURLToPath(new URL("../extension/dist/webview", import.meta.url)),
    emptyOutDir: true,
    cssCodeSplit: false,
    sourcemap: false,
    lib: {
      entry: fileURLToPath(new URL("./src/extension/main.tsx", import.meta.url)),
      formats: ["iife"],
      name: "CodeMap",
      fileName: () => "graph.js",
    },
    rollupOptions: {
      output: {
        assetFileNames: "graph[extname]",
      },
    },
  },
  // Library builds otherwise leave React's process.env check to the consumer.
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});
