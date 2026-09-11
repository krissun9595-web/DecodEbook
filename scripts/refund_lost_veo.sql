-- Refund the 340 credits for the Premium (Veo) video that was charged but never delivered
-- (a metering bug corrupted the download-URI retrieval; usage_id 474ddb2e, 2026-09-08 02:13:46).
-- Run in the Supabase SQL Editor (admin). Replace <YOUR_USER_ID> with your auth uid if needed;
-- the SELECT below fills it from that exact usage row automatically.
do $$
declare v_uid uuid;
begin
  select user_id into v_uid from public.usage_logs
   where action = 'videoVeo' and credits_cost = 340
     and created_at >= '2026-09-08 02:13:00' and created_at < '2026-09-08 02:14:00'
   order by created_at desc limit 1;
  if v_uid is null then raise notice 'row not found — set v_uid manually'; return; end if;
  perform public.add_bonus_credits(v_uid, 340);  -- also writes a credit_ledger audit row
  raise notice 'refunded 340 to %', v_uid;
end $$;
