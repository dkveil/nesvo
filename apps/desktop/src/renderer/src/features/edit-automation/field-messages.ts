import type { FieldMessage } from '@/shared/ui/field';

export const errorMessages = (message: string | undefined): FieldMessage[] =>
  message ? [{ severity: 'error', message }] : [];

export const messagesId = (id: string, message: string | undefined) =>
  message ? `${id}-messages` : undefined;
