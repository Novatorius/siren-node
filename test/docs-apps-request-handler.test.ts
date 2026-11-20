import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/*
 * The records of packet apps-answer-handler: the README leads its handler
 * section with the feature page's samples, the same text the sample tests
 * run, and the CHANGELOG and the architecture note
 * (docs/architecture/apps-request-handler.md) name each call and type.
 */

function raw(name: string): string {
  return readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
}

function read(name: string): string {
  return raw(name).replace(/\s+/g, ' ');
}

/** A sample's function, from `answers.on(` to the line before the server line. */
function fn(sample: string): string {
  const text = raw(`test/answer-samples/${sample}.js`);
  return text.slice(text.indexOf('answers.on('), text.indexOf('\nexpress().post')).trimEnd();
}

describe('apps-answer-handler: the records', () => {
  it("lead the README's handler section with the samples the tests run, as written", () => {
    const readme = raw('README.md');
    const section = readme.slice(readme.indexOf('### Answer Siren in a few lines'), readme.indexOf('### Check and answer by hand'));
    expect(section).toContain('```js\n' + raw('test/answer-samples/post-conversion-action.js').trimEnd() + '\n```');
    for (const sample of ['post-allocation-action', 'distribution-resolver', 'incentive-resolver', 'incentive-type']) {
      expect(section, sample).toContain('```js\n' + fn(sample) + '\n```');
    }
    // Every sample shares 5.1's first lines and server line.
    const head = raw('test/answer-samples/post-conversion-action.js');
    for (const sample of ['post-allocation-action', 'distribution-resolver', 'incentive-resolver', 'incentive-type']) {
      const text = raw(`test/answer-samples/${sample}.js`);
      expect(text.slice(0, text.indexOf('answers.on('))).toBe(head.slice(0, head.indexOf('answers.on(')));
      expect(text.slice(text.indexOf('\nexpress().post'))).toBe(head.slice(head.indexOf('\nexpress().post')));
    }
  });

  it('keep each sample at 16 lines or fewer, as AP-R80 asks', () => {
    for (const sample of ['post-conversion-action', 'post-allocation-action', 'distribution-resolver', 'incentive-resolver', 'incentive-type']) {
      expect(raw(`test/answer-samples/${sample}.js`).trimEnd().split('\n').length, sample).toBeLessThanOrEqual(16);
    }
  });

  it('name each call, each reply and the low-level path', () => {
    const readme = read('README.md');
    for (const words of [
      '`apps.requestHandler()`',
      '`apps.splitPool()`',
      '`onEvent(type, fn)`',
      'No function handles <kind> <key>.',
      'answers.fastify',
      'export default { fetch: answers }',
      '`runLater: after`',
      '### Check and answer by hand',
      'duplicate: true',
    ]) {
      expect(readme, words).toContain(words);
    }
    const changelog = read('CHANGELOG.md');
    for (const words of ['`apps.requestHandler({ signingSecret, toleranceSeconds, runLater, onError })`', '`apps.splitPool(pool, weights)`', '`AppDistributionQuestion`', '`AppRequestReply`']) {
      expect(changelog, words).toContain(words);
    }
    const note = read('docs/architecture/apps-request-handler.md');
    for (const words of ['`siren.apps.requestHandler(options)`', '`siren.apps.splitPool(pool, weights)`', 'POST /apps/requests/{id}/answer', 'f97b42820', '`checkSignedDelivery()`']) {
      expect(note, words).toContain(words);
    }
  });
});
