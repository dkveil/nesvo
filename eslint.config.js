// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*'],
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    // Transport and domain code must remain usable without the mobile UI.
    files: ['src/connection/**/*.ts', 'src/groups.ts', 'src/types.ts'],
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
                '**/state/**',
                '**/screens/**',
                '**/AppRoot',
                '**/components/**',
              ],
              message:
                'Keep domain and transport independent from UI. Inject effects through the application layer.',
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      'src/app/**/*.{ts,tsx}',
      'src/screens/**/*.{ts,tsx}',
      'src/components/**/*.{ts,tsx}',
      'src/*Screen.tsx',
      'src/AppRoot.tsx',
      'src/GroupPicker.tsx',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/connection/wire', 'tweetnacl', 'ws'],
              message:
                'Use the application state or HostClient; screens must not implement transport or encryption.',
            },
          ],
        },
      ],
    },
  },
]);
