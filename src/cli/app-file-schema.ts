import { FeatureKind } from '../taxonomy';
import {
  APP_FIELDS,
  CONVERSION_TYPES,
  ITEM_FIELDS,
  KEY,
  KINDS,
  MAX_ANSWER_WINDOW_MINUTES,
  MAX_DOMAINS,
  MAX_FEATURES,
  RESERVED_APP_KEYS,
  TOP_FIELDS,
} from './app-file';
import { kindLabel } from './app-kinds';

/*
 * The JSON schema of siren.app.json, built from the lists and limits
 * `parseAppFile` checks with, so the two cannot drift. The package ships it
 * as siren.app.schema.json, and `apps init` points `$schema` at it, so an
 * editor completes kinds and fields. test/cli-app-file-schema.test.ts holds
 * the committed file to this function's output, and runs a set of files
 * through both to show they agree.
 *
 * The schema checks the file's shape. A few checks need more than JSON
 * Schema says well, and only the tool makes them: filling `${SIREN_APP_...}`
 * in the url and the url's scheme, each contact's address and their count
 * once repeats are dropped, and each allowed domain's grammar.
 */

type Schema = Record<string, unknown>;

const TEXT: Schema = { type: 'string' };
const TEXT_LIST: Schema = { type: 'array', items: TEXT };
const KEY_NAME: Schema = { type: 'string', pattern: KEY.source, maxLength: 64 };

/** A rule that a field is required for one kind and refused for the others, or only refused for the others when `required` is false. */
function onlyFor(kind: string, fields: readonly string[], required: boolean): Schema {
  const isKind = { required: ['kind'], properties: { kind: { const: kind } } };
  const refused = { not: { anyOf: fields.map((field) => ({ required: [field] })) } };
  return required ? { if: isKind, then: { required: [...fields] }, else: refused } : { if: isKind, else: refused };
}

function feature(): Schema {
  const properties: Record<string, Schema> = {
    kind: {
      enum: [...KINDS],
      description: `The feature's kind, which locks once Siren makes it: ${KINDS.map(kindLabel).join(', ')}.`,
    },
    name: { type: 'string', minLength: 1, description: 'The name the dashboard shows.' },
    description: TEXT,
    currencies: { ...TEXT_LIST, minItems: 1, description: `For a ${kindLabel(FeatureKind.PayoutMethod)}: the currency codes it pays.` },
    answerWindowMinutes: { type: 'integer', minimum: 1, maximum: MAX_ANSWER_WINDOW_MINUTES, description: 'How long Siren waits for an answer to an ask, in minutes.' },
    scoresMoney: { type: 'boolean', description: `For a ${kindLabel(FeatureKind.MetricCalculation)}: whether its score is an amount of money.` },
    conversionTypes: {
      type: 'array',
      items: { enum: [...CONVERSION_TYPES] },
      minItems: 1,
      uniqueItems: true,
      description: `For an ${kindLabel(FeatureKind.IncentiveType)}: the conversions it pays, each once.`,
    },
    fields: {
      type: 'object',
      additionalProperties: { type: 'object', required: ['type'], properties: { type: TEXT, required: { type: 'boolean' } } },
      description: `For a ${kindLabel(FeatureKind.CustomEvent)}: each field's name to {"type": ..., "required": ...}.`,
    },
    domains: { ...TEXT_LIST, maxItems: MAX_DOMAINS, description: `For a ${kindLabel(FeatureKind.CustomEvent)}: the websites that may send it from a browser, such as example.com or *.example.com.` },
  };
  return {
    type: 'object',
    required: ['kind', 'name'],
    additionalProperties: false,
    properties: Object.fromEntries(ITEM_FIELDS.map((field) => [field, properties[field] ?? {}])),
    allOf: [
      onlyFor(FeatureKind.PayoutMethod, ['currencies'], true),
      onlyFor(FeatureKind.IncentiveType, ['conversionTypes'], true),
      onlyFor(FeatureKind.MetricCalculation, ['scoresMoney'], false),
      onlyFor(FeatureKind.CustomEvent, ['fields', 'domains'], false),
    ],
  };
}

function app(): Schema {
  const properties: Record<string, Schema> = {
    name: { type: 'string', minLength: 1, description: 'The name the dashboard shows.' },
    description: TEXT,
    url: { ...TEXT, description: 'Where Siren sends requests: https, or http to localhost. ${SIREN_APP_URL} is filled from the shell or .env.' },
    scopes: { ...TEXT_LIST, description: "The app key's scopes." },
    events: { ...TEXT_LIST, description: 'The events Siren tells the app about.' },
    contacts: { ...TEXT_LIST, description: 'Email addresses Siren tells when something is wrong with the app.' },
    features: { type: 'object', propertyNames: KEY_NAME, maxProperties: MAX_FEATURES, additionalProperties: feature(), description: 'Each feature under its feature key.' },
  };
  const allCustomEvents = { additionalProperties: { required: ['kind'], properties: { kind: { const: FeatureKind.CustomEvent } } } };
  return {
    type: 'object',
    required: ['name'],
    additionalProperties: false,
    properties: Object.fromEntries(APP_FIELDS.map((field) => [field, properties[field] ?? {}])),
    // Siren sends a feature its requests at the app's address. Only custom events need none.
    if: { required: ['features'], properties: { features: { not: allCustomEvents } } },
    then: { required: ['url'] },
  };
}

/** The schema, as siren.app.schema.json holds it. */
export function appFileSchema(): Schema {
  const properties: Record<string, Schema> = {
    $schema: TEXT,
    version: { const: 1 },
    name: { ...TEXT, description: "A recipe's name. The tool sends only the app's own name." },
    description: TEXT,
    apps: {
      type: 'object',
      minProperties: 1,
      maxProperties: 1,
      propertyNames: { ...KEY_NAME, not: { enum: [...RESERVED_APP_KEYS] } },
      additionalProperties: app(),
      description: 'One app, under its app key.',
    },
  };
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'siren.app.json',
    description: 'One Siren app and its features, which siren apps apply declares.',
    type: 'object',
    required: ['version', 'apps'],
    additionalProperties: false,
    properties: Object.fromEntries(TOP_FIELDS.map((field) => [field, properties[field] ?? {}])),
  };
}
