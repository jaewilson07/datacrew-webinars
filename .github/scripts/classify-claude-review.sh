#!/usr/bin/env bash
# Usage: classify-claude-review.sh <execution_file>
# Exit 0 and print the kind on stdout when the failure is a tooling failure;
# exit 1 for everything else (real review error, or no execution file).
#
# Tooling signature (observed 2026-10-14..18): the final result message has
# is_error true, num_turns <= 1 and total_cost_usd == 0. Keywords only name the
# kind AFTER that gate passes; a long, costly run whose text mentions "401" or
# "OAuth" is a review result, not tooling.
set -uo pipefail
f="${1:-}"
if [ -z "$f" ] || [ ! -s "$f" ]; then exit 1; fi
sig=$(jq -r '[.[] | select(.type == "result")] | last // {}
  | ((.is_error // false) == true and (.num_turns // 99) <= 1 and (.total_cost_usd // 1) == 0)' "$f" 2>/dev/null || echo false)
[ "$sig" = "true" ] || exit 1
text=$(jq -r '[.[] | select(.type == "result")] | last | (.result // "") | tostring' "$f" | tr '[:upper:]' '[:lower:]')
if printf '%s' "$text" | grep -Eq "usage limit|hit your limit|limit reached|rate.?limit|quota|overloaded|429"; then
  echo "usage or rate limit"
elif printf '%s' "$text" | grep -Eq "401|unauthori[sz]ed|authentication|oauth|invalid.*(token|api key)|login"; then
  echo "auth"
else
  echo "1-turn zero-cost error (limit or auth)"
fi
