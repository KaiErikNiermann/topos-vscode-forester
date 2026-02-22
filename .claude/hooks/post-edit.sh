#!/usr/bin/env bash
# Post-edit hook: auto-fix deterministic ESLint issues after every file edit.
#
# Runs eslint --fix (fully deterministic, no AI) on the modified TypeScript file.
# Remaining non-auto-fixable issues are printed so the session can address them.
#
# For non-trivial fixes that need semantic reasoning, prefer invoking
# claude-haiku-4-5-20251001 (see CLAUDE.md §Model selection).
#
# Anti-recursion guard: if a haiku sub-agent edits files, it will also
# trigger this hook — the CLAUDE_HOOK_RUNNING env var prevents loops.

set -euo pipefail

# Guard against recursive invocation (e.g. haiku sub-agent fixing lint errors)
if [[ -n "${CLAUDE_HOOK_RUNNING:-}" ]]; then
    exit 0
fi
export CLAUDE_HOOK_RUNNING=1

# ── Parse the modified file path from tool-input JSON (passed on stdin) ───────
input=$(cat)

file=$(printf '%s' "$input" | python3 -c "
import sys, json
try:
    data = json.loads(sys.stdin.read())
    # tool_input may be nested or flat depending on hook event shape
    ti = data.get('tool_input', data)
    print(ti.get('file_path', ''))
except Exception:
    print('')
" 2>/dev/null || true)

# ── Guard: only process TypeScript source files ───────────────────────────────
if [[ -z "$file" ]]; then
    exit 0
fi

case "$file" in
    *.ts|*.mts) ;;   # proceed
    *) exit 0 ;;     # skip non-TS files
esac

# Skip generated and build-output files
case "$file" in
    */generated/*|*/out/*|*/dist/*|*.d.ts) exit 0 ;;
esac

# ── Run from project root ─────────────────────────────────────────────────────
project_root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
cd "$project_root"

# Skip if file doesn't exist (e.g. deleted)
if [[ ! -f "$file" ]]; then
    exit 0
fi

# ── eslint --fix: auto-correct deterministic issues ───────────────────────────
# (missing semicolons, spacing, prefer-includes, etc. — no AI needed)
./node_modules/.bin/eslint --fix --quiet "$file" 2>/dev/null || true

# ── Report remaining non-auto-fixable issues ──────────────────────────────────
remaining=$(./node_modules/.bin/eslint --format compact "$file" 2>&1 || true)

if [[ -n "$remaining" ]] && ! grep -q ": 0 problems" <<< "$remaining" 2>/dev/null; then
    echo ""
    echo "⚠️  Lint issues in ${file##$project_root/}:"
    echo "$remaining"
    echo ""
    echo "💡 For semantic fixes: claude --model claude-haiku-4-5-20251001 -p 'fix lint errors in $file'"
fi
