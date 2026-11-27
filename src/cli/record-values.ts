import {
  CollaboratorStatus,
  DistributorStatus,
  FulfillmentStatus,
  ObligationStatus,
  OpportunityStatus,
  PayoutStatus,
  ProgramStatus,
  TransactionStatus,
} from '../taxonomy';

/*
 * The status words the record commands check before sending, where Siren's
 * openapi.json lists none (CLI review round 1, finding C11). openapi.json
 * gives most list routes a plain-text `status` filter, so a wrong word went
 * out and came back as a green, empty list. These are the words Siren
 * stores, from the SDK's own taxonomy, so the filter refuses any other.
 *
 * Conversions are the one resource whose read and write words differ:
 * Siren takes `approved` on a write and stores an approved conversion as
 * `complete` (ConversionApproveService::APPROVED). Its filter takes either
 * and sends `complete`, and help says so.
 */

/** The words one resource's status filter takes, the ones it reads as another, and a sentence for help. */
export interface StatusWords {
  readonly values: readonly string[];
  /** A word the filter takes in place of the stored one, such as `approved` for a conversion's `complete`. */
  readonly aliases?: Readonly<Record<string, string>>;
  /** Said in help beside the values when the read and write words differ. */
  readonly note?: string;
}

const words = (taxonomy: Readonly<Record<string, string>>): string[] => Object.values(taxonomy);

/** What each resource's `--status` filter takes, by resource name. */
export const READ_STATUSES: Readonly<Record<string, StatusWords>> = {
  conversions: {
    values: ['pending', 'complete', 'rejected', 'expired', 'deleted'],
    aliases: { approved: 'complete' },
    note: 'Siren stores an approved conversion as complete, so --status approved reads complete. A write takes approved.',
  },
  obligations: { values: words(ObligationStatus) },
  transactions: { values: words(TransactionStatus) },
  payouts: { values: words(PayoutStatus) },
  // UpdateProgram takes draft, and an invited collaborator reads as invited, though the taxonomy names neither.
  programs: { values: [...words(ProgramStatus), 'draft'] },
  collaborators: { values: [...words(CollaboratorStatus), 'invited'] },
  distributors: { values: words(DistributorStatus) },
  fulfillments: { values: words(FulfillmentStatus) },
  opportunities: { values: words(OpportunityStatus) },
};

/**
 * The values a body field takes where openapi.json marks the field
 * unreadable and lists none, by resource name and method, then field. They
 * follow Siren's validators: CreateNewCollaborator and UpdateCollaborator
 * through CollaboratorStatusProvider, CreateNewProgram and UpdateProgram.
 */
export const WRITE_VALUES: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  'collaborators POST': { status: ['active', 'inactive', 'pending'] },
  'collaborators PUT': { status: ['active', 'inactive', 'pending', 'rejected', 'invited'] },
  'programs POST': { status: ['active', 'inactive'] },
  'programs PUT': { status: ['active', 'inactive', 'draft', 'deleted'] },
};

/** Said beside a body field in help, when its read words differ from its write words. */
export const WRITE_NOTES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  conversions: { status: 'Siren reads an approved conversion back as complete.' },
};
