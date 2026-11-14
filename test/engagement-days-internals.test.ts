import { describe, expect, it } from 'vitest';
import { isDay } from '../src/resources/engagements';

/*
 * Unit tests for isDay, the private day check the F4 implementer added to
 * engagements.ts. The acceptance tests in engagement-days.test.ts reach it
 * through engagements.list. These pin its own answers, including the years
 * 0 to 99 that Date.UTC would read as 1900 to 1999.
 */

describe('isDay', () => {
  it.each([
    ['an ordinary day', '2026-11-12'],
    ['February 29 in a leap year', '2024-02-29'],
    ['February 29 in a year divisible by 400', '2000-02-29'],
    ['the last day of a 31-day month', '2026-07-31'],
    ['a day in year 99', '0099-12-31'],
    ['February 29 in year 96', '0096-02-29'],
    ['a day in year 1', '0001-01-01'],
  ])('accepts %s', (_label, value) => {
    expect(isDay(value)).toBe(true);
  });

  it.each([
    ['February 29 in a year divisible by 100 and not 400', '2100-02-29'],
    ['February 30', '2024-02-30'],
    ['June 31', '2026-06-31'],
    ['month 13', '2026-13-01'],
    ['day 32', '2026-01-32'],
    ['a five-digit year', '12026-11-12'],
    ['a day with text before it', 'x2026-11-12'],
    ['a day with text after it', '2026-11-12x'],
  ])('refuses %s', (_label, value) => {
    expect(isDay(value)).toBe(false);
  });

  it.each([
    ['a number', 20261112],
    ['a Date', new Date(Date.UTC(2026, 10, 12))],
    ['undefined', undefined],
    ['an object that prints as a day', { toString: () => '2026-11-12' }],
  ])('refuses %s, which is not a string', (_label, value) => {
    expect(isDay(value)).toBe(false);
  });
});
