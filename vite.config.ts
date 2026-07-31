import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  root: "src/frontend",
  base: "./",
  optimizeDeps: {
    exclude: ["monaco-editor"],
  },
  build: {
    outDir: "../../dist/frontend",
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      input: {
        dashboard: resolve(__dirname, "src/frontend/dashboard.html"),
        "monaco-entry": resolve(__dirname, "src/frontend/editor/monaco-setup.ts"),
      },
      output: {
        entryFileNames: (chunk) => chunk.name === "monaco-entry"
          ? "js/monaco-entry.js"
          : "assets/[name]-[hash].js",
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    host: "127.0.0.1",
    proxy: {
      "/api": "http://127.0.0.1:3099",
    },
  },
  plugins: [
    // 开发模式：/ → /dashboard.html（Vite 默认只认 index.html）
    { name: "dev-index", configureServer(s) { s.middlewares.use((r, _, n) => { if (r.url === "/" || r.url === "/index.html") r.url = "/dashboard.html"; n(); }); } },
    // 构建时剥离非 module 的 <script> 标签（它们由 esbuild 单独打包，Vite 无需处理）
    { name: "strip-non-module", transformIndexHtml: { order: "pre", handler(html, ctx) {
      if (!ctx.server && ctx.filename) { // build mode (no dev server, has filename)
        return html.replace(/<script(?![\s>]*type=["']module)[\s\S]*?<\/script>\n?/g, "");
      }
      return html;
    } } },
  ],
});
