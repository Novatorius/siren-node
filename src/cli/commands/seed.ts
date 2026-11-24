import { readObject, writeRecord } from '../../resources/record-requests';
import { contextOf } from '../context';
import type { CommandInput } from '../context';
import { onSandbox, transportOf } from '../sandboxes';
import { styleFor } from '../style';
import { CliRefusal, CliUsageError } from '../targets';

/*
 * `siren seed`: fills a sandbox organization with sample sales spread back
 * over past months, through `POST /sandbox/seed`, and waits on its job.
 * Contract: contract/devtools-sandbox.md in the run folder.
 */

/** Each count's least, most and default, as Siren's SeedSandbox::LIMITS holds them. */
export const SEED_LIMITS = {
  sales: [1, 200, 50],
  collaborators: [1, 25, 10],
  months: [1, 6, 3],
} as const;

/** How often and how long `seed` waits on its job. */
const POLL_MS = 1000;
const POLLS = 600;

/** What `GET /jobs/{jobId}` answers for a seed job. */
interface SeedJob {
  jobId: string;
  status: string;
  totalItems?: number;
  processedItems?: number;
  errorMessage?: string | null;
  progress?: {
    phase?: string;
    months?: number;
    collaboratorsMade?: number;
    collaboratorsUsed?: number;
    salesSent?: number;
    salesRefused?: number;
    conversions?: number;
    firstAt?: string | null;
    lastAt?: string | null;
    lastRefusal?: string | null;
  };
}

/** A count option, checked against its limits before anything is sent. */
function countOf(input: CommandInput, field: keyof typeof SEED_LIMITS): number {
  const [least, most, fallback] = SEED_LIMITS[field];
  const raw = input.values[field];
  if (raw === undefined) return fallback;
  const value = typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw) : NaN;
  if (!Number.isInteger(value) || value < least || value > most) throw new CliUsageError(`--${field} takes a whole number from ${least} to ${most}.`);
  return value;
}

/** `siren seed [--sales N --collaborators N --months N --seed N]`. */
export async function seed(input: CommandInput): Promise<number> {
  const json = input.values.json === true;
  const body: Record<string, number> = {
    sales: countOf(input, 'sales'),
    collaborators: countOf(input, 'collaborators'),
    months: countOf(input, 'months'),
  };
  if (input.values.seed !== undefined) {
    const raw = String(input.values.seed).trim();
    if (!/^\d{1,15}$/.test(raw)) throw new CliUsageError('--seed takes a whole number, such as 7, so the same seed makes the same sales.');
    body.seed = Number(raw);
  }
  const run = contextOf(input);
  const session = await onSandbox(run, 'seed');
  const slug = session.orgSlug ?? String(session.orgId);
  const http = transportOf(run);

  const queued = await writeRecord<{ jobId: string; status: string; sales: number; collaborators: number; months: number }>(http, 'POST', '/sandbox/seed', body);
  const style = styleFor(input.io, 'stdout', { json });
  if (input.values['no-wait'] === true) {
    if (json) input.io.stdout(`${JSON.stringify(queued, null, 2)}\n`);
    else
      input.io.stdout(
        style.report({
          headline: `Queued ${queued.sales} sample sales for ${style.bold(slug)}`,
          rows: [['Job', queued.jobId], ['Months', String(queued.months)]],
          tips: [`Siren answers GET /jobs/${queued.jobId} with its progress.`],
        }),
      );
    return 0;
  }

  const progress = json ? null : style.spinner(`Seeding ${slug}: 0 of ${queued.sales} sales`, (chunk) => input.io.stdout(chunk));
  const read = () => readObject<SeedJob>(http, `/jobs/${encodeURIComponent(queued.jobId)}`);
  const ended = (status: string) => status === 'complete' || status === 'failed';
  // Read once at once: a Siren that runs tasks in the request answers a seed that has already ended.
  let job = await read();
  for (let poll = 0; poll < POLLS && !ended(job.status); poll += 1) {
    const counts = job.progress ?? {};
    progress?.update(
      counts.phase === 'collaborators'
        ? `Seeding ${slug}: finding collaborators`
        : `Seeding ${slug}: ${(counts.salesSent ?? 0) + (counts.salesRefused ?? 0)} of ${queued.sales} sales`,
    );
    await input.io.sleep(POLL_MS);
    job = await read();
  }

  const counts = job.progress ?? {};
  if (json) {
    input.io.stdout(`${JSON.stringify({ jobId: job.jobId, status: job.status, progress: counts, errorMessage: job.errorMessage ?? null }, null, 2)}\n`);
    return job.status === 'complete' ? 0 : 1;
  }
  if (job.status !== 'complete') {
    progress?.stop(false, `Seeding ${slug} ${job.status === 'failed' ? 'failed' : 'did not finish in ten minutes'}.`);
    throw new CliRefusal(`The seed job for ${slug} ${job.status === 'failed' ? 'failed' : `is still ${job.status}`}.`, {
      why: job.errorMessage ?? `${counts.salesSent ?? 0} sales were sent before it stopped.`,
      note: `Job ${job.jobId}.`,
    });
  }

  const months = counts.months ?? queued.months;
  progress?.stop(true, `Seeded ${style.bold(slug)} with ${months} ${months === 1 ? 'month' : 'months'} of sales`);
  const made = counts.collaboratorsMade ?? 0;
  const used = counts.collaboratorsUsed ?? 0;
  const report = style.report({
    headline: '',
    rows: [
      ['Sales', `${counts.salesSent ?? 0} sent, ${counts.salesRefused ?? 0} refused`],
      ['Conversions', String(counts.conversions ?? 0)],
      ['Collaborators', `${used} (${made} made, ${used - made} already here)`],
      ...(counts.firstAt && counts.lastAt ? [['From', `${counts.firstAt.slice(0, 10)} to ${counts.lastAt.slice(0, 10)}`] as const] : []),
      ...(counts.lastRefusal ? [['Last refusal', counts.lastRefusal] as const] : []),
    ],
    next: [{ text: style.command(input.command('sandbox inbox')) }, { text: style.command(input.command('sandbox reset')), aside: 'clears it again' }],
    tips: ['Seeded sales are test sales. Siren never pays them or reports them.'],
  });
  // The spinner printed the headline, so the report starts at its block.
  input.io.stdout(report.split('\n').slice(1).join('\n'));
  return 0;
}
