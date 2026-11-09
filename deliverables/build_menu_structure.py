"""메뉴구조도(WHALE-MENU) — sources/menus.json(메뉴 테이블 스냅숏)을 엑셀로 낸다.

    .venv/bin/python build_menu_structure.py --version 1.0

스냅숏은 일회용 로컬 Postgres 에 prisma/migrations 를 모두 적용한 뒤 menus 를 읽은 것이다(계획 문서의 「실행」).
스냅숏 행 수와 문서 줄 수가 다르거나, 스냅숏의 마지막 마이그레이션이 저장소의 마지막 것과 다르면(낡음) 멈춘다.
"""
import argparse
import json
import os

from common import HERE, open_xlsx, record_basis, save_xlsx, table_sheet

SNAPSHOT = os.path.join(HERE, "sources", "menus.json")
MIGRATIONS = os.path.join(HERE, "..", "prisma", "migrations")
HEADERS = ["서비스", "깊이", "메뉴 이름", "URL", "정렬 순서", "사용 여부", "삭제 여부", "권한 단위(메뉴 코드)", "상위 메뉴"]
WIDTHS = [22, 6, 36, 34, 9, 9, 9, 18, 24]
STATUS = {"ACTIVE": "사용", "INACTIVE": "사용중지"}
CLIENT = "관리자 웹"  # 메뉴 테이블의 서비스는 모두 관리자 웹 메뉴다. 직원 근무 앱 메뉴는 DB 에 없다.


def tree_rows(snap):
    """서비스 순서 → 깊이 우선(같은 부모 안에서는 정렬 순서 · ID 순)으로 줄을 만든다."""
    menus = snap["menus"]
    label = {s["code"]: s["label"] for s in snap["services"]}
    order = {s["code"]: s["sort_order"] for s in snap["services"]}
    by_id = {m["menu_id"]: m for m in menus}
    children = {}
    for m in menus:
        children.setdefault(m["parent_menu_id"], []).append(m)
    for v in children.values():
        v.sort(key=lambda m: (m["sort_order"], m["menu_id"]))
    rows = []

    def walk(m):
        parent = by_id.get(m["parent_menu_id"])
        rows.append((m["service_code"], [
            label.get(m["service_code"], m["service_code"]), m["depth"], "    " * (m["depth"] - 1) + m["name"],
            m["url"] or "", m["sort_order"], STATUS.get(m["status"], m["status"]), "Y" if m["is_deleted"] else "N",
            m["menu_code"], parent["name"] if parent else ""]))
        for c in children.get(m["menu_id"], []):
            walk(c)

    roots = sorted(children.get(None, []), key=lambda m: (order.get(m["service_code"], 99), m["sort_order"], m["menu_id"]))
    for r in roots:
        walk(r)
    # 부모가 스냅숏에 없는 메뉴(있으면 안 된다)도 빠뜨리지 않는다
    seen = {r[1][7] for r in rows}
    rows += [(m["service_code"], [label.get(m["service_code"], m["service_code"]), m["depth"], m["name"], m["url"] or "",
                                  m["sort_order"], STATUS.get(m["status"], m["status"]),
                                  "Y" if m["is_deleted"] else "N", m["menu_code"], f"(없는 상위 {m['parent_menu_id']})"])
             for m in menus if m["menu_code"] not in seen]
    return rows, label


def basis(snap):
    return f"마이그레이션 {snap['lastMigration'].split('_')[0]}"


def write(version):
    """엑셀을 쓰고 (경로, 메뉴 수, 서비스별 수) 를 돌려준다."""
    snap = json.load(open(SNAPSHOT, encoding="utf-8"))
    latest = max(d for d in os.listdir(MIGRATIONS) if os.path.isdir(os.path.join(MIGRATIONS, d)))
    if snap["lastMigration"] != latest:
        raise SystemExit(f"메뉴 스냅숏이 낡았습니다: 스냅숏 {snap['lastMigration']} · 저장소 {latest}. "
                         "계획 문서 「실행」대로 menus.json 을 다시 만들어 주세요.")
    rows, label = tree_rows(snap)
    if not (len(rows) == len(snap["menus"]) == snap["menuCount"]):
        raise SystemExit(f"메뉴 테이블 {snap['menuCount']} · 스냅숏 {len(snap['menus'])} · 문서 {len(rows)} 이 다릅니다.")
    wb, doc_name, doc_no = open_xlsx("MENU", version)
    notes = [("원본", f"menus 테이블 — {snap['source']}. 마지막 마이그레이션 {snap['lastMigration']}, 읽은 날 {snap['readAt']}"),
             ("클라이언트", f"아래 메뉴는 모두 {CLIENT} 메뉴다. 직원 근무 앱 메뉴는 DB 에 없음."),
             ("권한", "권한 그룹마다 메뉴 코드 단위로 조회 · 등록 · 수정 · 삭제를 켠다(role_group_menus).")]
    table_sheet(wb, "메뉴 트리", HEADERS, [r for _, r in rows], WIDTHS, top_rows=notes)
    counts = {}
    for code, r in rows:
        counts.setdefault(code, []).append(r)
    for code, rs in counts.items():
        table_sheet(wb, f"{CLIENT} - {label.get(code, code)}"[:31], HEADERS, rs, WIDTHS, top_rows=notes[:1])
    path = save_xlsx(wb, doc_name, f"{doc_no}_{doc_name}.xlsx")
    record_basis("MENU", version, path, basis(snap))
    return path, len(rows), {label.get(k, k): len(v) for k, v in counts.items()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", required=True)
    path, n, counts = write(ap.parse_args().version)
    print(f"{path}\n메뉴 {n} · " + " · ".join(f"{k} {v}" for k, v in counts.items()))


if __name__ == "__main__":
    main()
