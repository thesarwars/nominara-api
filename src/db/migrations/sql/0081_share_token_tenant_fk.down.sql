ALTER TABLE share_tokens DROP CONSTRAINT share_tokens_theme_fkey;
ALTER TABLE share_tokens
  ADD CONSTRAINT share_tokens_theme_id_fkey
    FOREIGN KEY (theme_id) REFERENCES brand_themes (id) ON DELETE SET NULL;

ALTER TABLE share_token_views DROP CONSTRAINT share_token_views_token_fkey;
ALTER TABLE share_token_views
  ADD CONSTRAINT share_token_views_share_token_id_fkey
    FOREIGN KEY (share_token_id) REFERENCES share_tokens (id) ON DELETE CASCADE;

ALTER TABLE brand_themes DROP CONSTRAINT brand_themes_workspace_id_id_key;
ALTER TABLE share_tokens DROP CONSTRAINT share_tokens_workspace_id_id_key;
