-- 0009_alert_scan.sql
--
-- PR E support: lets clients surface their local sync_dead_letter
-- moves to the server so the alert-scan Edge Function can detect
-- spikes across users. The local Dexie dead-letter table stays the
-- source of truth on the device; the audit_event is a "this user
-- has at least one dead-letter for this row" beacon.
--
-- See docs/operational-runbook.md (alert-scan section) for the
-- pg_cron setup, env vars, and threshold tuning.

create or replace function public.record_dead_letter(
  p_table   text,
  p_row_id  text,
  p_op      text,
  p_reason  text
) returns void
  language plpgsql security definer set search_path = public as $$
begin
  perform public.emit_audit_event(
    auth.uid(),
    'sync.dead_letter',
    jsonb_build_object('type', p_table, 'id', p_row_id),
    jsonb_build_object('op', p_op, 'reason', left(coalesce(p_reason, ''), 500))
  );
end $$;

revoke execute on function public.record_dead_letter(text, text, text, text) from public;
grant  execute on function public.record_dead_letter(text, text, text, text) to authenticated;
