const path = require('node:path');
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
const boundaries = require('eslint-plugin-boundaries');
const conventions = require('./scripts/eslint-conventions.cjs');

const layerPolicies = [
  ['app', ['widgets', 'features', 'entities', 'shared']],
  ['widgets', ['features', 'entities', 'shared']],
  ['features', ['entities', 'shared']],
  ['entities', ['entities', 'shared']],
  ['shared', ['shared']],
].map(([from, to]) => ({
  from: { element: { type: from } },
  allow: { to: { element: { type: to } } },
}));

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['**/dist/**', '**/.expo/**', '**/target/**', '**/generated.ts', 'artifacts/**'],
  },
  {
    files: ['apps/mobile/src/**/*.{ts,tsx}'],
    plugins: { boundaries, conventions },
    settings: {
      'import/resolver': {
        typescript: { project: path.join(__dirname, 'apps/mobile/tsconfig.json') },
      },
      'boundaries/elements': [
        { type: 'app', pattern: 'apps/mobile/src/app/**' },
        { type: 'widgets', pattern: 'apps/mobile/src/widgets/*' },
        { type: 'features', pattern: 'apps/mobile/src/features/*' },
        { type: 'entities', pattern: 'apps/mobile/src/entities/*' },
        { type: 'shared', pattern: 'apps/mobile/src/shared/**' },
      ],
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'react/jsx-no-leaked-render': ['error', { validStrategies: ['coerce', 'ternary'] }],
      'conventions/kebab-case': 'error',
      'boundaries/no-unknown-files': 'error',
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          policies: [
            ...layerPolicies,
            {
              disallow: {
                to: {
                  element: {
                    type: ['features', 'entities', 'widgets'],
                    fileInternalPath: '!index.ts',
                  },
                },
              },
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/mobile/src/{entities,shared}/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'expo-router', message: 'Inject navigation from the app composition layer.' },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/mobile/src/shared/api/host/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'react',
                'react-native',
                'expo-router',
                '@widgets/*',
                '@features/*',
                '@entities/*',
                '@shared/ui*',
              ],
              message: 'Keep host transport independent from UI and product domains.',
            },
          ],
        },
      ],
    },
  },
]);
