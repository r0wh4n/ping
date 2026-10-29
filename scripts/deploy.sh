#!/usr/bin/env bash
# Deploy Ping to one environment, in the only order that is safe.
#
# This exists because the same mistake was made twice by hand: `functions deploy`
# run before `db push`. Both times the function went live expecting a column that
# did not exist yet, and both times it failed SILENTLY — member lists came back
# empty, capability cards came back null, every response still 200 OK. An agent
# testing it reported it as "a caching bug".
#
# The rule: a migration must be applied and verified before any function that
# depends on it is deployed to that same environment. Here that rule is the
# control flow — `set -e` plus the ordering below means a failed migration can
# never be followed by a function deploy.
#
#   ./scripts/deploy.sh staging
#   ./scripts/deploy.sh prod

set -euo pipefail

ENV="${1:-}"
case "$ENV" in
  staging|prod) ;;
  *) echo "usage: $0 <staging|prod>" >&2; exit 2 ;;
esac

ENVFILE=".env.${ENV}"
[ -f "$ENVFILE" ] || { echo "Missing $ENVFILE — copy .env.staging.example and fill it in." >&2; exit 2; }
# shellcheck disable=SC1090
set -a; source "$ENVFILE"; set +a

: "${SUPABASE_PROJECT_REF:?Set SUPABASE_PROJECT_REF in $ENVFILE}"

if [ "$ENV" = "prod" ]; then
  echo "About to deploy to PRODUCTION (project $SUPABASE_PROJECT_REF)."
  echo "Staging first is the point of having staging. Type 'prod' to continue:"
  read -r confirm
  [ "$confirm" = "prod" ] || { echo "Stopped."; exit 1; }
fi

echo "==> [1/4] Local checks"
npm run check

echo "==> [2/4] Migrations to $ENV"
# Nothing below this line runs if a migration fails: that is the whole mechanism.
npx supabase db push --project-ref "$SUPABASE_PROJECT_REF"

echo "==> [3/4] Verifying the schema actually took"
# "db push exited 0" is not the same as "the column is there" — a push that
# applied nothing also exits 0. Ask the database directly.
npx supabase db diff --project-ref "$SUPABASE_PROJECT_REF" --schema public > /tmp/ping-schema-drift.sql 2>/dev/null || true
if [ -s /tmp/ping-schema-drift.sql ]; then
  echo "Remote schema still differs from the local migrations:" >&2
  head -40 /tmp/ping-schema-drift.sql >&2
  echo "Refusing to deploy functions against a schema that is not what this code expects." >&2
  exit 1
fi

echo "==> [4/4] Edge functions to $ENV"
for fn in group-api group-hook send-push; do
  echo "    - $fn"
  npx supabase functions deploy "$fn" --project-ref "$SUPABASE_PROJECT_REF"
done

echo
echo "Done: $ENV is on migrations-then-functions order."
[ "$ENV" = "staging" ] && echo "Smoke it, then run: ./scripts/deploy.sh prod"
