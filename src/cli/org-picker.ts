import type { StoredMembership } from './credentials';
import type { CliIo } from './io';
import { clean, styleFor } from './style';
import type { Style } from './style';
import { CliRefusal } from './targets';

/*
 * The organization question, in gh's shape (pass 3 re-check, must-fix 3).
 * In a terminal that sends keys, an arrow-key list of the person's
 * organizations, name and slug, with the session's own organization picked
 * to start. Typing filters it, so a slug or the start of one picks it. A
 * terminal that sends whole lines gets a numbered list and takes a number,
 * a slug, or the start of a slug or a name, and an empty line takes the
 * session's organization. Either way, a miss asks again, at most three
 * times, and never ends in a sentence with an empty name.
 */

const UP = '\u001b[A';
const DOWN = '\u001b[B';
const CTRL_C = '\u0003';
const ESCAPE = '\u001b';
const BACKSPACE = ['\u007f', '\b'];
const ENTER = ['\r', '\n'];
const CLEAR_LINE = '\u001b[2K';

/** How many answers the line question takes before it stops. */
const TRIES = 3;

/** The organizations that `typed` picks: a number from the list, a slug or id, or the start of a slug or a name. */
export function orgsMatching(memberships: readonly StoredMembership[], typed: string): StoredMembership[] {
  const wanted = typed.trim().toLowerCase();
  if (wanted === '') return [...memberships];
  if (/^\d+$/.test(wanted)) {
    const byNumber = memberships[Number(wanted) - 1];
    const byId = memberships.find((membership) => String(membership.orgId) === wanted);
    return byNumber !== undefined ? [byNumber] : byId !== undefined ? [byId] : [];
  }
  const exact = memberships.find((membership) => membership.orgSlug.toLowerCase() === wanted);
  if (exact !== undefined) return [exact];
  return memberships.filter((membership) => membership.orgSlug.toLowerCase().startsWith(wanted) || membership.orgName.toLowerCase().startsWith(wanted));
}

/**
 * Asks which organization, on standard error, and answers it. `current` is
 * the session's own organization, picked to start and taken by an empty
 * answer. Refuses after Ctrl-C, or three answers that name none.
 */
export async function askOrg(io: CliIo, memberships: readonly StoredMembership[], current?: number): Promise<StoredMembership> {
  const style = styleFor(io, 'stderr', {});
  const start = Math.max(0, memberships.findIndex((membership) => membership.orgId === current));
  const listening = io.stderrTty === true && io.screen !== undefined;
  const chosen = (listening ? await pick(io, style, memberships, start) : undefined) ?? (await askByLine(io, style, memberships, memberships.find((membership) => membership.orgId === current)));
  const slug = chosen.orgSlug || String(chosen.orgId);
  io.stderr(`${style.rich ? style.dim(`› Skip this next time with --org ${slug} or SIREN_ORG=${slug}.`) : `Skip this next time with --org ${slug} or SIREN_ORG=${slug}.`}\n`);
  return chosen;
}

/** The list's rows: the name padded so the slugs line up, the slug dim. */
function rows(style: Style, memberships: readonly StoredMembership[]): string[] {
  const width = Math.max(...memberships.map((membership) => clean(membership.orgName).length));
  return memberships.map((membership) => `${clean(membership.orgName).padEnd(width)}  ${style.dim(clean(membership.orgSlug) || String(membership.orgId))}`);
}

/** The line that stays once a pick is made: the question and the answer. */
function picked(style: Style, chosen: StoredMembership): string {
  return `${style.green('?')} ${style.bold('Which organization?')} ${clean(chosen.orgName)} (${clean(chosen.orgSlug) || chosen.orgId})`;
}

/**
 * The arrow-key list. Answers undefined when standard input sends no keys,
 * so the line question asks instead.
 */
async function pick(io: CliIo, style: Style, memberships: readonly StoredMembership[], start: number): Promise<StoredMembership | undefined> {
  const screen = io.screen!;
  let filter = '';
  let index = start;
  let drawn = 0;
  const shown = () => orgsMatching(memberships, filter);
  const draw = () => {
    const list = shown();
    index = Math.min(index, Math.max(0, list.length - 1));
    const lines = [
      `${style.green('?')} ${style.bold('Which organization?')} ${filter === '' ? style.dim('Arrows move, typing filters, Enter picks.') : filter}`,
      ...(list.length === 0 ? [style.dim(`  None starts with ${filter}.`)] : rows(style, list).map((row, at) => (at === index ? `${style.cyan('❯')} ${row}` : `  ${row}`))),
    ];
    let text = drawn > 0 ? `\u001b[${drawn}A` : '';
    for (const line of lines) text += `\r${CLEAR_LINE}${line}\n`;
    for (let extra = lines.length; extra < drawn; extra++) text += `\r${CLEAR_LINE}\n`;
    if (drawn > lines.length) text += `\u001b[${drawn - lines.length}A`;
    io.stderr(text);
    drawn = lines.length;
  };
  return new Promise<StoredMembership | undefined>((resolve, reject) => {
    const finish = (chosen: StoredMembership | undefined, error?: CliRefusal) => {
      stop?.();
      let text = `\u001b[${drawn}A`;
      for (let line = 0; line < drawn; line++) text += `\r${CLEAR_LINE}\n`;
      io.stderr(`${text}\u001b[${drawn}A${chosen === undefined ? '' : `${picked(style, chosen)}\n`}`);
      if (error !== undefined) reject(error);
      else resolve(chosen);
    };
    const stop = screen.listen((key) => {
      const list = shown();
      if (key === CTRL_C) {
        finish(undefined, new CliRefusal('No organization picked.', { why: 'Ctrl-C stopped the question, so nothing was sent.', fixText: 'Run it again, or pass --org <slug>.' }));
      } else if (ENTER.includes(key)) {
        if (list[index] !== undefined) finish(list[index]);
      } else if (key === UP) {
        index = (index - 1 + list.length) % Math.max(1, list.length);
        draw();
      } else if (key === DOWN) {
        index = (index + 1) % Math.max(1, list.length);
        draw();
      } else if (BACKSPACE.includes(key)) {
        filter = filter.slice(0, -1);
        draw();
      } else if (key === ESCAPE) {
        filter = '';
        draw();
      } else if (/^[\x20-\x7e]+$/.test(key)) {
        filter += key;
        index = 0;
        draw();
      }
    });
    if (stop === null) {
      resolve(undefined);
      return;
    }
    draw();
  });
}

/** The numbered list and a line answer, asked again on a miss, at most {@link TRIES} times. */
async function askByLine(io: CliIo, style: Style, memberships: readonly StoredMembership[], fallback: StoredMembership | undefined): Promise<StoredMembership> {
  io.stderr(`${style.green('?')} ${style.bold('Which organization?')}\n`);
  const listed = rows(style, memberships);
  listed.forEach((row, at) => io.stderr(`  ${style.dim(String(at + 1))}  ${row}\n`));
  const hint = fallback === undefined ? '' : ` [${clean(fallback.orgSlug) || fallback.orgId}]`;
  let last = '';
  for (let tries = 0; tries < TRIES; tries++) {
    const typed = (await io.prompt(`Number or slug${hint}: `)).trim();
    if (typed === '' && fallback !== undefined) return fallback;
    const found = typed === '' ? [] : orgsMatching(memberships, typed);
    if (found.length === 1) return found[0]!;
    last = typed;
    const miss = typed === '' ? 'Type a number or a slug.' : found.length > 1 ? `${clean(typed)} starts more than one. Type more of it.` : `${clean(typed)} is none of them. Type a number or a slug.`;
    io.stderr(`${style.rich ? style.wrap(`${style.amber('!')} `, miss) : miss}\n`);
  }
  throw new CliRefusal('No organization picked.', {
    why: last === '' ? `Nothing was typed ${TRIES} times, so nothing was sent.` : `${clean(last)} named none of them, so nothing was sent.`,
    fixText: 'Run it again, or pass --org <slug>.',
  });
}
