#!/usr/bin/env bash
# =============================================================================
# Migration Repair Script
# Project: IDM  |  Database: MySQL (based on error code 1054)
#
# Run from the project root (same directory as manage.py).
# Make sure your virtualenv is active.
# =============================================================================

set -euo pipefail

echo "=== Step 1: Copy fixed migration files ==="
# Replace the two broken migration files BEFORE touching the database.
#
#   Source (from this repo / fixes/ directory):
#     fixes/workflows/migrations/0002_auto_20260414_0953.py
#     fixes/documents/migrations/0003_documenttype_workflow_template.py
#
#   Destination:
#     apps/workflows/migrations/0002_auto_20260414_0953.py
#     apps/documents/migrations/0003_documenttype_workflow_template.py
#
# cp fixes/workflows/migrations/0002_auto_20260414_0953.py \
#    apps/workflows/migrations/0002_auto_20260414_0953.py
#
# cp fixes/documents/migrations/0003_documenttype_workflow_template.py \
#    apps/documents/migrations/0003_documenttype_workflow_template.py

echo ""
echo "=== Step 2: Verify Django can load the migration graph cleanly ==="
python manage.py migrate --check --run-syncdb 2>&1 || true
# Ignore the non-zero exit; we just want to see the error list.

echo ""
echo "=== Step 3: Check current migration state ==="
python manage.py showmigrations workflows
python manage.py showmigrations documents

echo ""
echo "=== Step 4: Handle the DB depending on its current state ==="
echo ""
echo "CASE A — documents/0003 has already been applied to the DB"
echo "(django_migrations table contains a row for documents/0003):"
echo ""
echo "    python manage.py migrate --fake documents 0003_documenttype_workflow_template"
echo "    python manage.py migrate workflows"
echo ""
echo "CASE B — documents/0003 has NOT been applied yet:"
echo ""
echo "    python manage.py migrate"
echo ""
echo "CASE C — workflows/0002 is listed as applied but rule_id column is missing"
echo "(migration recorded in django_migrations but ALTER TABLE never ran):"
echo ""
echo "    # Remove the stale record so Django will re-run it"
echo "    python manage.py dbshell"
echo "    > DELETE FROM django_migrations"
echo "    >   WHERE app='workflows' AND name='0002_auto_20260414_0953';"
echo "    > \\q"
echo "    python manage.py migrate workflows"
echo ""

echo "=== Step 5: Verify all migrations are applied cleanly ==="
python manage.py showmigrations

echo ""
echo "=== Step 6: Confirm rule_id column now exists ==="
python manage.py dbshell <<'SQL'
DESCRIBE workflows_workflowinstance;
SQL

echo ""
echo "Done. If the DESCRIBE output includes rule_id, the DB is repaired."
