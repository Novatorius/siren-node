import { describe, expect, it } from 'vitest';
import { ConversionsResource, UnexpectedResponseError } from '../src/index';
import { writeRecordOrNothing } from '../src/resources/record-writes';
import { reply } from './http-fakes';
import { transportOver } from './record-fakes';

/*
 * Contract test added in the slice 4 review: a 2xx whose body is the JSON
 * literal `null`. The doc comment on writeRecordOrNothing lists `null` among
 * the bodies it refuses, and test/conversion-writes.test.ts covers the empty
 * body, an array, a string and text, but not `null`. Without this file the
 * helper could answer `null` for that body, which reads as "Siren took the
 * write and sent nothing back", and no test would notice.
 */

/** A 200 whose body is the four characters `null`, sent as JSON. */
const jsonNull = reply(200, null);

describe('writeRecordOrNothing: a JSON null body', () => {
  it('sends a body of exactly null, not an empty one', () => {
    expect(jsonNull.body).toBe('null');
  });

  it('throws UnexpectedResponseError with the 2xx status', async () => {
    const { http, transport } = transportOver([jsonNull]);

    const error = await writeRecordOrNothing(transport, 'PUT', '/conversions/61', {}).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect((error as UnexpectedResponseError).statusCode).toBe(200);
    expect(http.requests).toHaveLength(1);
  });

  it('makes conversions.update throw rather than answer null', async () => {
    const { http, transport } = transportOver([jsonNull]);

    await expect(new ConversionsResource(transport).update(61, { type: 'lead' })).rejects.toBeInstanceOf(
      UnexpectedResponseError,
    );
    expect(http.requests).toHaveLength(1);
  });
});
