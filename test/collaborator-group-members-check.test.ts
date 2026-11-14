import { describe, expect, it } from 'vitest';
import { SirenError } from '../src/index';
import { checkedMembers } from '../src/resources/collaborator-group-members';

/*
 * Unit tests for checkedMembers, the private members check the P7
 * implementer added to CollaboratorGroupMembersResource. The acceptance
 * tests in collaborator-group-members.test.ts reach it through add and set.
 * These pin its own answers and messages.
 */

function refusal(call: () => unknown): SirenError {
  let caught: unknown;
  try {
    call();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(SirenError);
  return caught as SirenError;
}

describe('checkedMembers', () => {
  it('answers the same list it was given when every member is good', () => {
    const members = [{ collaboratorId: 4 }, { collaboratorId: 9, metadata: { level: 'L1' } }];

    expect(checkedMembers(members, 'add', false)).toBe(members);
  });

  it('accepts an empty list only when allowEmpty is true', () => {
    expect(checkedMembers([], 'set', true)).toEqual([]);
    expect(refusal(() => checkedMembers([], 'add', false)).message).toBe('add needs at least one member.');
  });

  it.each([
    ['an object', {}],
    ['null', null],
    ['a string', '4'],
  ])('refuses members given as %s, naming the method', (_label, members) => {
    expect(refusal(() => checkedMembers(members, 'set', true)).message).toBe('set needs members as a list.');
  });

  it.each([
    ['a number', 4],
    ['null', null],
    ['a list', [4]],
  ])('refuses a member that is %s', (_label, member) => {
    expect(refusal(() => checkedMembers([{ collaboratorId: 4 }, member], 'add', false)).message).toBe(
      'add needs each member as an object with a collaboratorId.',
    );
  });

  it.each([
    ['0', { collaboratorId: 0 }, '0'],
    ['a fraction', { collaboratorId: 1.5 }, '1.5'],
    ['a string', { collaboratorId: '4' }, '"4"'],
    ['a missing id', {}, 'undefined'],
  ])('refuses a collaboratorId of %s through recordId, naming the field', (_label, member, shown) => {
    expect(refusal(() => checkedMembers([{ collaboratorId: 4 }, member], 'set', true)).message).toBe(
      `set needs a positive whole number collaboratorId, and got ${shown}.`,
    );
  });
});
