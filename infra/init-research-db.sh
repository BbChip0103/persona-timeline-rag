#!/usr/bin/env bash
set -euo pipefail
# Docker entrypoint executes this only for a brand-new ptr_goal1 volume.
# psql reads the private password from process environment, never command arguments.
psql --no-psqlrc --quiet --set ON_ERROR_STOP=1 --username supabase_admin --dbname postgres <<'SQL'
SET log_statement='none';
SET log_min_error_statement='panic';
SET log_min_duration_statement=-1;
SET pgaudit.log='none';
\getenv ptr_password POSTGRES_PASSWORD
SELECT format('CREATE ROLE ptr_researcher LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', :'ptr_password') \gexec
CREATE DATABASE ptr_research OWNER ptr_researcher;
\connect ptr_research
CREATE EXTENSION IF NOT EXISTS vector;
SQL
