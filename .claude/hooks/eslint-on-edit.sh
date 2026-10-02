#!/usr/bin/env bash
INPUT=$(cat)
FILE=$(jq -r '.tool_input.file_path // empty' <<<"$INPUT")
[ -f "$FILE" ] || exit 0
case "$FILE" in *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs) ;; *) exit 0 ;; esac
cd "$(jq -r '.cwd' <<<"$INPUT")" || exit 0
OUTPUT=$(pnpm exec eslint --cache --no-warn-ignored --max-warnings 0 "$FILE" 2>&1) && exit 0
printf 'ESLint found problems in %s. Fix all of them before continuing:\n%s\n' "$FILE" "$OUTPUT" >&2
exit 2
