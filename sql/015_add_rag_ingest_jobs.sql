-- 015: automated RAG ingestion pipeline (upload -> Storage -> Queue -> chunks)
-- Run once in the Supabase SQL editor.

create table if not exists public.rag_ingest_jobs (
  id          uuid primary key default gen_random_uuid(),
  file_path   text not null,                       -- path inside the rag-uploads bucket
  file_name   text not null,
  source      text not null,                       -- citation string (same as manual --source)
  context     text not null default 'both' check (context in ('clinical','general','both')),
  replace     boolean not null default false,      -- delete existing chunks for this source first
  status      text not null default 'queued' check (status in ('queued','processing','done','failed')),
  chunk_count int,
  error       text,
  attempts    int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists rag_ingest_jobs_status_idx  on public.rag_ingest_jobs (status);
create index if not exists rag_ingest_jobs_created_idx on public.rag_ingest_jobs (created_at desc);

-- Worker uses the service key (bypasses RLS); lock the table from anon/public.
alter table public.rag_ingest_jobs enable row level security;

-- Private bucket for uploaded source documents.
insert into storage.buckets (id, name, public)
values ('rag-uploads', 'rag-uploads', false)
on conflict (id) do nothing;
