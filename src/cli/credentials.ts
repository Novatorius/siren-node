import type { Edition } from './session-auth';

/**
 * One signed-in session, kept per Siren address. Holds what the next
 * command needs and nothing more: never the password, the five-minute
 * verification token, an app's API key or its signing secret.
 */
export interface StoredSession {
  /** What Siren reported at sign-in. Every later command checks it against `--live`. */
  edition: Edition;
  email: string;
  userId: number;
  orgId: number;
  orgName: string;
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
  sessions: Record<string, StoredSession>;
}

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
 * Stub: reads nothing and writes nothing. Packet cli-session.
 */
export class CredentialStore {
  constructor(private readonly configDir: string) {}

  /** The session for this base URL, or null. */
  async get(baseUrl: string): Promise<StoredSession | null> {
    void this.configDir;
    void baseUrl;
    return null;
  }

  /** Saves the session for this base URL, replacing the one before. Other bases keep theirs. */
  async put(baseUrl: string, session: StoredSession): Promise<void> {
    void baseUrl;
    void session;
  }

  /** Forgets the session for this base URL. */
  async remove(baseUrl: string): Promise<void> {
    void baseUrl;
  }
}
