import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Electron 生产模式以 file:// 加载 dist/index.html，资源需相对路径
  base: "./",
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
});
