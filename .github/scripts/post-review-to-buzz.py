"""pr-agent 가 이번 실행에서 PR 에 단 리뷰·코드 제안 코멘트를 요약해 Buzz 채널에 올린다.

환경변수: GH_TOKEN, REPO(owner/name), PR_NUMBER, SINCE(이번 실행 시작 시각, ISO 8601 UTC),
BUZZ_CHANNEL. BUZZ_RELAY_URL · BUZZ_PRIVATE_KEY 는 buzz CLI 가 직접 읽는다.
DRY_RUN=1 이면 게시하지 않고 메시지만 출력한다.
"""

import html
import json
import os
import re
import subprocess
import sys
import urllib.request


def github(path):
    req = urllib.request.Request(
        f"https://api.github.com/repos/{os.environ['REPO']}/{path}",
        headers={
            "Authorization": f"Bearer {os.environ['GH_TOKEN']}",
            "Accept": "application/vnd.github+json",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.load(res)


def text(fragment):
    """HTML 조각을 한 줄 평문으로."""
    fragment = re.sub(r"<[^>]+>", " ", fragment)
    fragment = re.sub(r"\s+", " ", html.unescape(fragment)).strip()
    return fragment.replace(" :", ":")


def review_lines(body):
    """「PR Reviewer Guide」 표의 줄마다 제목 한 줄, 지적 사항은 제목과 링크."""
    lines = []
    for row in re.findall(r"<tr><td>(.*?)</td></tr>", body, re.S):
        head = re.split(r"<br>|<details>", row, maxsplit=1)[0]
        lines.append(f"- {text(head)}")
        for url, title in re.findall(
            r"<summary><a href='([^']+)'><strong>(.*?)</strong></a>", row, re.S
        ):
            lines.append(f"  - [{text(title)}]({url})")
    return lines


def suggestion_lines(body):
    """「PR Code Suggestions」 표에서 (구분, 제목, 영향도). 이전 커밋 제안 묶음은 뺀다."""
    body = body.split("<summary>Suggestions up to commit")[0]
    items, category = [], ""
    for cat, summary, impact in re.findall(
        r"<td rowspan=\d+>(.*?)</td>|<details><summary>(.*?)</summary>|<td align=center>\s*(\w+)",
        body,
        re.S,
    ):
        if cat:
            category = text(cat)
        elif summary and not summary.startswith("Suggestion importance"):
            items.append([category, text(summary), ""])
        elif impact and items:
            items[-1][2] = impact
    return [f"- [{c}] {t}" + (f" ({i})" if i else "") for c, t, i in items]


def main():
    number = os.environ["PR_NUMBER"]
    since = os.environ["SINCE"]
    pr = github(f"pulls/{number}")
    # since 는 updated_at 기준이라 코멘트가 100개를 넘어도 이번 실행이 단 것만 온다.
    comments = [
        c
        for c in github(f"issues/{number}/comments?since={since}&per_page=100")
        if c["user"]["login"] == "github-actions[bot]"
    ]
    review = next((c for c in comments if "pr-agent:review" in c["body"]), None)
    improve = next((c for c in comments if "pr-agent:improve" in c["body"]), None)
    if not review and not improve:
        print("이번 실행에서 달린 pr-agent 리뷰·코드 제안이 없어 게시하지 않는다.")
        return

    # 여러 저장소가 같은 채널에 올리므로 머리에 저장소 이름을 붙인다.
    repo = os.environ["REPO"].split("/")[-1]
    parts = [f"**[{repo}] PR #{number} 코드리뷰** — {pr['title']}", pr["html_url"]]
    if review:
        parts += ["", f"**리뷰 요약** ([전문]({review['html_url']}))", *review_lines(review["body"])]
    if improve:
        lines = suggestion_lines(improve["body"])
        parts += ["", f"**코드 제안 {len(lines)}건** ([전문]({improve['html_url']}))", *lines]
    message = "\n".join(parts)

    if os.environ.get("DRY_RUN") == "1":
        print(message)
        return
    subprocess.run(
        ["buzz", "messages", "send", "--channel", os.environ["BUZZ_CHANNEL"], "--content", "-"],
        input=message.encode(),
        check=True,
        timeout=60,
    )


if __name__ == "__main__":
    sys.exit(main())
