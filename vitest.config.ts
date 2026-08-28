import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 后端（electron/backend）单元测试，node 环境；renderer 无自动化测试
    include: ["electron/**/*.test.ts"],
    environment: "node",
  },
});
