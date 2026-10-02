#!/usr/bin/env bash
INPUT=$(cat)
FILE=$(jq -r '.tool_input.file_path // empty' <<<"$INPUT")
[ -f "$FILE" ] || exit 0
case "$FILE" in *.prisma) ;; *) exit 0 ;; esac
cd "$(jq -r '.cwd' <<<"$INPUT")" || exit 0
OUTPUT=$(PRISMA_HIDE_UPDATE_MESSAGE=1 pnpm run --silent lint:prisma 2>&1) && exit 0
printf 'Prisma checks failed after editing %s. Fix all of them before continuing:\n%s\n' "$FILE" "$OUTPUT" >&2
exit 2
