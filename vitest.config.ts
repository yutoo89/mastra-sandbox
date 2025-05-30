import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: "./globalSetup.ts",
    setupFiles: ["./testSetup.ts"],
    // agent評価のタイムアウト対策
    testTimeout: 10000,
    hookTimeout: 10000,
    // SQLITE_BUSY: database is locked エラー対策
    pool: 'forks',
    fileParallelism: false,
    // テストのグローバル設定
    environment: 'node',
    include: ['**/*.test.ts'],
    // カバレッジの設定
    coverage: {
      reporter: ['text', 'html'],
    },
  },
}); 