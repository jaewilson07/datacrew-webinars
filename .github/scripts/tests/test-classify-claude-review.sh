#!/usr/bin/env bash
# Run: bash .github/scripts/tests/test-classify-claude-review.sh
here="$(cd "$(dirname "$0")" && pwd)"
c="$here/../classify-claude-review.sh"; fx="$here/claude-review-fixtures"
fail=0
check() { # name expected_exit file
  bash "$c" "$fx/$3" >/dev/null; got=$?
  if [ "$got" = "$2" ]; then echo "ok   $1"; else echo "FAIL $1 (exit $got, want $2)"; fail=1; fi
}
check "tooling: 1 turn, \$0, limit text"      0 tooling-limit.json
check "tooling: 1 turn, 0.0 cost"             0 tooling-1turn-float-cost.json
check "real: 38 turns, \$2.10, mentions 401"  1 real-38turn-mentions-oauth-401.json
check "real: 30 turns"                        1 real-30turn.json
check "not an error result"                   1 not-error-1turn.json
check "missing file is red"                   1 does-not-exist.json
exit $fail
