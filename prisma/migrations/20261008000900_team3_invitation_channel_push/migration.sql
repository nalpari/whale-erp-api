-- 초대 수신 채널에 앱 푸시(PUSH)를 더한다 (2026-10-08). 소속 추가 확인 · 복귀 확인은 토큰 링크가 아니라 기존 계정의
-- 앱 푸시로 간다(okf staff 「초대와 계약」). invitations.channel 이 NOT NULL 이라 그 초대에 넣을 값이 있어야 한다.
-- 물리 결정은 docs/erd-physical/_model.py 의 ENUMS.
ALTER TYPE "invitation_channel" ADD VALUE 'PUSH';
