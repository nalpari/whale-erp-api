-- 도입문의를 지우거나 1년 뒤 파기할 때 그 도입문의를 가리키는 운영 알림을 함께 지운다(운영 정책 CNT-11, api #41).
-- 알림은 업무를 외래키 없이 (related_type, related_id) 로 가리켜, 인덱스가 없으면 그때마다 notifications 를 끝까지 훑는다.
CREATE INDEX "notifications_related_type_related_id_idx" ON "notifications" ("related_type", "related_id");
