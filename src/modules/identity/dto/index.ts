// DTOs are z.infer<> re-exports of contracts/ schemas (coding-standards.md
// §2) — never hand-written. STORY-014 fills this in for the first time.
export {
  registrationOptionsRequestSchema,
  type RegistrationOptionsRequest,
} from "../../../../contracts/identity/registration-options-request.schema.js";
export {
  assertionOptionsRequestSchema,
  type AssertionOptionsRequest,
} from "../../../../contracts/identity/assertion-options-request.schema.js";
export {
  passkeyOptionsRequestSchema,
  type PasskeyOptionsRequest,
} from "../../../../contracts/identity/passkey-options-request.schema.js";
export {
  registrationVerifyRequestSchema,
  type RegistrationVerifyRequest,
} from "../../../../contracts/identity/registration-verify-request.schema.js";
export {
  assertionVerifyRequestSchema,
  type AssertionVerifyRequest,
} from "../../../../contracts/identity/assertion-verify-request.schema.js";
export {
  passkeyVerifyRequestSchema,
  type PasskeyVerifyRequest,
} from "../../../../contracts/identity/passkey-verify-request.schema.js";
export {
  passkeyRenameRequestSchema,
  type PasskeyRenameRequest,
} from "../../../../contracts/identity/passkey-rename-request.schema.js";
export {
  passkeyListItemSchema,
  passkeyListResponseSchema,
  type PasskeyListItem,
  type PasskeyListResponse,
} from "../../../../contracts/identity/passkey-list-response.schema.js";
export {
  accessTokenClaimsSchema,
  type AccessTokenClaims,
} from "../../../../contracts/identity/access-token-claims.schema.js";
export {
  oauthProviderSchema,
  type OauthProvider,
} from "../../../../contracts/identity/oauth-provider.schema.js";
export {
  oauthStartResponseSchema,
  type OauthStartResponse,
} from "../../../../contracts/identity/oauth-start-response.schema.js";
export {
  oauthCallbackQuerySchema,
  type OauthCallbackQuery,
} from "../../../../contracts/identity/oauth-callback-query.schema.js";
export {
  oauthCallbackResponseSchema,
  type OauthCallbackResponse,
} from "../../../../contracts/identity/oauth-callback-response.schema.js";
export {
  emailOtpRequestSchema,
  type EmailOtpRequest,
} from "../../../../contracts/identity/email-otp-request.schema.js";
export {
  emailOtpVerifyRequestSchema,
  type EmailOtpVerifyRequest,
} from "../../../../contracts/identity/email-otp-verify-request.schema.js";
export {
  emailOtpRequestResponseSchema,
  type EmailOtpRequestResponse,
} from "../../../../contracts/identity/email-otp-request-response.schema.js";
