import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // テストのグローバル設定
    environment: 'node',
    include: ['**/*.test.ts'],
    // カバレッジの設定
    coverage: {
      reporter: ['text', 'html'],
    },
  },
}); 