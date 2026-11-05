"""Claude Code 세션(서브 에이전트) 기록 jsonl 에서 Manyfast read_project 응답 원문을 꺼내 항목별로 합쳐 스냅숏 JSON 을 쓴다.

    python3 sources/manyfast_snapshot.py sources/manyfast.json ~/.claude/projects/<프로젝트>/<세션>/subagents/agent-*.jsonl

스크립트는 MCP 를 직접 부르지 못한다. 그래서 에이전트가 read_project 를 항목 하나씩(field + itemIds, nextCursor 끝까지)
부른 기록을 원문 그대로 꺼낸다 — 모델이 본문을 옮겨 적지 않으므로 잘리거나 바뀌지 않는다.

항목(field, id)마다 cursor 없이 시작한 마지막 호출 사슬을 쓴다. fragment 는 offset 순으로 이어 붙여
pageComplete 가 되면 JSON 으로 푼다. 끝나지 않은(truncated 가 남은) 사슬은 쓰지 않는다.
"""
import json
import sys

out, srcs = sys.argv[1], sys.argv[2:]
uses, results = {}, {}
for line in (l for src in srcs for l in open(src, encoding="utf-8")):
    d = json.loads(line)
    for x in (d.get("message", {}).get("content") or []) if isinstance(d.get("message", {}).get("content"), list) else []:
        if x.get("type") == "tool_use" and x.get("name") == "mcp__manyfast__read_project":
            uses[x["id"]] = (d.get("timestamp", ""), len(uses), x["input"])
        elif x.get("type") == "tool_result" and x.get("tool_use_id"):
            c = x.get("content")
            text = c if isinstance(c, str) else "".join(p.get("text", "") for p in c if isinstance(p, dict))
            results[x["tool_use_id"]] = text

chains = {}  # (field, id) -> 끝까지 읽은 마지막 사슬
current = {}  # (field, id) -> 읽는 중인 사슬
for tid, (_, _, inp) in sorted(uses.items(), key=lambda kv: kv[1][:2]):
    if tid not in results or not inp.get("itemIds"):
        continue
    try:
        res = json.loads(results[tid])
    except json.JSONDecodeError:
        continue  # 오류 응답(stale_cursor 등)
    key = (inp["field"], inp["itemIds"][0])
    if not inp.get("cursor"):
        current[key] = []
    current.setdefault(key, []).append(res)
    if not res.get("truncated"):
        chains[key] = current.pop(key)


def assemble(responses):
    """사슬의 응답들 → 완성된 페이지 객체 목록."""
    pages, frag = [], []
    for r in responses:
        if "fragment" in r:
            frag.append(r["fragment"])
            if r["fragment"].get("pageComplete"):
                frag.sort(key=lambda f: f["offset"])
                text = "".join(f["text"] for f in frag)
                assert len(text) == frag[0]["totalLength"], (len(text), frag[0]["totalLength"])
                pages.append(json.loads(text))
                frag = []
        else:
            pages.append(r)
    if responses and responses[-1].get("truncated"):
        raise SystemExit("끝나지 않은 사슬")
    return pages


items = {"requirements": [], "features": [], "specs": []}
for (field, iid), responses in chains.items():
    pages = assemble(responses)
    found = [it for p in pages for it in (p.get("projectData", {}).get(field) or []) if it.get("id") == iid]
    if not found:
        print("없음", field, iid, [p.get("selection") for p in pages][:1])
        continue
    item = found[0]
    # 같은 항목이 여러 페이지에 나뉘어 왔으면 data 의 문자열 칸을 이어 붙이지 않고 마지막 완성본을 쓴다
    items[field].append(item)
# readAt 은 마지막으로 읽은 호출의 날짜(UTC)다
meta = {"readAt": max(t for t, _, _ in uses.values())[:10], "projectId": "9fd8001a-fa1b-4476-aaff-d11c90d8e747", "title": "Whale Erp",
        "method": "Manyfast MCP read_project 를 항목 하나씩(field + itemIds, pageSize 4000 · 16000, nextCursor 끝까지) 읽기만 함",
        "counts": {k: len(v) for k, v in items.items()}}
json.dump({**meta, **items}, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(meta["counts"])
