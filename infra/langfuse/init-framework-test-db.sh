#!/bin/sh
set -eu
# Runs only during FIRST initialization of this stack's NEW volume. No research data/connection.
psql --no-psqlrc --quiet --set ON_ERROR_STOP=1 --username ptr_framework_bootstrap --dbname postgres <<'SQL'
\getenv tester_password PTR_FRAMEWORK_TEST_DB_PASSWORD
SELECT format('CREATE ROLE ptr_framework_tester LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', :'tester_password') \gexec
CREATE DATABASE ptr_framework_test OWNER ptr_framework_tester;
REVOKE CONNECT ON DATABASE ptr_framework_test FROM PUBLIC;
\connect ptr_framework_test
CREATE EXTENSION vector;
GRANT USAGE, CREATE ON SCHEMA public TO ptr_framework_tester;
SQL
