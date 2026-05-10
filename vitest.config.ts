import { defineConfig } from 'vitest/config';

export default defineConfig({
    cacheDir: '.cache/vite',
    test: {
        includeSource: ['src/**/*.ts', 'scripts/**/*.ts'],
    },
});
