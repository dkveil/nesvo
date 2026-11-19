import tseslint from 'typescript-eslint';
import hooks from 'eslint-plugin-react-hooks';
import refresh from 'eslint-plugin-react-refresh';
import prettier from 'eslint-config-prettier';

const typed = [
  'apps/desktop/src/**/*.{ts,tsx}',
  'apps/host/src/**/*.ts',
  'apps/mobile-client/src/**/*.{ts,tsx}',
  'packages/contracts/src/**/*.ts',
  'apps/web/src/**/*.{ts,tsx}',
  'apps/web/tests/**/*.{ts,tsx}',
  'apps/web/*.ts',
];
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/release/**',
      'apps/web/.next/**',
      'apps/web/.open-next/**',
      'apps/web/.wrangler/**',
      'apps/web/next-env.d.ts',
    ],
  },
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
          allowExportNames: [
            'buttonVariants',
            'badgeVariants',
            'toggleVariants',
          ],
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
          paths: [
            {
              name: '@/shared/lib/use-panel-width',
              importNames: ['usePanelWidth'],
              message: 'SidePanel owns drawer widths.',
            },
            {
              name: '@/shared/ui/panel-resizer',
              message: 'SidePanel owns drawer resizing.',
            },
            {
              name: '@/shared/ui/sheet',
              importNames: ['SheetContent'],
              message:
                'Use SidePanel for right drawers or LeftSheetContent for navigation.',
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      'apps/desktop/src/renderer/src/features/edit-automation/automation-editor.tsx',
      'apps/desktop/src/renderer/src/features/new-workflow/new-workflow-drawer.tsx',
      'apps/desktop/src/renderer/src/widgets/workflow-assistant/index.tsx',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'ImportDeclaration[source.value="@/shared/ui/dialog"], ImportDeclaration[source.value="@/shared/ui/sheet"]',
          message: 'Use SidePanel for this right drawer.',
        },
      ],
    },
  },
  {
    files: ['apps/mobile-client/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': hooks },
    rules: {
      ...hooks.configs.recommended.rules,
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            'effect',
            'effect/*',
            'node:*',
            'electron',
            '@nesvo/host',
            '@nesvo/host/*',
            '@nesvo/desktop',
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
  {
    files: ['apps/web/src/**/*.{ts,tsx}', 'apps/web/tests/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': hooks },
    rules: {
      ...hooks.configs.recommended.rules,
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            'effect',
            'effect/*',
            'electron',
            '@nesvo/host',
            '@nesvo/host/*',
            '@nesvo/desktop',
          ],
        },
      ],
    },
  },
  prettier,
);
