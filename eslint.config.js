import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  // .claude holds agent worktrees — separate checkouts with their own tsconfig,
  // which the type-aware parser cannot resolve from here.
  { ignores: ['dist', 'node_modules', 'public', '.claude'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Typed arrays and interop with the OCCT wasm make a few any-s unavoidable;
      // flag them rather than fail the build.
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
);
