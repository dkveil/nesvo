export type FileCategory =
  | 'image'
  | 'document'
  | 'spreadsheet'
  | 'data'
  | 'archive'
  | 'audio'
  | 'video'
  | 'program'
  | 'code'
  | 'other';

const CATEGORY_EXTENSIONS: [FileCategory, string[]][] = [
  [
    'image',
    ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'heic', 'tif'],
  ],
  [
    'document',
    ['pdf', 'txt', 'md', 'markdown', 'rtf', 'doc', 'docx', 'odt', 'log'],
  ],
  ['spreadsheet', ['csv', 'tsv', 'xls', 'xlsx', 'ods', 'numbers']],
  ['data', ['json', 'jsonc', 'yaml', 'yml', 'toml', 'xml', 'ini', 'env']],
  ['archive', ['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'zst']],
  ['audio', ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac']],
  ['video', ['mp4', 'mov', 'mkv', 'webm', 'avi']],
  ['program', ['sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd', 'exe', 'msi', 'bin']],
  [
    'code',
    [
      'ts',
      'tsx',
      'js',
      'jsx',
      'mjs',
      'cjs',
      'py',
      'rb',
      'go',
      'rs',
      'java',
      'kt',
      'swift',
      'c',
      'h',
      'cpp',
      'hpp',
      'cs',
      'php',
      'html',
      'css',
      'scss',
      'sql',
      'vue',
      'svelte',
    ],
  ],
];

const CATEGORIES = new Map(
  CATEGORY_EXTENSIONS.flatMap(([category, extensions]) =>
    extensions.map(extension => [extension, category] as const),
  ),
);

export const fileExtension = (name: string) => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

export const fileCategory = (name: string): FileCategory =>
  CATEGORIES.get(fileExtension(name)) ?? 'other';
