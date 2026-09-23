create table if not exists public.access_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  label text not null default '',
  duration_days integer not null check (duration_days between 1 and 365),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  is_active boolean not null default true,
  bound_device_1 text,
  bound_device_2 text,
  bound_device_1_at timestamptz,
  bound_device_2_at timestamptz,
  device_reset_count bigint not null default 0 check (device_reset_count >= 0),
  last_used_at timestamptz,
  usage_count bigint not null default 0 check (usage_count >= 0)
);

alter table public.access_codes add column if not exists bound_device_1 text;
alter table public.access_codes add column if not exists bound_device_2 text;
alter table public.access_codes add column if not exists bound_device_1_at timestamptz;
alter table public.access_codes add column if not exists bound_device_2_at timestamptz;
alter table public.access_codes add column if not exists device_reset_count bigint not null default 0;

create index if not exists access_codes_code_idx on public.access_codes (code);
create index if not exists access_codes_created_at_idx on public.access_codes (created_at desc);

alter table public.access_codes enable row level security;
revoke all on table public.access_codes from anon, authenticated;
