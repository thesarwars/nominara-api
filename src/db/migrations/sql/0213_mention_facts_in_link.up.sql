-- STORY-036 AC5 - a mention inside a URL, a code span or a link target is recorded with in_link = true and excluded from prominence.
--
-- The matcher has always returned the flag and the prominence formula has always honoured it; what was missing was somewhere to keep it, so
-- the result document hard-coded in_link: false. It is NOT folded into render_form: 'linked' there means "rendered as a link", a different
-- fact from "the brand appears only inside a citation URL".
--
-- Expand only. A constant default is a catalog change, not a rewrite, on the partitioned parent and every partition. Rows written before this
-- migration read false: that is what the document already said for them, and a re-parse writes the real value.
ALTER TABLE mention_facts ADD COLUMN in_link boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN mention_facts.in_link IS
  'STORY-036 - the occurrence sits inside a URL, a code span or a link target. Recorded, excluded from prominence; a citation rather than a mention.';
