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

-- Deleted sessions would become visible to old peers without C4 tombstone filtering.
-- Run split retention until it has purged every deleted session before this script.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM app.sessions WHERE deleted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'ROLLBACK_DELETED_SESSIONS_REMAIN';
  END IF;
END $$;

UPDATE app.sessions
SET document = document #- '{userMemoryConsent}'
WHERE document ? 'userMemoryConsent';

-- Root fields are defensive cleanup for malformed earlier C4 receipts persisted as replies.

UPDATE app.turns
SET reply = (CASE
    WHEN reply #>> '{replyGuard,reason}' = 'formatting'
    THEN reply #- '{replyGuard}'
    ELSE reply
  END)
  #- '{summaryUpdate}'
  #- '{userMemoryOps}'
  #- '{operatorMetadata}'
  #- '{operatorTrace}'
  #- '{agent,variables,speechLevel}'
  #- '{agent,variables,lastYearRecallUsed}'
  #- '{agent,variables,summary}'
  #- '{agent,variables,userMemories}'
  #- '{agent,variables,userMemoryConsent}'
  #- '{agent,variables,summaryUpdate}'
  #- '{agent,variables,userMemoryOps}'
WHERE reply ?| ARRAY['summaryUpdate', 'userMemoryOps', 'operatorMetadata', 'operatorTrace']
  OR (reply #>> '{replyGuard,reason}') = 'formatting'
  OR (reply #> '{agent,variables}') ?| ARRAY[
    'speechLevel', 'lastYearRecallUsed', 'summary', 'userMemories', 'userMemoryConsent',
    'summaryUpdate', 'userMemoryOps'
  ];

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM app.sessions WHERE document ? 'userMemoryConsent') THEN
    RAISE EXCEPTION 'ROLLBACK_V2_SESSION_KEYS_REMAIN';
  END IF;
  IF EXISTS (
    SELECT 1 FROM app.turns
    WHERE reply ?| ARRAY['summaryUpdate', 'userMemoryOps', 'operatorMetadata', 'operatorTrace']
      OR (
        (reply #> '{replyGuard,reason}') IS NOT NULL
        AND COALESCE(reply #>> '{replyGuard,reason}', '') NOT IN (
          'human_impersonation', 'missing_ai_disclosure', 'private_life',
          'background_denial', 'meta_talk'
        )
      )
      OR (reply #> '{agent,variables}') ?| ARRAY[
      'speechLevel', 'lastYearRecallUsed', 'summary', 'userMemories', 'userMemoryConsent',
      'summaryUpdate', 'userMemoryOps'
    ]
  ) THEN
    RAISE EXCEPTION 'ROLLBACK_V2_REPLY_KEYS_REMAIN';
  END IF;
END $$;
