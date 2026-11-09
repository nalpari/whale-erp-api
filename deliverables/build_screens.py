"""화면설계서(WHALE-SCR) — 두 저장소 docs/demo 를 찍은 이미지와 sources/screens/areas/*.json 을 워드로 낸다.

    .venv/bin/python build_screens.py --capture                # origin/main 데모를 찍어 sources/screens/ 를 다시 만든다
    .venv/bin/python build_screens.py --version 1.0 --draft    # 설명 행이 비어 있어도 낸다(1단계)
    .venv/bin/python build_screens.py --version 1.0

장 = 클라이언트(관리자 웹 · 직원 근무 앱 · 비로그인 화면), 절 = 영역, 화면마다 정보 표 · 이미지 · 설명 표. 데모 원본은 고치지 않는다.
찍기 전 DOM 에서만 가리고(TEXT_FIXES · DEMO_BUTTONS · HIDE_CSS), 이미지 글자는 찍을 때 보이는 글자로 점검한다. 계획은 docs/plans/2026-11-09-deliverables-screens.md.
"""
import argparse
import fnmatch
import glob
import json
import os
import re
import shutil
import subprocess
import tarfile
import tempfile
from io import BytesIO

from docx.image.image import Image
from docx.shared import Cm

from common import (EMAIL, HERE, INTERNAL, OUT, PHONE, TEAM, TEAM_NAMES, heading, open_docx, para, picture, safe, save_docx,
                    table)
from build_policy import RULE_IDS


ROOT = os.path.join(HERE, "sources", "screens")
AREAS = os.path.join(ROOT, "areas")
IMG = os.path.join(ROOT, "img")
SOURCE_JSON = os.path.join(ROOT, "SOURCE.json")
VISIBLE_JSON = os.path.join(OUT, "screens_visible_text.json")  # 찍을 때의 보이는 글자. 커밋하지 않는다(점검은 찍을 때 이미 끝난다)
EXCLUDED_JSON = os.path.join(ROOT, "excluded.json")
MENUS_JSON = os.path.join(HERE, "sources", "menus.json")
V2 = os.path.expanduser("~/IdeaProjects/whale-erp-v2")
REPOS = {"admin": "whale-erp-front", "staff": "whale-erp-staff"}  # 비로그인 화면(public)은 front 데모다
CLIENTS = [("admin", "관리자 웹"), ("staff", "직원 근무 앱"), ("public", "비로그인 화면")]
VIEW = {"admin": (1440, 900, 1), "staff": (390, 844, 2), "public": (1720, 900, 1)}  # 비로그인 화면은 고정 폭 1720 디자인이라 이 폭으로 찍는다
SLICE = {"admin": 1900, "staff": 1100, "public": 1900}  # 긴 화면을 자르는 높이(CSS px). 한 장이 워드 한 쪽에 들어가는 값
WIDTH_CM = {"admin": 15, "staff": 7, "public": 15}
MAX_HEIGHT_CM = 20
GROW = 1800  # 안쪽 스크롤을 펴려고 뷰포트를 늘리는 한도
QUALITY = 72
HEADERS = ["구역", "구성 요소", "동작", "관련 운영 정책 번호"]
WIDTHS = [2.6, 4, 6.1, 2.5]

# 찍기 전에 넣는 CSS: 직원 근무 앱 상태 도구를 가리고, 관리자 웹 프레임의 디자인 최소 폭을 푼다(계획 문서).
HIDE_CSS = ('details:has([data-demo-pick]){display:none!important}'
            '*,*::before,*::after{transition:none!important;animation:none!important}')
# 직원 근무 앱 하단 탭은 sticky 라 전체 쪽을 찍으면 본문 중간에 겹친다. 흐름 배치로 본문 맨 아래에 둔다.
STAFF_CSS = '[class~="sticky"][class~="bottom-0"]{position:static!important}'
FIT_1440 = '[class*="min-w-[1720px]"]{min-width:0!important}'  # 관리자 웹만. 안 풀면 1440 뷰포트에서 표 · 패널 오른쪽이 잘린다

# 찍기 전 DOM 에서 지우는 쟁점 표시 · 안내 문구 (화면 파일 glob, 정규식, 바꿀 글). 못 찾으면 멈춘다. 원본은 고치지 않는다.
TEXT_FIXES = [
    ("contract/index.html#*", r"^문구 확정 전$", ""),  # 제4조 · 제7조: 조항 제목만 남는다(보고 목록)
    ("contract/index.html#*", r"\s*— 노무사 검토 중입니다\.$", ""),
    ("contract/index.html#*", r"\s*— 문구는 노무사 검토 중\(PAY-5\)", ""),
    ("check-in/index.html#consent", r"\s*동의서 항목·문구는 법무 검토 중\(ATT-8\)", ""),
    ("pay/index.html#detail", r"\s*끝자리 세무 확인 대기\(PAY-7\)", ""),
    ("staff/payrolls-detail.html", r"\(PAY-22\)", "(운영 정책 PAY-22)"),
    ("system/menus-master.html", r" · 목업 표본에서 생략", ""),
    # 없앤 상태 · 옛 표현
    ("staff/index.html", r"^가입·인증$", "가입 상태"),
    ("staff/contracts.html", r" · 연결 보류$", ""),
    ("home/index.html", r"휴대폰 본인인증과 ", ""),
    # 운영자 메모의 내부 말투: 메모 칸을 비운다
    ("support/inquiry-detail.html", r"(?s)^계약서에 소정근로시간이 주 14시간으로.*", ""),
    ("support/lead-detail.html", r"(?s)^본사\(㈜한강상회\)가 이미 FRANCHISE PLAN.*", ""),
]

# 찍기 전에 숨기는 데모 이동 전용 버튼 (화면 키 glob, 버튼 글자). 못 찾으면 멈춘다. 원본은 고치지 않는다.
DEMO_BUTTONS = [
    ("login/index.html#find", "맞지 않는 경우 보기"),
    ("join/index.html#code", "번호나 코드가 맞지 않으면?"),
    ("join/index.html#invite", "이 번호로 계정이 이미 있으면?"),
    ("join/index.html#invite", "이미 가입을 마친 초대면?"),
    ("join/index.html#invite", "만료된 초대면?"),
    ("join/index.html#signup", "만 19세 미만이면?"),
    ("join/index.html#signup", "초대 링크로 왔으면?"),
    ("join/index.html#done", "종이 계약이면 · 신고 정보 입력"),
    ("check-in/index.html#ready", "이미 출근한 상태로 눌러 보기"),
    ("check-in/index.html#consent", "이미 출근한 상태로 눌러 보기"),
]

# 찍기 전에 숨기는 줄 (화면 키 glob, 숨길 요소 선택자, 그 요소 글자의 정규식). 못 찾으면 멈춘다. 없앤 상태 · 옛 표현.
HIDE_ROWS = [
    ("staff/index.html", "label", r"^연결 보류$"),
    ("staff/index.html", "tr", r"연결 보류 · 4일"),  # 표의 한 줄이 빠진다(보고 목록)
    ("staff/detail.html", "div:has(> dt)", r"^본인인증"),
    ("notify/templates.html", "tr", r"가입 연결 보류"),  # 표의 한 줄이 빠진다(보고 목록)
]
# 실제 상호가 읽히는 점포 사진은 회색 자리표시로 바꾼다.
SIGN_PHOTOS = ("store-photo-1.", "store-photo-2.", "store-photo-5.")
# 이미지를 싣지 않는 화면. 약관 전문은 본문이 초안이라 화면 구성 설명만 싣는다. 이 화면만 예외다.
NO_IMAGE = {"SCR-PUB-013"}
# 데모에 실제 값일 수 있어 따로 대조하는 휴대전화번호. 치환 뒤 보이는 글자에 있으면 멈춘다.
KNOWN_PHONES = ("010-4821-7730", "010-5520-3141", "010-2290-5173", "010-5521-3380", "010-2291-7730", "010-5530-1182",
                "010-3321-0981")
MASKED_PHONE = re.compile(r"01[016789][-\s]*\*{2,}[-\s]*\d{0,4}")
PHONE_JSON = os.path.join(OUT, "screens_phone_check.json")

# 납품본 점검. 쟁점 번호: 운영 정책 번호는 「운영 정책 」을 붙인 것만 통과한다.
ISSUE = re.compile(r"(?<!운영 정책 )(?<![A-Za-z0-9_-])[A-Z]{2,}-\d+")
TOOLS = re.compile(r"Manyfast|Plane|BUZZ|Figma|Claude|Orca|DESIGN\.md|목업|데모|시안")
REPO_PATH = re.compile(r"whale-erp-(?:v2|api|front|staff)|docs/(?:demo|mockup|flow)|src/(?:app|pages)|\.mjs\b")
MEMO = re.compile(r"미정(?!산)|협의|보류|TBD|법무|노무사|검토 중|확인 중|확정 전|세무 확인|추후|쟁점")
# 미결 메모처럼 보이는 업무어 (화면 파일 glob, 지울 글). 점검 전에 빼고 본다.
MEMO_ALLOW = [
    ("*", "시간 미정"),  # TO-DO 수행 예정 일시에 시간이 없을 때
    ("notify/index.html", "협의한 날과 다릅니다"),  # 예시 거부 사유
    ("staff/payslips.html", "검토 중"),  # 급여명세서 상태
    ("staff/contracts.html", "소속 확인 중"),  # 소속 추가 확인 진행 표시
]
FAKE_PHONES = {"010-1234-5678", "01012345678"}
OLD_TERMS = re.compile(r"본인인증|가입·인증")  # 없앤 표현. 「연결 보류」는 MEMO 의 「보류」로 걸린다


def leaks(text, key=""):
    """납품본에 남으면 안 되는 것을 찾는다. key 는 데모 파일(MEMO_ALLOW 범위)."""
    t = text
    for pat, phrase in MEMO_ALLOW:
        if fnmatch.fnmatch(key.split("#")[0], pat):
            t = t.replace(phrase, "")
    found = []
    for name, rx in (("쟁점 번호", ISSUE), ("팀 표시", TEAM), ("팀원 실명", TEAM_NAMES), ("내부 표지", INTERNAL),
                     ("내부 도구", TOOLS), ("저장소 경로", REPO_PATH), ("미결 메모", MEMO), ("없앤 표현", OLD_TERMS)):
        found += [f"{name}: {m.group()}" for m in rx.finditer(t)]
    # 뒤에 조사가 붙으면(「…@example.com로」) common.EMAIL 의 \b 가 안 걸려 바뀐 값도 잡힌다
    found += [f"실제 이메일: {m.group()}" for m in EMAIL.finditer(t) if "@example.com" not in m.group()]
    found += [f"휴대전화번호: {m.group()}" for m in PHONE.finditer(t) if m.group() not in FAKE_PHONES]
    found += [f"데모 휴대전화번호: {p}" for p in KNOWN_PHONES if p in t or p.replace("-", "") in t]
    return sorted(set(found))


# ── 데이터 ──

def load_areas():
    """[(파일 경로, 영역 dict)]. 파일 이름 순서가 문서 순서."""
    files = sorted(glob.glob(os.path.join(AREAS, "*.json")))
    if not files:
        raise SystemExit(f"{AREAS} 에 영역 파일이 없습니다.")
    return [(f, json.load(open(f, encoding="utf-8"))) for f in files]


def save_area(path, area):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(area, f, ensure_ascii=False, indent=2)
        f.write("\n")


def screens():
    return [(a, s) for _, a in load_areas() for s in a["screens"]]


def menu_tree():
    """메뉴구조도 순서(서비스 정렬 · 깊이 우선)의 말단 메뉴 [(menu_code, 위치 글, status)]."""
    snap = json.load(open(MENUS_JSON, encoding="utf-8"))
    order = {s["code"]: (s["sort_order"], s["label"]) for s in snap["services"]}
    children = {}
    for m in snap["menus"]:
        children.setdefault(m["parent_menu_id"], []).append(m)
    for v in children.values():
        v.sort(key=lambda m: (m["sort_order"], m["menu_id"]))
    leaves = []

    def walk(m, trail):
        kids = children.get(m["menu_id"], [])
        if not kids:
            leaves.append((m["menu_code"], " > ".join(trail + [m["name"]]), m["status"]))
        for c in kids:
            walk(c, trail + [m["name"]])

    for r in sorted(children.get(None, []), key=lambda m: (order[m["service_code"]][0], m["sort_order"], m["menu_id"])):
        walk(r, [order[r["service_code"]][1]])
    return leaves


def key_of(s):
    d = s["demo"]
    return d["file"] + (f"#{d['state']}" if d.get("state") else "")


# ── 캡처 ──

def _export(repo, dst):
    """origin/main 의 docs/demo 를 임시 폴더에 푼다. 체크아웃은 건드리지 않는다. (커밋, 커밋 시각)"""
    root = os.path.join(V2, repo)
    commit = subprocess.check_output(["git", "-C", root, "rev-parse", "origin/main"], text=True).strip()
    date = subprocess.check_output(["git", "-C", root, "log", "-1", "--format=%cI", commit], text=True).strip()
    data = subprocess.check_output(["git", "-C", root, "archive", commit, "docs/demo"])
    with tarfile.open(fileobj=BytesIO(data)) as tar:
        tar.extractall(dst, filter="data")
    return commit, date


_TEXTS = """() => {
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT), n = [];
  while (w.nextNode()) n.push(w.currentNode);
  n.push(...document.querySelectorAll('input,textarea'));
  document.querySelectorAll('[placeholder]').forEach(e => n.push({ ph: e }));
  window.__nodes = n;
  return n.map(x => x.ph ? x.ph.placeholder : x.nodeType === 3 ? x.nodeValue : x.value);
}"""
_SET = """v => window.__nodes.forEach((x, i) => {
  if (x.ph) x.ph.placeholder = v[i]; else if (x.nodeType === 3) x.nodeValue = v[i]; else x.value = v[i];
})"""
# 보이는 글자: innerText + 자리표시 글자. 입력값은 점검에만 쓰고 저장하지 않는다(values). 비밀번호 칸 값은 점검에서도 뺀다.
_VISIBLE = """() => {
  const f = [...document.querySelectorAll('input,textarea')].filter(e => e.offsetParent);
  return { text: [document.body.innerText, ...f.map(e => e.placeholder).filter(Boolean)].join('\\n'),
           values: f.filter(e => e.type !== 'password').map(e => e.value).filter(Boolean).join('\\n') };
}"""
_HIDE_ROW = """([sel, rx]) => {
  const r = new RegExp(rx);
  const hit = [...document.querySelectorAll(sel)].filter(e => e.getClientRects().length && r.test(e.innerText.trim()));
  hit.forEach(e => { e.style.display = 'none'; });
  return hit.length;
}"""
_GRAY_PHOTO = """names => {
  let n = 0;
  document.querySelectorAll('img').forEach(i => {
    if (names.some(x => (i.getAttribute('src') || '').includes(x))) {
      i.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1' height='1'/%3E";
      i.style.background = '#d9dde2';
      n++;
    }
  });
  return n;
}"""
# 휴대전화번호 대조: 치환 전 글자를 보이는 곳과 숨김 영역(닫힌 팝업 · 안 보이는 상태 · 속성값)으로 나눈다.
_PHONE_SCAN = """() => {
  const seen = e => e.checkVisibility && e.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true });
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT), vis = [], hid = [];
  while (w.nextNode()) (w.currentNode.parentElement && seen(w.currentNode.parentElement) ? vis : hid).push(w.currentNode.nodeValue);
  document.querySelectorAll('input,textarea').forEach(e => { if (e.type !== 'password') (seen(e) ? vis : hid).push(e.value); });
  document.querySelectorAll('*').forEach(e => { for (const a of e.attributes) if (/01[016789]/.test(a.value)) hid.push(a.value); });
  return { visible: vis.join('\\n'), hidden: hid.join('\\n') };
}"""
_HIDE_BUTTON = """t => {
  const hit = [...document.querySelectorAll('button,a')]
    .filter(e => e.getClientRects().length && e.innerText.replace(/\\s+/g, ' ').trim() === t);
  hit.forEach(e => { e.style.display = 'none'; });
  return hit.length;
}"""
_SCROLL = """() => {
  let m = 0;
  for (const e of document.querySelectorAll('*')) {
    const s = getComputedStyle(e);
    if (/(auto|scroll)/.test(s.overflowY) && e.clientHeight > 400 && e.scrollHeight > e.clientHeight + 2 && e.getClientRects().length)
      m = Math.max(m, e.scrollHeight - e.clientHeight);
  }
  return m;
}"""


def _fix_text(page, key, used):
    """글자 노드 · 입력값에 TEXT_FIXES 와 safe 를 건다."""
    vals = page.evaluate(_TEXTS)
    out = []
    for v in vals:
        for i, (pat, rx, rep) in enumerate(TEXT_FIXES):
            if fnmatch.fnmatch(key, pat):
                v2 = re.sub(rx, rep, v)
                if v2 != v:
                    used.add(i)
                v = v2
        out.append(safe(v))
    page.evaluate(_SET, out)


def _shoot(page, client, sid):
    """전체 쪽을 JPEG 로 찍고 길면 자른다. 이미지 파일 이름 목록."""
    size = page.evaluate("[document.documentElement.scrollWidth, document.documentElement.scrollHeight]")
    w, h = size
    if h < 200 or w < 300:
        raise RuntimeError(f"페이지 크기 {size}")
    names = []
    if client == "staff" and page.locator("dialog[open]").count():  # 바텀시트는 화면 아래에 붙어 있어 뷰포트만 찍는다
        page.screenshot(path=os.path.join(IMG, f"{sid}.jpg"), type="jpeg", quality=QUALITY)
        return [f"{sid}.jpg"]
    y, n = 0, 1
    while y < h:
        name = f"{sid}.jpg" if n == 1 else f"{sid}-{n}.jpg"
        tall = h - y if h - y - SLICE[client] < 150 else SLICE[client]  # 끝에 조금 남으면 앞 장에 붙인다
        page.screenshot(path=os.path.join(IMG, name), type="jpeg", quality=QUALITY, full_page=True,
                        clip={"x": 0, "y": y, "width": w, "height": tall})
        names.append(name)
        y += tall
        n += 1
    return names


def _check_pages(all_demo, used_keys):
    """데모의 모든 페이지 · 상태는 화면이거나 excluded.json 에 있어야 한다."""
    excluded = json.load(open(EXCLUDED_JSON, encoding="utf-8"))
    missing = sorted(set(all_demo) - used_keys - set(excluded))
    extra = sorted(set(excluded) & used_keys)
    if missing or extra:
        raise SystemExit(f"화면이나 제외 목록에 없는 데모: {missing}\n화면과 제외 목록에 다 있는 데모: {extra}")


def capture():
    from playwright.sync_api import sync_playwright
    shutil.rmtree(IMG, ignore_errors=True)
    os.makedirs(IMG)
    source, visible, all_demo, used, hidden = {}, {}, [], set(), set()
    rows_hidden, phones = set(), {}
    areas = load_areas()
    with tempfile.TemporaryDirectory() as tmp, sync_playwright() as pw:
        browser = pw.chromium.launch()
        pages = {}
        roots = {}
        for client, repo in REPOS.items():
            dst = os.path.join(tmp, client)
            os.makedirs(dst)
            commit, date = _export(repo, dst)
            source[client] = {"repo": repo, "ref": "origin/main", "commit": commit, "committedAt": date}
            roots[client] = os.path.join(dst, "docs", "demo")
        for pat in glob.glob("**/*.html", root_dir=roots["admin"], recursive=True):
            if not pat.startswith(("_check/", "src/", "kit")) and pat != "index.html":
                all_demo.append(pat)
        for client in ("admin", "staff", "public"):
            w, h, ratio = VIEW[client]
            pages[client] = browser.new_page(viewport={"width": w, "height": h}, device_scale_factor=ratio,
                                             color_scheme="light")
        staff = pages["staff"]
        for pat in glob.glob("*/index.html", root_dir=roots["staff"]):
            if pat.startswith(("src/", "assets/")):
                continue
            staff.goto("file://" + os.path.join(roots["staff"], pat))
            all_demo += [f"{pat}#{x}" for x in staff.evaluate("[...document.querySelectorAll('[data-state]')].map(e => e.dataset.state)")]

        used_keys = {key_of(s) for _, a in areas for s in a["screens"]}
        _check_pages(all_demo, used_keys)
        for path, area in areas:
            client = area["client"]
            page = pages[client]
            w, h, _ = VIEW[client]
            root = roots["staff" if client == "staff" else "admin"]
            for s in area["screens"]:
                key = key_of(s)
                if s["id"] in NO_IMAGE:
                    s["images"] = []
                    continue
                try:
                    page.set_viewport_size({"width": w, "height": h})
                    page.goto("file://" + os.path.join(root, s["demo"]["file"]))
                    page.wait_for_load_state("load")
                    page.add_style_tag(content=HIDE_CSS + (FIT_1440 if client == "admin" else STAFF_CSS if client == "staff" else ""))
                    state = s["demo"].get("state")
                    if state:
                        page.evaluate("s => { location.hash = s; }", state)
                        page.wait_for_selector(f'[data-state="{state}"]:not([hidden])', timeout=3000)
                        page.wait_for_timeout(200)
                    page.evaluate("document.fonts.ready")
                    page.wait_for_timeout(150)
                    page.set_viewport_size({"width": w, "height": h + min(page.evaluate(_SCROLL), GROW)})
                    page.wait_for_timeout(150)
                    for i, (pat, label) in enumerate(DEMO_BUTTONS):
                        if fnmatch.fnmatch(key, pat) and page.evaluate(_HIDE_BUTTON, label):
                            hidden.add(i)
                    for i, (pat, sel, rx) in enumerate(HIDE_ROWS):
                        if fnmatch.fnmatch(key, pat) and page.evaluate(_HIDE_ROW, [sel, rx]):
                            rows_hidden.add(i)
                    page.evaluate(_GRAY_PHOTO, list(SIGN_PHOTOS))
                    before = page.evaluate(_PHONE_SCAN)
                    _fix_text(page, key, used)
                    seen = page.evaluate(_VISIBLE)
                    text = seen["text"]
                    phones[s["id"]] = {
                        "visibleBefore": sorted({p for p in KNOWN_PHONES if p in before["visible"] or p.replace("-", "") in before["visible"]}),
                        "hiddenBefore": sorted({p for p in KNOWN_PHONES if p in before["hidden"] or p.replace("-", "") in before["hidden"]}),
                        "maskedAfter": sorted(set(MASKED_PHONE.findall(f"{text}\n{seen['values']}"))),
                    }
                    bad = leaks(f"{text}\n{seen['values']}", key)
                    if bad:
                        raise RuntimeError(f"이미지 글자에 내부 표시: {bad}")
                    s["images"] = _shoot(page, client, s["id"])
                    visible[s["id"]] = text
                except Exception as e:  # 빈 칸을 두지 않는다
                    raise SystemExit(f"{s['id']} ({key}) 을 찍지 못했습니다: {e}")
            save_area(path, area)
        browser.close()
    lost = [TEXT_FIXES[i][:2] for i in range(len(TEXT_FIXES)) if i not in used]
    if lost:
        raise SystemExit(f"TEXT_FIXES 의 원문을 찾지 못했습니다(원본이 바뀌었는지 확인): {lost}")
    lost = [DEMO_BUTTONS[i] for i in range(len(DEMO_BUTTONS)) if i not in hidden]
    lost += [HIDE_ROWS[i] for i in range(len(HIDE_ROWS)) if i not in rows_hidden]
    if lost:
        raise SystemExit(f"DEMO_BUTTONS 의 버튼을 찾지 못했습니다(원본이 바뀌었는지 확인): {lost}")
    with open(SOURCE_JSON, "w", encoding="utf-8") as f:
        json.dump({**source, "viewport": {k: list(v) for k, v in VIEW.items()}, "jpegQuality": QUALITY}, f,
                  ensure_ascii=False, indent=2)
        f.write("\n")
    os.makedirs(OUT, exist_ok=True)
    with open(PHONE_JSON, "w", encoding="utf-8") as f:
        json.dump({k: v for k, v in phones.items() if any(v.values())}, f, ensure_ascii=False, indent=1)
        f.write("\n")
    with open(VISIBLE_JSON, "w", encoding="utf-8") as f:
        json.dump(visible, f, ensure_ascii=False, indent=1)
        f.write("\n")
    return source, sum(len(s["images"]) for _, a in areas for s in a["screens"])


# ── 워드 ──

def place(d, client, name):
    path = os.path.join(IMG, name)
    img = Image.from_file(path)
    width = min(WIDTH_CM[client], MAX_HEIGHT_CM * img.px_width / img.px_height)
    picture(d, path, width_cm=width)


def row_cells(r):
    for p in r["policies"]:
        if p not in RULE_IDS:
            raise SystemExit(f"운영정책에 없는 번호: {p}")
    return [r["zone"], r["element"], r["action"], ", ".join(f"운영 정책 {p}" for p in r["policies"]) or "-"]


def menu_of(s, position):
    if s.get("menuCode"):
        if s["menuCode"] not in position:
            raise SystemExit(f"{s['id']}: 메뉴 코드 {s['menuCode']} 가 말단 메뉴에 없습니다.")
        return position[s["menuCode"]]
    return s.get("menu") or "메뉴 없음"


def write(version, draft=False):
    """워드를 쓰고 (경로, 화면 수, 이미지 수, 메뉴 점검) 을 돌려준다."""
    areas = load_areas()
    leaves = menu_tree()
    position = {c: p for c, p, _ in leaves}
    active = {c for c, _, st in leaves if st == "ACTIVE"}
    covered = {s.get("menuCode") for _, a in areas for s in a["screens"]}
    no_screen = sorted(active - covered)
    if no_screen:
        raise SystemExit(f"화면이 없는 사용 중 메뉴: {[position[c] for c in no_screen]}")
    d, doc_name, doc_no = open_docx("SCR", version)
    total_img, total = 0, 0
    empty = []
    visible = json.load(open(VISIBLE_JSON, encoding="utf-8")) if os.path.exists(VISIBLE_JSON) else {}  # 찍을 때 이미 점검했다
    for key, label in CLIENTS:
        heading(d, label, 1)
        for _, a in (x for x in areas if x[1]["client"] == key):
            heading(d, a["area"], 2)
            for s in a["screens"]:
                total += 1
                if not s.get("images") and s["id"] not in NO_IMAGE:
                    raise SystemExit(f"{s['id']}: 이미지가 없습니다. --capture 를 먼저 돌려 주세요.")
                h3 = heading(d, f"{s['id']} {s['name']}", 3)
                h3.paragraph_format.page_break_before = True
                route = s.get("route") or "경로 없음"
                if s.get("routeNote"):
                    route += f" ({s['routeNote']})"
                table(d, ["화면 번호", "화면 이름", "메뉴 위치", "경로"], [[s["id"], s["name"], menu_of(s, position), route]],
                      widths=[2.8, 3.2, 5.2, 4])
                para(d, "")
                for name in s["images"]:
                    if not os.path.exists(os.path.join(IMG, name)):
                        raise SystemExit(f"{s['id']}: 이미지 파일 {name} 이 없습니다.")
                    place(d, key, name)
                    total_img += 1
                if s["rows"]:
                    table(d, HEADERS, [row_cells(r) for r in s["rows"]], widths=WIDTHS)
                else:
                    empty.append(s["id"])
                    if draft:
                        para(d, "(설명 표는 다음 단계에서 채운다)")
                bad = leaks(visible.get(s["id"], ""), key_of(s))
                if bad:
                    raise SystemExit(f"{s['id']}: 이미지 글자 점검 실패 {bad}")
    if empty and not draft:
        raise SystemExit(f"설명 표가 빈 화면 {len(empty)}개: {empty[:20]}")
    texts = [p.text for p in d.paragraphs] + [c.text for t in d.tables for r in t.rows for c in r.cells]
    bad = sorted({x for t in texts for x in leaks(t)})
    if bad:
        raise SystemExit(f"문서 글자에 내부 표시가 남음: {bad}")
    path = save_docx(d, f"{doc_no}_{doc_name}.docx")
    return path, total, total_img, (len(leaves), len(active), len(empty))


def report():
    leaves = menu_tree()
    covered = {s.get("menuCode") for _, s in screens()}
    print("메뉴에 있는데 데모에 없는 말단 메뉴(사용중지 포함):")
    for c, p, st in leaves:
        if c not in covered:
            print(f"  [{st}] {p}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--version")
    ap.add_argument("--capture", action="store_true")
    ap.add_argument("--draft", action="store_true", help="설명 표가 빈 화면을 허용한다(1단계)")
    a = ap.parse_args()
    if a.capture:
        source, images = capture()
        for k in REPOS:
            print(f"{k}: {source[k]['repo']} {source[k]['commit']}")
        size = sum(os.path.getsize(os.path.join(IMG, f)) for f in os.listdir(IMG))
        print(f"화면 {len(screens())} · 이미지 {images} · 합계 {size / 1024 / 1024:.1f}MB")
        report()
        return
    if not a.version:
        ap.error("--version 이 필요합니다")
    path, total, images, (leaves, active, empty) = write(a.version, a.draft)
    rows = sum(len(s["rows"]) for _, s in screens())
    print(f"{path} ({os.path.getsize(path) / 1024 / 1024:.1f}MB)\n화면 {total} · 이미지 {images} · 설명 행 {rows} · 말단 메뉴 {leaves}(사용 {active}) · 설명 빈 화면 {empty}")


if __name__ == "__main__":
    main()
