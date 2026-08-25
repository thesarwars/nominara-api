// DTOs are z.infer<> re-exports of contracts/ schemas (coding-standards.md
// §2) — never hand-written. STORY-021 fills this in for the first time.
export {
  createWorkspaceRequestSchema,
  type CreateWorkspaceRequest,
} from "../../../../contracts/workspaces/create-workspace-request.schema.js";
export {
  updateWorkspaceRequestSchema,
  type UpdateWorkspaceRequest,
} from "../../../../contracts/workspaces/update-workspace-request.schema.js";
export {
  workspaceResponseSchema,
  type WorkspaceResponse,
} from "../../../../contracts/workspaces/workspace-response.schema.js";
export {
  workspaceListItemSchema,
  workspaceListItemWithRelationshipSchema,
  workspaceListResponseSchema,
  type WorkspaceListItem,
  type WorkspaceListItemWithRelationship,
  type WorkspaceListResponse,
} from "../../../../contracts/workspaces/workspace-list-response.schema.js";
export {
  memberResponseSchema,
  type MemberResponse,
} from "../../../../contracts/workspaces/member-response.schema.js";
export {
  updateMemberRoleRequestSchema,
  type UpdateMemberRoleRequest,
} from "../../../../contracts/workspaces/update-member-role-request.schema.js";
export {
  createInvitationRequestSchema,
  type CreateInvitationRequest,
} from "../../../../contracts/workspaces/create-invitation-request.schema.js";
export {
  invitationResponseSchema,
  type InvitationResponse,
} from "../../../../contracts/workspaces/invitation-response.schema.js";
export {
  acceptInvitationRequestSchema,
  type AcceptInvitationRequest,
} from "../../../../contracts/workspaces/accept-invitation-request.schema.js";
