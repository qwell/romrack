const { defineConfig } = require('eslint/config');
const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const prettierRecommended = require('eslint-plugin-prettier/recommended');
const globals = require('globals');

module.exports = defineConfig(
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
                tsconfigRootDir: __dirname,
            },
        },
    },

    {
        files: ['**/eslint.config.cjs', '**/vitest.config.ts'],
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
