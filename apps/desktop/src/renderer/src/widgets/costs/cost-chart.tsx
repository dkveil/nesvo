import type { CostPeriod, CostReport } from '@nesvo/contracts';
import { cn } from '@/shared/lib/cn';
import { formatCost } from '@/shared/lib/format-cost';
import { Hint } from '@/shared/ui/tooltip';
import { formatSpend } from './format-spend';
import { costCoverage } from './labels';

type Bucket = CostReport['buckets'][number];
type Slot = { date: string; bucket?: Bucket };

const DAY_MS = 86_400_000;
const WEEK_DAYS = 7;
const MONTH_TICK_DAYS = 7;

const dayLabel = new Intl.DateTimeFormat('en', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});
const weekdayLabel = new Intl.DateTimeFormat('en', {
  weekday: 'short',
  timeZone: 'UTC',
});

function periodDays(range: CostPeriod, first: Date): number {
  if (range === 'week') return WEEK_DAYS;
  if (range === 'month')
    return new Date(
      Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
    ).getUTCDate();
  return 1;
}

function periodSlots(range: CostPeriod, buckets: Bucket[]): Slot[] {
  const first = new Date(buckets[0]!.date);
  const length = Math.max(buckets.length, periodDays(range, first));
  return Array.from({ length }, (_, index) => ({
    date: new Date(first.getTime() + index * DAY_MS).toISOString().slice(0, 10),
    bucket: buckets[index],
  }));
}

function axisLabel(range: CostPeriod, date: Date, index: number) {
  if (range === 'week') return weekdayLabel.format(date);
  if (range === 'month' && index % MONTH_TICK_DAYS !== 0) return '';
  return dayLabel.format(date);
}

function describe(date: string, bucket: Bucket) {
  const day = dayLabel.format(new Date(date));
  return bucket.turnCount
    ? `${day} · ${formatCost(bucket.costUsd)} · ${costCoverage(bucket)}`
    : `${day} · No usage`;
}

function BarMark({ bucket, max }: { bucket?: Bucket; max: number }) {
  const mark = 'w-full max-w-6';
  if (!bucket)
    return (
      <span className={cn(mark, 'h-0.5 rounded-full bg-track opacity-50')} />
    );
  const cost = bucket.costUsd;
  if (cost === null && bucket.turnCount)
    return (
      <span
        className={cn(
          mark,
          'border-t-2 border-dashed border-muted-foreground/70',
        )}
      />
    );
  if (!cost || max === 0)
    return <span className={cn(mark, 'h-0.5 rounded-full bg-track')} />;
  return (
    <span
      className={cn(
        mark,
        'rounded-t-sm bg-muted-foreground transition-colors duration-fast group-hover/bar:bg-foreground',
      )}
      style={{ height: `max(2px, ${(cost / max) * 100}%)` }}
    />
  );
}

export function CostChart({
  range,
  buckets,
}: {
  range: CostPeriod;
  buckets: CostReport['buckets'];
}) {
  const max = Math.max(0, ...buckets.map(bucket => bucket.costUsd ?? 0));
  const slots = periodSlots(range, buckets);
  const first = dayLabel.format(new Date(slots[0]!.date));
  const last = dayLabel.format(new Date(slots.at(-1)!.date));
  return (
    <figure aria-label="Transcript cost by date" className="space-y-1.5">
      <div
        aria-hidden="true"
        className="flex justify-between text-micro text-muted-foreground"
      >
        <span>Daily cost</span>
        {max > 0 && (
          <span className="tabular-nums">Peak {formatSpend(max)}</span>
        )}
      </div>
      <div className="flex h-24 items-end gap-1">
        {slots.map(({ date, bucket }) =>
          bucket ? (
            <Hint key={date} label={describe(date, bucket)}>
              <div
                tabIndex={0}
                aria-label={describe(date, bucket)}
                className="group/bar focus-ring flex h-full min-w-0 flex-1 items-end justify-center rounded-sm transition-colors duration-fast hover:bg-accent"
              >
                <BarMark bucket={bucket} max={max} />
              </div>
            </Hint>
          ) : (
            <div
              key={date}
              aria-hidden="true"
              className="flex h-full min-w-0 flex-1 items-end justify-center"
            >
              <BarMark max={max} />
            </div>
          ),
        )}
      </div>
      <div aria-hidden="true" className="flex gap-1">
        {slots.map(({ date }, index) => (
          <span
            key={date}
            className={cn(
              'min-w-0 flex-1 overflow-visible text-micro whitespace-nowrap text-muted-foreground',
              range === 'month' ? 'text-left' : 'text-center',
            )}
          >
            {axisLabel(range, new Date(date), index)}
          </span>
        ))}
      </div>
      <figcaption className="sr-only">
        {first === last ? first : `${first} to ${last}`}
      </figcaption>
    </figure>
  );
}
