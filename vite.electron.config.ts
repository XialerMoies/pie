import { defineConfig } from "vite";
import * as path from "path";

export default defineConfig({
  build: {
    outDir: "dist-electron",
    lib: {
      entry: path.resolve(__dirname, "src/electron-main.ts"),
      formats: ["cjs"],
      fileName: () => "main.js",
    },
    rollupOptions: {
      external: ["electron"],
    },
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
  },
});
