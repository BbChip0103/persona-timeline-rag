#!/bin/sh
set -eu
# NEW synthetic benchmark volume only; preserve historical logical identities at a different port.
psql --no-psqlrc --quiet --set ON_ERROR_STOP=1 --username ptr_framework_baseline_tester --dbname ptr_framework_baseline <<'SQL'
\getenv tester_password POSTGRES_PASSWORD
SELECT format('CREATE ROLE ptr_loadtester LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', :'tester_password') \gexec
CREATE DATABASE ptr_loadtest OWNER ptr_loadtester;
REVOKE CONNECT ON DATABASE ptr_loadtest FROM PUBLIC;
\connect ptr_loadtest
CREATE EXTENSION vector;
GRANT USAGE, CREATE ON SCHEMA public TO ptr_loadtester;
SQL
