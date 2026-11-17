import type { HttpClient } from '../http';
import type { CliIo } from './io';

/*
 * Signing a person in from a terminal, against Siren's session routes
 * (lib/Users/Service/Rest, base `/auth`, read at 20c47873d). These routes
 * take no API key. The dashboard uses the same ones, so the tokens are an
 * ordinary session: the access token lasts one hour (AuthService::TOKEN_TTL)
 * and the refresh token thirty days from its last use, since every refresh
 * answers a new pair (REFRESH_TOKEN_TTL, buildTokenResponse()).
 *
 * Internal to the command-line tool. The package does not export it.
 */

/** Which kind of Siren Cloud answered. `GET /auth/signup-options` names it from slice 7 on. */
export type Edition = 'sandbox' | 'production';

/** The person, as Siren's auth answers describe them (AuthService::userPayload()). */
export interface SessionUser {
  id: number;
  email: string;
  role?: string;
  status?: string;
}

/** A session for one person in one organization. */
export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  user: SessionUser;
}

/** One organization the person belongs to (AuthService::buildMembershipsList()). */
export interface Membership {
  orgId: number;
  orgName: string;
  orgSlug: string;
  role: string;
  orgLogoUrl?: string | null;
}

/**
 * What `POST /auth/login` answers with no `orgId`: a session when the person
 * belongs to one organization, or a five-minute verification token and the
 * list to choose from when they belong to several (AuthService::completeAuthentication()).
 */
export type LoginResult =
  | { kind: 'session'; tokens: SessionTokens; memberships: Membership[] }
  | { kind: 'choose-org'; verificationToken: string; memberships: Membership[] };

/** What `POST /auth/register-org` answers (OrgRegistrationService::register()). */
export interface RegisteredOrg {
  org: Membership;
  /** Null when Siren asks the person to confirm their address first, which the sandbox never does. */
  tokens: SessionTokens | null;
}

/** What `signup` sends. Siren refuses a sign-up without `acceptTerms`. */
export interface RegisterOrgParams {
  orgName: string;
  email: string;
  password: string;
  acceptTerms: true;
}

/**
 * Siren's session routes, called through an `HttpClient` the way the
 * connect entry's `OAuthClient` calls the OAuth routes: one JSON request
 * per call to `{baseUrl}/auth/...`, the SDK's `Accept`, `Content-Type` and
 * `User-Agent`, never a redirect followed, and no error that carries a
 * password or a token.
 *
 * - `edition()` and `memberships()` are reads and retry on a network
 *   error, 429 or 5xx, up to twice. Every other call is sent once.
 * - A 2xx answer of the wrong shape raises `UnexpectedResponseError`.
 * - Any other status raises the error `errorFromResponse` builds, so a wrong
 *   password is `AuthenticationError` with Siren's own message.
 *
 * Stub: every call answers an empty value of its type. Packet cli-session.
 */
export class SessionAuthClient {
  constructor(private readonly options: { baseUrl: string; httpClient: HttpClient; timeout?: number }) {}

  /**
   * `GET /auth/signup-options`, and its `edition`. An answer with no
   * `edition`, from a Siren older than slice 7, counts as `production`, so
   * the tool treats an unknown Cloud as live.
   */
  async edition(): Promise<Edition> {
    void this.options;
    return 'production';
  }

  /** `POST /auth/register-org`. Sent once: a second send would make a second org or answer 409. */
  async registerOrg(params: RegisterOrgParams): Promise<RegisteredOrg> {
    void params;
    return { org: { orgId: 0, orgName: '', orgSlug: '', role: '' }, tokens: null };
  }

  /** `POST /auth/login` with `email` and `password`, and `orgId` when given. */
  async login(email: string, password: string, orgId?: number): Promise<LoginResult> {
    void email;
    void password;
    void orgId;
    return { kind: 'choose-org', verificationToken: '', memberships: [] };
  }

  /** `POST /auth/select-org`, the second step for a person in several organizations. */
  async selectOrg(verificationToken: string, orgId: number): Promise<SessionTokens> {
    void verificationToken;
    void orgId;
    return { accessToken: '', refreshToken: '', user: { id: 0, email: '' } };
  }

  /** `POST /auth/refresh`. Siren answers a new pair, and the old refresh token is spent. */
  async refresh(refreshToken: string): Promise<SessionTokens> {
    void refreshToken;
    return { accessToken: '', refreshToken: '', user: { id: 0, email: '' } };
  }

  /** `GET /auth/memberships` with the access token as the bearer. */
  async memberships(accessToken: string): Promise<Membership[]> {
    void accessToken;
    return [];
  }

  /** `POST /auth/switch-org` with the access token as the bearer: a new session in another organization. */
  async switchOrg(accessToken: string, orgId: number): Promise<SessionTokens> {
    void accessToken;
    void orgId;
    return { accessToken: '', refreshToken: '', user: { id: 0, email: '' } };
  }

  /** `POST /auth/logout` with the access token as the bearer and the refresh token in the body, so Siren revokes both. */
  async logout(accessToken: string, refreshToken: string): Promise<void> {
    void accessToken;
    void refreshToken;
  }
}

/**
 * How `siren login` proves who the person is. The first step has one,
 * {@link PasswordSignIn}. Device sign-in (slice 9) adds a second that shows
 * a code to approve in a browser and ends with the same {@link LoginResult},
 * so nothing after sign-in changes.
 */
export interface SignInMethod {
  signIn(auth: SessionAuthClient, io: CliIo, request: { email?: string; passwordFromStdin: boolean; orgId?: number }): Promise<LoginResult>;
}

/**
 * Email and password. The password comes from a hidden prompt, or from
 * standard input with `--password-stdin`, and is never a flag, because a
 * flag lands in the shell's history and the process list. It is sent once
 * to `POST /auth/login` and kept nowhere.
 *
 * Stub: answers an empty choice. Packet cli-session.
 */
export class PasswordSignIn implements SignInMethod {
  async signIn(auth: SessionAuthClient, io: CliIo, request: { email?: string; passwordFromStdin: boolean; orgId?: number }): Promise<LoginResult> {
    void auth;
    void io;
    void request;
    return { kind: 'choose-org', verificationToken: '', memberships: [] };
  }
}
