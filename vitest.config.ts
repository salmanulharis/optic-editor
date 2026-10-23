import { defineConfig } from 'vitest/config';

// Unit tests (pure TypeScript: recipes, colour maths, export geometry). Browser tests live in
// tests/e2e (Playwright) and scripts/run-bench.mjs (GPU seam test).
export default defineConfig({
  test: { include: ['tests/unit/**/*.test.ts'], environment: 'node' },
});
