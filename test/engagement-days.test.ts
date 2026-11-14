import { describe, expect, it } from 'vitest';
import { EngagementsResource, SirenError } from '../src/index';
import { reply } from './http-fakes';
import { page, pathOf, queryOf, transportOver } from './record-fakes';
import { EngagementAnswers } from './record-fakes-2';

/*
 * Slice 4 contract fix, packet F4: the day filters on `engagements.list`.
 * Siren's DayRangeFilterMiddleware (lib/Core/Service/Middlewares, lines 83
 * to 101 at b6f7140) reads `from` and `to` only as a string matching
 * `^\d{4}-\d{2}-\d{2}$` that names a real calendar day, and leaves any other
 * value out, so a bounded report came back unbounded. The SDK refuses such a
 * value before sending, naming the key and the value.
 *
 * Integration shape (KB 568): the real resource over the real HttpTransport,
 * with a FakeHttpClient at the HttpClient seam, aimed at example.invalid.
 */

function over() {
  const built = transportOver([reply(200, page([EngagementAnswers.listed]))]);
  return { ...built, engagements: new EngagementsResource(built.transport) };
}

/** The value as the refusal shows it: a string in JSON quotes, anything else through String(). */
function shown(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

const NOT_DAYS: Array<[string, unknown]> = [
  ['a February 29 in a year with none', '2026-02-29'],
  ['month 13', '2026-13-01'],
  ['month 0', '2026-00-10'],
  ['day 0', '2026-11-00'],
  ['April 31', '2026-04-31'],
  ['a month with one digit', '2026-1-05'],
  ['a two-digit year', '26-11-12'],
  ['a timestamp', '2026-11-12T00:00:00Z'],
  ['a day and a time', '2026-11-12 08:00:00'],
  ['a trailing space', '2026-11-12 '],
  ['a leading space', ' 2026-11-12'],
  ['a trailing line break', '2026-11-12\n'],
  ['slashes', '2026/11/12'],
  ['a day first', '12-11-2026'],
  ['an empty string', ''],
  ['a number', 20261112],
  ['a Date', new Date(Date.UTC(2026, 10, 12))],
  ['null', null],
  ['a list of one day', ['2026-11-12']],
];

const ROWS = (['from', 'to'] as const).flatMap((key) => NOT_DAYS.map(([label, value]) => [key, label, value] as const));

describe('4 fix F4: engagements.list day filters', () => {
  it.each(ROWS)('refuses a %s that is %s before sending, naming it', async (key, _label, value) => {
    const { http, engagements } = over();

    const error = await engagements.list({ collaboratorId: 42, [key]: value } as never).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SirenError);
    expect((error as SirenError).message).toBe(`engagements.list() needs ${key} as a day, YYYY-MM-DD, and got ${shown(value)}.`);
    expect(http.requests).toHaveLength(0);
  });

  it('refuses a bad to even when from is a day', async () => {
    const { http, engagements } = over();

    await expect(engagements.list({ from: '2026-11-01', to: '2026-11-31' })).rejects.toThrow(
      'engagements.list() needs to as a day, YYYY-MM-DD, and got "2026-11-31".',
    );
    expect(http.requests).toHaveLength(0);
  });

  it.each([
    ['an ordinary day', '2026-11-12'],
    ['February 29 in a leap year', '2024-02-29'],
    ['the first day of a year', '2027-01-01'],
    ['the last day of a year', '2026-12-31'],
    ['February 29 in a year divisible by 400', '2000-02-29'],
  ])('sends %s as it is', async (_label, day) => {
    const { http, engagements } = over();

    await engagements.list({ from: day, to: day });

    expect(pathOf(http.requests[0])).toBe('/engagements');
    expect(queryOf(http.requests[0])).toEqual({ from: day, to: day });
  });

  it('sends no bound when from and to are left out or undefined', async () => {
    const { http, engagements } = over();

    await engagements.list({ collaboratorId: 42, from: undefined, to: undefined });

    expect(queryOf(http.requests[0])).toEqual({ collaboratorId: '42' });
  });
});
