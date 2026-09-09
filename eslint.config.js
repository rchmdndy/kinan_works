import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const sourceFiles = ['**/*.ts'];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '.bun/**',
      '.zcode/**',
      'data/**',
      'config/**',
      'firebase/**',
      'mosquitto/**',
      'legacy/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...svelte.configs.recommended,
  {
    files: sourceFiles,
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.bun,
        ...globals.node,
      },
      parser: tseslint.parser,
      parserOptions: {
        extraFileExtensions: ['.svelte'],
      },
    },
  },
  {
    files: ['web/**/*.{ts,svelte}'],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    files: ['**/*.svelte'],
    languageOptions: {
      parser: svelte.parser,
      parserOptions: {
        parser: tseslint.parser,
      },
    },
  },
  prettier,
);
