import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/*
 * The refresh advice, wherever a store's developer reads it: the README's
 * Refresh section, the doc comment on `OAuthClient.refresh` (which reaches
 * the published types) and the slice 5 note's OAuth wire rule. The slice 5
 * review (Journal 32315, finding K3) found the comment said "further
 * recovery goes through its queue", which a reader could take as a retry
 * minutes later, past Cloud's 30-second reuse window, where Cloud revokes
 * the token family. Siren's own plugin resends a lost refresh once, at once,
 * with the same attempt id, and a shopper's request hands that one resend
 * to a background task that runs straight away.
 *
 * Each text must say the window is 30 seconds, that the one resend carries
 * the same `attemptId` and goes at once, and that nothing resends after it.
 * No sentence may put a refresh, a resend or any recovery off to a queue or
 * a later time, unless it says never to.
 */

function read(name: string): string {
  return readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
}

/** The text from `start` up to the first `end` after it. */
function between(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  expect(from, start).toBeGreaterThan(-1);
  const to = text.indexOf(end, from + start.length);
  expect(to, end).toBeGreaterThan(-1);
  return text.slice(from, to);
}

/** Sentences, with doc comment stars and line breaks folded into spaces. */
function sentences(text: string): string[] {
  return text
    .replace(/^\s*\*\s?/gm, ' ')
    .replace(/\s+/g, ' ')
    .split(/(?<=\.)\s/);
}

const SOURCES: Array<[string, () => string]> = [
  ['the README Refresh section', () => between(read('README.md'), '\n### Refresh\n', '\n### SirenConnect\n')],
  ['the OAuthClient.refresh doc comment', () => between(read('src/connect/oauth.ts'), 'Spends the refresh token', 'async refresh(')],
  ['the slice 5 note OAuth wire rule', () => between(read('docs/architecture/ncc-slice-5.md'), '- Every OAuth call is sent exactly once.', '\n- ')],
];

/**
 * A sentence that puts a refresh, a resend or a recovery off: through a
 * queue, by having a queue send it, or later, without saying never to. A
 * sentence that only names the queue, such as the reason a queue cannot
 * make the try, passes, and so does one that says a resend cannot do
 * something later.
 */
function delaysTheRefresh(sentence: string): boolean {
  if (!/\b(?:refresh|resend|retr(?:y|ies|ied)|recover)/i.test(sentence)) return false;
  const throughQueue = /\b(?:through|via|from|to|into|on|in|by)\s+(?:(?:its|the|a|their|own|site's|store's|task)\s+)*queue/i.test(sentence);
  const queueSends = /\bqueue[sd]?\s+(?:the |a |its |that )?(?:retr(?:y|ies)|resends?|recovers?|refresh(?:es)?|sends?)\b/i.test(sentence);
  const queued = (throughQueue || queueSends) && !/\b(?:never|not|no)\b[^.]{0,40}\bqueue/i.test(sentence);
  const later =
    /\b(?:later|after a (?:while|delay|pause)|next run)\b/i.test(sentence) &&
    !/\b(?:never|not|no|cannot|can't)\b[^.]{0,40}\b(?:later|after a (?:while|delay|pause)|next run)\b/i.test(sentence);
  return queued || later;
}

describe('refresh advice', () => {
  it.each(SOURCES)('%s states the 30-second window and that the one resend carries the same attemptId', (_name, text) => {
    const all = sentences(text());

    expect(all.some((s) => /\b30(?:-| )second/i.test(s) && /\b(?:revoke[sd]?|family)\b/i.test(s)), 'a sentence names the window and the revoked family').toBe(true);
    expect(all.some((s) => /`attemptId`/.test(s) && /\bsame\b/i.test(s) && /\bresend\b/i.test(s)), 'a sentence says the resend carries the same attemptId').toBe(true);
  });

  it.each(SOURCES)('%s says the resend goes at once and nothing resends after it', (_name, text) => {
    const all = sentences(text());

    expect(all.some((s) => /\bresend\b/i.test(s) && /\b(?:at once|straight away|right away|immediately)\b/i.test(s)), 'a sentence says the resend goes at once').toBe(true);
    expect(all.some((s) => /\b(?:nothing more|nothing resends|sends nothing)\b/i.test(s)), 'a sentence says nothing resends after it').toBe(true);
  });

  it.each(SOURCES)('%s puts no refresh, resend or recovery off to a queue or a later time', (_name, text) => {
    expect(sentences(text()).filter(delaysTheRefresh)).toEqual([]);
  });

  it.each([
    ['the sentence the review found', 'Any further recovery goes through its queue with that `attemptId`.', true],
    ['a queued retry', 'A failed refresh is retried from the queue later.', true],
    ['the advice to never queue it', 'A request that cannot wait hands the resend to a background task that runs straight away, never to a queue that waits minutes.', false],
    ['a queue that retries it', "The store's queue retries a lost refresh.", true],
    ['a queued refresh', 'It queues the refresh.', true],
    ['the reason a queue cannot make the try', 'That one resend is the only exception to the rule that the queue owns retries, because a queue waits minutes between tries.', false],
    ['a sentence about the event outbox', 'The outbox resends a failed event with the same eventId.', false],
    ['a resend sent later', 'The store may send that resend later, with the same `attemptId`.', true],
    ['a refresh tried again after a while', 'Try the refresh again after a while.', true],
    ['the reason to pass attemptId first', 'Give each refresh a random `attemptId` on its first try, because a resend cannot add one later.', false],
  ])('reads %s as putting a refresh off: %s', (_name, sentence, delayed) => {
    expect(delaysTheRefresh(sentence)).toBe(delayed);
  });
});
