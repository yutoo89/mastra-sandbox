import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: "./globalSetup.ts",
    setupFiles: ["./testSetup.ts"],
    // テストのグローバル設定
    environment: 'node',
    include: ['**/*.test.ts'],
    // カバレッジの設定
    coverage: {
      reporter: ['text', 'html'],
    },
  },
}); 