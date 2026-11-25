import { describe, expect, it } from 'vitest';
import { table } from '../src/cli/commands/resource-output';
import { activityRows } from '../src/cli/commands/trigger-client';
import type { ActivityResult } from '../src/cli/commands/trigger-client';
import { Style, visibleLength } from '../src/cli/style';

/*
 * The devtools commands follow the CLI builder's restyle: in a terminal no
 * line passes 80 columns, and through a pipe every value is whole, since a
 * script or a reader of a log file wants every character. The style module
 * makes the call with `rich`, and `fit()` is the one place that cuts.
 */

const plain = new Style({ tty: false, env: {} });
const rich = new Style({ tty: true, env: {} });
const LONG = `Acme ${'very '.repeat(20)}long name`;

describe('devtools output: 80 columns in a terminal, whole lines through a pipe', () => {
  it('fit() cuts with an ellipsis only in a terminal', () => {
    expect(rich.fit(LONG, 20)).toHaveLength(20);
    expect(rich.fit(LONG, 20).endsWith('…')).toBe(true);
    expect(plain.fit(LONG, 20)).toBe(LONG);
    expect(rich.fit('short', 20)).toBe('short');
  });

  it("a record list shows every column and whole values through a pipe, and fits 80 columns in a terminal", () => {
    const rows = [{ id: 1, name: LONG, description: LONG, status: 'active', units: 'USD', createdAt: '2026-11-25T10:00:00+00:00' }];
    const piped = table(plain, rows).join('\n');
    expect(piped).toContain(LONG);
    for (const key of ['description', 'status', 'units', 'createdAt']) expect(piped).toContain(key);
    for (const line of table(rich, rows)) expect(visibleLength(line), line).toBeLessThanOrEqual(80);
  });

  it("siren trigger's rows keep a long name whole through a pipe and cut it in a terminal", () => {
    const result: ActivityResult = {
      event: 'sale',
      simulated: false,
      status: 'recorded',
      message: null,
      opportunityId: null,
      transactionId: 77,
      total: null,
      collaborator: { id: 1, name: LONG },
      conversions: [],
      obligations: [],
      waits: [],
    };
    const collaborator = (style: Style) => activityRows(style, result).find(([label]) => label === 'Collaborator')![1];
    expect(collaborator(plain)).toBe(`${LONG} (1)`);
    expect(collaborator(rich).endsWith('…')).toBe(true);
  });
});
