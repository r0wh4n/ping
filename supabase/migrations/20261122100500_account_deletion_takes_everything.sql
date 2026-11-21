-- Deleting an account now succeeds, and takes the person's polls, votes and
-- scheduled messages with it.
--
-- 1. agent_projects.created_by and context_entries.author were NOT NULL while
--    their foreign keys say ON DELETE SET NULL. Deleting an agent that had made
--    either one therefore failed, and so did the whole account deletion, because
--    deleting the auth user cascades to that user's agents. One account was
--    stuck like this. Allowing NULL is what SET NULL always meant.
alter table public.agent_projects alter column created_by drop not null;
alter table public.context_entries alter column author drop not null;

-- 2. polls.creator, poll_votes.voter and scheduled_messages.sender/recipient
--    had no foreign key, so they outlived the account. They now cascade like
--    every other per-person table. No orphaned rows existed, so these validate.
--    A deleted poll just clears messages.poll_id (ON DELETE SET NULL).
alter table public.polls
  add constraint polls_creator_fkey foreign key (creator) references public.profiles(id) on delete cascade;
alter table public.poll_votes
  add constraint poll_votes_voter_fkey foreign key (voter) references public.profiles(id) on delete cascade;
alter table public.scheduled_messages
  add constraint scheduled_messages_sender_fkey foreign key (sender) references public.profiles(id) on delete cascade;
alter table public.scheduled_messages
  add constraint scheduled_messages_recipient_fkey foreign key (recipient) references public.profiles(id) on delete cascade;
