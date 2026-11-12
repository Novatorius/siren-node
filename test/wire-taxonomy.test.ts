import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ApiKeyScope,
  ApiKeyStatus,
  CollaboratorAliasType,
  CollaboratorBulkAction,
  CollaboratorStatus,
  ConversionStatus,
  CustomCurrencyType,
  DistributorStatus,
  ErrorCode,
  EventReason,
  EventSlug,
  EventStatus,
  FulfillmentStatus,
  HoldConflictReason,
  ObligationStatus,
  OpportunityStatus,
  POLICY_ERROR_CODES,
  PayoutStatus,
  ProgramBulkAction,
  ProgramGroupBulkAction,
  ProgramGroupSorter,
  ProgramStatus,
  RefundKind,
  TransactionStatus,
  WebhookEventType,
  WebhookSubscriptionStatus,
} from '../src/index';

/*
 * Slice 1 acceptance tests: the wire vocabulary.
 *
 * Siren owns these terms, per Taxonomy Ownership & SDK Typing Doctrine
 * (KB 566, https://navigator.novatori.us/r/kb/566). Each
 * expectation below was copied from Siren at bb49b7d or from the Siren PHP
 * SDK at 59383e6b, and the comment on each block names the file. When one
 * fails, reconcile against Siren, never by editing the expectation to match
 * the code.
 *
 * Every test compares the whole object, keys and values, so a missing,
 * extra or renamed constant fails it.
 */

function catalogEvents(): string[] {
  const fixture = JSON.parse(
    readFileSync(new URL('./fixtures/webhook-events.json', import.meta.url), 'utf8'),
  ) as { body: Array<{ event: string }> };
  return fixture.body.map((entry) => entry.event);
}

describe('WebhookEventType', () => {
  // Siren lib/Webhooks/Service/Services/WebhookCatalog.php EVENTS, generated
  // into test/fixtures/webhook-events.json by scripts/siren-fixtures.mjs. A
  // unit test in Siren keeps that list equal to the events its dispatchers send.
  it('holds exactly the 64 events Siren delivers, plus "*"', () => {
    const values = Object.values(WebhookEventType).filter((value) => value !== '*');
    expect(values.slice().sort()).toEqual(catalogEvents().sort());
    expect(values).toHaveLength(64);
    expect(WebhookEventType.All).toBe('*');
  });

  it('names each event by its type in PascalCase', () => {
    for (const [key, value] of Object.entries(WebhookEventType)) {
      if (value === '*') continue;
      const expected = value
        .split(/[._]/)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join('');
      expect(key).toBe(expected);
    }
  });

  it('carries the 30 events the SDK lacked before slice 1', () => {
    expect(WebhookEventType).toMatchObject({
      CollaboratorApplied: 'collaborator.applied',
      CollaboratorDeclined: 'collaborator.declined',
      CollaboratorDeleted: 'collaborator.deleted',
      CollaboratorJoined: 'collaborator.joined',
      CollaboratorGroupCreated: 'collaborator_group.created',
      CollaboratorGroupUpdated: 'collaborator_group.updated',
      CollaboratorGroupDeleted: 'collaborator_group.deleted',
      CollaboratorGroupMemberAdded: 'collaborator_group.member_added',
      CollaboratorGroupMemberRemoved: 'collaborator_group.member_removed',
      CouponLinked: 'coupon.linked',
      CouponMerged: 'coupon.merged',
      CouponUnlinked: 'coupon.unlinked',
      DistributorCreated: 'distributor.created',
      DistributorDeleted: 'distributor.deleted',
      DistributorUpdated: 'distributor.updated',
      ObligationApproved: 'obligation.approved',
      ObligationRejected: 'obligation.rejected',
      ObligationSuperseded: 'obligation.superseded',
      PayoutFailed: 'payout.failed',
      PayoutWaiting: 'payout.waiting',
      ProductMerged: 'product.merged',
      ProgramDeleted: 'program.deleted',
      ProgramStatusChanged: 'program.status_changed',
      ProgramUpdated: 'program.updated',
      ProgramGroupCreated: 'program_group.created',
      ProgramGroupUpdated: 'program_group.updated',
      ProgramGroupDeleted: 'program_group.deleted',
      RefundRecorded: 'refund.recorded',
      StoreConnected: 'store.connected',
      StoreDisconnected: 'store.disconnected',
    });
  });
});

describe('ErrorCode', () => {
  // Siren lib/Core/Service/Rest/ApiErrorCode.php, every code it defines.
  it('holds exactly the codes Siren sends', () => {
    expect(ErrorCode).toEqual({
      SiteDisconnected: 'site_disconnected',
      ApiKeyNotAccepted: 'api_key_not_accepted',
      MissingScope: 'missing_scope',
      StoreKeyNotAllowed: 'store_key_not_allowed',
      FieldNotAllowed: 'field_not_allowed',
      PendingStatusRequired: 'pending_status_required',
      UserTypeNotAllowed: 'user_type_not_allowed',
      ProgramNotOnSite: 'program_not_on_site',
      CollaboratorNotOnSite: 'collaborator_not_on_site',
      SiteFilterRequired: 'site_filter_required',
      ReportNotAllowed: 'report_not_allowed',
      NotPermitted: 'not_permitted',
      MigrationClosed: 'migration_closed',
      PlanRequired: 'plan_required',
      AdminRequired: 'admin_required',
      EmailConfirmationRequired: 'email_confirmation_required',
      CodeHeld: 'code_held',
      MappingExists: 'mapping_exists',
      HoldNoCredit: 'hold_no_credit',
      HoldTokenInUse: 'hold_token_in_use',
      HoldCurrencyNotAtStore: 'hold_currency_not_at_store',
      CurrencyResolutionRequired: 'currency_resolution_required',
      InvalidCurrencyResolution: 'invalid_currency_resolution',
      CollaboratorDeletionRefused: 'collaborator_deletion_refused',
      ReservedAddress: 'reserved_address',
      PlanUnavailable: 'plan_unavailable',
    });
  });

  // Siren PHP SDK src/Exception/ErrorCode.php POLICY.
  it('lists the policy refusals as the PHP SDK does', () => {
    expect([...POLICY_ERROR_CODES]).toEqual([
      'field_not_allowed',
      'pending_status_required',
      'user_type_not_allowed',
      'program_not_on_site',
      'collaborator_not_on_site',
      'site_filter_required',
      'report_not_allowed',
      'not_permitted',
    ]);
  });

  // Siren PHP SDK src/Exception/HoldConflictException.php REASON_*.
  it('names the two hold conflict reasons', () => {
    expect(HoldConflictReason).toEqual({ NoCredit: 'no_credit', TokenInUse: 'token_in_use' });
  });
});

describe('status taxonomies', () => {
  // Siren PHP SDK src/*Status.php and src/CustomCurrencyType.php, one class
  // each, holding the values Siren accepts today.
  const cases: Array<[string, object, Record<string, string>]> = [
    [
      'ConversionStatus',
      ConversionStatus,
      { Pending: 'pending', Approved: 'approved', Rejected: 'rejected', Expired: 'expired', Deleted: 'deleted' },
    ],
    ['TransactionStatus', TransactionStatus, { Complete: 'complete', Cancelled: 'cancelled', Refunded: 'refunded' }],
    [
      'ObligationStatus',
      ObligationStatus,
      {
        Draft: 'draft',
        Pending: 'pending',
        Approved: 'approved',
        Rejected: 'rejected',
        Complete: 'complete',
        Deleted: 'deleted',
        Cancelled: 'cancelled',
      },
    ],
    ['PayoutStatus', PayoutStatus, { Unpaid: 'unpaid', Processing: 'processing', Paid: 'paid', Failed: 'failed' }],
    ['OpportunityStatus', OpportunityStatus, { Active: 'active', Inactive: 'inactive', Invalid: 'invalid' }],
    ['ProgramStatus', ProgramStatus, { Active: 'active', Inactive: 'inactive', Deleted: 'deleted' }],
    [
      'CollaboratorStatus',
      CollaboratorStatus,
      { Active: 'active', Inactive: 'inactive', Pending: 'pending', Rejected: 'rejected', Deleted: 'deleted' },
    ],
    ['DistributorStatus', DistributorStatus, { Active: 'active', Inactive: 'inactive', Deleted: 'deleted' }],
    [
      'FulfillmentStatus',
      FulfillmentStatus,
      { Pending: 'pending', Processing: 'processing', Complete: 'complete', Failed: 'failed' },
    ],
    ['ApiKeyStatus', ApiKeyStatus, { Active: 'active', Revoked: 'revoked' }],
    ['WebhookSubscriptionStatus', WebhookSubscriptionStatus, { Active: 'active', Paused: 'paused' }],
    ['CustomCurrencyType', CustomCurrencyType, { Internal: 'internal', Monetary: 'monetary' }],
  ];

  for (const [name, actual, expected] of cases) {
    it(`${name} holds exactly Siren's values`, () => {
      expect(actual).toEqual(expected);
    });
  }
});

describe('event vocabulary', () => {
  // Siren PHP SDK src/EventSlug.php.
  it('EventSlug names the three built-in event routes', () => {
    expect(EventSlug).toEqual({ Sale: 'sale', Refund: 'refund', SiteVisited: 'site-visited' });
  });

  it('each built-in event scope names its EventSlug', () => {
    expect(ApiKeyScope.Sale).toBe(`event:${EventSlug.Sale}`);
    expect(ApiKeyScope.Refund).toBe(`event:${EventSlug.Refund}`);
    expect(ApiKeyScope.SiteVisited).toBe(`event:${EventSlug.SiteVisited}`);
  });

  // Siren lib/Commerce/Models/RefundDetails.php KINDS, which
  // RefundEventFactory validates `kind` against.
  it('RefundKind holds the kinds a refund may send', () => {
    expect(RefundKind).toEqual({ Refund: 'refund', Cancelled: 'cancelled', Voided: 'voided' });
  });

  // Siren lib/Conversions/Core/Interfaces/SaleIngestion.php STATUS_* and
  // lib/Events/Core/Factories/SiteVisitedFactory.php STATUS_*.
  it('EventStatus holds every status a sale or a visit answers with', () => {
    expect(EventStatus).toEqual({
      Created: 'created',
      Recorded: 'recorded',
      Duplicate: 'duplicate',
      Unattributed: 'unattributed',
      Ignored: 'ignored',
      Attributed: 'attributed',
      NotAttributed: 'not_attributed',
      Queued: 'queued',
      Checked: 'checked',
    });
  });

  // The REASON_* constants in the same two Siren files.
  it('EventReason holds every reason a sale or a visit gives', () => {
    expect(EventReason).toEqual({
      NoOpportunity: 'no_opportunity',
      UnknownTrackingId: 'unknown_tracking_id',
      NoProgram: 'no_program',
      NoEngagement: 'no_engagement',
      EngagementUsed: 'engagement_used',
      EngagementEnded: 'engagement_ended',
      NotAwarded: 'not_awarded',
      CollaboratorNotFound: 'collaborator_not_found',
      CollaboratorNotActive: 'collaborator_not_active',
      SiteCheckNotFound: 'site_check_not_found',
    });
  });
});

describe('record vocabulary', () => {
  // Slice 3. Siren Cloud at b6f7140: the IsAny list in
  // lib/Collaborators/Rest/Service/CollaboratorBulkAction.php line 261. The
  // PHP SDK's Collaborators::BULK_* constants (src/Resources/Collaborators.php
  // lines 20 to 29) lack `reject`, which Cloud accepts, so the SDK follows Cloud.
  it('CollaboratorBulkAction holds every action Siren runs on collaborators', () => {
    expect(CollaboratorBulkAction).toEqual({
      Activate: 'activate',
      Reject: 'reject',
      Deactivate: 'deactivate',
      Restore: 'restore',
      Delete: 'delete',
      PermanentDelete: 'permanent_delete',
      AddToProgram: 'addToProgram',
      RemoveFromProgram: 'removeFromProgram',
      AddToDistributor: 'addToDistributor',
      RemoveFromDistributor: 'removeFromDistributor',
      SendSignupEmail: 'sendSignupEmail',
    });
  });

  // The PHP SDK's CollaboratorAliases::TYPE_* constants
  // (src/Resources/CollaboratorAliases.php lines 36 and 37), and the
  // generateUniqueAlias('tracking') call in Cloud's
  // lib/Collaborators/Rest/Service/GenerateReferralCode.php line 73.
  it('CollaboratorAliasType holds the plain code types', () => {
    expect(CollaboratorAliasType).toEqual({ Tracking: 'tracking', Coupon: 'coupon' });
  });

  // Cloud's IsAny list in lib/Programs/Rest/Service/ProgramBulkAction.php
  // line 200, and the PHP SDK's Programs::BULK_* constants
  // (src/Resources/Programs.php lines 16 to 20).
  it('ProgramBulkAction holds every action Siren runs on programs', () => {
    expect(ProgramBulkAction).toEqual({
      Activate: 'activate',
      Deactivate: 'deactivate',
      Restore: 'restore',
      Delete: 'delete',
      PermanentDelete: 'permanent_delete',
    });
  });

  // Cloud's IsOneOf list in lib/ProgramGroups/Rest/Service/UpdateProgramGroup.php
  // line 257, and the PHP SDK's src/ProgramGroupSorter.php lines 14 and 17.
  it('ProgramGroupSorter holds the two sorters a program group takes', () => {
    expect(ProgramGroupSorter).toEqual({
      OldestBindingWins: 'oldestBindingWins',
      NewestBindingWins: 'newestBindingWins',
    });
  });

  // Cloud's IsAny list in lib/ProgramGroups/Rest/Service/ProgramGroupBulkAction.php
  // line 163, and the PHP SDK's ProgramGroups::BULK_DELETE
  // (src/Resources/ProgramGroups.php line 16).
  it('ProgramGroupBulkAction holds the one action Siren runs on program groups', () => {
    expect(ProgramGroupBulkAction).toEqual({ Delete: 'delete' });
  });
});
