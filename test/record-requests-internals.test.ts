import { describe, expect, it } from 'vitest';
import { isJsonObject, isRecordId, listRecords } from '../src/resources/record-requests';
import { reply } from './http-fakes';
import { transportOver } from './record-fakes';

/*
 * Unit tests for the two predicates the P1 request helpers share. The
 * acceptance tests reach them only through recordId, recordListQuery and the
 * answer checks, so these pin each edge the predicates decide on their own.
 * The last test pins that a list's count stays off its enumerable keys, which
 * the acceptance tests read only through a spread. Its request goes to a
 * FakeHttpClient at the HttpClient seam, so nothing leaves the machine.
 */

describe('isRecordId', () => {
  it.each([1, 2, 500, Number.MAX_SAFE_INTEGER])('accepts %j', (value) => {
    expect(isRecordId(value)).toBe(true);
  });

  it.each([
    ['zero', 0],
    ['a negative whole number', -3],
    ['a fraction', 2.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['one past the largest safe integer', Number.MAX_SAFE_INTEGER + 1],
    ['a numeric string', '4'],
    ['a boxed number', Object(4)],
    ['a bigint', 4n],
    ['null', null],
    ['undefined', undefined],
    ['true', true],
    ['a list holding one id', [4]],
  ])('refuses %s', (_label, value) => {
    expect(isRecordId(value)).toBe(false);
  });
});

describe('isJsonObject', () => {
  it.each([
    ['an empty object', {}],
    ['a record', { id: 4, status: 'active' }],
    ['an object with no prototype', Object.create(null) as object],
  ])('accepts %s', (_label, value) => {
    expect(isJsonObject(value)).toBe(true);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty array', []],
    ['an array of objects', [{ id: 1 }]],
    ['a string', 'ok'],
    ['a number', 5],
    ['a boolean', false],
  ])('refuses %s', (_label, value) => {
    expect(isJsonObject(value)).toBe(false);
  });
});

describe('listRecords count', () => {
  it('keeps estimatedCount out of JSON and spreads', async () => {
    const { transport } = transportOver([reply(200, { items: [{ id: 4 }], total: 42 })]);

    const list = await listRecords(transport, '/programs', {}, []);

    expect(list.estimatedCount).toBe(42);
    expect(Object.keys(list)).toEqual(['0']);
    expect(JSON.stringify(list)).toBe('[{"id":4}]');
  });
});
