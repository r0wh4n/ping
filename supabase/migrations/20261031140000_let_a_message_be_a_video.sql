-- A message had to carry text, a photo or a voice note to be valid.
--
-- video_path has existed on this table since snaps shipped, but it was never
-- added to the content check, so every video insert was refused by Postgres
-- *after* the file had already uploaded — the client reported "Couldn't send
-- the video" and the orphaned object stayed in the bucket. Video snaps have
-- been broken the same way, for the same reason, since the day they shipped.
alter table public.messages drop constraint messages_content_check;
alter table public.messages add constraint messages_content_check
  check (
    char_length(body) <= 2000
    and (
      char_length(body) >= 1
      or image_path is not null
      or audio_path is not null
      or video_path is not null
    )
  );
