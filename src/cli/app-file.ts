import type { DeclareAppParams } from '../record-types';
import type { AppItemKind } from '../taxonomy';

/*
 * The app file, `siren.app.json`: a Siren recipe that holds one `apps`
 * stanza. Contract: docs/architecture/apps-cli.md, "The app file".
 *
 *   {
 *     "version": 1,
 *     "name": "Acme payouts",
 *     "description": "Pays collaborators through Acme's ledger.",
 *     "apps": {
 *       "acme-payouts": {
 *         "name": "Acme payouts",
 *         "url": "${ACME_SIREN_URL}",
 *         "scopes": [],
 *         "events": [],
 *         "items": {
 *           "notify-crm": { "kind": "postConversionAction", "name": "Tell the CRM" },
 *           "acme-ledger": { "kind": "fulfillmentMethod", "name": "Acme ledger", "currencies": ["USD"] }
 *         }
 *       }
 *     }
 *   }
 */

/** The file name `apps init` writes and `apps apply` reads when given none. */
export const APP_FILE_NAME = 'siren.app.json';

/** One item as the file declares it, keyed by its item key in `items`. */
export interface AppFileItem {
  kind: AppItemKind;
  name: string;
  description?: string;
  currencies?: string[];
  answerWindowMinutes?: number;
}

/** One app as the file declares it, keyed by its app key in `apps`. */
export interface AppFileApp {
  name: string;
  description?: string;
  url: string;
  scopes?: string[];
  events?: string[];
  items?: Record<string, AppFileItem>;
}

/** A checked app file, with every `${NAME}` already filled from the environment. */
export interface AppFile {
  version: 1;
  name: string;
  description: string;
  /** Exactly one app in the first step. */
  apps: Record<string, AppFileApp>;
}

/**
 * One problem with the file. `path` is the dotted key it sits at, such as
 * `apps.acme-payouts.items.notify-crm.kind`, or empty for the whole file.
 * `line` and `column` count from 1 and point at that key in the text, or at
 * the character JSON could not read.
 */
export interface AppFileProblem {
  path: string;
  line: number;
  column: number;
  message: string;
}

/**
 * Reads and checks an app file's text before anything is sent. Answers the
 * file, or every problem found, each naming its key and line. The rules are
 * in the architecture note, "The app file". `${NAME}` in any string is
 * filled from `env`, and a name `env` lacks is a problem at that key.
 *
 * Stub: answers no file and no problems. Packet cli-app-file.
 */
export function parseAppFile(
  text: string,
  env: Readonly<Record<string, string | undefined>>,
): { file: AppFile; problems: [] } | { file: null; problems: AppFileProblem[] } {
  void text;
  void env;
  return { file: null, problems: [] };
}

/**
 * The declaration `PUT /apps/{key}` takes for the file's one app: its
 * fields as they are, and `items` turned from a map into a list in the
 * file's order, each with its `key`.
 *
 * Stub. Packet cli-app-file.
 */
export function declarationFor(file: AppFile): { key: string; params: DeclareAppParams } {
  void file;
  return { key: '', params: { name: '', url: '' } };
}

/**
 * The text `apps init` writes: a file that passes {@link parseAppFile} once
 * `SIREN_APP_URL` is set, declaring the app `key` named `name` with one
 * post-conversion action, `notify`, and one fulfillment method, `pay`,
 * paying `USD`.
 *
 * Stub. Packet cli-app-file.
 */
export function appFileTemplate(key: string, name: string): string {
  void key;
  void name;
  return '';
}
