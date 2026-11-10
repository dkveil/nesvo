import { z } from 'zod';

export const colorSchemes = ['system', 'light', 'dark'] as const;
export const colorSchemeSchema = z.enum(colorSchemes);
export type ColorScheme = z.infer<typeof colorSchemeSchema>;
