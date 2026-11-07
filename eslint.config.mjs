import tseslint from 'typescript-eslint';
import hooks from 'eslint-plugin-react-hooks';
import refresh from 'eslint-plugin-react-refresh';
import prettier from 'eslint-config-prettier';

const typed = [
  'apps/desktop/src/**/*.{ts,tsx}',
  'apps/host/src/**/*.ts',
  'packages/contracts/src/**/*.ts',
];
export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/release/**'] },
  ...tseslint.configs.recommended.map(config => ({ ...config, files: typed })),
  {
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': hooks, 'react-refresh': refresh },
    rules: {
      ...hooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'error',
        {
          allowConstantExport: true,
          allowExportNames: ['buttonVariants', 'badgeVariants'],
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            'effect',
            'effect/*',
            '@nesvo/host',
            '@nesvo/host/*',
            'node:*',
            'electron',
            '../../main/*',
            '../../preload/*',
          ],
        },
      ],
    },
  },
  {
    files: ['packages/contracts/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            'effect',
            'effect/*',
            'node:*',
            'electron',
            'react',
            '@nesvo/host',
            '@nesvo/desktop',
          ],
        },
      ],
    },
  },
  prettier,
);
