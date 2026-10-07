-- CP1 audit (e-reports MAJOR) — make share_token_views' and share_tokens.theme_id's foreign keys
-- tenant-consistent. Postgres evaluates FK checks without RLS, so the single-column FK from 0004
-- accepted another tenant's share_token_id (an existence oracle) and let that tenant's deletion of
-- its token cascade into this one's view history. ShareTokensService.consumeView is the first
-- runtime writer of share_token_views, so the database must hold the line, not only the service.
-- Composite (workspace_id, id) FKs bind every reference to the row's own tenant; 0079 is the
-- precedent. brand_themes gets the same unique key for share_tokens.theme_id, which today only the
-- service-level foreign-theme check guards.
-- Every existing row was written under a tenant context for its own workspace, so none can violate
-- the new constraints.

ALTER TABLE share_tokens  ADD CONSTRAINT share_tokens_workspace_id_id_key  UNIQUE (workspace_id, id);
ALTER TABLE brand_themes  ADD CONSTRAINT brand_themes_workspace_id_id_key  UNIQUE (workspace_id, id);

ALTER TABLE share_token_views DROP CONSTRAINT share_token_views_share_token_id_fkey;
ALTER TABLE share_token_views
  ADD CONSTRAINT share_token_views_token_fkey
    FOREIGN KEY (workspace_id, share_token_id)
    REFERENCES share_tokens (workspace_id, id) ON DELETE CASCADE;

ALTER TABLE share_tokens DROP CONSTRAINT share_tokens_theme_id_fkey;
-- SET NULL on the theme column only: workspace_id is NOT NULL and must survive.
ALTER TABLE share_tokens
  ADD CONSTRAINT share_tokens_theme_fkey
    FOREIGN KEY (workspace_id, theme_id)
    REFERENCES brand_themes (workspace_id, id) ON DELETE SET NULL (theme_id);
