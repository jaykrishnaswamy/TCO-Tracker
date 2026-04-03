-- TCO Tracker Database Schema
-- Run this in Supabase SQL Editor

-- ── Allowed users (invite-only whitelist) ──
create table if not exists allowed_users (
  email text primary key,
  invited_by text,
  invited_at timestamptz default now(),
  note text
);

-- ── Vehicles (one per user per car) ──
create table if not exists vehicles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  vehicle jsonb not null default '{}',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ── Fuel log entries ──
create table if not exists fuel_entries (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid references vehicles(id) on delete cascade not null,
  user_id uuid references auth.users(id) on delete cascade not null,
  data jsonb not null default '{}',
  created_at timestamptz default now()
);

-- ── Maintenance entries ──
create table if not exists maintenance_entries (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid references vehicles(id) on delete cascade not null,
  user_id uuid references auth.users(id) on delete cascade not null,
  data jsonb not null default '{}',
  created_at timestamptz default now()
);

-- ── Fixed cost entries ──
create table if not exists fixed_entries (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid references vehicles(id) on delete cascade not null,
  user_id uuid references auth.users(id) on delete cascade not null,
  data jsonb not null default '{}',
  created_at timestamptz default now()
);

-- ── Consumable entries ──
create table if not exists consumable_entries (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid references vehicles(id) on delete cascade not null,
  user_id uuid references auth.users(id) on delete cascade not null,
  data jsonb not null default '{}',
  created_at timestamptz default now()
);

-- ── Row Level Security ──
-- Users can only see and modify their own data

alter table vehicles enable row level security;
alter table fuel_entries enable row level security;
alter table maintenance_entries enable row level security;
alter table fixed_entries enable row level security;
alter table consumable_entries enable row level security;
alter table allowed_users enable row level security;

-- Vehicles policies
create policy "users can manage own vehicles"
  on vehicles for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Fuel policies
create policy "users can manage own fuel entries"
  on fuel_entries for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Maintenance policies
create policy "users can manage own maintenance entries"
  on maintenance_entries for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Fixed cost policies
create policy "users can manage own fixed entries"
  on fixed_entries for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Consumable policies
create policy "users can manage own consumable entries"
  on consumable_entries for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Allowed users: only service role can write, authenticated users can check their own email
create policy "users can check if their email is allowed"
  on allowed_users for select
  using (email = auth.jwt() ->> 'email');

-- ── Auth trigger: block sign-ins from non-invited emails ──
create or replace function check_allowed_user()
returns trigger language plpgsql security definer as $$
begin
  if not exists (
    select 1 from allowed_users
    where email = new.email
  ) then
    raise exception 'Access denied. Please request an invite.';
  end if;
  return new;
end;
$$;

-- Apply trigger on new user creation
drop trigger if exists enforce_invite_on_signup on auth.users;
create trigger enforce_invite_on_signup
  before insert on auth.users
  for each row execute function check_allowed_user();

-- ── Add yourself as the first allowed user ──
-- Replace with your actual Gmail address
insert into allowed_users (email, invited_by, note)
values ('YOUR_EMAIL@gmail.com', 'self', 'owner')
on conflict (email) do nothing;

-- ── Indexes for performance ──
create index if not exists idx_vehicles_user_id on vehicles(user_id);
create index if not exists idx_fuel_vehicle_id on fuel_entries(vehicle_id);
create index if not exists idx_maint_vehicle_id on maintenance_entries(vehicle_id);
create index if not exists idx_fixed_vehicle_id on fixed_entries(vehicle_id);
create index if not exists idx_cons_vehicle_id on consumable_entries(vehicle_id);

-- ── Scan usage tracking ──
create table if not exists scan_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  month text not null, -- format: YYYY-MM
  count integer not null default 0,
  unique(user_id, month)
);

alter table scan_usage enable row level security;

create policy "users can view own usage"
  on scan_usage for select
  using (auth.uid() = user_id);

create index if not exists idx_scan_usage_user_month on scan_usage(user_id, month);
