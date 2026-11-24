import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Edition } from './session-auth';
import { CliRefusal } from './targets';

/**
 * One signed-in session, kept per Siren address. Holds what the next
 * command needs and nothing more: never the password, the five-minute
 * verification token, an app's API key or its signing secret.
 */
export interface StoredSession {
  /**
   * What Siren reported at sign-in. Every later command reads the edition
   * the Siren reports now and refuses a session made for another one.
   */
  edition: Edition;
  /**
   * The address the session was made for, with no trailing slash, the same
   * as its key in the file. Absent in a file written before it was kept.
   */
  baseUrl?: string;
  email: string;
  userId: number;
  orgId: number;
  orgName: string;
  /** The organization's slug. Absent in a file written before it was kept. */
  orgSlug?: string;
  role: string;
  accessToken: string;
  refreshToken: string;
  /** When the access token ends, in Unix seconds, read from its `exp`. The tool refreshes before it. */
  accessExpiresAt: number;
  /**
   * Where `apps apply` wrote each app's key and secret, by app key: the
   * absolute path of the env file beside its app file. `apps rotate` writes
   * the new pair to the same file. Holds paths only, never a key.
   */
  envFiles?: Record<string, string>;
}

/** The file's whole shape. `sessions` is keyed by the base URL with no trailing slash. */
export interface CredentialsFile {
  version: 1;
  /**
   * The Siren the last `login`, `signup` or `use` was for, which a command
   * talks to when it names none and `SIREN_BASE_URL` is not set.
   */
  current?: string;
  sessions: Record<string, StoredSession>;
}

/** The modes are POSIX ones. Windows keeps its own access lists and reports no useful mode. */
const POSIX = process.platform !== 'win32';

/**
 * `credentials.json` in the config folder (`CliIo.configDir`).
 *
 * - The folder is made with mode 0700 and the file written with mode 0600,
 *   through a temporary file in the same folder and a rename, so a crash
 *   never leaves half a file. On Windows the modes are not checked.
 * - A file whose mode lets anyone but its owner read it is refused, with a
 *   message that names the file and says to run `chmod 600` on it, before
 *   any token in it is used. The tool never loosens or fixes the mode itself.
 * - A missing file reads as no sessions. A file that is not this shape is
 *   refused with its path, and never overwritten by a sign-in.
 *
 * Every read goes to the disk, so two commands run one after the other see
 * each other's writes. Each change reads the file, changes one session and
 * writes the whole file back.
 */
export class CredentialStore {
  constructor(private readonly configDir: string) {}

  /** The full path of `credentials.json`. */
  get path(): string {
    return join(this.configDir, 'credentials.json');
  }

  /** The session for this base URL, or null. */
  async get(baseUrl: string): Promise<StoredSession | null> {
    return (await this.read()).sessions[baseUrl] ?? null;
  }

  /** Saves the session for this base URL, replacing the one before. Other bases keep theirs. With `current`, it becomes the Siren in use. */
  async put(baseUrl: string, session: StoredSession, current = false): Promise<void> {
    const file = await this.read();
    file.sessions[baseUrl] = session;
    if (current) file.current = baseUrl;
    await this.write(file);
  }

  /** Forgets the session for this base URL, and forgets it as the Siren in use. */
  async remove(baseUrl: string): Promise<void> {
    const file = await this.read();
    if (!Object.prototype.hasOwnProperty.call(file.sessions, baseUrl)) return;
    delete file.sessions[baseUrl];
    if (file.current === baseUrl) delete file.current;
    await this.write(file);
  }

  /** The Siren in use and its session, or null when none is remembered or its session is gone. */
  async current(): Promise<{ baseUrl: string; session: StoredSession } | null> {
    const file = await this.read();
    const session = file.current === undefined ? undefined : file.sessions[file.current];
    return file.current === undefined || session === undefined ? null : { baseUrl: file.current, session };
  }

  /** Every session kept, by base URL. */
  async all(): Promise<Record<string, StoredSession>> {
    return (await this.read()).sessions;
  }

  /** The whole file, or an empty one when there is none. Refuses a file others can read or one of another shape. */
  private async read(): Promise<CredentialsFile> {
    let text: string;
    try {
      if (POSIX) {
        const mode = (await stat(this.path)).mode;
        if ((mode & 0o077) !== 0) {
          throw new CliRefusal(`${this.path} can be read by other users of this machine. Run chmod 600 ${this.path}, then try again.`);
        }
      }
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, sessions: Object.create(null) as Record<string, StoredSession> };
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (!isCredentialsFile(parsed)) {
      throw new CliRefusal(`${this.path} is not a Siren credentials file. Move it out of the way, then sign in again.`);
    }
    const sessions = Object.create(null) as Record<string, StoredSession>;
    for (const [base, session] of Object.entries(parsed.sessions)) sessions[base] = session;
    return { version: 1, ...(typeof parsed.current === 'string' ? { current: parsed.current } : {}), sessions };
  }

  /** Writes the whole file through a temporary file and a rename, mode 0600 in a folder of mode 0700. */
  private async write(file: CredentialsFile): Promise<void> {
    const made = await mkdir(this.configDir, { recursive: true, mode: 0o700 });
    if (made !== undefined && POSIX) await chmod(this.configDir, 0o700);
    const temporary = join(this.configDir, `.credentials.${randomBytes(6).toString('hex')}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      await rename(temporary, this.path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}

/** True for `{ version: 1, sessions: { <base>: <session> } }` whose sessions each hold their tokens as text. */
function isCredentialsFile(value: unknown): value is CredentialsFile {
  if (typeof value !== 'object' || value === null) return false;
  const { version, sessions, current } = value as { version?: unknown; sessions?: unknown; current?: unknown };
  if (current !== undefined && typeof current !== 'string') return false;
  if (version !== 1 || typeof sessions !== 'object' || sessions === null || Array.isArray(sessions)) return false;
  return Object.values(sessions).every((session: unknown) => {
    if (typeof session !== 'object' || session === null) return false;
    const s = session as Record<string, unknown>;
    return (
      (s.edition === 'sandbox' || s.edition === 'production') &&
      (s.baseUrl === undefined || typeof s.baseUrl === 'string') &&
      typeof s.accessToken === 'string' &&
      typeof s.refreshToken === 'string' &&
      typeof s.accessExpiresAt === 'number' &&
      typeof s.orgId === 'number' &&
      (s.envFiles === undefined || (typeof s.envFiles === 'object' && s.envFiles !== null && !Array.isArray(s.envFiles)))
    );
  });
}
