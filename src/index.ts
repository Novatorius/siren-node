export { Siren } from './client';
export { WebhookEventType } from './event-types';
export { ApiKeyScope, LEDGER_READ_SCOPES, eventScope } from './api-key-scopes';
export {
  ErrorCode,
  SirenError,
  BadRequestError,
  AuthenticationError,
  ApiKeyNotAcceptedError,
  PermissionError,
  MissingScopeError,
  StoreKeyNotAllowedError,
  NotFoundError,
  ConflictError,
  ValidationError,
  RateLimitError,
  ApiError,
  ConnectionError,
  SignatureVerificationError,
} from './errors';
export type { SirenErrorDetails, FailedValidation } from './errors';
export type {
  SirenOptions,
  EventResult,
  LineItem,
  SaleParams,
  RefundParams,
  SiteVisitedParams,
  WebhookEvent,
  WebhookHeaders,
  WebhookSubscription,
  CreatedWebhookSubscription,
  CreateWebhookSubscriptionParams,
  ApiKey,
  CreatedApiKey,
  CreateApiKeyParams,
  ListParams,
  SirenList,
} from './types';
export { EventsResource } from './resources/events';
export { WebhooksResource, WebhookSubscriptionsResource } from './resources/webhooks';
export { ApiKeysResource } from './resources/api-keys';
export { RecordsResource } from './resources/records';

export { Siren as default } from './client';
