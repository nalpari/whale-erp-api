-- 근무스케줄에서 근무 유형을 뺀다 (2026-10-08 재영).
-- work_schedules.work_type 칸과 enum work_type(DAY · OPEN · MIDDLE · CLOSE)을 지운다. 칸을 먼저 지워야 타입을 지울 수 있다.
-- 물리 결정은 docs/erd-physical/_model.py 의 DROP.

ALTER TABLE "work_schedules" DROP COLUMN "work_type";
DROP TYPE "work_type";
