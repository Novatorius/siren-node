import { describe, expect, it } from 'vitest';
import { table } from '../src/cli/commands/resource-output';
import { activityRows } from '../src/cli/commands/trigger-client';
import type { ActivityResult } from '../src/cli/commands/trigger-client';
import { Style, visibleLength } from '../src/cli/style';

/*
 * The devtools commands follow the CLI builder's restyle: in a terminal no
 * line passes the terminal's width, and through a pipe every value is whole,
 * since a script or a reader of a log file wants every character. Nothing is
 * cut anywhere: a long value wraps at word boundaries (review round 1, C8).
 */

const plain = new Style({ tty: false, env: {} });
const rich = new Style({ tty: true, env: {} });
const LONG = `Acme ${'very '.repeat(20)}long name`;

describe('devtools output: the terminal width in a terminal, whole lines through a pipe', () => {
  it('fold() wraps a long line under its last column in a terminal, and keeps it whole through a pipe', () => {
    const line = `7518  complete  ${LONG}`;
    const folded = rich.fold(line).split('\n');
    expect(folded.length).toBeGreaterThan(1);
    for (const one of folded) expect(visibleLength(one)).toBeLessThanOrEqual(80);
    expect(folded.slice(1).every((one) => one.startsWith(' '.repeat(16)))).toBe(true);
    expect(folded.map((one) => one.trim()).join(' ').split(/ +/)).toEqual(line.split(/ +/));
    expect(plain.fold(line)).toBe(line);
    expect(rich.fold('short')).toBe('short');
    expect(new Style({ tty: true, env: {}, columns: 200 }).fold(line)).toBe(line);
  });

  it("a record list shows the default columns with whole values through a pipe, and fits 80 columns in a terminal", () => {
    const rows = [{ id: 1, name: LONG, description: LONG, status: 'active', units: 'USD', createdAt: '2026-11-25T10:00:00+00:00' }];
    const piped = table(plain, rows).join('\n');
    expect(piped).toContain(LONG);
    for (const key of ['id', 'name', 'status', 'createdAt']) expect(piped).toContain(key);
    expect(piped).not.toContain('description');
    for (const line of table(rich, rows)) expect(visibleLength(line), line).toBeLessThanOrEqual(80);
  });

  it("siren trigger's rows keep a long name whole, in a terminal as through a pipe", () => {
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
    expect(collaborator(rich)).toBe(`${LONG} (1)`);
  });
});
