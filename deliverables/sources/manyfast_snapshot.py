"""Claude Code 세션 기록 jsonl 에서 Manyfast 응답 원문을 꺼내 스냅숏 JSON(sources/manyfast.json)을 쓴다.

    python3 sources/manyfast_snapshot.py sources/manyfast.json <세션>.jsonl <세션>/subagents/agent-*.jsonl

스크립트는 MCP 를 직접 부르지 못한다. 그래서 세션(과 서브 에이전트)이 부른 Manyfast 읽기 도구의 결과를 기록에서
원문 그대로 꺼낸다 — 모델이 본문을 옮겨 적지 않으므로 잘리거나 바뀌지 않는다. 기록은 그 세션의 것이라 다른 사람은
같은 스냅숏을 재현할 수 없다(계획 문서 「한계」).

- 항목: read_project 를 항목 하나씩(field + itemIds) 부른 호출 사슬 가운데 끝까지 읽은(truncated false) 마지막 사슬.
  fragment 는 offset 순으로 이어 붙여 pageComplete 가 되면 JSON 으로 푼다.
- 항목 수(totalCounts): 가장 늦은 read_project_meta 의 stats(totalRequirements · totalFeatures · totalSpecs).
- 기기 이름(devices): read_project 전체 읽기 응답의 projectData.prd.attribute.devices 가운데 가장 늦은 것.
"""
import json
import sys

PROJECT = "9fd8001a-fa1b-4476-aaff-d11c90d8e747"
out, srcs = sys.argv[1], sys.argv[2:]
calls, results = [], {}
for src in srcs:
    for line in open(src, encoding="utf-8"):
        d = json.loads(line)
        content = d.get("message", {}).get("content")
        for x in content if isinstance(content, list) else []:
            if x.get("type") == "tool_use" and x.get("name", "").startswith("mcp__manyfast__read_project"):
                calls.append((d.get("timestamp", ""), len(calls), x["name"], x["id"], x["input"]))
            elif x.get("type") == "tool_result" and x.get("tool_use_id"):
                c = x.get("content")
                results[x["tool_use_id"]] = c if isinstance(c, str) else "".join(
                    p.get("text", "") for p in c if isinstance(p, dict))
calls.sort()

chains, current, meta_stats, devices, read_dates = {}, {}, None, None, []
for ts, _, name, tid, inp in calls:
    if inp.get("projectId") != PROJECT or tid not in results:
        continue
    try:
        res = json.loads(results[tid])
    except json.JSONDecodeError:
        continue  # 오류 응답(stale_cursor 등)
    if name == "mcp__manyfast__read_project_meta":
        meta_stats = res.get("stats") or meta_stats
        continue
    if not inp.get("itemIds"):  # 전체 읽기: PRD 의 기기 이름만 쓴다
        found = ((res.get("projectData") or {}).get("prd") or {}).get("attribute", {}).get("devices")
        if found:
            devices = {x["id"]: x["name"] for x in found}
        continue
    key = (inp["field"], inp["itemIds"][0])
    if not inp.get("cursor"):
        current[key] = []
    current.setdefault(key, []).append(res)
    if not res.get("truncated"):
        chains[key] = current.pop(key)
        read_dates.append(ts)


def pages(responses):
    """사슬의 응답들 → 완성된 페이지 객체 목록(조각은 이어 붙여 푼다)."""
    done, frag = [], []
    for r in responses:
        if "fragment" not in r:
            done.append(r)
            continue
        frag.append(r["fragment"])
        if r["fragment"].get("pageComplete"):
            frag.sort(key=lambda f: f["offset"])
            text = "".join(f["text"] for f in frag)
            assert len(text) == frag[0]["totalLength"], (len(text), frag[0]["totalLength"])
            done.append(json.loads(text))
            frag = []
    return done


items = {"requirements": [], "features": [], "specs": []}
for (field, iid), responses in chains.items():
    found = [it for p in pages(responses) for it in (p.get("projectData", {}).get(field) or []) if it.get("id") == iid]
    if not found:
        raise SystemExit(f"사슬에 항목이 없습니다: {field} {iid}")
    items[field].append(found[-1])  # 사슬의 마지막 완성본(앞 페이지에 같은 항목이 걸쳐 있어도 끝의 것)
if not meta_stats:
    raise SystemExit("read_project_meta 결과가 기록에 없습니다. 항목 수를 대조할 수 없습니다.")
if not devices:
    raise SystemExit("PRD 의 기기 목록(prd.attribute.devices)이 기록에 없습니다.")
snapshot = {
    "readAt": max(read_dates)[:10],  # 마지막으로 읽은 항목 호출의 날짜(UTC)
    "projectId": PROJECT, "title": "Whale Erp",
    "method": "Manyfast MCP read_project 를 항목 하나씩(field + itemIds, nextCursor 끝까지) 읽기만 함. "
              "항목 수는 read_project_meta 의 stats",
    "totalCounts": {"requirements": meta_stats["totalRequirements"], "features": meta_stats["totalFeatures"],
                    "specs": meta_stats["totalSpecs"]},
    "counts": {k: len(v) for k, v in items.items()},
    "devices": devices,
    **items,
}
with open(out, "w", encoding="utf-8") as f:
    json.dump(snapshot, f, ensure_ascii=False, indent=1)
    f.write("\n")
print(snapshot["totalCounts"], snapshot["counts"], devices)
