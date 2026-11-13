export { Siren } from './client';
export { WebhookEventType } from './event-types';
export { ApiKeyScope, LEDGER_READ_SCOPES, eventScope } from './api-key-scopes';
export { ConnectorScope } from './auth/connector-scope';
export type { AccessTokenSource } from './auth/access-token-source';
export { StaticAccessToken } from './auth/static-access-token';
export { CallbackAccessTokenSource } from './auth/callback-access-token-source';
export { FetchHttpClient, HttpClientError } from './http';
export type { HttpClient, HttpRequest, HttpResponse, HttpMethod } from './http';
export {
  EventSlug,
  RefundKind,
  EventStatus,
  EventReason,
  ConversionStatus,
  TransactionStatus,
  ObligationStatus,
  PayoutStatus,
  OpportunityStatus,
  ProgramStatus,
  CollaboratorStatus,
  DistributorStatus,
  FulfillmentStatus,
  ApiKeyStatus,
  WebhookSubscriptionStatus,
  CustomCurrencyType,
} from './taxonomy';
export {
  ErrorCode,
  POLICY_ERROR_CODES,
  isKnownErrorCode,
  HoldConflictReason,
  SirenError,
  BadRequestError,
  AuthenticationError,
  ApiKeyNotAcceptedError,
  SiteDisconnectedError,
  PermissionError,
  MissingScopeError,
  StoreKeyNotAllowedError,
  PolicyError,
  NotFoundError,
  ConflictError,
  CodeConflictError,
  HoldConflictError,
  ValidationError,
  RateLimitError,
  ApiError,
  UnexpectedResponseError,
  ConnectionError,
  SignatureVerificationError,
} from './errors';
export type { SirenErrorDetails, FailedValidation } from './errors';
export type {
  SirenOptions,
  SirenBaseOptions,
  SirenApiKeyOptions,
  SirenAccessTokenOptions,
  EventResult,
  LineItem,
  SaleFields,
  LiveSaleParams,
  TestSaleParams,
  SaleParams,
  RefundLine,
  RefundParams,
  TrackingCodeReference,
  SiteVisitedParams,
  WebhookEvent,
  WebhookHeaders,
  WebhookSubscription,
  CreatedWebhookSubscription,
  CreateWebhookSubscriptionParams,
  WebhookCatalogEntry,
  ApiKey,
  ApiKeyScopeEntry,
  ApiKeyScopeGroups,
  CreatedApiKey,
  CreateApiKeyParams,
  ListParams,
  SirenList,
} from './types';
export { ForwardedEventSlug, FORWARDED_EVENT_VERSION } from './connect/forwarded-events';
export type * from './connect/forwarded-events';
export { EventsResource } from './resources/events';
export { WebhooksResource, WebhookSubscriptionsResource } from './resources/webhooks';
export { ApiKeysResource } from './resources/api-keys';
export { RecordsResource, ConversionsResource, TransactionsResource } from './resources/records';
export type { RetrieveParams } from './resources/records';

// Slice 3 adds these in their own block so it merges cleanly with slice 5.
export {
  CollaboratorBulkAction,
  CollaboratorAliasType,
  ProgramBulkAction,
  ProgramGroupSorter,
  ProgramGroupBulkAction,
} from './taxonomy';
export { PropertyQualifier } from './property-qualifier';
export {
  CollaboratorsResource,
  COLLABORATOR_BINDING_FIELDS,
  SITE_CREATABLE_COLLABORATOR_FIELDS,
  SITE_UPDATABLE_COLLABORATOR_FIELDS,
} from './resources/collaborators';
export { CollaboratorAliasesResource } from './resources/collaborator-aliases';
export { ProgramEnrollmentsResource } from './resources/program-enrollments';
export { CollaboratorGroupsResource } from './resources/collaborator-groups';
export { CollaboratorGroupMembersResource } from './resources/collaborator-group-members';
export { ProgramsResource } from './resources/programs';
export { ProgramGroupsResource } from './resources/program-groups';
export { MAX_BULK_IDS } from './resources/record-requests';
export type * from './record-types';
// Slice 4 adds these in their own block so it merges cleanly with slice 5.
export {
  ConversionBulkAction,
  TransactionBulkAction,
  DistributorBulkAction,
  CreditHoldStatus,
} from './taxonomy';
export { OpportunitiesResource } from './resources/opportunities';
export { EngagementsResource } from './resources/engagements';
export { DistributorsResource } from './resources/distributors';
export { CustomCurrenciesResource } from './resources/custom-currencies';
export { CreditsResource } from './resources/credits';
export { MappingsResource } from './resources/mappings';
export { SettingsResource } from './resources/settings';

export { Siren as default } from './client';
