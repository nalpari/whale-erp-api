-- 근로계약서 보낸 원본 · 처리 완료본(WHALEERP-131, 2026-10-29 김민식).
-- 처리 완료본의 사용자 칸(상호 · 대표자 · 사업자등록번호 · 소재지 · 전화번호)은 날인 시점 값이다 — 날인할 때 점포 정보를 계약 당사자 행에
-- 고정한다. 점포 사업자 정보는 바뀔 수 있고 변경 이력으로 과거 값을 되살릴 수 없어서다. 있던 계약은 채우지 않는다(NULL) — 고정 전에
-- 체결된 계약의 완료본은 만드는 시점의 점포 정보로 만들고, employer_fixed_at 이 NULL 인 것이 그 기록이다.
ALTER TABLE "contract_parties" ADD COLUMN "employer_name" TEXT;
ALTER TABLE "contract_parties" ADD COLUMN "employer_ceo_name" TEXT;
ALTER TABLE "contract_parties" ADD COLUMN "employer_registration_number" TEXT;
ALTER TABLE "contract_parties" ADD COLUMN "employer_address" TEXT;
ALTER TABLE "contract_parties" ADD COLUMN "employer_address_detail" TEXT;
ALTER TABLE "contract_parties" ADD COLUMN "employer_phone" TEXT;
ALTER TABLE "contract_parties" ADD COLUMN "employer_fixed_at" TIMESTAMPTZ(6);
-- 제2조 근무 장소 · 직무도 날인 시점 값이다(2026-10-30 김민식) — 근무 장소를 비운 계약은 그때 점포명, 직무 칸이 빈 옛 계약은 그때
-- 직원 직무를 남긴다. 점포 이름 · 직원 직무가 바뀌어도 체결된 계약의 본문 · 처리 완료본 문장이 그대로다. 있던 계약은 채우지 않는다.
ALTER TABLE "contract_parties" ADD COLUMN "fixed_work_location" TEXT;
ALTER TABLE "contract_parties" ADD COLUMN "fixed_job_title" TEXT;

-- 보낸 원본은 발송마다 한 장, 처리 완료본은 계약마다 한 장 — 어느 발송의 것인지 남기고, 날인 직후 · 채우기 배치가 함께 만들어도
-- 하나만 남게 고유 인덱스로 막는다. 있던 파일(종이 계약 날인본 · 임금계약서 · 서명 이미지)은 NULL 그대로다.
ALTER TABLE "contract_documents" ADD COLUMN "sent_at" TIMESTAMPTZ(6);
ALTER TABLE "contract_documents" ADD CONSTRAINT "contract_documents_sent_at_for_generated" CHECK ("kind" NOT IN ('SENT_ORIGINAL', 'SIGNED_COPY') OR "sent_at" IS NOT NULL);
CREATE UNIQUE INDEX "contract_documents_contract_id_kind_sent_at_key" ON "contract_documents" ("contract_id", "kind", "sent_at") WHERE "kind" IN ('SENT_ORIGINAL', 'SIGNED_COPY');

COMMENT ON COLUMN "contract_parties"."employer_name" IS '사용자 상호 — 날인 때 점포 상호(없으면 점포명)를 고정 — 처리 완료본 사용자 칸 (WHALEERP-131, 2026-10-29 김민식) (물리에서 추가)';
COMMENT ON COLUMN "contract_parties"."employer_ceo_name" IS '사용자 대표자 — 날인 때 고정 — 처리 완료본 사용자 칸 (WHALEERP-131) (물리에서 추가)';
COMMENT ON COLUMN "contract_parties"."employer_registration_number" IS '사용자 사업자등록번호 — 날인 때 고정 — 처리 완료본 사용자 칸 (WHALEERP-131) (물리에서 추가)';
COMMENT ON COLUMN "contract_parties"."employer_address" IS '사용자 소재지 기본주소 — 날인 때 점포 사업자 주소를 고정 — 처리 완료본 사용자 칸 (WHALEERP-131) (물리에서 추가)';
COMMENT ON COLUMN "contract_parties"."employer_address_detail" IS '사용자 소재지 상세주소 — 날인 때 고정 — 처리 완료본 사용자 칸 (WHALEERP-131) (물리에서 추가)';
COMMENT ON COLUMN "contract_parties"."employer_phone" IS '사용자 전화번호 — 날인 때 점포 연락처를 고정 — 처리 완료본 사용자 칸 (WHALEERP-131) (물리에서 추가)';
COMMENT ON COLUMN "contract_parties"."employer_fixed_at" IS '사용자 고정 일시 — 날인 때 사용자 칸을 고정한 시각. NULL 이면 고정 전에 체결된 계약 — 처리 완료본은 만드는 시점의 점포 정보로 만든다 (WHALEERP-131, 2026-10-29 김민식) (물리에서 추가)';
COMMENT ON COLUMN "contract_parties"."fixed_work_location" IS '고정 근무 장소 — 날인 때 제2조 근무 장소(비었으면 그때 점포명)를 고정 — 체결된 계약의 본문 · 처리 완료본 (WHALEERP-131, 2026-10-30 김민식) (물리에서 추가)';
COMMENT ON COLUMN "contract_parties"."fixed_job_title" IS '고정 직무 — 날인 때 제2조 직무(비었으면 그때 직원 직무)를 고정 — 체결된 계약의 본문 · 처리 완료본 (WHALEERP-131, 2026-10-30 김민식) (물리에서 추가)';
COMMENT ON COLUMN "contract_documents"."sent_at" IS '발송 일시 — 보낸 원본 · 처리 완료본이 담은 계약의 발송 일시(contracts.sent_at). 다른 파일은 NULL (WHALEERP-131, 2026-10-29 김민식) (물리에서 추가)';
