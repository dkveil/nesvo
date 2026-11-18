import handler from './.open-next/worker.js';
import { runScheduledCleanup } from './src/server/scheduled-cleanup';

export default {
  fetch: handler.fetch,
  scheduled: async (_controller, env, context) => {
    context.waitUntil(runScheduledCleanup(env.DB, Date.now()));
  },
} satisfies ExportedHandler<CloudflareEnv>;
