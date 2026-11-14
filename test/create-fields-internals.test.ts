import { describe, expect, it } from 'vitest';
import { SirenError } from '../src/index';
import { pickFields } from '../src/resources/create-fields';

/*
 * Unit tests for the internal helper behind the four create allow lists
 * (slice 4 fix packet F3). The acceptance tests in create-fields.test.ts
 * hold the creates. These hold the helper on its own.
 */

const ALLOWED = ['name', 'value', 'note'] as const;
const refuse = (key: string) => `cannot send "${key}".`;

describe('pickFields', () => {
  it('answers a new object holding the allowed keys given, as given', () => {
    const params = { name: 'Mug', value: 1200 };

    const body = pickFields(params, ALLOWED, refuse);

    expect(body).not.toBe(params);
    expect(body).toStrictEqual({ name: 'Mug', value: 1200 });
  });

  it('leaves out an allowed key whose value is undefined, and keeps one whose value is null', () => {
    const body = pickFields({ name: 'Mug', value: undefined, note: null }, ALLOWED, refuse);

    expect(Object.keys(body)).toEqual(['name', 'note']);
    expect(body.note).toBeNull();
  });

  it.each([
    ['a value', 9],
    ['an undefined value', undefined],
  ])('throws SirenError with the refusal for a key not allowed, with %s', (_label, value) => {
    const error = (() => {
      try {
        return pickFields({ name: 'Mug', id: value }, ALLOWED, refuse);
      } catch (thrown) {
        return thrown;
      }
    })();

    expect(error).toBeInstanceOf(SirenError);
    expect((error as SirenError).message).toBe('cannot send "id".');
  });

  it('copies no key the object inherits, so an inherited toJSON or field never reaches the body', () => {
    const params = Object.assign(Object.create({ toJSON: () => ({ id: 9 }), note: 'inherited' }) as object, { name: 'Mug' });

    const body = pickFields(params, ALLOWED, refuse);

    expect(Object.keys(body)).toEqual(['name']);
    expect(JSON.stringify(body)).toBe('{"name":"Mug"}');
  });
});
