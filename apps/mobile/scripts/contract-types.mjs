import { compile } from 'json-schema-to-typescript';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import prettier from 'prettier';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const OUTPUT_DIRECTORY = 'apps/mobile/src/shared/api/contracts';

export const CONTRACT_TYPES = [
  {
    schema: 'docs/harness-cli.schema.json',
    output: `${OUTPUT_DIRECTORY}/harness-cli.ts`,
    rootName: 'HarnessCliEnvelope',
  },
  {
    schema: 'docs/harness-events.schema.json',
    output: `${OUTPUT_DIRECTORY}/harness-events.ts`,
    rootName: 'HarnessEventRecord',
  },
];

const DOCUMENTING_KEYWORDS = { description: 'string', maxItems: 'number', minItems: 'number' };

const isDocumentingKeyword = (key, item) =>
  Object.hasOwn(DOCUMENTING_KEYWORDS, key) && typeof item === DOCUMENTING_KEYWORDS[key];

const SHAPING_KEYWORDS = [
  'properties',
  'additionalProperties',
  'patternProperties',
  'oneOf',
  'anyOf',
  'allOf',
  '$ref',
];

const isEmptyClosedObjectSchema = value =>
  [value.type].flat().includes('object') &&
  value.additionalProperties === false &&
  Object.keys(value.properties ?? {}).length === 0 &&
  SHAPING_KEYWORDS.filter(key => key !== 'properties' && key !== 'additionalProperties').every(
    key => !(key in value),
  );

const withObjectType = value =>
  isEmptyClosedObjectSchema(value) ? { ...value, tsType: 'Record<string, never>' } : value;

const prepareSchema = value => {
  if (Array.isArray(value)) return value.map(prepareSchema);
  if (!value || typeof value !== 'object') return value;
  const prepared = Object.fromEntries(
    Object.entries(value)
      .filter(([key, item]) => !isDocumentingKeyword(key, item))
      .map(([key, item]) => [key, prepareSchema(item)]),
  );
  return withObjectType(prepared);
};

const GENERATOR_DOC_BLOCK = /^[ \t]*\/\*\*[\s\S]*?\*\/\n/gm;

const withoutDocBlocks = source => source.replace(GENERATOR_DOC_BLOCK, '');

const interfacesAsTypes = source =>
  source
    .split('\n')
    .reduce(
      ({ lines, open }, line) => {
        const declaration = /^export interface (\w+) \{$/.exec(line);
        if (declaration)
          return { lines: [...lines, `export type ${declaration[1]} = {`], open: true };
        if (open && line === '}') return { lines: [...lines, '};'], open: false };
        return { lines: [...lines, line], open };
      },
      { lines: [], open: false },
    )
    .lines.join('\n');

const generate = async ({ schema, output, rootName }) => {
  const parsed = JSON.parse(await readFile(resolve(ROOT, schema), 'utf8'));
  const source = await compile(prepareSchema({ ...parsed, title: rootName }), rootName, {
    bannerComment: '',
    cwd: resolve(ROOT, 'docs'),
    declareExternallyReferenced: true,
    format: false,
    maxItems: -1,
    strictIndexSignatures: true,
    unreachableDefinitions: true,
  });
  const filepath = resolve(ROOT, output);
  const options = await prettier.resolveConfig(filepath);
  return {
    output,
    content: await prettier.format(interfacesAsTypes(withoutDocBlocks(source)), {
      ...options,
      filepath,
    }),
  };
};

export const generateContractTypes = () => Promise.all(CONTRACT_TYPES.map(generate));

export const contractTypesPath = output => resolve(ROOT, output);
