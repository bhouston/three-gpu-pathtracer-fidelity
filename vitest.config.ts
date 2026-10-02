import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'packages/*/src/**/*.test.tsx',
      'submodules/fidelity-kit-blender/src/**/*.test.ts',
      'submodules/fidelity-kit-three-gpu-pathtracer/src/**/*.test.ts',
    ],
    exclude: ['**/dist/**', '**/node_modules/**'],
    environment: 'node',
    testTimeout: 120_000, // the scene registry test loads every model (the LEGO ones parse thousands of LDraw parts)
    coverage: {
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.spec.ts', '**/node_modules/**'],
    },
  },
});
