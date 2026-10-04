#!/usr/bin/env bash
set -euo pipefail
# Goal2: separate synthetic-only load-test database on the existing ptr_goal1 container.
# Idempotent. Run inside the container with passwords in the process environment only:
#   docker exec -i -e PGPASSWORD -e PTR_LOADTEST_DB_PASSWORD ptr_goal1_db bash -s < infra/init-loadtest-db.sh
# (PGPASSWORD = supabase_admin bootstrap password; PTR_LOADTEST_DB_PASSWORD = new role password.)
psql --no-psqlrc --quiet --set ON_ERROR_STOP=1 --username supabase_admin --dbname postgres <<'SQL'
SET log_statement='none';
SET log_min_error_statement='panic';
SET log_min_duration_statement=-1;
SET pgaudit.log='none';
\getenv lt_password PTR_LOADTEST_DB_PASSWORD
SELECT format('CREATE ROLE ptr_loadtester LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', :'lt_password')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ptr_loadtester') \gexec
SELECT 'CREATE DATABASE ptr_loadtest OWNER ptr_loadtester'
  WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname='ptr_loadtest') \gexec
REVOKE CONNECT ON DATABASE ptr_loadtest FROM PUBLIC;
\connect ptr_loadtest
CREATE EXTENSION IF NOT EXISTS vector;
SQL
