import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CallbackAccessTokenSource } from '../auth/callback-access-token-source';
import { createHttpTransport } from '../client';
import type { HttpTransport } from '../http';
import type { CommandContext } from './context';
import type { StoredSession } from './credentials';
import { CliRefusal } from './targets';

/*
 * What `siren sandbox` and `siren seed` share: the check that keeps them on
 * a sandbox Siren, a transport for Siren's sandbox routes, and the record of
 * which live organization each sandbox organization was copied from.
 * Contract: contract/devtools-sandbox.md in the run folder.
 */

/** One organization, as the copy record names it. */
export interface OrgRef {
  baseUrl: string;
  orgId: number;
  orgSlug: string;
  orgName: string;
}

/** One copy `siren sandbox create` made. Holds names and ids only, never a token or key. */
export interface SandboxCopy extends OrgRef {
  from: OrgRef;
  /** When the copy was made, as an ISO 8601 time. */
  copiedAt: string;
}

interface SandboxesFile {
  version: 1;
  copies: SandboxCopy[];
}

/**
 * `sandboxes.json` in the config folder, beside `credentials.json`, written
 * mode 0600 through a temporary file and a rename as that file is. A missing
 * file reads as no copies.
 */
export class SandboxRecords {
  constructor(private readonly configDir: string) {}

  get path(): string {
    return join(this.configDir, 'sandboxes.json');
  }

  /** Every copy kept, oldest first. */
  async all(): Promise<SandboxCopy[]> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    const copies = (parsed as Partial<SandboxesFile> | undefined)?.copies;
    if (!Array.isArray(copies)) {
      throw new CliRefusal(`${this.path} is not a Siren sandbox record.`, { why: 'The tool keeps which live organization each sandbox came from there.', note: 'Move it out of the way, then try again.' });
    }
    return copies.filter((copy): copy is SandboxCopy => typeof copy === 'object' && copy !== null && typeof copy.baseUrl === 'string' && typeof copy.orgId === 'number');
  }

  /** The copy of this sandbox organization, or null. */
  async find(baseUrl: string, orgId: number): Promise<SandboxCopy | null> {
    return (await this.all()).find((copy) => copy.baseUrl === baseUrl && copy.orgId === orgId) ?? null;
  }

  /** Keeps a copy, replacing an older record of the same sandbox organization. */
  async add(copy: SandboxCopy): Promise<void> {
    const copies = (await this.all()).filter((kept) => !(kept.baseUrl === copy.baseUrl && kept.orgId === copy.orgId));
    copies.push(copy);
    const made = await mkdir(this.configDir, { recursive: true, mode: 0o700 });
    if (made !== undefined && process.platform !== 'win32') await chmod(this.configDir, 0o700);
    const temporary = join(this.configDir, `.sandboxes.${randomBytes(6).toString('hex')}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify({ version: 1, copies } satisfies SandboxesFile, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      await rename(temporary, this.path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}

/**
 * The session for a command that runs only on a sandbox Siren. `--live` and
 * a target that reports itself live (or names no edition) are refused before
 * anything but the edition read is sent. `words` is the command, such as
 * `sandbox reset`, for the fix line.
 */
export async function onSandbox(run: CommandContext, words: string): Promise<StoredSession> {
  if (run.target.live) {
    throw new CliRefusal(`siren ${words} runs only on a sandbox Siren, and --live names a live one.`, {
      why: 'Nothing was sent.',
      fix: `siren ${words}`,
      fixWords: 'without --live',
    });
  }
  if ((await run.targetEdition()) !== 'sandbox') {
    throw new CliRefusal(`${run.target.baseUrl} is a live Siren, and siren ${words} runs only on a sandbox.`, {
      why: 'It changes test data, so it never touches a live organization. Nothing was sent.',
      fix: `siren ${words} --sandbox`,
      fixWords: 'or pass --base-url with a sandbox Siren',
    });
  }
  return run.signedIn();
}

/**
 * A transport for routes the SDK has no resource for, such as the sandbox
 * routes and the recipe routes, carrying the command's session. It
 * refreshes the token as `CommandContext.siren()` does.
 */
export function transportOf(run: CommandContext): HttpTransport {
  return createHttpTransport({
    accessToken: new CallbackAccessTokenSource(
      () => run.accessToken(),
      () => run.refresh(),
    ),
    httpClient: run.io.httpClient,
    baseUrl: run.target.baseUrl,
  });
}

/** The host of an address, for a short line: `sandbox.sirenaffiliates.com`, or `127.0.0.1:34171`. */
export function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** A count and its noun: `1 program`, `3 programs`. */
export function counted(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}
