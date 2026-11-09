-- Run manually in Supabase SQL Editor after review.
-- Isolated 9A attendance schema; no existing tables modified.
create extension if not exists pgcrypto;
create table if not exists public.xp_classes (
 id uuid primary key default gen_random_uuid(),
 teacher_id uuid not null references public.teacher_accounts(id),
 title text not null default '9 А',
 created_at timestamptz not null default now()
);
create table if not exists public.xp_students (
 id uuid primary key default gen_random_uuid(),
 class_id uuid not null references public.xp_classes(id) on delete cascade,
 full_name text not null,
 login text not null unique,
 password_hash text not null,
 active boolean not null default true,
 created_at timestamptz not null default now()
);
create table if not exists public.xp_sessions (
 id uuid primary key default gen_random_uuid(),
 class_id uuid not null references public.xp_classes(id) on delete cascade,
 challenge_hash text not null unique,
 starts_at timestamptz not null default now(),
 expires_at timestamptz not null,
 created_at timestamptz not null default now(),
 constraint xp_session_window check (expires_at > starts_at and expires_at <= starts_at + interval '15 minutes')
);
create table if not exists public.xp_attendance (
 id uuid primary key default gen_random_uuid(),
 session_id uuid not null references public.xp_sessions(id) on delete cascade,
 student_id uuid not null references public.xp_students(id) on delete cascade,
 status text not null default 'pending' check (status in ('pending','confirmed','rejected')),
 scanned_at timestamptz not null default now(),
 reviewed_at timestamptz,
 unique(session_id,student_id)
);
create table if not exists public.xp_ledger (
 id uuid primary key default gen_random_uuid(),
 student_id uuid not null references public.xp_students(id) on delete cascade,
 attendance_id uuid unique references public.xp_attendance(id) on delete cascade,
 delta integer not null check (delta between -100 and 100),
 reason text not null,
 created_at timestamptz not null default now()
);
create index if not exists xp_class_teacher_idx on public.xp_classes(teacher_id);
create index if not exists xp_student_class_idx on public.xp_students(class_id);
create index if not exists xp_attendance_student_idx on public.xp_attendance(student_id);
-- Server-side atomic scan: prevents reused codes after expiration and duplicate attendance.
create or replace function public.xp_scan(p_student uuid,p_challenge_hash text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_session public.xp_sessions%rowtype; v_student public.xp_students%rowtype; v_id uuid;
begin
 select * into v_student from public.xp_students where id=p_student and active=true;
 if not found then raise exception 'Student not found'; end if;
 select * into v_session from public.xp_sessions where challenge_hash=p_challenge_hash and starts_at<=now() and expires_at>now();
 if not found or v_session.class_id<>v_student.class_id then raise exception 'QR invalid or expired'; end if;
 insert into public.xp_attendance(session_id,student_id) values(v_session.id,p_student)
 on conflict(session_id,student_id) do update set scanned_at=public.xp_attendance.scanned_at
 returning id into v_id;
 return v_id;
end $$;
-- Confirm once and award XP atomically; caller must validate teacher ownership before RPC.
create or replace function public.xp_confirm(p_attendance uuid,p_teacher uuid)
returns boolean language plpgsql security definer set search_path=public as $$
declare v_student uuid;
begin
 update public.xp_attendance a set status='confirmed',reviewed_at=now()
 from public.xp_sessions s join public.xp_classes c on c.id=s.class_id
 where a.id=p_attendance and a.session_id=s.id and c.teacher_id=p_teacher and a.status='pending'
 returning a.student_id into v_student;
 if v_student is null then return false; end if;
 insert into public.xp_ledger(student_id,attendance_id,delta,reason) values(v_student,p_attendance,10,'Сабаққа қатысу расталды')
 on conflict(attendance_id) do nothing;
 return true;
end $$;
alter table public.xp_classes enable row level security;
alter table public.xp_students enable row level security;
alter table public.xp_sessions enable row level security;
alter table public.xp_attendance enable row level security;
alter table public.xp_ledger enable row level security;
revoke all on function public.xp_scan(uuid,text) from public,anon,authenticated;
revoke all on function public.xp_confirm(uuid,uuid) from public,anon,authenticated;
grant execute on function public.xp_scan(uuid,text) to service_role;
grant execute on function public.xp_confirm(uuid,uuid) to service_role;
