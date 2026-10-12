-- 근로계약 상태에 임시저장(DRAFT)을 더한다 (2026-10-08). 근로계약서를 다 쓰기 전에 저장해 둔 것이고 초대 · 계약서를 보내지 않는다.
-- 순서는 맨 앞(발송 대기 앞). 기본값은 그대로 발송 대기다. 물리 결정은 docs/erd-physical/_model.py 의 _CSTATUS.
ALTER TYPE "contract_status" ADD VALUE 'DRAFT' BEFORE 'PENDING_SEND';
