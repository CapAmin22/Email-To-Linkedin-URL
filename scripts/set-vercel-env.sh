#!/usr/bin/env bash
# scripts/set-vercel-env.sh — Push all env vars to Vercel (production + preview + development)
# Usage: bash scripts/set-vercel-env.sh
# Run from the project root after `vercel link`

set -e

ENV_FILE=".env"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: .env file not found. Run from the project root."
  exit 1
fi

# Skip DATABASE_URL from Vercel (only used locally for migrations)
SKIP_KEYS="DATABASE_URL"

echo "Setting Vercel environment variables from $ENV_FILE..."
echo ""

while IFS= read -r line || [[ -n "$line" ]]; do
  # Skip comments and blank lines
  [[ "$line" =~ ^# ]] && continue
  [[ -z "$line" ]] && continue
  [[ "$line" != *=* ]] && continue

  KEY="${line%%=*}"
  VALUE="${line#*=}"

  # Skip keys in the skip list
  if [[ "$SKIP_KEYS" == *"$KEY"* ]]; then
    echo "  ⏭  Skipping $KEY (local only)"
    continue
  fi

  echo "  Setting $KEY..."
  # Set for all three environments
  printf '%s' "$VALUE" | vercel env add "$KEY" production  --force 2>/dev/null || true
  printf '%s' "$VALUE" | vercel env add "$KEY" preview     --force 2>/dev/null || true
  printf '%s' "$VALUE" | vercel env add "$KEY" development --force 2>/dev/null || true

done < "$ENV_FILE"

echo ""
echo "Done. Verify with: vercel env ls"
