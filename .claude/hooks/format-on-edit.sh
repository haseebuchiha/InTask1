#!/usr/bin/env bash
INPUT=$(cat)
FILE=$(jq -r '.tool_input.file_path // empty' <<<"$INPUT")
is_formattable() {
  [ -f "$FILE" ] || return 1
  case "$FILE" in "$CLAUDE_PROJECT_DIR"/*) ;; *) return 1 ;; esac
  case "$FILE" in *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.mts|*.cts|*.json|*.jsonc|*.css) return 0 ;; esac
  return 1
}
if is_formattable; then
  OUTPUT=$(cd "$CLAUDE_PROJECT_DIR" && pnpm exec biome check --write --no-errors-on-unmatched --files-ignore-unknown=true "$FILE" 2>&1) || {
    printf 'Biome could not format %s. Fix the problem before continuing:\n%s\n' "$FILE" "$OUTPUT" >&2
    exit 2
  }
fi
exec "$CLAUDE_PROJECT_DIR"/.claude/hooks/eslint-on-edit.sh <<<"$INPUT"
