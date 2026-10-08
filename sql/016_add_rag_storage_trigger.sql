-- 016: auto-ingest — any file uploaded to the rag-uploads bucket (dashboard or
-- app) calls the Worker's POST /rag/webhook, which creates + queues a job.
--
-- BEFORE RUNNING: replace BOTH placeholders below.
--   <WEBHOOK_SECRET>  any long random string; set the SAME value as the Worker
--                     secret INGEST_WEBHOOK_SECRET in Cloudflare.
-- Do not commit the real secret to git.
--
-- Folder convention inside the bucket:
--   clinical/xxx.pdf -> context "clinical"   general/xxx.pdf -> "general"
--   xxx.pdf (root)   -> context "both"
-- Source (citation) = file name without extension, underscores -> spaces.
-- Paths starting with "api/" are used by POST /rag/upload and are ignored here.

create extension if not exists pg_net with schema extensions;

create or replace function public.rag_notify_new_upload()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if new.bucket_id = 'rag-uploads' and new.name not like 'api/%' then
    perform net.http_post(
      url     := 'https://chakudya-api.edisontaimu9.workers.dev/rag/webhook',
      headers := jsonb_build_object(
                   'Content-Type', 'application/json',
                   'x-webhook-secret', '<WEBHOOK_SECRET>'),
      body    := jsonb_build_object('bucket', new.bucket_id, 'name', new.name)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists rag_upload_notify on storage.objects;
create trigger rag_upload_notify
  after insert on storage.objects
  for each row execute function public.rag_notify_new_upload();
