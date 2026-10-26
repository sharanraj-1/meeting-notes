-- Meetings and their transcripts.
-- The desktop app talks to Supabase from its main process with the secret
-- (service role) key, so RLS is on with no policies: the public/anon key can
-- read nothing, and only the app's trusted process can read or write.

create table public.meetings (
  id             uuid primary key default gen_random_uuid(),
  title          text not null default 'Untitled meeting',
  source_app     text,                       -- e.g. "Zoom", "Microsoft Teams"
  started_at     timestamptz not null default now(),
  ended_at       timestamptz,
  user_notes     text not null default '',   -- what you typed during the call
  enhanced_notes text,                       -- Claude's write-up
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table public.transcript_segments (
  id          bigint generated always as identity primary key,
  meeting_id  uuid not null references public.meetings (id) on delete cascade,
  channel     smallint not null check (channel in (0, 1)), -- 0 = your mic, 1 = computer audio
  speaker     text not null,                               -- "You", "Them", "Speaker 2", ...
  text        text not null,
  start_sec   real not null,
  end_sec     real not null,
  created_at  timestamptz not null default now()
);

create index transcript_segments_meeting_idx
  on public.transcript_segments (meeting_id, start_sec);

create index meetings_started_idx on public.meetings (started_at desc);

-- Full-text search across titles, notes and transcripts.
create index meetings_search_idx on public.meetings
  using gin (to_tsvector('english', title || ' ' || user_notes || ' ' || coalesce(enhanced_notes, '')));
create index transcript_search_idx on public.transcript_segments
  using gin (to_tsvector('english', text));

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger meetings_touch before update on public.meetings
  for each row execute function public.touch_updated_at();

-- Search helper the app calls with supabase.rpc('search_meetings', { q }).
create or replace function public.search_meetings(q text)
returns setof public.meetings
language sql stable as $$
  select distinct m.*
  from public.meetings m
  left join public.transcript_segments s on s.meeting_id = m.id
  where to_tsvector('english', m.title || ' ' || m.user_notes || ' ' || coalesce(m.enhanced_notes, ''))
          @@ websearch_to_tsquery('english', q)
     or to_tsvector('english', s.text) @@ websearch_to_tsquery('english', q)
  order by m.started_at desc
  limit 50;
$$;

alter table public.meetings enable row level security;
alter table public.transcript_segments enable row level security;
revoke execute on function public.search_meetings(text) from anon, authenticated;
