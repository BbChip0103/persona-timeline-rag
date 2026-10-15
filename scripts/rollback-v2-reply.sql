-- Run only after intake is paused and all turns have drained, before starting a C2 worker.
-- The database and role checks prevent accidental use on an unrelated target.
DO $$
BEGIN
  IF current_database() NOT IN ('ptr_split_test', 'ptr_split_research') THEN
    RAISE EXCEPTION 'ROLLBACK_V2_REPLY_DATABASE_REQUIRED';
  END IF;
  IF current_user NOT IN ('ptr_split_owner', 'postgres') THEN
    RAISE EXCEPTION 'ROLLBACK_V2_REPLY_OWNER_REQUIRED';
  END IF;
END $$;

UPDATE app.turns
SET reply = reply
  #- '{agent,variables,speechLevel}'
  #- '{agent,variables,summary}'
  #- '{agent,variables,userMemories}'
  #- '{agent,variables,userMemoryConsent}'
  #- '{agent,variables,summaryUpdate}'
  #- '{agent,variables,userMemoryOps}'
WHERE jsonb_typeof(reply #> '{agent,variables}') = 'object'
  AND (reply #> '{agent,variables}') ?| ARRAY[
    'speechLevel', 'summary', 'userMemories', 'userMemoryConsent',
    'summaryUpdate', 'userMemoryOps'
  ];

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM app.turns
    WHERE (reply #> '{agent,variables}') ?| ARRAY[
      'speechLevel', 'summary', 'userMemories', 'userMemoryConsent',
      'summaryUpdate', 'userMemoryOps'
    ]
  ) THEN
    RAISE EXCEPTION 'ROLLBACK_V2_REPLY_KEYS_REMAIN';
  END IF;
END $$;
