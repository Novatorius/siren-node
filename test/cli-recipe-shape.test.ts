import { describe, expect, it } from 'vitest';
import { RECIPE_NOTE, parseAppFile } from '../src/cli/app-file';
import { appFileSchema } from '../src/cli/app-file-schema';
import { harness } from './cli-fakes';
import { APP_KEY, appRecord } from './apps-siren-answers';
import { reply } from './http-fakes';

/*
 * CLI pass 2, finding 4, declined: the reviewer asked for a flat file in
 * place of an `apps` map that holds one app. The file stays a Siren recipe,
 * so the CLI and the dashboard can share it. What changes is that the file
 * says so: init and pull write a description that calls it a recipe, the
 * schema says why `apps` is a map, and a file with two apps hears why a
 * folder holds one.
 */

const KEY = APP_KEY;

describe('the app file says it is a recipe', () => {
  it('apps init and apps pull write the recipe description, and the file still parses', async () => {
    const init = harness([]);
    expect(await init.run(['apps', 'init', '--key', KEY]), init.err()).toBe(0);
    expect(JSON.parse(init.file('siren.app.json')).description).toBe(RECIPE_NOTE);

    const pull = harness([reply(200, appRecord())]);
    pull.signedIn();
    expect(await pull.run(['apps', 'pull', KEY]), pull.err()).toBe(0);
    const pulled = JSON.parse(pull.file('siren.app.json'));
    expect(pulled.description).toBe(RECIPE_NOTE);
    expect(Object.keys(pulled)).toEqual(['$schema', 'version', 'description', 'apps']);
    expect(parseAppFile(pull.file('siren.app.json'), {}).problems).toEqual([]);
  });

  it('calls the file a recipe and names the command that sends it', () => {
    expect(RECIPE_NOTE).toBe('A Siren recipe that sets up one app. siren apps apply sends it to Siren.');
  });

  it("the schema says why apps is a map that holds one app", () => {
    const apps = (appFileSchema().properties as Record<string, { description?: string }>).apps!;
    expect(apps.description).toBe(
      'One app under its app key. A Siren recipe maps each key to its record, so apps is a map. It holds one app, since the env file beside siren.app.json keeps that one app\'s key.',
    );
  });

  it('a file with two apps or none hears why a folder holds one app, and nothing about flattening the file', () => {
    const two = parseAppFile(JSON.stringify({ version: 1, apps: { one: { name: 'One' }, two: { name: 'Two' } } }), {});
    expect(two.problems.map((problem) => problem.message)).toEqual([
      "apps holds 2 apps, and a file holds one, since the env file beside it keeps that one app's key. Give each app a folder of its own.",
    ]);
    const none = parseAppFile(JSON.stringify({ version: 1, apps: {} }), {});
    expect(none.problems.map((problem) => problem.message)).toEqual(['apps holds no app. Write the app under its app key, such as "acme-payouts": { ... }.']);
  });
});
