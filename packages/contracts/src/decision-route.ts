import { z } from 'zod';

export const decisionRouteSchema = z.enum(['inbox', 'parent', 'both']);
export type DecisionRoute = z.infer<typeof decisionRouteSchema>;

export const routesToParent = (route: DecisionRoute) =>
  route === 'parent' || route === 'both';

export const routesToInbox = (route: DecisionRoute) =>
  route === 'inbox' || route === 'both';
