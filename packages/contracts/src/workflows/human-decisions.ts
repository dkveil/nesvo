import { z } from 'zod';

const key = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z][a-z0-9-]*$/);
const label = z.string().trim().min(1).max(160);
const unique = (values: { id: string }[]) =>
  new Set(values.map(value => value.id)).size === values.length;
const fieldBase = { id: key, label, required: z.boolean().default(true) };
const fieldSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...fieldBase,
    type: z.literal('text'),
    max_length: z.number().int().min(1).max(2000).default(500),
  }),
  z.strictObject({ ...fieldBase, type: z.literal('number') }),
  z.strictObject({ ...fieldBase, type: z.literal('boolean') }),
]);
export const humanDecisionFormSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('binary') }),
  z.strictObject({
    kind: z.literal('choice'),
    options: z
      .array(z.strictObject({ id: key, label }))
      .min(2)
      .max(12)
      .refine(unique),
  }),
  z.strictObject({ kind: z.literal('files') }),
  z.strictObject({
    kind: z.literal('fields'),
    fields: z.array(fieldSchema).min(1).max(10).refine(unique),
  }),
]);
const filePath = z.string().min(1).max(4096);
const values = z.union([z.string().trim().max(2000), z.number(), z.boolean()]);
export const humanDecisionAnswerSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('choice'), option: key }),
  z.strictObject({
    kind: z.literal('files'),
    paths: z
      .array(filePath)
      .min(1)
      .max(500)
      .refine(paths => new Set(paths).size === paths.length),
  }),
  z.strictObject({
    kind: z.literal('fields'),
    values: z
      .record(key, values)
      .refine(fields => Object.keys(fields).length <= 10),
  }),
]);

export const pinnedHumanDecisionSchema = z.strictObject({
  form: humanDecisionFormSchema,
  files: z.array(filePath).max(500).optional(),
});

export type HumanDecisionForm = z.infer<typeof humanDecisionFormSchema>;
export type HumanDecisionAnswer = z.infer<typeof humanDecisionAnswerSchema>;
export type PinnedHumanDecision = z.infer<typeof pinnedHumanDecisionSchema>;

export function validateHumanAnswer(
  decision: PinnedHumanDecision | undefined,
  answer: HumanDecisionAnswer | undefined,
): boolean {
  const form = decision?.form;
  if (!form || form.kind === 'binary') return answer === undefined;
  if (!answer || answer.kind !== form.kind) return false;
  if (form.kind === 'choice' && answer.kind === 'choice')
    return form.options.some(option => option.id === answer.option);
  if (form.kind === 'files' && answer.kind === 'files') {
    const allowed = new Set(decision.files ?? []);
    return answer.paths.every(path => allowed.has(path));
  }
  if (form.kind !== 'fields' || answer.kind !== 'fields') return false;
  const shape = Object.fromEntries(
    form.fields.map(field => {
      const base =
        field.type === 'text'
          ? z.string().trim().min(1).max(field.max_length)
          : field.type === 'number'
            ? z.number()
            : z.boolean();
      return [field.id, field.required ? base : base.optional()];
    }),
  );
  return z.strictObject(shape).safeParse(answer.values).success;
}
