import {
  constructFromEvents,
  EVENT_DOCUMENT,
  EVENT_MAPPING,
  EVENT_POP,
  EVENT_SEQUENCE,
  JSON_SCHEMA,
  parseEvents,
  type Event,
} from 'js-yaml';

export const yamlLimits = { depth: 12, nodes: 512 } as const;

export type YamlLimitKind = 'depth' | 'nodes' | 'documents';

const parserDepthIncludingDocument = yamlLimits.depth + 1;

export class YamlLimitError extends Error {
  readonly kind: YamlLimitKind;

  constructor(kind: YamlLimitKind) {
    super(limitMessages[kind]);
    this.name = 'YamlLimitError';
    this.kind = kind;
  }
}

const limitMessages: Record<YamlLimitKind, string> = {
  depth: `YAML nesting exceeds the supported depth of ${yamlLimits.depth}.`,
  nodes: `YAML exceeds the supported ${yamlLimits.nodes} nodes.`,
  documents: 'YAML must contain a single document.',
};

function parseBoundedEvents(source: string): Event[] {
  try {
    return parseEvents(source, { maxDepth: parserDepthIncludingDocument });
  } catch (error) {
    if (/nesting exceeded maxDepth/.test((error as Error).message))
      throw new YamlLimitError('depth');
    throw error;
  }
}

function assertWithinLimits(events: Event[]): void {
  let depth = 0;
  let nodes = 0;
  let documents = 0;
  for (const event of events) {
    if (event.type === EVENT_DOCUMENT) {
      if (++documents > 1) throw new YamlLimitError('documents');
      continue;
    }
    if (event.type === EVENT_POP) {
      if (depth > 0) depth--;
      continue;
    }
    if (++nodes > yamlLimits.nodes) throw new YamlLimitError('nodes');
    if (event.type === EVENT_SEQUENCE || event.type === EVENT_MAPPING) {
      if (++depth > yamlLimits.depth) throw new YamlLimitError('depth');
    }
  }
}

export function loadBoundedYaml(source: string): unknown {
  const events = parseBoundedEvents(source);
  assertWithinLimits(events);
  const [document] = constructFromEvents(events, {
    source,
    schema: JSON_SCHEMA,
    maxAliases: 0,
  });
  return document;
}
