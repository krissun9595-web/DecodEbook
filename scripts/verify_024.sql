-- sql/024 confirm — ONE statement so the SQL Editor shows all checks in a single result row.
select
  normalize_email('Me.Too+tag@Gmail.com')   as gmail,        -- expect: metoo@gmail.com
  normalize_email('a.b.c@googlemail.com')    as googlemail,   -- expect: abc@gmail.com
  normalize_email('User+promo@Outlook.com')  as outlook,      -- expect: user@outlook.com (dots kept)
  position('normalize_email' in pg_get_functiondef('public.award_referral_on_engagement(uuid)'::regprocedure)) > 0
                                             as award_dedup,   -- expect: true (new logic installed)
  has_function_privilege('authenticated','public.award_referral_on_engagement(uuid)','EXECUTE')
                                             as authed_award;  -- expect: false (already confirmed)
