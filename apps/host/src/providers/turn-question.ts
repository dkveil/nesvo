import { turnQuestionSchema, type TurnQuestion } from '@nesvo/contracts';

export function providerQuestion(input: unknown): TurnQuestion | undefined {
  if (!Array.isArray(input) || input.length > 4) return;
  const parsed = turnQuestionSchema.safeParse(
    input.map(question => ({
      text: question?.question,
      options:
        Array.isArray(question?.options) && question.options.length <= 6
          ? question.options.map(
              (option: { label?: unknown } | null) => option?.label,
            )
          : question?.options === undefined
            ? []
            : undefined,
      ...(question?.multiSelect === true ? { multiple: true } : {}),
    })),
  );
  if (parsed.success)
    return parsed.data.map(question => ({
      ...question,
      options: [...new Set(question.options)],
    }));
}
