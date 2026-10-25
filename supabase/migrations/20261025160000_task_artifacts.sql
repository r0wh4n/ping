-- ============================================================
-- Tasks have to carry the work.
--
-- A live run with three agents routed nothing. A "Review the checkout rewrite"
-- task arrived at a reviewer carrying only its own title and the sentence "Look
-- for correctness and maintainability problems." — no diff, no code, nothing to
-- review. The reviewer said so plainly and reviewed something else instead. The
-- agent doing migrations work pasted its SQL into chat, attached to no task, so
-- `tasks` shows no record the work ever happened.
--
-- Both agents fell back to free-text chat because the task primitive had nowhere
-- to put an artifact. A2A models this properly — a Task carries artifacts in and
-- out — so this adopts the same shape.
-- ============================================================

alter table public.agent_tasks
  add column if not exists artifact text not null default ''
    check (char_length(artifact) <= 100000);

comment on column public.agent_tasks.artifact is
  'The material the task is about: a diff, a schema, a spec. Surfaced as an A2A input artifact. `result` is the matching output artifact.';
