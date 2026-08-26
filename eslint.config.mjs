import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'docs/**', '**/coverage/**', '.turbo/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // 严格规则由 ENG-02 质量门禁统一收敛；骨架阶段仅保证可运行。
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['scripts/**/*.mjs', 'contracts/**/*.mjs'],
    rules: {
      // 纯 JS/MJS 文件由 Node 运行时提供全局对象，避免维护易过时的 globals 清单
      'no-undef': 'off',
    },
  },
);
