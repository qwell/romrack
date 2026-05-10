import { defineConfig } from 'eslint/config';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';

export default defineConfig(
    {
        ignores: [
            '**/dist/',
            '**/.cache/',
            '**/*.d.ts',
            '**/node_modules/',
            '**/.yarn/',
            '**/.pnp.cjs',
            '**/.pnp.loader.mjs',
        ],
    },

    js.configs.recommended,
    prettierRecommended,

    {
        files: ['**/*.ts'],
        extends: [
            tseslint.configs.recommended,
            tseslint.configs.recommendedTypeChecked,
        ],
        languageOptions: {
            parser: tseslint.parser,
            parserOptions: {
                ecmaVersion: 2022,
                sourceType: 'module',
                projectService: {
                    allowDefaultProject: ['vitest.config.ts'],
                },
                tsconfigRootDir: import.meta.dirname,
            },
        },
    },

    {
        files: ['eslint.config.js', 'vitest.config.ts'],
        languageOptions: {
            globals: {
                ...globals.node,
            },
        },
    },

    {
        files: ['src/server/**/*.ts', 'scripts/**/*.ts'],
        languageOptions: {
            globals: {
                ...globals.node,
            },
        },
    },

    {
        files: ['src/client/**/*.ts'],
        languageOptions: {
            globals: {
                ...globals.browser,
            },
        },
    }
);
