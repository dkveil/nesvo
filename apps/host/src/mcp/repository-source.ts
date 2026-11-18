import { mcpReviewBytes } from '@nesvo/contracts';
import { stringify } from 'smol-toml';
import { reviewLaunch, reviewText } from './repository-details';
import { tableSchema, type ConfigTable } from './scoped-config';

type RepositorySource = { path: string; sections: ConfigTable };

function reviewServers(servers: unknown) {
  return Object.fromEntries(
    Object.entries(tableSchema.parse(servers)).map(([name, config]) => {
      const server = tableSchema.safeParse(config);
      return [
        name,
        server.success ? reviewLaunch(server.data, false).reviewed : config,
      ];
    }),
  );
}

function reviewHooks(hooks: unknown) {
  return Object.fromEntries(
    Object.entries(tableSchema.parse(hooks)).map(([event, groups]) => [
      event,
      Array.isArray(groups)
        ? groups.map(value => {
            const group = tableSchema.safeParse(value);
            if (!group.success || !Array.isArray(group.data.hooks))
              return value;
            return {
              ...group.data,
              hooks: group.data.hooks.map(value => {
                const handler = tableSchema.safeParse(value);
                return handler.success
                  ? reviewLaunch(handler.data, true).reviewed
                  : value;
              }),
            };
          })
        : groups,
    ]),
  );
}

function reviewSection(name: string, value: unknown) {
  if (name === 'hooks') return reviewHooks(value);
  if (name === 'projects')
    return Object.fromEntries(
      Object.entries(tableSchema.parse(value)).map(([path, config]) => [
        path,
        { mcpServers: reviewServers(tableSchema.parse(config).mcpServers) },
      ]),
    );
  if (
    [
      'disableAllHooks',
      'settings',
      'commands',
      'agents',
      'skills',
      'output-styles',
    ].includes(name)
  )
    return value;
  return reviewServers(value);
}

export function reviewRepositorySources(sources: RepositorySource[]) {
  let bytes = 0;
  const files = [];
  for (const { path, sections } of sources) {
    const relevant = Object.entries(sections).filter(
      ([, value]) => value === true || Object.keys(value as ConfigTable).length,
    );
    if (!relevant.length) continue;
    const reviewed = Object.fromEntries(
      relevant.map(([name, value]) => [name, reviewSection(name, value)]),
    );
    const formatted = path.endsWith('.toml')
      ? stringify(reviewed)
      : JSON.stringify(reviewed, null, 2);
    const file = {
      path: reviewText(path),
      text: formatted.split('\n').map(reviewText).join('\n'),
    };
    bytes += Buffer.byteLength(JSON.stringify(file));
    if (bytes > mcpReviewBytes) return null;
    files.push(file);
  }
  return files.length ? files : null;
}
