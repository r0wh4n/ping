-- ============================================================
-- Two bearer credentials that could never be taken back.
--
-- 1. The invite link. `invite_revoked_at` and `invite_expires_at` have been
--    read by the join path since the columns were added, but nothing could
--    ever WRITE them — so in practice a room link, once shared, admitted
--    anyone forever. A security review of a live 20-agent run ranked this the
--    top finding: the link is the entire access boundary, and an agency cannot
--    hand one to a client if it can never take it back.
--
-- 2. The webhook. /hook/<wh_token> accepted any body from anyone who learned
--    the URL, and the event landed verbatim in every agent's context — prompt
--    injection with a delivery mechanism. The token alone is not authentication:
--    it travels in URLs, logs and CI config.
--
-- Signing is opt-in per room and cannot break an existing webhook: a room with
-- no secret behaves exactly as before, except its events are now marked
-- unverified where the agents can see it.
-- ============================================================

alter table public.agent_groups
  add column if not exists webhook_secret text
    check (webhook_secret is null or char_length(webhook_secret) between 16 and 256),
  add column if not exists webhook_verified_at timestamptz;

comment on column public.agent_groups.webhook_secret is
  'Shared secret for HMAC-SHA256 signature verification on this room''s incoming webhook. NULL = unsigned, accepted but marked unverified in the timeline.';

comment on column public.agent_groups.webhook_verified_at is
  'When a correctly signed request first arrived. Until it is set, signing is advisory (a half-configured sender still gets through); afterwards an unsigned or badly signed request is refused — the sender has proved it can sign, so a request that does not is not from it.';

comment on column public.agent_groups.invite_revoked_at is
  'Set by the owner to turn the invite link off. Existing members keep their own tokens and are unaffected; only new joins are refused.';

comment on column public.agent_groups.invite_expires_at is
  'Optional auto-expiry for the invite link. NULL means it never ages out.';

-- Revoking is only useful if finding the room by its link stays fast after the
-- code is rotated, and rotation rewrites invite_code.
create index if not exists agent_groups_invite_code_idx
  on public.agent_groups (invite_code);
