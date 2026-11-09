#!/usr/bin/env bash
# Publish this site to Vercel PRODUCTION (or a preview) from a prebuilt bundle.
#
# Hardened (QA round 4). What changed and why:
#   * Production deploys use `--prod`. Before, the deploy went out as a preview
#     and was never promoted.
#   * Deployment protection is no longer switched off project-wide. Previews
#     share the production database, so they must stay behind Vercel
#     Authentication. The script only READS the setting. Opt in with
#     GO_LIVE_SET_STANDARD_PROTECTION=1 to set "Standard Protection"
#     (production domains public, previews and deployment URLs protected).
#   * No secret is ever passed on a command line (visible in `ps` and in CI
#     logs). The CLI reads VERCEL_TOKEN from the environment, runtime secrets
#     live in the Vercel project's env and are only *checked* here, and
#     GO_LIVE_SYNC_ENV=1 uploads them through stdin (`vercel env add`).
#   * The Vercel CLI version is pinned (VERCEL_CLI_VERSION), not @latest.
#   * The database schema is part of the contract. A production deploy refuses
#     to run until you either apply named migrations through the explicit
#     opt-in step (GO_LIVE_MIGRATIONS=...) or confirm you already applied
#     them (GO_LIVE_SCHEMA_CONFIRMED=1). Afterwards it reads
#     /api/health/payments when that route exists.
#
# Nothing here runs automatically: `bun run go-live` is a manual, owner-only
# step. With the GitHub integration, merging to main already deploys
# production, so this script is the fallback path, not the normal one.
#
# Inputs (environment only; never arguments):
#   VERCEL_TOKEN            required. Read by the CLI from the environment.
#   GO_LIVE_TARGET          "production" (default) or "preview".
#   GO_LIVE_ENV_FILE        optional KEY=VALUE file (parsed, never sourced) to
#                           load secrets from, e.g. a chmod 600 file outside the
#                           repo. Only the keys in ENV_FILE_ALLOWLIST are
#                           accepted; any other key aborts (no PATH/BASH_ENV/...).
#   GO_LIVE_SYNC_ENV=1      upload the runtime vars present in this shell to the
#                           project's env for the target, via stdin. Variables
#                           that already exist are skipped unless
#                           GO_LIVE_SYNC_OVERWRITE=1, which lists them and asks
#                           you to type "overwrite" (never a silent --force).
#   GO_LIVE_MIGRATIONS      opt-in: space-separated file names in migrations/
#                           to apply, in that order, with psql. Needs
#                           DATABASE_URL_UNPOOLED and a typed confirmation, and
#                           first proves that URL is the project's database:
#                           host (pooler suffix ignored), port and db name must
#                           match the target's DATABASE_URL from `vercel env
#                           pull`, or, when that value is sensitive and cannot
#                           be pulled (and only then), GO_LIVE_EXPECTED_DB_HOST
#                           + GO_LIVE_EXPECTED_DB_NAME (copied from the
#                           Vercel/Neon dashboard). Any mismatch aborts.
#   GO_LIVE_SCHEMA_CONFIRMED=1  you already applied the migrations this code
#                           needs (see PAYMENTS.md / the PR notes).
#   GO_LIVE_SET_STANDARD_PROTECTION=1  opt-in, see above.
#   VERCEL_SCOPE / VERCEL_TEAM_ID / VERCEL_PROJECT_NAME  optional overrides.
#
# Runtime vars the deployment needs (checked in the project's env for the
# target; uploaded only with GO_LIVE_SYNC_ENV=1):
#   DATABASE_URL, STRIPE_WEBHOOK_SECRET, RESEND_API_KEY, GIFT_FROM_EMAIL
#   (PUBLIC_SITE_URL optional).
set -euo pipefail
cd "$(dirname "$0")"
umask 002

VERCEL_CLI_VERSION="65.12.1"
VERCEL=(bunx "vercel@${VERCEL_CLI_VERSION}")
REQUIRED_RUNTIME_VARS=(DATABASE_URL STRIPE_WEBHOOK_SECRET RESEND_API_KEY GIFT_FROM_EMAIL)
OPTIONAL_RUNTIME_VARS=(PUBLIC_SITE_URL)
ENV_FILE_ALLOWLIST=(VERCEL_TOKEN DATABASE_URL_UNPOOLED "${REQUIRED_RUNTIME_VARS[@]}" "${OPTIONAL_RUNTIME_VARS[@]}")
PG_URL_HELPER="scripts/pg-url.mjs"

die() { echo "error: $*" >&2; exit 1; }

# --- inputs -----------------------------------------------------------------
if [ -n "${GO_LIVE_ENV_FILE:-}" ]; then
  [ -f "$GO_LIVE_ENV_FILE" ] || die "GO_LIVE_ENV_FILE not found: $GO_LIVE_ENV_FILE"
  # Parse, never source: the file is data, not code.
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    key="${line%%=*}"
    val="${line#*=}"
    [[ "$key" =~ ^[A-Z_][A-Z0-9_]*$ ]] || die "bad line in GO_LIVE_ENV_FILE (key: ${key:0:40})"
    allowed=0
    for k in "${ENV_FILE_ALLOWLIST[@]}"; do [ "$k" = "$key" ] && allowed=1; done
    [ "$allowed" = 1 ] || die "GO_LIVE_ENV_FILE key not allowed: $key (allowed: ${ENV_FILE_ALLOWLIST[*]})"
    val="${val%\"}"; val="${val#\"}"
    export "$key=$val"
  done < "$GO_LIVE_ENV_FILE"
fi

: "${VERCEL_TOKEN:?set VERCEL_TOKEN in the environment (never pass it as an argument)}"
export VERCEL_TOKEN

TARGET="${GO_LIVE_TARGET:-production}"
case "$TARGET" in
  production) TARGET_ARGS=(--prod) ;;
  preview) TARGET_ARGS=() ;;
  *) die "GO_LIVE_TARGET must be production or preview (got: $TARGET)" ;;
esac

PROJECT_NAME="${VERCEL_PROJECT_NAME:-$(basename "$(pwd)")}"

# --- team / scope (token stays in the environment) ---------------------------
if [ -z "${VERCEL_SCOPE:-}" ] || [ -z "${VERCEL_TEAM_ID:-}" ]; then
  RESOLVED="$(bun -e '
    const h = { headers: { Authorization: "Bearer " + process.env.VERCEL_TOKEN } };
    const [u, tj] = await Promise.all([
      fetch("https://api.vercel.com/v2/user", h).then((r) => r.json()).catch(() => ({})),
      fetch("https://api.vercel.com/v2/teams?limit=50", h).then((r) => r.json()).catch(() => ({})),
    ]);
    const teams = tj.teams || [];
    const def = (u.user || u || {}).defaultTeamId;
    const t = teams.find((x) => x.id === def) || teams[0];
    if (t) process.stdout.write(t.id + " " + t.slug);
  ' 2>/dev/null || true)"
  VERCEL_TEAM_ID="${VERCEL_TEAM_ID:-${RESOLVED%% *}}"
  [ "$RESOLVED" != "${RESOLVED#* }" ] && VERCEL_SCOPE="${VERCEL_SCOPE:-${RESOLVED##* }}"
fi
SCOPE_ARGS=()
if [ -n "${VERCEL_SCOPE:-}" ]; then SCOPE_ARGS=(--scope "$VERCEL_SCOPE"); fi
TEAM_QS=""
if [ -n "${VERCEL_TEAM_ID:-}" ]; then TEAM_QS="?teamId=$VERCEL_TEAM_ID"; fi

# Vercel REST call with the token in a curl config on stdin, not in argv.
vercel_api() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-sf -X "$method" "https://api.vercel.com${path}${TEAM_QS}" -K -)
  if [ -n "$body" ]; then args+=(-H "Content-Type: application/json" --data-binary "$body"); fi
  printf 'header = "Authorization: Bearer %s"\n' "$VERCEL_TOKEN" | curl "${args[@]}"
}

# Link this directory to the project so `vercel env` works (writes only
# .vercel/project.json locally).
"${VERCEL[@]}" link --yes --project "$PROJECT_NAME" "${SCOPE_ARGS[@]}" >/dev/null

# --- 1. runtime env: upload (opt-in, via stdin) or check ----------------------
list_env_names() {
  "${VERCEL[@]}" env ls "$TARGET" "${SCOPE_ARGS[@]}" 2>/dev/null | awk '{print $1}' || true
}

if [ "${GO_LIVE_SYNC_ENV:-}" = "1" ]; then
  EXISTING="$(list_env_names)"
  NEW=() REPLACE=()
  for name in "${REQUIRED_RUNTIME_VARS[@]}" "${OPTIONAL_RUNTIME_VARS[@]}"; do
    [ -n "${!name:-}" ] || continue
    if grep -qx "$name" <<<"$EXISTING"; then REPLACE+=("$name"); else NEW+=("$name"); fi
  done
  if [ "${#REPLACE[@]}" -gt 0 ]; then
    if [ "${GO_LIVE_SYNC_OVERWRITE:-}" = "1" ]; then
      echo "==> these $TARGET env vars ALREADY EXIST and would be replaced: ${REPLACE[*]}"
      [ -t 0 ] || die "overwriting existing env vars needs an interactive terminal"
      read -r -p "Type 'overwrite' to replace them: " answer
      [ "$answer" = "overwrite" ] || die "aborted; nothing uploaded"
    else
      echo "==> skipping existing $TARGET env vars (set GO_LIVE_SYNC_OVERWRITE=1 to replace): ${REPLACE[*]}"
      REPLACE=()
    fi
  fi
  echo "==> uploading runtime env vars to the $TARGET environment (via stdin)"
  for name in "${NEW[@]}"; do
    printf '%s' "${!name}" |
      "${VERCEL[@]}" env add "$name" "$TARGET" --yes "${SCOPE_ARGS[@]}" >/dev/null
    echo "    added $name"
  done
  for name in "${REPLACE[@]}"; do
    # Explicitly confirmed above; the CLI needs --force to replace a value.
    printf '%s' "${!name}" |
      "${VERCEL[@]}" env add "$name" "$TARGET" --force --yes "${SCOPE_ARGS[@]}" >/dev/null
    echo "    replaced $name"
  done
fi

echo "==> checking the project's $TARGET env vars (names only)"
ENV_NAMES="$(list_env_names)"
MISSING=()
for name in "${REQUIRED_RUNTIME_VARS[@]}"; do
  grep -qx "$name" <<<"$ENV_NAMES" || MISSING+=("$name")
done
if [ "${#MISSING[@]}" -gt 0 ]; then
  die "missing $TARGET env vars on the Vercel project: ${MISSING[*]}
  set them in the dashboard, or rerun with GO_LIVE_SYNC_ENV=1 and the values exported
  (or in GO_LIVE_ENV_FILE); they are uploaded through stdin, never as arguments"
fi

# --- 2. database schema: explicit opt-in step or explicit confirmation -------
if [ -n "${GO_LIVE_MIGRATIONS:-}" ]; then
  : "${DATABASE_URL_UNPOOLED:?GO_LIVE_MIGRATIONS needs DATABASE_URL_UNPOOLED (the direct, unpooled URL)}"
  command -v psql >/dev/null || die "psql not found"
  read -r -a FILES <<<"$GO_LIVE_MIGRATIONS"
  for f in "${FILES[@]}"; do
    [[ "$f" =~ ^[0-9]{4}_[a-z0-9_]+\.sql$ ]] || die "not a migration file name: $f"
    [ -f "migrations/$f" ] || die "missing migrations/$f"
  done
  # Prove the URL is this project's database before touching it.
  echo "==> verifying DATABASE_URL_UNPOOLED is the $TARGET database of $PROJECT_NAME"
  PULL_DIR="$(mktemp -d)"
  trap 'rm -rf "$PULL_DIR"' EXIT
  chmod 700 "$PULL_DIR"
  "${VERCEL[@]}" env pull "$PULL_DIR/project.env" --environment "$TARGET" --yes \
    "${SCOPE_ARGS[@]}" >/dev/null 2>&1 || true
  # Exit 0 = same database, 1 = mismatch or invalid (always fatal), 3 = the
  # project's DATABASE_URL could not be read at all. Only 3 may fall back to
  # GO_LIVE_EXPECTED_DB_HOST + GO_LIVE_EXPECTED_DB_NAME; the fallback can never
  # override a real mismatch.
  DB_CHECK=0
  PG_URL="$DATABASE_URL_UNPOOLED" bun "$PG_URL_HELPER" same-project-db "$PULL_DIR/project.env" ||
    DB_CHECK=$?
  if [ "$DB_CHECK" -eq 0 ]; then
    echo "    matches the project's DATABASE_URL"
  elif [ "$DB_CHECK" -eq 3 ] && [ -n "${GO_LIVE_EXPECTED_DB_HOST:-}" ] &&
    [ -n "${GO_LIVE_EXPECTED_DB_NAME:-}" ]; then
    DB_CHECK=0
    PG_URL="$DATABASE_URL_UNPOOLED" EXPECTED_DB_HOST="$GO_LIVE_EXPECTED_DB_HOST" \
      EXPECTED_DB_NAME="$GO_LIVE_EXPECTED_DB_NAME" bun "$PG_URL_HELPER" same-host || DB_CHECK=$?
    if [ "$DB_CHECK" -ne 0 ]; then
      rm -rf "$PULL_DIR"
      die "DATABASE_URL_UNPOOLED does not match GO_LIVE_EXPECTED_DB_HOST/GO_LIVE_EXPECTED_DB_NAME; nothing applied."
    fi
    echo "    project DATABASE_URL unreadable; matches GO_LIVE_EXPECTED_DB_HOST/GO_LIVE_EXPECTED_DB_NAME"
  elif [ "$DB_CHECK" -eq 3 ]; then
    rm -rf "$PULL_DIR"
    die "could not read the project's $TARGET DATABASE_URL to check DATABASE_URL_UNPOOLED against; nothing applied.
  If the project's value is sensitive and cannot be pulled, set GO_LIVE_EXPECTED_DB_HOST to the
  endpoint host and GO_LIVE_EXPECTED_DB_NAME to the database name shown in the Vercel/Neon
  dashboard for $TARGET (pooler suffix optional)."
  else
    rm -rf "$PULL_DIR"
    die "DATABASE_URL_UNPOOLED does not match the project's $TARGET DATABASE_URL; nothing applied.
  (GO_LIVE_EXPECTED_DB_HOST is only consulted when the project's value cannot be read.)"
  fi
  rm -rf "$PULL_DIR"
  trap - EXIT

  echo "==> about to apply to that database, in order:"
  printf '      migrations/%s\n' "${FILES[@]}"
  [ -t 0 ] || die "migrations need an interactive terminal for the confirmation"
  read -r -p "Type 'apply' to continue: " answer
  [ "$answer" = "apply" ] || die "aborted; nothing applied"
  # libpq env vars from a strictly validated URL, so the password is never in
  # psql's argv and a malformed URL aborts before psql runs.
  PG_EXPORTS="$(PG_URL="$DATABASE_URL_UNPOOLED" bun "$PG_URL_HELPER" libpq-env)" ||
    die "DATABASE_URL_UNPOOLED is not a usable Postgres URL"
  eval "$PG_EXPORTS"
  unset PG_EXPORTS
  for f in "${FILES[@]}"; do
    echo "==> psql migrations/$f"
    psql -X -v ON_ERROR_STOP=1 -q -f "migrations/$f"
  done
  unset PGPASSWORD
elif [ "$TARGET" = "production" ] && [ "${GO_LIVE_SCHEMA_CONFIRMED:-}" != "1" ]; then
  die "production deploy needs the database schema first.
  Either apply the migrations this code needs through the opt-in step:
    GO_LIVE_MIGRATIONS=\"0004_payments_schema.sql ...\" DATABASE_URL_UNPOOLED=... bun run go-live
  or apply them yourself (see PAYMENTS.md) and rerun with GO_LIVE_SCHEMA_CONFIRMED=1"
fi

# --- 3. build + deploy ---------------------------------------------------------
echo "==> building Vercel bundle"
VERCEL_ENV="$TARGET" bash ./build-vercel.sh

echo "==> deploying to $TARGET${VERCEL_SCOPE:+ (scope: $VERCEL_SCOPE)} with vercel@$VERCEL_CLI_VERSION"
DEPLOY_OUT="$("${VERCEL[@]}" deploy --prebuilt --yes "${TARGET_ARGS[@]}" \
  "${SCOPE_ARGS[@]}" 2>&1)" || {
  printf '%s\n' "$DEPLOY_OUT" >&2
  exit 1
}
DEPLOY_URL="$(printf '%s\n' "$DEPLOY_OUT" | grep -oE 'https://[a-zA-Z0-9._-]+\.vercel\.app' | head -1)"
ALIAS_URL="$(printf '%s\n' "$DEPLOY_OUT" | grep -iE 'alias|production' | grep -oE 'https://[a-zA-Z0-9._-]+' | tail -1 || true)"
LIVE_URL="${ALIAS_URL:-$DEPLOY_URL}"
[ -n "$LIVE_URL" ] || { printf '%s\n' "$DEPLOY_OUT" >&2; die "deploy finished but no URL was parsed"; }

# --- 4. deployment protection: read, never disable --------------------------
PROJECT_JSON="$(vercel_api GET "/v9/projects/${PROJECT_NAME}" || true)"
PROTECTION="$(printf '%s' "$PROJECT_JSON" | bun -e '
  const t = await Bun.stdin.text();
  try { const p = JSON.parse(t); process.stdout.write(p.ssoProtection ? p.ssoProtection.deploymentType : "none"); }
  catch { process.stdout.write("unknown"); }' 2>/dev/null || echo unknown)"
echo "==> deployment protection: $PROTECTION"
if [ "${GO_LIVE_SET_STANDARD_PROTECTION:-}" = "1" ] && [ "$PROTECTION" != "all_except_custom_domains" ]; then
  echo "==> setting Standard Protection (production domains public; previews protected)"
  vercel_api PATCH "/v9/projects/${PROJECT_NAME}" \
    '{"ssoProtection":{"deploymentType":"all_except_custom_domains"}}' >/dev/null ||
    echo "warning: could not update deployment protection" >&2
elif [ "$PROTECTION" = "none" ]; then
  echo "warning: deployment protection is OFF; previews share the production DB." >&2
  echo "         Turn on Standard Protection (or rerun with GO_LIVE_SET_STANDARD_PROTECTION=1)." >&2
elif [ "$PROTECTION" = "all" ]; then
  echo "note: protection is 'all'; the production domain may show a login wall." >&2
  echo "      Standard Protection keeps previews private and production public." >&2
fi

# --- 5. readiness (read-only) -------------------------------------------------
HEALTH="$(curl -s -o /dev/null -w '%{http_code}' "$LIVE_URL/api/health/payments" || true)"
case "$HEALTH" in
  200) echo "==> payments schema ready" ;;
  404) echo "note: /api/health/payments not in this build; check the schema manually" >&2 ;;
  503) echo "WARNING: payments schema NOT migrated: $LIVE_URL/api/health/payments" >&2 ;;
  401|403) echo "note: health check behind deployment protection (HTTP $HEALTH)" >&2 ;;
  *) echo "note: health check returned HTTP ${HEALTH:-none}" >&2 ;;
esac

echo "LIVE: $LIVE_URL"
