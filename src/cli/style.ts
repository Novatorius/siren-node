import { SIREN_GREEN } from './hook';
import type { CliIo } from './io';
import type { CliRefusal } from './targets';

/*
 * How the `siren` command styles what it prints, Alex's ruling M108
 * (briefs/sdk-dx-loop.md, "CLI output and errors, pulled forward"). Every
 * command formats its lines through a {@link Style}, so none of them writes
 * its own escape codes.
 *
 * - Siren green for success and the wordmark, red for errors, amber for
 *   warnings, dim for secondary detail such as ids, paths and times, and
 *   bold for the one thing a line is about.
 * - ✓ done, ✗ failed, ! a warning, › a next step.
 * - Plain wherever styling would get in the way: when the stream is not a
 *   terminal, under NO_COLOR (any value but empty), TERM=dumb or CI (any
 *   value but empty, `false` or `0`), and with --json. Plain output carries
 *   no symbol and no escape code, so it reads as it did before this module.
 */

const RESET = '\u001b[0m';
const BOLD = '\u001b[1m';
const DIM = '\u001b[2m';
const RED = '\u001b[31m';
const AMBER = '\u001b[33m';
const CYAN = '\u001b[36m';
const CLEAR_LINE = '\u001b[2K';
const HIDE_CURSOR = '\u001b[?25l';
const SHOW_CURSOR = '\u001b[?25h';

/** The spinner's frames, braille, one every {@link SPIN_MS} milliseconds. */
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPIN_MS = 80;

/** One numbered step under Next: what to do, and a dim aside aligned after it. */
export interface NextStep {
  text: string;
  aside?: string;
}

/**
 * A command's success output, the shape every command keeps (Alex,
 * 2026-11-24, after `siren apps init`): a ✓ headline with the thing in
 * bold, a short block of labels and values, a numbered Next, and one or
 * two tips.
 */
export interface Report {
  headline: string;
  /** False for a view, whose headline gets no ✓, since nothing was done. */
  mark?: boolean;
  rows?: ReadonlyArray<readonly [string, string]>;
  next?: readonly NextStep[];
  tips?: readonly string[];
}

/**
 * The width the tool wraps to when it can't measure the terminal, as
 * through a pipe: 80 columns. In a terminal every view wraps to the
 * terminal's own width ({@link Style.width}).
 */
export const REPORT_WIDTH = 80;

/**
 * Text from Siren, such as an organization's name or an email, with every
 * escape sequence and control character taken out, so nothing a server
 * sends can move the cursor, clear the screen, recolor the terminal or
 * plant a link. Run it on every value Siren sends before printing it.
 */
export function clean(text: string): string {
  return text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, '')
    .replace(/(?:\u001b\[|\u009b)[\d;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[@-_]/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
}

/** `text` that {@link wrapWords} keeps on one line, such as a command a person copies. A report prints it with plain spaces. */
export function unbroken(text: string): string {
  return text.replace(/ /g, '\u00a0');
}

/** `text` broken at spaces into lines of at most `width` visible columns. A word longer than `width` keeps a line of its own. */
export function wrapWords(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line !== '' && visibleLength(line) + 1 + visibleLength(word) > width) {
      lines.push(line);
      line = word;
    } else {
      line = line === '' ? word : `${line} ${word}`;
    }
  }
  return [...lines, line];
}

/**
 * `text` wrapped at word boundaries to fit `width` columns, the first line
 * after `lead` and the rest after `indent`. A line break in `text` starts a
 * new line. A no-break space keeps two words together, and prints as a
 * space. Used for every line the tool prints in a terminal, so nothing
 * wraps mid-word at 80 columns (CLI pass 3, must-fix 2).
 */
export function hanging(lead: string, text: string, indent = '  ', width = REPORT_WIDTH): string {
  const first = width - visibleLength(lead);
  const rest = width - visibleLength(indent);
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    const room = lines.length === 0 ? first : rest;
    const [head = '', ...tail] = wrapWords(paragraph, room);
    lines.push(head, ...(tail.length === 0 ? [] : wrapWords(tail.join(' '), rest)));
  }
  return lines.map((line, at) => `${at === 0 ? lead : indent}${line}`.replace(/\u00a0/g, ' ')).join('\n');
}

/** A command kept on one line when it fits one, its spaces made no-break. */
function keptWhole(command: string, width: number): string {
  return visibleLength(command) <= width - 10 ? command.replace(/ /g, '\u00a0') : command;
}

/** How many columns `text` takes, without its escape codes. */
export function visibleLength(text: string): number {
  return [...text.replace(/\u001b\[[\d;?]*[A-Za-z]/g, '')].length;
}

/** What decides whether a stream is styled. */
export interface StyleOptions {
  /** True when the stream is a terminal. */
  tty: boolean;
  env: Readonly<Record<string, string | undefined>>;
  /** True with --json, which is never styled. */
  json?: boolean;
  /** The terminal's width in columns, when the stream is a terminal the tool can measure. */
  columns?: number;
}

/** A spinner on a line of its own, until {@link Spinner.stop} turns it into one ✓ or ✗ line. */
export interface Spinner {
  /** Changes the words beside the spinner. */
  update(text: string): void;
  stop(ok: boolean, line: string): void;
  /** Stops and clears the spinner's line, printing nothing in its place. */
  cancel(): void;
}

/** True when CI names a build machine: set, and not empty, `false` or `0`. */
function inCi(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.CI !== undefined && env.CI !== '' && env.CI !== 'false' && env.CI !== '0';
}

/** The styling for one stream. Build it with {@link styleFor}. */
export class Style {
  /** True when this stream gets color and symbols. */
  readonly rich: boolean;
  /**
   * The columns this stream's text wraps to: the terminal's width when the
   * tool can measure it, else {@link REPORT_WIDTH}. Text wraps at word
   * boundaries and is never cut (CLI review round 1, C8 and C23).
   */
  readonly width: number;
  private readonly greenCode: string;

  constructor(options: StyleOptions) {
    const env = options.env;
    this.rich =
      options.tty && options.json !== true && !(env.NO_COLOR !== undefined && env.NO_COLOR !== '') && env.TERM !== 'dumb' && !inCi(env);
    const depth = (env.COLORTERM ?? '').toLowerCase();
    this.greenCode = depth === 'truecolor' || depth === '24bit' ? SIREN_GREEN.truecolor : SIREN_GREEN.ansi256;
    this.width = options.tty && options.columns !== undefined && options.columns >= 20 ? options.columns : REPORT_WIDTH;
  }

  /** `text` wrapped at word boundaries to this stream's width, as {@link hanging} does. */
  wrap(lead: string, text: string, indent = '  '): string {
    return hanging(lead, text, indent, this.width);
  }

  private paint(code: string, text: string): string {
    return this.rich && text !== '' ? `${code}${text}${RESET}` : text;
  }

  green(text: string): string {
    return this.paint(this.greenCode, text);
  }

  red(text: string): string {
    return this.paint(RED, text);
  }

  amber(text: string): string {
    return this.paint(AMBER, text);
  }

  cyan(text: string): string {
    return this.paint(CYAN, text);
  }

  dim(text: string): string {
    return this.paint(DIM, text);
  }

  bold(text: string): string {
    return this.paint(BOLD, text);
  }

  /** A command a person can run, such as `siren login`, in bold. */
  command(text: string): string {
    return this.bold(text);
  }

  /** "✓ Applied acme-payouts.", wrapped to the terminal's width. */
  success(line: string): string {
    return this.rich ? this.wrap(`${this.green('✓')} `, line) : line;
  }

  /** "✗ Not logged in.", the words in bold, wrapped to the terminal's width. */
  failure(line: string): string {
    return this.rich ? `${RED}${BOLD}${this.wrap('✗ ', line)}${RESET}` : line;
  }

  /** "! The key is not saved.", wrapped to the terminal's width. */
  warning(line: string): string {
    return this.rich ? this.wrap(`${this.amber('!')} `, line) : line;
  }

  /** "› siren apps apply", wrapped to the terminal's width at word boundaries. */
  next(line: string): string {
    return this.rich ? this.wrap(`${this.dim('›')} `, line) : line;
  }

  /**
   * An error as the tool prints it, ending in a line break. Plain, it is
   * one line, `siren: ` and the refusal's message, as every error was
   * before, then its note. In a terminal it is three parts at most: a red ✗
   * and the headline, the why under it, and the fix as a command to run.
   * `verbose` adds the detail, dim, in both.
   */
  error(refusal: Pick<CliRefusal, 'message' | 'headline' | 'parts'>, verbose: boolean): string {
    const parts = refusal.parts;
    const extra = [...(parts.note === undefined ? [] : [parts.note]), ...(verbose ? (parts.detail ?? []) : [])];
    const problems = parts.problems ?? [];
    if (!this.rich) {
      return `siren: ${refusal.message}\n${[...problems.map((problem) => `${problem.at}: ${problem.message}`), ...extra].map((line) => `${line}\n`).join('')}`;
    }
    const lines = [this.failure(refusal.headline), this.wrap('  ', parts.why)];
    for (const problem of problems) lines.push(`  ${this.dim(problem.at)}`, this.wrap('    ', problem.message, '    '));
    const fix =
      parts.fix === undefined
        ? parts.fixText
        : `${parts.fixLead ?? 'Run'} ${this.command(keptWhole(parts.fix, this.width))}${parts.fixWords === undefined ? '' : ` ${parts.fixWords}`}.`;
    lines.push(this.wrap(`${this.green('›')} `, fix));
    for (const line of extra) lines.push(this.dim(this.wrap('', line)));
    return `${lines.join('\n')}\n`;
  }

  /**
   * A {@link Report} as lines of text, ending in a line break. Plain, it
   * keeps the layout and drops the symbols and escape codes.
   */
  report(report: Report): string {
    const lines = [report.mark === false ? report.headline : this.success(report.headline)];
    const rows = report.rows ?? [];
    if (rows.length > 0) {
      const width = Math.max(...rows.map(([label]) => label.length)) + 3;
      lines.push('');
      for (const [label, value] of rows) {
        const [first = '', ...rest] = wrapWords(value, Math.max(20, this.width - 2 - width));
        lines.push(`  ${this.dim(label)}${' '.repeat(width - label.length)}${first}`, ...rest.map((line) => `${' '.repeat(2 + width)}${line}`));
      }
    }
    const next = report.next ?? [];
    if (next.length > 0) {
      const width = Math.max(...next.map((step) => visibleLength(step.text)));
      lines.push('', this.bold('Next'));
      next.forEach((step, at) => {
        const lead = `  ${at + 1}  ${step.text}`;
        if (step.aside === undefined) return lines.push(lead);
        const gap = ' '.repeat(width - visibleLength(step.text) + 3);
        const beside = `${lead}${gap}${this.dim(step.aside)}`;
        return lines.push(visibleLength(beside) <= this.width ? beside : lead, ...(visibleLength(beside) <= this.width ? [] : [`     ${this.dim(step.aside)}`]));
      });
    }
    const tips = report.tips ?? [];
    if (tips.length > 0) {
      lines.push('');
      for (const tip of tips) {
        const [first = '', ...rest] = wrapWords(tip, this.width - 2);
        lines.push(this.rich ? this.dim(`› ${first}`) : first, ...rest.map((line) => (this.rich ? this.dim(`  ${line}`) : `  ${line}`)));
      }
    }
    return `${lines.join('\n').replace(/\u00a0/g, ' ')}\n`;
  }

  /**
   * Rows aligned under a header, two spaces apart, the header dim. Nothing
   * is ever cut: a row wider than `width` wraps its last column at word
   * boundaries, each line under that column's start (CLI review round 1,
   * C8). Pass `Infinity` for a pipe, where a row stays on one line.
   */
  table(headers: readonly string[], rows: ReadonlyArray<readonly string[]>, width: number): string[] {
    const all = [headers, ...rows];
    const widths = headers.map((_, column) => Math.max(...all.map((row) => visibleLength(row[column] ?? ''))));
    const lines = (row: readonly string[]): string[] => {
      const cells = row.map((cell, column) => (column === row.length - 1 ? cell : `${cell}${' '.repeat(widths[column]! - visibleLength(cell))}`));
      const text = cells.join('  ');
      if (visibleLength(text) <= width || row.length === 0) return [text];
      const before = row.length === 1 ? '' : `${cells.slice(0, -1).join('  ')}  `;
      const indent = visibleLength(before);
      const [first = '', ...rest] = wrapWords(row.at(-1) ?? '', Math.max(width - indent, 20));
      return [`${before}${first}`, ...rest.map((line) => `${' '.repeat(indent)}${line}`)];
    };
    return [lines(headers).map((line) => this.dim(line)).join('\n'), ...rows.flatMap(lines)];
  }

  /**
   * A spinner beside `text`, written with `write`. In a terminal it turns
   * every {@link SPIN_MS} milliseconds with the cursor hidden, and `stop`
   * clears it for one ✓ or ✗ line and shows the cursor again. Plain, it
   * writes the words once, and `stop` writes the last line.
   */
  spinner(text: string, write: (text: string) => void): Spinner {
    if (!this.rich) {
      write(`${text}...\n`);
      return { update: () => undefined, stop: (_ok, line) => write(`${line}\n`), cancel: () => undefined };
    }
    let words = text;
    let frame = 0;
    const draw = () => write(`\r${CLEAR_LINE}${this.green(SPIN[frame % SPIN.length]!)} ${words}`);
    write(HIDE_CURSOR);
    draw();
    const timer = setInterval(() => {
      frame += 1;
      draw();
    }, SPIN_MS);
    timer.unref?.();
    let stopped = false;
    return {
      update: (next) => {
        words = next;
        if (!stopped) draw();
      },
      stop: (ok, line) => {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
        write(`\r${CLEAR_LINE}${ok ? this.success(line) : this.failure(line)}\n${SHOW_CURSOR}`);
      },
      cancel: () => {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
        write(`\r${CLEAR_LINE}${SHOW_CURSOR}`);
      },
    };
  }
}

/** The style for one of the command's streams. */
export function styleFor(io: CliIo, stream: 'stdout' | 'stderr', flags: { json?: boolean }): Style {
  const tty = stream === 'stdout' ? io.stdoutTty === true : io.stderrTty === true;
  return new Style({ tty, env: io.env, json: flags.json, columns: io.screen?.size?.columns });
}
