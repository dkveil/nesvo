export type FieldNote = { severity: 'error' | 'warning'; message: string };

export type IssueLike = {
  severity: 'error' | 'warning';
  message: string;
  field?: string;
};

export type NotesByField = Record<string, FieldNote[]>;

export type SchemaCheck =
  | { success: true }
  | {
      success: false;
      error: { issues: { path: PropertyKey[]; message: string }[] };
    };

const firstSegment = (path: PropertyKey[]) => String(path[0] ?? 'form');

export const schemaNotes = (
  result: SchemaCheck,
  fieldOf: (path: PropertyKey[]) => string = firstSegment,
): NotesByField => {
  if (result.success) return {};
  const notes: NotesByField = {};
  for (const issue of result.error.issues) {
    const field = fieldOf(issue.path);
    const list = (notes[field] ??= []);
    if (!list.some(note => note.message === issue.message))
      list.push({ severity: 'error', message: issue.message });
  }
  return notes;
};

export const mergeNotes = (
  client: NotesByField,
  issues: readonly IssueLike[],
  fields: readonly string[],
): NotesByField => {
  const merged: NotesByField = {};
  for (const [field, list] of Object.entries(client)) merged[field] = [...list];
  for (const issue of issues) {
    const field =
      issue.field && fields.includes(issue.field) ? issue.field : 'form';
    const list = (merged[field] ??= []);
    if (!list.some(note => note.message === issue.message))
      list.push({ severity: issue.severity, message: issue.message });
  }
  return merged;
};

export const notesId = (id: string) => `${id}-notes`;

export const describedBy = (id: string, notes: FieldNote[]) =>
  notes.length ? notesId(id) : undefined;

export const hasError = (notes: FieldNote[]) =>
  notes.some(note => note.severity === 'error');

export const inspectorInput = 'h-7 px-2 text-xs md:text-xs';
export const inspectorTextarea =
  'max-h-72 min-h-24 px-2 py-1.5 font-mono text-xs leading-5 md:text-xs';
