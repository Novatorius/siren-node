import { BadRequestError } from '../errors';
import type { FailedValidation } from '../errors';
import { clean } from './style';

/*
 * Siren's 400 VALIDATION_FAILED as rows a person can read: one row a field,
 * each message without the field's name, which the row already shows.
 * phpnomad/rest's ValidationSet and Siren's lib/Validations/Core rules write
 * the failures into error.context.failedValidations as {field, message,
 * type, context}. Each message starts with its field, as "email must be a
 * valid email address." or "The key amount must be numeric."
 */

/** One field Siren refused, with what it needs, such as {at: 'email', message: 'must be a valid email address'}. */
export interface FieldProblem {
  at: string;
  message: string;
}

/** A failure's message without its field's name or the closing stop, and with the valid values where Siren names them. */
function messageOf(failure: FailedValidation): string {
  const field = failure.field;
  const valid = failure.context?.validValues;
  if (failure.type === 'REQUIRES_ANY' && Array.isArray(valid) && valid.length > 0) {
    return `must be one of ${valid.map((value) => clean(String(value))).join(', ')}`;
  }
  let text = clean(failure.message).trim();
  for (const lead of [`The key ${field} `, `keys for ${field} `, `${field} `]) {
    if (field !== '' && text.startsWith(lead)) {
      text = `${lead.startsWith('keys') ? 'keys ' : ''}${text.slice(lead.length)}`;
      break;
    }
  }
  return text.replace(/\.$/, '');
}

/**
 * The fields of a validation failure, one row each in Siren's order. A
 * REQUIRED failure stands alone for its field, since the other rules on a
 * field with no value only say again that it has none. Two other rules on
 * one field are joined. Empty for any other error.
 */
export function fieldProblems(error: unknown): FieldProblem[] {
  if (!(error instanceof BadRequestError) || error.fieldErrors.length === 0) return [];
  const byField = new Map<string, FailedValidation[]>();
  for (const failure of error.fieldErrors) byField.set(failure.field, [...(byField.get(failure.field) ?? []), failure]);
  return [...byField].map(([field, failures]) => {
    const required = failures.find((failure) => failure.type === 'REQUIRED');
    const messages = [...new Set((required === undefined ? failures : [required]).map(messageOf))];
    return { at: field === '' ? 'the body' : clean(field), message: messages.join(', and ') };
  });
}

/** "3 fields need fixing." or "1 field needs fixing." */
export function fieldsLine(problems: readonly FieldProblem[]): string {
  return problems.length === 1 ? '1 field needs fixing.' : `${problems.length} fields need fixing.`;
}
