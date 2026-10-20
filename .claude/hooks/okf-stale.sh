#!/bin/bash
# Stop hook: if a file documented in okf/ changed but okf/ didn't, hand the work back to Claude.
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
[ "$(jq -r '.stop_hook_active // false')" = true ] && exit 0

changed=$(git status --porcelain | awk '{print $NF}')
echo "$changed" | grep -q '^okf/' && exit 0

# concept 은 okf/<그룹>/*.md 라 resource 가 ../../ 로 시작한다 — 앞의 ../ 를 전부 떼고 저장소 기준 경로로 맞춘다
hits=""
for s in $(find okf -name '*.md' -exec sed -n 's/.*resource: //p' {} + | sed 's#^\(\.\./\)*##' | sort -u); do
  echo "$changed" | grep -q "^$s" && hits="$hits $s"
done
[ -z "$hits" ] && exit 0

jq -cn --arg f "${hits# }" '{
  decision: "block",
  reason: ("okf/ 가 갱신되지 않았다. 변경된 문서화 대상:" + $f + " — 해당 concept 본문과 generated.at 을 갱신하고 okf/log.md 에 한 줄 남겨라.")
}'
