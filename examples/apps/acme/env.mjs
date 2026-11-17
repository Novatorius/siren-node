// Finds and reads the env file `siren apps apply` wrote beside siren.app.json,
// so server.mjs and send-sale.mjs talk to the Siren the app was applied to.
//
// - SIREN_ENV_FILE, when set, names the file.
// - Otherwise the folder must hold exactly one of `.env.sandbox` and
//   `.env.live`. Both is refused, naming both and SIREN_ENV_FILE, so the
//   example never guesses between the sandbox and live.
// - The file must hold SIREN_BASE_URL, SIREN_API_KEY and SIREN_SIGNING_SECRET.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const NAMES = ['SIREN_BASE_URL', 'SIREN_API_KEY', 'SIREN_SIGNING_SECRET'];

/**
 * @param {string} folder
 * @param {Record<string, string | undefined>} env
 * @returns {{ path: string, values: { SIREN_BASE_URL: string, SIREN_API_KEY: string, SIREN_SIGNING_SECRET: string } }}
 */
export function loadAppEnv(folder, env) {
  let path;
  if (env.SIREN_ENV_FILE) {
    path = resolve(env.SIREN_ENV_FILE);
  } else {
    const found = ['.env.sandbox', '.env.live'].map((name) => join(folder, name)).filter((file) => existsSync(file));
    if (found.length === 0) throw new Error(`There is no .env.sandbox or .env.live in ${folder}. Run siren apps apply here first.`);
    if (found.length > 1) throw new Error(`Both ${found.join(' and ')} are here. Set SIREN_ENV_FILE to the one to use.`);
    path = found[0];
  }

  // apply writes plain NAME=value lines, so this reads them the same way.
  const values = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const at = line.indexOf('=');
    if (at > 0 && NAMES.includes(line.slice(0, at))) values[line.slice(0, at)] = line.slice(at + 1);
  }
  const missing = NAMES.filter((name) => !values[name]);
  if (missing.length > 0) {
    // Each line has its own command, since an app's key and its signing secret change apart.
    const fixes = {
      SIREN_BASE_URL: 'siren apps apply writes SIREN_BASE_URL',
      SIREN_API_KEY: 'siren apps rotate-key writes a new key, or siren apps add-key for an app that holds none',
      SIREN_SIGNING_SECRET: 'siren apps rotate-secret writes a new signing secret, and an app with no url has none, so give siren.app.json a url and run siren apps apply',
    };
    throw new Error(`${path} has no ${missing.join(', ')}. ${missing.map((name) => fixes[name]).join('. ')}.`);
  }
  return { path, values };
}
