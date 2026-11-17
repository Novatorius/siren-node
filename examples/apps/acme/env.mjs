// Finds and reads the env file `siren apps apply` wrote beside siren.app.json,
// so server.mjs and send-sale.mjs talk to the Siren the app was applied to.
//
// - SIREN_ENV_FILE, when set, names the file.
// - Otherwise the folder must hold exactly one of `.env.sandbox` and
//   `.env.live`. Both is refused, naming both and SIREN_ENV_FILE, so the
//   example never guesses between the sandbox and live.
// - The file must hold SIREN_BASE_URL, SIREN_API_KEY and SIREN_SIGNING_SECRET.
//
// Stub: answers an empty path and no values. Packet example-app builds it.

/**
 * @param {string} folder
 * @param {Record<string, string | undefined>} env
 * @returns {{ path: string, values: { SIREN_BASE_URL: string, SIREN_API_KEY: string, SIREN_SIGNING_SECRET: string } }}
 */
export function loadAppEnv(folder, env) {
  void folder;
  void env;
  return { path: '', values: { SIREN_BASE_URL: '', SIREN_API_KEY: '', SIREN_SIGNING_SECRET: '' } };
}
