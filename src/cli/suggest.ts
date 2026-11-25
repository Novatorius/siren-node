/** The nearest of `choices` to `typed` by edit distance, when it is near enough to be a typo. */
export function nearest(typed: string, choices: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const choice of choices) {
    const distance = editDistance(typed, choice);
    if (distance < bestDistance) {
      best = choice;
      bestDistance = distance;
    }
  }
  return bestDistance <= Math.max(2, Math.floor(typed.length / 3)) ? best : undefined;
}

/**
 * What to offer for a name Siren does not have: the nearest one when it is
 * close, such as `event:sale` for `event:sales`. Otherwise up to four that
 * it starts, such as `postAllocationAction` for `postAllocation`, or that
 * share its first part, such as each `program.` event for `program.made`.
 * Empty when neither finds one.
 */
export function suggestions(typed: string, choices: readonly string[], separator: RegExp): string[] {
  const close = nearest(typed, choices);
  if (close !== undefined) return [close];
  // A name cut short, such as postAllocation, names each one it starts.
  const started = typed.length >= 3 ? choices.filter((choice) => choice.toLowerCase().startsWith(typed.toLowerCase())) : [];
  if (started.length > 0) return started.slice(0, 4);
  const group = typed.split(separator)[0];
  if (group === undefined || group === '' || group === typed) return [];
  return choices.filter((choice) => choice.split(separator)[0] === group).slice(0, 4);
}

/** "a", "a or b", or "a, b or c", each in double quotes. */
export function either(names: readonly string[]): string {
  const quoted = names.map((name) => `"${name}"`);
  return quoted.length <= 1 ? (quoted[0] ?? '') : `${quoted.slice(0, -1).join(', ')} or ${quoted.at(-1)}`;
}

/** Levenshtein distance. */
function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length]!;
}
