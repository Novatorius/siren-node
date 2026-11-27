export function loadAppEnv(
  folder: string,
  env: Record<string, string | undefined>,
): { path: string; values: { SIREN_BASE_URL: string; SIREN_API_KEY: string; SIREN_SIGNING_SECRET: string } };
