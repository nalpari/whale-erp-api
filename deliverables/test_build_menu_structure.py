"""메뉴구조도 자체 검사 — .venv/bin/python test_build_menu_structure.py

1) 작은 스냅숏으로 트리 순서를 확인하고, 2) 실제 스냅숏의 메뉴 테이블 행 수와 「메뉴 트리」 시트 줄 수가 같은지 본다.
"""
from openpyxl import load_workbook

import build_menu_structure as B

snap = {"services": [{"code": "W", "label": "웨일", "sort_order": 1}, {"code": "P", "label": "플랫폼", "sort_order": 2}],
        "menus": [
            {"menu_id": 3, "menu_code": "MN3", "service_code": "P", "parent_menu_id": None, "name": "시스템",
             "url": None, "sort_order": 1, "depth": 1, "status": "ACTIVE", "is_deleted": False},
            {"menu_id": 1, "menu_code": "MN1", "service_code": "W", "parent_menu_id": None, "name": "직원",
             "url": None, "sort_order": 2, "depth": 1, "status": "ACTIVE", "is_deleted": False},
            {"menu_id": 2, "menu_code": "MN2", "service_code": "W", "parent_menu_id": 1, "name": "직원 목록",
             "url": "/staff", "sort_order": 1, "depth": 2, "status": "INACTIVE", "is_deleted": False},
            {"menu_id": 4, "menu_code": "MN4", "service_code": "W", "parent_menu_id": None, "name": "홈",
             "url": "/", "sort_order": 1, "depth": 1, "status": "ACTIVE", "is_deleted": True}]}
rows, _ = B.tree_rows(snap)
assert [r[1][7] for r in rows] == ["MN4", "MN1", "MN2", "MN3"]  # 서비스 순서 → 정렬 순서 → 자식
assert rows[2][1] == ["웨일", 2, "    직원 목록", "/staff", 1, "사용중지", "N", "MN2", "직원"]
assert rows[0][1][6] == "Y"

path, n, counts = B.write("1.0")
snapshot = B.json.load(open(B.SNAPSHOT, encoding="utf-8"))
ws = load_workbook(path)["메뉴 트리"]
head = next(r for r in range(1, ws.max_row + 1) if ws.cell(r, 1).value == "서비스")
lines = sum(1 for r in range(head + 1, ws.max_row + 1) if ws.cell(r, 8).value)
assert snapshot["menuCount"] == len(snapshot["menus"]) == n == lines == sum(counts.values()), (snapshot["menuCount"], lines)
print(f"ok — 메뉴 테이블 {snapshot['menuCount']} = 문서 {lines}")
