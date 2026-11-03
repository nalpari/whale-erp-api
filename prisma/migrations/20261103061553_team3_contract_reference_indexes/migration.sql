-- 근로계약을 가리키는 외래키 칸의 인덱스(WHALEERP-645). 퇴직자 근로계약 파기가 계약을 지우면 외래키(RESTRICT) 검사가 지우는
-- 계약마다 이 칸들을 찾는다 — 인덱스가 없으면 그때마다 표 전체를 훑어, 파일을 지운 뒤 60초 배치 제한을 넘길 수 있다.
-- 파기 배치가 근무스케줄(source_contract_id) · 다른 계약(previous_contract_id) · 퇴직 처리 이력(contract_id)을 이 칸으로 찾아 잠그는 데도 쓴다.
CREATE INDEX "payslips_contract_id_idx" ON "payslips" ("contract_id");
CREATE INDEX "work_schedules_source_contract_id_idx" ON "work_schedules" ("source_contract_id");
CREATE INDEX "contracts_previous_contract_id_idx" ON "contracts" ("previous_contract_id");
CREATE INDEX "staff_member_retirement_logs_contract_id_idx" ON "staff_member_retirement_logs" ("contract_id");
