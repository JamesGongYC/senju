-- Senju: accounts, teams, memory and history.
-- Run once in the Supabase SQL editor (or `supabase db push`).
-- Sign-up itself is Supabase Auth; this adds what hangs off a user.

create extension if not exists pgcrypto;

-- ---- People and teams ---------------------------------------------------------------------

create table if not exists profiles (
  id uuid primary key references auth.users on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

-- A profile is created for every new account, named from the sign-up form.
create or replace function handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, name)
  values (new.id, coalesce(nullif(trim(new.raw_user_meta_data->>'name'), ''), split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function handle_new_user();

create table if not exists teams (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  invite_code text unique not null default encode(gen_random_bytes(6), 'hex'),
  created_by uuid references profiles,
  created_at timestamptz not null default now()
);

create table if not exists team_members (
  team_id uuid not null references teams on delete cascade,
  user_id uuid not null references profiles on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (team_id, user_id)
);

create table if not exists devices (
  id text primary key,
  user_id uuid not null references profiles on delete cascade,
  team_id uuid not null references teams on delete cascade,
  name text not null,
  platform text,
  last_seen timestamptz not null default now()
);

-- Each person's own model API key, encrypted by the server before it is stored.
-- Row level security is on with no policies: only the server (service role) can touch it.
create table if not exists user_secrets (
  user_id uuid primary key references profiles on delete cascade,
  anthropic_key_enc text not null,
  updated_at timestamptz not null default now()
);

-- ---- Sessions and chat --------------------------------------------------------------------

create table if not exists sessions (
  id uuid primary key,
  team_id uuid not null references teams on delete cascade,
  owner_id uuid not null references profiles,          -- whose key paid, who may stop it
  goal text not null,
  status text not null default 'running',
  summary text,
  usage jsonb,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);

create table if not exists messages (
  id bigint generated always as identity primary key,
  session_id uuid not null references sessions on delete cascade,
  author_id uuid not null references profiles,
  target text not null default 'lead',
  text text not null,
  created_at timestamptz not null default now()
);

-- ---- Memory ---------------------------------------------------------------------------------
-- kind 'note':  a lasting preference or fact. scope 'user' is about one person and visible
--               only to them; scope 'team' is for the whole team.
-- kind 'skill': a how-to written by the lead after a session. Always team scope.
-- author_id is the single person the entry is attributed to: whoever stated the note, or the
-- owner of the session that produced the skill.

create table if not exists memories (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('note', 'skill')),
  scope text not null check (scope in ('user', 'team')),
  team_id uuid not null references teams on delete cascade,
  subject_id uuid references profiles on delete cascade,
  author_id uuid not null references profiles,
  session_id uuid references sessions on delete set null,
  name text,
  description text,
  body text not null,
  revision int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (kind <> 'skill' or (scope = 'team' and name is not null)),
  check (scope <> 'user' or subject_id is not null)
);
create unique index if not exists memories_skill_name on memories (team_id, name) where kind = 'skill';
create index if not exists memories_lookup on memories (team_id, scope, subject_id);

-- Every earlier version of a skill, with who it was attributed to.
create table if not exists memory_revisions (
  id bigint generated always as identity primary key,
  memory_id bigint not null references memories on delete cascade,
  revision int not null,
  author_id uuid not null references profiles,
  description text,
  body text not null,
  created_at timestamptz not null default now()
);

-- ---- Access rules -----------------------------------------------------------------------------

create or replace function is_team_member(t uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from team_members where team_id = t and user_id = auth.uid());
$$;

alter table profiles enable row level security;
alter table teams enable row level security;
alter table team_members enable row level security;
alter table devices enable row level security;
alter table user_secrets enable row level security;
alter table sessions enable row level security;
alter table messages enable row level security;
alter table memories enable row level security;
alter table memory_revisions enable row level security;

drop policy if exists profiles_read on profiles;
create policy profiles_read on profiles for select using (
  id = auth.uid() or exists (
    select 1 from team_members mine join team_members theirs on theirs.team_id = mine.team_id
    where mine.user_id = auth.uid() and theirs.user_id = profiles.id));
drop policy if exists profiles_update on profiles;
create policy profiles_update on profiles for update using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists teams_read on teams;
create policy teams_read on teams for select using (is_team_member(id));
drop policy if exists members_read on team_members;
create policy members_read on team_members for select using (is_team_member(team_id));
drop policy if exists members_leave on team_members;
create policy members_leave on team_members for delete using (user_id = auth.uid());
drop policy if exists devices_read on devices;
create policy devices_read on devices for select using (is_team_member(team_id));
drop policy if exists sessions_read on sessions;
create policy sessions_read on sessions for select using (is_team_member(team_id));
drop policy if exists messages_read on messages;
create policy messages_read on messages for select using (
  exists (select 1 from sessions s where s.id = messages.session_id and is_team_member(s.team_id)));

-- Team memory is visible to the team. Personal memory is visible only to the person it is about.
drop policy if exists memories_read on memories;
create policy memories_read on memories for select using (
  (scope = 'team' and is_team_member(team_id)) or (scope = 'user' and subject_id = auth.uid()));
-- You may delete what is remembered about you, and team members may prune team memory.
drop policy if exists memories_delete on memories;
create policy memories_delete on memories for delete using (
  (scope = 'user' and subject_id = auth.uid()) or (scope = 'team' and is_team_member(team_id)));
drop policy if exists revisions_read on memory_revisions;
create policy revisions_read on memory_revisions for select using (
  exists (select 1 from memories m where m.id = memory_revisions.memory_id and m.scope = 'team' and is_team_member(m.team_id)));

-- ---- Things the web app calls -------------------------------------------------------------------

create or replace function create_team(team_name text) returns uuid language plpgsql security definer set search_path = public as $$
declare t uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if length(trim(team_name)) = 0 then raise exception 'Give the team a name'; end if;
  insert into teams (name, created_by) values (trim(team_name), auth.uid()) returning id into t;
  insert into team_members (team_id, user_id, role) values (t, auth.uid(), 'owner');
  return t;
end $$;

create or replace function join_team(code text) returns uuid language plpgsql security definer set search_path = public as $$
declare t uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  select id into t from teams where invite_code = lower(trim(code));
  if t is null then raise exception 'No team has that invite code'; end if;
  insert into team_members (team_id, user_id) values (t, auth.uid()) on conflict do nothing;
  return t;
end $$;

create or replace function has_api_key() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from user_secrets where user_id = auth.uid());
$$;

grant execute on function create_team(text), join_team(text), has_api_key(), is_team_member(uuid) to authenticated;
