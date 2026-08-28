// 编译 Electron 主进程与 preload：electron/{main,preload}.ts → dist-electron/*.cjs
// （bundle 一体化输出，electron 运行时无需模块解析；renderer 由 vite 单独构建）
import { build } from "esbuild";

const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["electron"],
  sourcemap: false,
  logLevel: "info",
  outdir: "dist-electron",
  outExtension: { ".js": ".cjs" },
};

await build({
  ...common,
  entryPoints: ["electron/main.ts", "electron/preload.ts"],
});
