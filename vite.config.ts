import { defineConfig } from "vite";
import { resolve } from "path";

const buildTarget = process.env.MY_CODE_AGENT_VITE_TARGET || "all";
const workerNames = {
  "worker:editor": "editor.worker",
  "worker:typescript": "ts.worker",
  "worker:json": "json.worker",
  "worker:css": "css.worker",
  "worker:html": "html.worker",
} as const;
const workerName = workerNames[buildTarget as keyof typeof workerNames];
const buildWorker = Boolean(workerName);
const workerInput = workerName
  ? resolve(__dirname, `src/frontend/editor/workers/${workerName === "ts.worker" ? "typescript" : workerName.replace(".worker", "")}.ts`)
  : undefined;

export default defineConfig({
  root: "src/frontend",
  base: "./",
  optimizeDeps: {
    exclude: ["monaco-editor"],
  },
  build: {
    outDir: "../../dist/frontend",
    // The dashboard and Monaco graphs are built in separate processes. The
    // second pass must retain the dashboard assets already emitted by Vite.
    emptyOutDir: !buildWorker,
    cssCodeSplit: false,
    minify: "esbuild",
    // Gzip-size reporting retains every large worker chunk during the peak
    // native-memory phase. CI already performs artifact-size checks in smoke.
    reportCompressedSize: false,
    rollupOptions: {
      input: buildWorker
        ? { [workerName!]: workerInput! }
        : { dashboard: resolve(__dirname, "src/frontend/dashboard.html") },
      output: {
        entryFileNames: buildWorker
          ? `assets/${workerName}.js`
          : "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
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
