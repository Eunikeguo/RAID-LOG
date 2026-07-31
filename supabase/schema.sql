-- ============================================================
--  RAID Log — complete schema, RLS and triggers
--  Idempotent: safe to run repeatedly. Paste into the Supabase
--  SQL editor, or run with `supabase db push`.
-- ============================================================

create extension if not exists "pgcrypto";

-- ------------------------------------------------------------
--  1. ENUMS
-- ------------------------------------------------------------
do $$ begin
  create type plan_t            as enum ('free','paid');
  exception when duplicate_object then null; end $$;
do $$ begin
  create type sub_status_t      as enum ('active','past_due','canceled');
  exception when duplicate_object then null; end $$;
do $$ begin
  create type ws_role_t         as enum ('admin','user');
  exception when duplicate_object then null; end $$;
do $$ begin
  create type member_state_t    as enum ('invited','active');
  exception when duplicate_object then null; end $$;
do $$ begin
  create type project_role_t    as enum ('admin','member');
  exception when duplicate_object then null; end $$;
do $$ begin
  create type raid_type_t       as enum ('risk','action','issue','dependency','decision');
  exception when duplicate_object then null; end $$;
do $$ begin
  create type priority_t        as enum ('critical','high','medium','low');
  exception when duplicate_object then null; end $$;
do $$ begin
  create type status_t          as enum ('open','in_progress','resolved','closed');
  exception when duplicate_object then null; end $$;
do $$ begin
  create type notification_t    as enum ('assigned','mention');
  exception when duplicate_object then null; end $$;

-- ------------------------------------------------------------
--  2. TABLES
-- ------------------------------------------------------------
create table if not exists workspaces (
  id                     uuid primary key default gen_random_uuid(),
  name                   text not null check (length(trim(name)) > 0),
  plan                   plan_t not null default 'free',
  has_expansion_addon    boolean not null default false,
  stripe_customer_id     text,
  stripe_subscription_id text,
  subscription_status    sub_status_t not null default 'active',
  created_at             timestamptz not null default now()
);

create table if not exists workspace_members (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id      uuid references auth.users(id) on delete set null,
  email        text not null,
  name         text not null,
  role         ws_role_t not null default 'user',
  state        member_state_t not null default 'invited',
  invited_at   timestamptz not null default now(),
  unique (workspace_id, email)
);
-- one workspace per person, for MVP (§7 out of scope: multiple workspaces)
create unique index if not exists workspace_members_user_uniq
  on workspace_members(user_id) where user_id is not null;

create table if not exists projects (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name         text not null check (length(trim(name)) > 0),
  created_at   timestamptz not null default now()
);
-- expression uniqueness has to be an index, not a table constraint
create unique index if not exists projects_ws_name_uniq
  on projects(workspace_id, lower(name));

create table if not exists project_members (
  id                  uuid primary key default gen_random_uuid(),
  project_id          uuid not null references projects(id) on delete cascade,
  workspace_member_id uuid not null references workspace_members(id) on delete cascade,
  project_role        project_role_t not null default 'member',
  assigned_at         timestamptz not null default now(),
  assigned_by         uuid references workspace_members(id) on delete set null,
  unique (project_id, workspace_member_id)
);

create table if not exists raid_items (
  id                    uuid primary key default gen_random_uuid(),
  workspace_id          uuid not null references workspaces(id) on delete cascade,
  project_id            uuid not null references projects(id) on delete cascade,
  ref                   text not null,                       -- RAID-021
  type                  raid_type_t not null,
  priority              priority_t not null,
  status                status_t not null default 'open',
  title                 text not null check (length(trim(title)) > 0),
  description           text not null default '',
  impact                text not null default '',
  next_step             text not null default '',
  final_resolution      text not null default '',
  owner_id              uuid references workspace_members(id) on delete set null,
  due_date              date not null,
  last_reminder_sent_at timestamptz,
  snoozed_until         date,
  created_by            uuid references workspace_members(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_by            uuid references workspace_members(id) on delete set null,
  updated_at            timestamptz not null default now(),
  unique (workspace_id, ref)
);

create table if not exists raid_item_comments (
  id           uuid primary key default gen_random_uuid(),
  raid_item_id uuid not null references raid_items(id) on delete cascade,
  author_id    uuid references workspace_members(id) on delete set null,
  comment_text text not null check (length(trim(comment_text)) > 0),
  created_at   timestamptz not null default now()
);

create table if not exists notifications (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  recipient_id  uuid not null references workspace_members(id) on delete cascade,
  actor_id      uuid references workspace_members(id) on delete set null,
  raid_item_id  uuid references raid_items(id) on delete cascade,
  type          notification_t not null,
  snippet       text,
  read          boolean not null default false,
  created_at    timestamptz not null default now()
);

create index if not exists idx_ws_members_ws      on workspace_members(workspace_id);
create index if not exists idx_ws_members_email   on workspace_members(lower(email));
create index if not exists idx_projects_ws        on projects(workspace_id);
create index if not exists idx_proj_members_proj  on project_members(project_id);
create index if not exists idx_proj_members_wm    on project_members(workspace_member_id);
create index if not exists idx_items_ws           on raid_items(workspace_id);
create index if not exists idx_items_project      on raid_items(project_id);
create index if not exists idx_items_owner        on raid_items(owner_id);
create index if not exists idx_items_updated      on raid_items(workspace_id, updated_at desc);
create index if not exists idx_comments_item      on raid_item_comments(raid_item_id);
create index if not exists idx_notifs_recipient   on notifications(recipient_id, read, created_at desc);

-- ------------------------------------------------------------
--  3. SECURITY DEFINER HELPERS
--  These bypass RLS so membership policies never recurse.
--  search_path is pinned to defeat search_path hijacking.
-- ------------------------------------------------------------
create or replace function my_member_id()
returns uuid language sql security definer stable set search_path = public as $$
  select id from workspace_members
  where user_id = auth.uid() and state = 'active'
  limit 1;
$$;

create or replace function my_workspace_id()
returns uuid language sql security definer stable set search_path = public as $$
  select workspace_id from workspace_members
  where user_id = auth.uid() and state = 'active'
  limit 1;
$$;

create or replace function is_workspace_member(ws uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from workspace_members
    where workspace_id = ws and user_id = auth.uid() and state = 'active'
  );
$$;

create or replace function is_workspace_admin(ws uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from workspace_members
    where workspace_id = ws and user_id = auth.uid()
      and state = 'active' and role = 'admin'
  );
$$;

-- Workspace admins act as project admin everywhere (§2.2)
create or replace function is_project_member(proj uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1
    from projects p
    join workspace_members wm on wm.workspace_id = p.workspace_id
    where p.id = proj and wm.user_id = auth.uid() and wm.state = 'active'
      and (wm.role = 'admin'
           or exists (select 1 from project_members pm
                      where pm.project_id = p.id and pm.workspace_member_id = wm.id))
  );
$$;

create or replace function is_project_admin(proj uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1
    from projects p
    join workspace_members wm on wm.workspace_id = p.workspace_id
    where p.id = proj and wm.user_id = auth.uid() and wm.state = 'active'
      and (wm.role = 'admin'
           or exists (select 1 from project_members pm
                      where pm.project_id = p.id and pm.workspace_member_id = wm.id
                        and pm.project_role = 'admin'))
  );
$$;

-- ------------------------------------------------------------
--  4. EFFECTIVE LIMITS  (§3.4: base + add-on)
-- ------------------------------------------------------------
create or replace function effective_limits(ws uuid)
returns table (max_projects int, max_seats int, max_per_project int,
               max_project_admins int, csv_export boolean)
language sql security definer stable set search_path = public as $$
  select
    case when w.plan = 'paid' then 2 else 1 end
      + case when w.plan = 'paid' and w.has_expansion_addon then 1 else 0 end,
    case when w.plan = 'paid' then 20 else 5 end
      + case when w.plan = 'paid' and w.has_expansion_addon then 10 else 0 end,
    case when w.plan = 'paid' then 10 else 5 end,
    case when w.plan = 'paid' then 2 else 1 end,
    (w.plan = 'paid')
  from workspaces w where w.id = ws;
$$;

create or replace function can_export_csv(ws uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select coalesce((select csv_export from effective_limits(ws)), false);
$$;

-- ------------------------------------------------------------
--  5. CAP TRIGGERS  (§3.5: enforce in the DB, not just the UI)
-- ------------------------------------------------------------
create or replace function enforce_project_cap()
returns trigger language plpgsql security definer set search_path = public as $$
declare cap int; used int;
begin
  select max_projects into cap from effective_limits(new.workspace_id);
  select count(*) into used from projects where workspace_id = new.workspace_id;
  if used >= cap then
    raise exception 'PROJECT_LIMIT_REACHED: this plan covers % project(s)', cap
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists trg_project_cap on projects;
create trigger trg_project_cap before insert on projects
  for each row execute function enforce_project_cap();

create or replace function enforce_seat_cap()
returns trigger language plpgsql security definer set search_path = public as $$
declare cap int; used int;
begin
  select max_seats into cap from effective_limits(new.workspace_id);
  select count(*) into used from workspace_members where workspace_id = new.workspace_id;
  if used >= cap then
    raise exception 'SEAT_LIMIT_REACHED: this plan covers % seat(s)', cap
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists trg_seat_cap on workspace_members;
create trigger trg_seat_cap before insert on workspace_members
  for each row execute function enforce_seat_cap();

create or replace function enforce_project_member_caps()
returns trigger language plpgsql security definer set search_path = public as $$
declare ws uuid; per_cap int; admin_cap int; people int; admins int; ws_admins int;
begin
  select workspace_id into ws from projects where id = new.project_id;
  select max_per_project, max_project_admins into per_cap, admin_cap from effective_limits(ws);

  select count(*) into ws_admins from workspace_members
    where workspace_id = ws and role = 'admin';
  select count(*) into people from project_members
    where project_id = new.project_id
      and workspace_member_id <> new.workspace_member_id;

  -- workspace admins are on every project, so they count (§3.4)
  if (people + ws_admins + 1) > per_cap then
    raise exception 'PER_PROJECT_LIMIT_REACHED: no more than % people on one project', per_cap
      using errcode = 'check_violation';
  end if;

  if new.project_role = 'admin' then
    select count(*) into admins from project_members
      where project_id = new.project_id and project_role = 'admin'
        and workspace_member_id <> new.workspace_member_id;
    if (admins + 1) > admin_cap then
      raise exception 'PROJECT_ADMIN_LIMIT_REACHED: no more than % project admin(s)', admin_cap
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_project_member_caps on project_members;
create trigger trg_project_member_caps before insert or update on project_members
  for each row execute function enforce_project_member_caps();

-- A workspace must always keep at least one admin
create or replace function guard_last_admin()
returns trigger language plpgsql security definer set search_path = public as $$
declare remaining int;
begin
  if tg_op = 'UPDATE' and old.role = 'admin' and new.role <> 'admin' then
    select count(*) into remaining from workspace_members
      where workspace_id = old.workspace_id and role = 'admin' and id <> old.id;
    if remaining = 0 then
      raise exception 'LAST_ADMIN: a workspace needs at least one admin'
        using errcode = 'check_violation';
    end if;
  end if;
  if tg_op = 'DELETE' and old.role = 'admin' then
    select count(*) into remaining from workspace_members
      where workspace_id = old.workspace_id and role = 'admin' and id <> old.id;
    if remaining = 0 then
      raise exception 'LAST_ADMIN: a workspace needs at least one admin'
        using errcode = 'check_violation';
    end if;
  end if;
  return coalesce(new, old);
end $$;

drop trigger if exists trg_last_admin on workspace_members;
create trigger trg_last_admin before update or delete on workspace_members
  for each row execute function guard_last_admin();

-- ------------------------------------------------------------
--  6. AUTO-STAMPS
-- ------------------------------------------------------------
create or replace function stamp_updated()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  new.updated_by := coalesce(my_member_id(), new.updated_by);
  return new;
end $$;

drop trigger if exists trg_items_updated on raid_items;
create trigger trg_items_updated before update on raid_items
  for each row execute function stamp_updated();

-- Sequential per-workspace reference: RAID-001, RAID-002 …
create or replace function assign_item_ref()
returns trigger language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if new.ref is null or new.ref = '' then
    select coalesce(max(substring(ref from 6)::int), 0) + 1 into n
      from raid_items where workspace_id = new.workspace_id;
    new.ref := 'RAID-' || lpad(n::text, 3, '0');
  end if;
  new.created_by := coalesce(new.created_by, my_member_id());
  new.updated_by := coalesce(new.updated_by, new.created_by);
  return new;
end $$;

drop trigger if exists trg_item_ref on raid_items;
create trigger trg_item_ref before insert on raid_items
  for each row execute function assign_item_ref();

-- ------------------------------------------------------------
--  7. INVITE LINKING
--  An invited row has no user_id until that person first signs
--  in. Without this they authenticate but belong nowhere.
-- ------------------------------------------------------------
create or replace function link_invited_member()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update workspace_members
     set user_id = new.id, state = 'active'
   where lower(email) = lower(new.email)
     and user_id is null;
  return new;
end $$;

drop trigger if exists trg_link_invite on auth.users;
create trigger trg_link_invite after insert on auth.users
  for each row execute function link_invited_member();

-- ------------------------------------------------------------
--  8. SELF-SERVE WORKSPACE CREATION
--  Workspace + admin row in one transaction, so a workspace is
--  never left without an owner.
-- ------------------------------------------------------------
create or replace function create_workspace(ws_name text, display_name text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare new_ws uuid; uid uuid; uemail text;
begin
  uid := auth.uid();
  if uid is null then raise exception 'NOT_AUTHENTICATED'; end if;

  if exists (select 1 from workspace_members where user_id = uid) then
    raise exception 'ALREADY_IN_WORKSPACE';
  end if;

  select email into uemail from auth.users where id = uid;

  insert into workspaces (name) values (trim(ws_name)) returning id into new_ws;
  insert into workspace_members (workspace_id, user_id, email, name, role, state)
    values (new_ws, uid, uemail,
            coalesce(nullif(trim(display_name), ''), split_part(uemail, '@', 1)),
            'admin', 'active');
  return new_ws;
end $$;

-- ------------------------------------------------------------
--  9. SERVER-SIDE CSV GATE  (§3.5)
--  The UI hides the button; this is what actually stops a Free
--  workspace from pulling the export.
-- ------------------------------------------------------------
create or replace function export_raid_log()
returns table (ref text, type text, project text, priority text, status text,
               title text, owner text, due_date date, updated_at timestamptz, updated_by text)
language plpgsql security definer set search_path = public as $$
declare ws uuid;
begin
  ws := my_workspace_id();
  if ws is null then raise exception 'NOT_A_MEMBER'; end if;
  if not can_export_csv(ws) then
    raise exception 'CSV_EXPORT_REQUIRES_PAID' using errcode = 'insufficient_privilege';
  end if;

  return query
    select i.ref, i.type::text, p.name, i.priority::text, i.status::text,
           i.title, o.name, i.due_date, i.updated_at, u.name
      from raid_items i
      join projects p on p.id = i.project_id
      left join workspace_members o on o.id = i.owner_id
      left join workspace_members u on u.id = i.updated_by
     where i.workspace_id = ws
       and is_project_member(i.project_id)
     order by i.updated_at desc;
end $$;

-- ------------------------------------------------------------
--  10. ROW LEVEL SECURITY
-- ------------------------------------------------------------
alter table workspaces        enable row level security;
alter table workspace_members enable row level security;
alter table projects          enable row level security;
alter table project_members   enable row level security;
alter table raid_items        enable row level security;
alter table raid_item_comments enable row level security;
alter table notifications     enable row level security;

-- workspaces
drop policy if exists ws_select on workspaces;
create policy ws_select on workspaces for select
  using (is_workspace_member(id));

drop policy if exists ws_update on workspaces;
create policy ws_update on workspaces for update
  using (is_workspace_admin(id)) with check (is_workspace_admin(id));
-- note: plan / has_expansion_addon are set by you in the dashboard or by a
-- webhook using the service role, which bypasses RLS entirely.

-- workspace_members
drop policy if exists wm_select on workspace_members;
create policy wm_select on workspace_members for select
  using (is_workspace_member(workspace_id));

drop policy if exists wm_insert on workspace_members;
create policy wm_insert on workspace_members for insert
  with check (is_workspace_admin(workspace_id));

drop policy if exists wm_update on workspace_members;
create policy wm_update on workspace_members for update
  using (is_workspace_admin(workspace_id)) with check (is_workspace_admin(workspace_id));

drop policy if exists wm_delete on workspace_members;
create policy wm_delete on workspace_members for delete
  using (is_workspace_admin(workspace_id) and user_id is distinct from auth.uid());

-- projects
drop policy if exists proj_select on projects;
create policy proj_select on projects for select
  using (is_workspace_member(workspace_id));

drop policy if exists proj_insert on projects;
create policy proj_insert on projects for insert
  with check (is_workspace_admin(workspace_id));

drop policy if exists proj_update on projects;
create policy proj_update on projects for update
  using (is_workspace_admin(workspace_id)) with check (is_workspace_admin(workspace_id));

drop policy if exists proj_delete on projects;
create policy proj_delete on projects for delete
  using (is_workspace_admin(workspace_id));

-- project_members: workspace admin anywhere, project admin on their own (§2.3)
drop policy if exists pm_select on project_members;
create policy pm_select on project_members for select
  using (is_project_member(project_id));

drop policy if exists pm_insert on project_members;
create policy pm_insert on project_members for insert
  with check (is_project_admin(project_id));

drop policy if exists pm_update on project_members;
create policy pm_update on project_members for update
  using (is_project_admin(project_id)) with check (is_project_admin(project_id));

drop policy if exists pm_delete on project_members;
create policy pm_delete on project_members for delete
  using (is_project_admin(project_id));

-- raid_items: create/edit = any project member; delete = project admin (§2.3)
drop policy if exists items_select on raid_items;
create policy items_select on raid_items for select
  using (is_project_member(project_id));

drop policy if exists items_insert on raid_items;
create policy items_insert on raid_items for insert
  with check (is_project_member(project_id) and workspace_id = my_workspace_id());

drop policy if exists items_update on raid_items;
create policy items_update on raid_items for update
  using (is_project_member(project_id)) with check (is_project_member(project_id));

drop policy if exists items_delete on raid_items;
create policy items_delete on raid_items for delete
  using (is_project_admin(project_id));

-- comments: append-only (§4.3a) — no update, no delete policy at all
drop policy if exists comments_select on raid_item_comments;
create policy comments_select on raid_item_comments for select
  using (exists (select 1 from raid_items i
                 where i.id = raid_item_id and is_project_member(i.project_id)));

drop policy if exists comments_insert on raid_item_comments;
create policy comments_insert on raid_item_comments for insert
  with check (exists (select 1 from raid_items i
                      where i.id = raid_item_id and is_project_member(i.project_id)));

-- notifications: you read and dismiss your own; anyone on the project can raise one
drop policy if exists notif_select on notifications;
create policy notif_select on notifications for select
  using (recipient_id = my_member_id());

drop policy if exists notif_insert on notifications;
create policy notif_insert on notifications for insert
  with check (is_workspace_member(workspace_id));

drop policy if exists notif_update on notifications;
create policy notif_update on notifications for update
  using (recipient_id = my_member_id()) with check (recipient_id = my_member_id());

-- ------------------------------------------------------------
--  11. GRANTS
-- ------------------------------------------------------------
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant execute on all functions in schema public to authenticated;

-- ============================================================
--  Done. Verify with:
--    select tablename, rowsecurity from pg_tables
--     where schemaname = 'public';
--  Every table must show rowsecurity = true.
-- ============================================================
