import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { z } from 'zod';

const priceUrl =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const refreshInterval = 86_400_000;
export const codexAutoReview = 'codex-auto-review';
const rate = z.number().nonnegative();
const rateSchema = z.object({
  input_cost_per_token: rate,
  output_cost_per_token: rate,
  cache_read_input_token_cost: rate.optional(),
  cache_creation_input_token_cost: rate.optional(),
  input_cost_per_token_priority: rate.optional(),
  output_cost_per_token_priority: rate.optional(),
  cache_read_input_token_cost_priority: rate.optional(),
  cache_creation_input_token_cost_priority: rate.optional(),
  fast_mode_multiplier: z.number().positive().optional(),
});

const cacheSchema = z.object({
  attemptedAt: z.number(),
  prices: z.record(z.string(), z.unknown()),
});

type Prices = z.infer<typeof cacheSchema>['prices'];

export class CostPrices {
  private cache: z.infer<typeof cacheSchema> | undefined;

  constructor(private readonly path: string) {}

  async refresh(signal: AbortSignal) {
    this.cache ??= await readFile(this.path, 'utf8')
      .then(text => cacheSchema.parse(JSON.parse(text)))
      .catch(() => ({ attemptedAt: 0, prices: {} }));
    const now = Date.now();
    if (
      signal.aborted ||
      process.env.NESVO_SMOKE_TEST === '1' ||
      process.env.NESVO_TEST_MODE === '1' ||
      now - this.cache.attemptedAt < refreshInterval
    )
      return;

    this.cache.attemptedAt = now;
    await this.save();
    try {
      const response = await fetch(priceUrl, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
        redirect: 'error',
      });
      if (!response.ok) return;
      const prices = z
        .record(z.string(), z.unknown())
        .parse(await response.json());
      if (!Object.values(prices).some(row => rateSchema.safeParse(row).success))
        return;
      this.cache.prices = prices;
      await this.save();
    } catch {
      return;
    }
  }

  get table(): Prices {
    return this.cache?.prices ?? {};
  }

  private async save() {
    const pending = this.path + '.' + randomUUID() + '.tmp';
    await writeFile(pending, JSON.stringify(this.cache), {
      flag: 'wx',
      mode: 0o600,
    })
      .then(() =>
        rename(pending, this.path).catch(() => rm(pending, { force: true })),
      )
      .catch(() => undefined);
  }
}

export function resolveRates(prices: Prices, model: string, fast: boolean) {
  const name = model
    .toLowerCase()
    .replace(/^(?:(?:openai|anthropic|chatgpt|codex)[/.])+/, '');
  if (name === codexAutoReview) return;
  const undated = name.replace(/-(?:\d{4}-\d{2}-\d{2}|\d{8})(?=-|$)/, '');
  const base = undated.replace(
    /-(?:latest|preview|fast|thinking|low|medium|high|xhigh|minimal)$/,
    '',
  );
  const claudeAlias = base.replace(
    /^(claude)-(\d(?:-\d)?)-(opus|sonnet|haiku)$/,
    '$1-$3-$2',
  );
  for (const candidate of new Set([model, name, undated, base, claudeAlias])) {
    const price = rateSchema.safeParse(
      Object.hasOwn(prices, candidate) ? prices[candidate] : undefined,
    );
    if (!price.success) continue;
    const row = price.data;
    const multiplier = fast ? (row.fast_mode_multiplier ?? 1) : 1;
    const tier = (regular: number | undefined, priority: number | undefined) =>
      fast && priority !== undefined
        ? priority
        : regular === undefined
          ? undefined
          : regular * multiplier;
    return {
      input: tier(row.input_cost_per_token, row.input_cost_per_token_priority)!,
      output: tier(
        row.output_cost_per_token,
        row.output_cost_per_token_priority,
      )!,
      read: tier(
        row.cache_read_input_token_cost,
        row.cache_read_input_token_cost_priority,
      ),
      write: tier(
        row.cache_creation_input_token_cost,
        row.cache_creation_input_token_cost_priority,
      ),
    };
  }
}
