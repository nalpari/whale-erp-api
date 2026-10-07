-- 3팀 기본 알림 템플릿 — 40건 (운영 알림 10 · 앱 푸시 5 · 메일 24 · 알림톡 1).
--
-- 근거: 기획 세션 확정 문구(2026-10-07 재영, 「기본 알림 템플릿」 페이지). 받는 사람(to) · 메모(memo)는 표에 두지 않는다.
-- 운영 기준 데이터라 마이그레이션으로 처음 한 번 넣고, 그 뒤 변경은 플랫폼 운영자가 알림 템플릿 관리 화면에서 한다 —
-- 이 파일을 고쳐 문구를 바꾸지 않는다. 적용한 뒤 바꿀 것은 새 마이그레이션으로 낸다.
--
-- 변수 목록은 [{name, label, isRequired, sampleValue}] 배열(순서 = 표시 순서). 「링크」처럼 본문 · 제목에 쓰지 않고
-- 메일 공통 틀의 버튼이나 알림톡 버튼으로 붙는 변수는 isButtonLink: true 를 단다 — 저장 검사의 「필수 변수는 본문 · 제목에
-- 있어야 한다」에서 빠지는 것은 이 표시가 있는 변수뿐이다(이름으로 예외를 두지 않는다).
--
-- 사용 안 함(is_active = false) 4건: EMAIL_INQUIRY_RECEIVED · EMAIL_LEAD_RECEIVED · EMAIL_LEAD_ANSWERED ·
-- EMAIL_AFFILIATION_REJECTED. 알림톡 TALK_STAFF_INVITATION 의 카카오 템플릿 코드는 WHALE_INVITE_01.
-- 수정 관리자(updated_by)는 비우고, 변경 이력은 넣지 않는다. 손으로 쓴 데이터 마이그레이션이라 물리 생성기는 건드리지 않는다.

INSERT INTO "notification_templates"
  ("template_code", "channel", "template_name", "preference_category", "title", "body", "variables", "kakao_template_code", "is_active")
VALUES
  ('NTF_INQUIRY_RECEIVED', 'NOTIFICATION', '문의사항 접수', NULL, '새 문의사항이 접수되었습니다', '#{문의자} · #{문의제목}', '[{"name": "문의자", "label": "문의한 BP·점포", "isRequired": true, "sampleValue": "모리커피 연남점"}, {"name": "문의제목", "label": "문의 제목", "isRequired": true, "sampleValue": "급여명세서 공제 항목 문의"}]'::jsonb, NULL, true),
  ('NTF_LEAD_RECEIVED', 'NOTIFICATION', '도입문의 접수', NULL, '새 도입문의가 접수되었습니다', '#{도입문의자}', '[{"name": "도입문의자", "label": "도입문의 이름·업종", "isRequired": true, "sampleValue": "김도윤 · 카페"}]'::jsonb, NULL, true),
  ('NTF_INQUIRY_ANSWERED', 'NOTIFICATION', '문의사항 답변', NULL, '문의사항에 답변이 등록되었습니다', '#{문의제목}', '[{"name": "문의제목", "label": "문의 제목", "isRequired": true, "sampleValue": "급여명세서 공제 항목 문의"}]'::jsonb, NULL, true),
  ('NTF_LEAD_ANSWERED', 'NOTIFICATION', '도입문의 처리 상태 변경', NULL, '도입문의 처리 상태가 #{처리상태}(으)로 바뀌었습니다', '#{도입문의자}', '[{"name": "처리상태", "label": "바뀐 처리 상태", "isRequired": true, "sampleValue": "처리중"}, {"name": "도입문의자", "label": "도입문의 이름·업종", "isRequired": true, "sampleValue": "김도윤 · 카페"}]'::jsonb, NULL, true),
  ('NTF_CONTRACT_SIGNED', 'NOTIFICATION', '근로계약 날인', NULL, '#{직원이름} 님이 근로계약서에 날인했습니다', '#{근무지}', '[{"name": "직원이름", "label": "직원 이름", "isRequired": true, "sampleValue": "유하람"}, {"name": "근무지", "label": "근무지 점포 이름", "isRequired": true, "sampleValue": "모리커피 연남점"}]'::jsonb, NULL, true),
  ('NTF_CONTRACT_REJECTED', 'NOTIFICATION', '근로계약 거부', NULL, '#{직원이름} 님이 근로계약서를 거부했습니다', '사유 · #{거부사유}', '[{"name": "직원이름", "label": "직원 이름", "isRequired": true, "sampleValue": "유하람"}, {"name": "거부사유", "label": "거부 사유", "isRequired": false, "sampleValue": "근무 시작 시각이 면접 때와 다릅니다"}]'::jsonb, NULL, true),
  ('NTF_CONTRACT_EXPIRED', 'NOTIFICATION', '근로계약 만료', NULL, '#{직원이름} 님의 근로계약서가 날인 기한이 지나 만료되었습니다', '#{근무지} · 재발송할 수 있습니다', '[{"name": "직원이름", "label": "직원 이름", "isRequired": true, "sampleValue": "유하람"}, {"name": "근무지", "label": "근무지 점포 이름", "isRequired": true, "sampleValue": "모리커피 연남점"}]'::jsonb, NULL, true),
  ('NTF_LINK_HOLD', 'NOTIFICATION', '가입 연결 보류', NULL, '#{직원이름} 님의 가입 연결이 보류되었습니다', '#{보류사유} · 직원에게 확인한 뒤 연결해 주세요', '[{"name": "직원이름", "label": "직원 이름", "isRequired": true, "sampleValue": "유하람"}, {"name": "보류사유", "label": "보류 사유", "isRequired": true, "sampleValue": "휴대전화번호 불일치"}]'::jsonb, NULL, true),
  ('NTF_AFFILIATION_REJECTED', 'NOTIFICATION', '소속 추가 확인 거절', NULL, '#{직원이름} 님이 소속 추가 확인을 거절했습니다', '#{근무지}', '[{"name": "직원이름", "label": "직원 이름", "isRequired": true, "sampleValue": "유하람"}, {"name": "근무지", "label": "근무지 점포 이름", "isRequired": true, "sampleValue": "모리커피 연남점"}]'::jsonb, NULL, true),
  ('NTF_CONTRACT_RENEWAL_DUE', 'NOTIFICATION', '계약 갱신 예정', NULL, '#{직원이름} 님의 근로계약이 #{계약종료일}에 끝납니다', '#{근무지} · 갱신하려면 새 계약을 만들어 주세요', '[{"name": "직원이름", "label": "직원 이름", "isRequired": true, "sampleValue": "유하람"}, {"name": "계약종료일", "label": "계약 종료일", "isRequired": true, "sampleValue": "11월 6일"}, {"name": "근무지", "label": "근무지 점포 이름", "isRequired": true, "sampleValue": "모리커피 연남점"}]'::jsonb, NULL, true),
  ('PUSH_CONTRACT_SENT', 'PUSH', '근로계약서 발송', 'CONTRACT', '근로계약서가 도착했습니다', '#{근무지} 근로계약서를 확인하고 날인해 주세요. 날인 기한은 #{날인기한}까지입니다.', '[{"name": "근무지", "label": "근무지 점포 이름", "isRequired": true, "sampleValue": "모리커피 연남점"}, {"name": "날인기한", "label": "날인 기한", "isRequired": true, "sampleValue": "10월 30일"}]'::jsonb, NULL, true),
  ('PUSH_SCHEDULE_CHANGED', 'PUSH', '근무스케줄 주요 변경', 'SCHEDULE', '#{근무지} 근무스케줄이 바뀌었습니다', '#{변경내용}', '[{"name": "근무지", "label": "근무지 점포 이름", "isRequired": true, "sampleValue": "모리커피 연남점"}, {"name": "변경내용", "label": "바뀐 근무 요약", "isRequired": true, "sampleValue": "10월 9일(목) 09:00~15:00 → 12:00~18:00"}]'::jsonb, NULL, true),
  ('PUSH_TODO_ASSIGNED', 'PUSH', 'TO-DO 배정', 'TODO', '새 TO-DO가 배정되었습니다', '#{TO-DO제목} · #{수행예정일시}', '[{"name": "TO-DO제목", "label": "TO-DO 제목", "isRequired": true, "sampleValue": "마감 정산표 확인"}, {"name": "수행예정일시", "label": "수행 예정 일시", "isRequired": true, "sampleValue": "10월 8일 18:00"}]'::jsonb, NULL, true),
  ('PUSH_PAYSLIP_SENT', 'PUSH', '급여명세서 발송', 'PAYSLIP', '#{급여월} 급여명세서가 도착했습니다', '#{근무지}에서 보낸 급여명세서입니다. 눌러서 확인해 주세요.', '[{"name": "급여월", "label": "급여 기간의 달", "isRequired": true, "sampleValue": "7월"}, {"name": "근무지", "label": "근무지 점포 이름", "isRequired": true, "sampleValue": "모리커피 연남점"}]'::jsonb, NULL, true),
  ('EMAIL_INQUIRY_RECEIVED', 'EMAIL', '문의사항 접수', NULL, '[WHALE ERP] 새 문의사항: #{문의제목}', '#{문의자}에서 문의사항을 등록했습니다.

제목: #{문의제목}

관리자 웹 커뮤니티 관리에서 답변해 주세요.', '[{"name": "문의자", "label": "문의한 BP·점포", "isRequired": true, "sampleValue": "모리커피 연남점"}, {"name": "문의제목", "label": "문의 제목", "isRequired": true, "sampleValue": "급여명세서 공제 항목 문의"}, {"name": "링크", "label": "바로가기 링크(공통 틀이 버튼으로 붙임)", "isRequired": true, "sampleValue": "https://…", "isButtonLink": true}]'::jsonb, NULL, false),
  ('EMAIL_LEAD_RECEIVED', 'EMAIL', '도입문의 접수', NULL, '[WHALE ERP] 새 도입문의: #{도입문의자}', '새 도입문의가 접수되었습니다.

문의자: #{도입문의자}

영업일 1~2일 안에 연락해 주세요.', '[{"name": "도입문의자", "label": "도입문의 이름·업종", "isRequired": true, "sampleValue": "김도윤 · 카페"}, {"name": "링크", "label": "바로가기 링크(공통 틀이 버튼으로 붙임)", "isRequired": true, "sampleValue": "https://…", "isButtonLink": true}]'::jsonb, NULL, false),
  ('EMAIL_INQUIRY_ANSWERED', 'EMAIL', '문의사항 답변', NULL, '[WHALE ERP] 문의하신 「#{문의제목}」에 답변이 등록되었습니다', '문의하신 내용에 답변이 등록되었습니다.

제목: #{문의제목}

고객지원 › 문의사항에서 답변을 확인해 주세요.', '[{"name": "문의제목", "label": "문의 제목", "isRequired": true, "sampleValue": "급여명세서 공제 항목 문의"}, {"name": "링크", "label": "바로가기 링크(공통 틀이 버튼으로 붙임)", "isRequired": true, "sampleValue": "https://…", "isButtonLink": true}]'::jsonb, NULL, true),
  ('EMAIL_LEAD_ANSWERED', 'EMAIL', '도입문의 처리 상태 변경', NULL, '[WHALE ERP] 도입문의 처리 상태 변경: #{처리상태}', '#{도입문의자} 도입문의의 처리 상태가 #{처리상태}(으)로 바뀌었습니다.', '[{"name": "도입문의자", "label": "도입문의 이름·업종", "isRequired": true, "sampleValue": "김도윤 · 카페"}, {"name": "처리상태", "label": "바뀐 처리 상태", "isRequired": true, "sampleValue": "처리중"}, {"name": "링크", "label": "바로가기 링크(공통 틀이 버튼으로 붙임)", "isRequired": true, "sampleValue": "https://…", "isButtonLink": true}]'::jsonb, NULL, false),
  ('EMAIL_CONTRACT_SIGNED', 'EMAIL', '근로계약 날인', NULL, '[WHALE ERP] #{직원이름} 님이 근로계약서에 날인했습니다', '#{직원이름} 님이 #{근무지} 근로계약서에 날인했습니다.

계약이 체결 완료되었습니다. 직원은 이어서 신고 정보를 입력합니다.', '[{"name": "직원이름", "label": "직원 이름", "isRequired": true, "sampleValue": "유하람"}, {"name": "근무지", "label": "근무지 점포 이름", "isRequired": true, "sampleValue": "모리커피 연남점"}, {"name": "링크", "label": "바로가기 링크(공통 틀이 버튼으로 붙임)", "isRequired": true, "sampleValue": "https://…", "isButtonLink": true}]'::jsonb, NULL, true),
  ('EMAIL_CONTRACT_REJECTED', 'EMAIL', '근로계약 거부', NULL, '[WHALE ERP] #{직원이름} 님이 근로계약서를 거부했습니다', '#{직원이름} 님이 #{근무지} 근로계약서를 거부했습니다.

거부 사유: #{거부사유}

조건을 고쳐 새 계약을 만들거나 그대로 재발송할 수 있습니다.', '[{"name": "직원이름", "label": "직원 이름", "isRequired": true, "sampleValue": "유하람"}, {"name": "근무지", "label": "근무지 점포 이름", "isRequired": true, "sampleValue": "모리커피 연남점"}, {"name": "거부사유", "label": "거부 사유", "isRequired": false, "sampleValue": "근무 시작 시각이 면접 때와 다릅니다"}, {"name": "링크", "label": "바로가기 링크(공통 틀이 버튼으로 붙임)", "isRequired": true, "sampleValue": "https://…", "isButtonLink": true}]'::jsonb, NULL, true),
  ('EMAIL_CONTRACT_EXPIRED', 'EMAIL', '근로계약 만료', NULL, '[WHALE ERP] #{직원이름} 님의 근로계약서가 만료되었습니다', '#{직원이름} 님이 날인 기한까지 #{근무지} 근로계약서에 날인하지 않아 계약이 만료되었습니다.

같은 조건으로 재발송하거나 새 계약을 만들 수 있습니다.', '[{"name": "직원이름", "label": "직원 이름", "isRequired": true, "sampleValue": "유하람"}, {"name": "근무지", "label": "근무지 점포 이름", "isRequired": true, "sampleValue": "모리커피 연남점"}, {"name": "링크", "label": "바로가기 링크(공통 틀이 버튼으로 붙임)", "isRequired": true, "sampleValue": "https://…", "isButtonLink": true}]'::jsonb, NULL, true),
  ('EMAIL_LINK_HOLD', 'EMAIL', '가입 연결 보류', NULL, '[WHALE ERP] #{직원이름} 님의 가입 연결이 보류되었습니다', '#{직원이름} 님이 가입했지만 본인인증 정보가 초안과 달라 연결이 보류되었습니다.

보류 사유: #{보류사유}

직원에게 직접 연락해 번호를 확인한 뒤 연결하거나, 번호를 고쳐 재초대해 주세요.', '[{"name": "직원이름", "label": "직원 이름", "isRequired": true, "sampleValue": "유하람"}, {"name": "보류사유", "label": "보류 사유", "isRequired": true, "sampleValue": "휴대전화번호 불일치"}, {"name": "링크", "label": "바로가기 링크(공통 틀이 버튼으로 붙임)", "isRequired": true, "sampleValue": "https://…", "isButtonLink": true}]'::jsonb, NULL, true),
  ('EMAIL_AFFILIATION_REJECTED', 'EMAIL', '소속 추가 확인 거절', NULL, '[WHALE ERP] #{직원이름} 님이 소속 추가 확인을 거절했습니다', '#{직원이름} 님이 #{근무지} 소속 추가 확인을 거절했습니다.', '[{"name": "직원이름", "label": "직원 이름", "isRequired": true, "sampleValue": "유하람"}, {"name": "근무지", "label": "근무지 점포 이름", "isRequired": true, "sampleValue": "모리커피 연남점"}, {"name": "링크", "label": "바로가기 링크(공통 틀이 버튼으로 붙임)", "isRequired": true, "sampleValue": "https://…", "isButtonLink": true}]'::jsonb, NULL, false),
  ('EMAIL_CONTRACT_RENEWAL_DUE', 'EMAIL', '계약 갱신 예정', NULL, '[WHALE ERP] #{직원이름} 님의 근로계약이 #{계약종료일}에 끝납니다', '#{직원이름} 님의 #{근무지} 근로계약이 #{계약종료일}에 끝납니다.

계속 근무한다면 종료일 전에 새 계약을 만들어 보내 주세요.', '[{"name": "직원이름", "label": "직원 이름", "isRequired": true, "sampleValue": "유하람"}, {"name": "근무지", "label": "근무지 점포 이름", "isRequired": true, "sampleValue": "모리커피 연남점"}, {"name": "계약종료일", "label": "계약 종료일", "isRequired": true, "sampleValue": "11월 6일"}, {"name": "링크", "label": "바로가기 링크(공통 틀이 버튼으로 붙임)", "isRequired": true, "sampleValue": "https://…", "isButtonLink": true}]'::jsonb, NULL, true),
  ('EMAIL_STAFF_PASSWORD_PIN', 'EMAIL', '비밀번호 찾기 핀', NULL, '[WHALE ERP] 비밀번호 재설정 인증 핀', '비밀번호를 다시 정하려면 아래 핀을 직원 근무 앱에 입력해 주세요.

인증 핀: #{핀}

핀은 15분 동안 쓸 수 있습니다. 요청하지 않았다면 이 메일을 무시해 주세요.', '[{"name": "핀", "label": "인증 핀 6자리", "isRequired": true, "sampleValue": "A7K2Q9"}]'::jsonb, NULL, true),
  ('EMAIL_STAFF_RESET_LINK', 'EMAIL', '관리자 초기화 재설정 링크', NULL, '[WHALE ERP] 비밀번호 재설정 링크', '#{근무지} 관리자가 비밀번호 초기화를 요청했습니다.

아래 버튼을 눌러 새 비밀번호를 정해 주세요. 링크는 24시간 동안 한 번만 쓸 수 있습니다.', '[{"name": "근무지", "label": "근무지 점포 이름", "isRequired": true, "sampleValue": "모리커피 연남점"}, {"name": "링크", "label": "바로가기 링크(공통 틀이 버튼으로 붙임)", "isRequired": true, "sampleValue": "https://…", "isButtonLink": true}]'::jsonb, NULL, true),
  ('EMAIL_CHANGE_PIN', 'EMAIL', '로그인 이메일 변경 핀', NULL, '[WHALE ERP] 로그인 이메일 변경 인증 핀', '로그인 이메일을 이 주소로 바꾸려면 아래 핀을 직원 근무 앱에 입력해 주세요.

인증 핀: #{핀}

핀은 15분 동안 쓸 수 있습니다. 요청하지 않았다면 이 메일을 무시해 주세요.', '[{"name": "핀", "label": "인증 핀 6자리", "isRequired": true, "sampleValue": "A7K2Q9"}]'::jsonb, NULL, true),
  ('EMAIL_LEAD_CONFIRMATION', 'EMAIL', '도입문의 접수 확인', NULL, '[WHALE ERP] 도입문의가 접수되었습니다', '#{도입문의자} 님, WHALE ERP 도입문의가 접수되었습니다.

담당자가 영업일 기준 1~2일 안에 남겨 주신 연락처로 연락드리겠습니다.', '[{"name": "도입문의자", "label": "도입문의 이름·업종", "isRequired": true, "sampleValue": "김도윤 · 카페"}]'::jsonb, NULL, true),
  ('EMAIL_SIGNUP_DONE', 'EMAIL', '회원가입 완료', NULL, '[WHALE ERP] 회원가입이 완료되었습니다', '#{관리자이름} 님, #{BP이름}의 WHALE ERP 회원가입이 완료되었습니다.

로그인 아이디: #{로그인아이디}', '[{"name": "관리자이름", "label": "관리자 이름", "isRequired": true, "sampleValue": "이서준"}, {"name": "BP이름", "label": "BP 이름", "isRequired": true, "sampleValue": "모리커피"}, {"name": "로그인아이디", "label": "로그인 아이디", "isRequired": true, "sampleValue": "seojun01"}, {"name": "링크", "label": "바로가기 링크(공통 틀이 버튼으로 붙임)", "isRequired": true, "sampleValue": "https://…", "isButtonLink": true}]'::jsonb, NULL, true),
  ('EMAIL_SIGNUP_ALERT', 'EMAIL', '신규 BP 가입 알림', NULL, '[WHALE ERP] 새 BP가 가입했습니다: #{BP이름}', '#{BP이름}이(가) WHALE ERP에 가입했습니다.

사업자 정보를 확인해 주세요.', '[{"name": "BP이름", "label": "BP 이름", "isRequired": true, "sampleValue": "모리커피"}, {"name": "링크", "label": "바로가기 링크(공통 틀이 버튼으로 붙임)", "isRequired": true, "sampleValue": "https://…", "isButtonLink": true}]'::jsonb, NULL, true),
  ('EMAIL_BP_REGISTER', 'EMAIL', 'BP 신규 등록', NULL, '[WHALE ERP] #{BP이름} 계정이 등록되었습니다', '#{관리자이름} 님, 플랫폼 운영자가 #{BP이름}을(를) WHALE ERP에 등록했습니다.

로그인 아이디: #{로그인아이디}
임시 비밀번호: #{임시비밀번호}

처음 로그인할 때 비밀번호를 바꿔 주세요.', '[{"name": "관리자이름", "label": "관리자 이름", "isRequired": true, "sampleValue": "이서준"}, {"name": "BP이름", "label": "BP 이름", "isRequired": true, "sampleValue": "모리커피"}, {"name": "로그인아이디", "label": "로그인 아이디", "isRequired": true, "sampleValue": "seojun01"}, {"name": "임시비밀번호", "label": "임시 비밀번호", "isRequired": true, "sampleValue": "x8Rk-2mPq"}, {"name": "링크", "label": "바로가기 링크(공통 틀이 버튼으로 붙임)", "isRequired": true, "sampleValue": "https://…", "isButtonLink": true}]'::jsonb, NULL, true),
  ('EMAIL_PLAT_ADMIN_CREATE', 'EMAIL', '플랫폼 관리자 계정 생성', NULL, '[WHALE ERP] 플랫폼 관리자 계정이 만들어졌습니다', '#{관리자이름} 님의 WHALE ERP 플랫폼 관리자 계정이 만들어졌습니다.

로그인 아이디: #{로그인아이디}
임시 비밀번호: #{임시비밀번호}

처음 로그인할 때 비밀번호를 바꿔 주세요.', '[{"name": "관리자이름", "label": "관리자 이름", "isRequired": true, "sampleValue": "이서준"}, {"name": "로그인아이디", "label": "로그인 아이디", "isRequired": true, "sampleValue": "seojun01"}, {"name": "임시비밀번호", "label": "임시 비밀번호", "isRequired": true, "sampleValue": "x8Rk-2mPq"}, {"name": "링크", "label": "바로가기 링크(공통 틀이 버튼으로 붙임)", "isRequired": true, "sampleValue": "https://…", "isButtonLink": true}]'::jsonb, NULL, true),
  ('EMAIL_BP_ADMIN_CREATE', 'EMAIL', 'BP 관리자 계정 생성', NULL, '[WHALE ERP] #{BP이름} 관리자 계정이 만들어졌습니다', '#{관리자이름} 님의 #{BP이름} 관리자 계정이 만들어졌습니다.

로그인 아이디: #{로그인아이디}
임시 비밀번호: #{임시비밀번호}

처음 로그인할 때 비밀번호를 바꿔 주세요.', '[{"name": "관리자이름", "label": "관리자 이름", "isRequired": true, "sampleValue": "이서준"}, {"name": "BP이름", "label": "BP 이름", "isRequired": true, "sampleValue": "모리커피"}, {"name": "로그인아이디", "label": "로그인 아이디", "isRequired": true, "sampleValue": "seojun01"}, {"name": "임시비밀번호", "label": "임시 비밀번호", "isRequired": true, "sampleValue": "x8Rk-2mPq"}, {"name": "링크", "label": "바로가기 링크(공통 틀이 버튼으로 붙임)", "isRequired": true, "sampleValue": "https://…", "isButtonLink": true}]'::jsonb, NULL, true),
  ('EMAIL_PASSWORD_RESET', 'EMAIL', '비밀번호 초기화', NULL, '[WHALE ERP] 비밀번호가 초기화되었습니다', '#{관리자이름} 님의 비밀번호가 초기화되었습니다.

임시 비밀번호: #{임시비밀번호}

임시 비밀번호는 1시간 동안 쓸 수 있고, 로그인한 뒤 새 비밀번호를 정해야 합니다.', '[{"name": "관리자이름", "label": "관리자 이름", "isRequired": true, "sampleValue": "이서준"}, {"name": "임시비밀번호", "label": "임시 비밀번호", "isRequired": true, "sampleValue": "x8Rk-2mPq"}, {"name": "링크", "label": "바로가기 링크(공통 틀이 버튼으로 붙임)", "isRequired": true, "sampleValue": "https://…", "isButtonLink": true}]'::jsonb, NULL, true),
  ('EMAIL_TEMP_PASSWORD', 'EMAIL', '임시 비밀번호 발급', NULL, '[WHALE ERP] 임시 비밀번호를 보내 드립니다', '#{관리자이름} 님이 요청하신 임시 비밀번호입니다.

임시 비밀번호: #{임시비밀번호}

1시간 동안 쓸 수 있습니다. 요청하지 않았다면 바로 관리자에게 알려 주세요.', '[{"name": "관리자이름", "label": "관리자 이름", "isRequired": true, "sampleValue": "이서준"}, {"name": "임시비밀번호", "label": "임시 비밀번호", "isRequired": true, "sampleValue": "x8Rk-2mPq"}, {"name": "링크", "label": "바로가기 링크(공통 틀이 버튼으로 붙임)", "isRequired": true, "sampleValue": "https://…", "isButtonLink": true}]'::jsonb, NULL, true),
  ('EMAIL_WITHDRAW_DONE', 'EMAIL', '회원 탈퇴 완료', NULL, '[WHALE ERP] 회원 탈퇴가 완료되었습니다', '#{BP이름}의 WHALE ERP 회원 탈퇴가 #{탈퇴일}에 완료되었습니다.

그동안 이용해 주셔서 고맙습니다.', '[{"name": "BP이름", "label": "BP 이름", "isRequired": true, "sampleValue": "모리커피"}, {"name": "탈퇴일", "label": "탈퇴일", "isRequired": true, "sampleValue": "10월 7일"}]'::jsonb, NULL, true),
  ('TALK_STAFF_INVITATION', 'ALIMTALK', '가입 초대', NULL, NULL, '#{근무지}에서 근로계약서를 보내려고 합니다.
아래 링크로 WHALE ERP 직원 근무 앱에 가입해 주세요.
링크는 30일 동안 쓸 수 있습니다.', '[{"name": "근무지", "label": "근무지 점포 이름", "isRequired": true, "sampleValue": "모리커피 연남점"}, {"name": "링크", "label": "바로가기 링크(공통 틀이 버튼으로 붙임)", "isRequired": true, "sampleValue": "https://…", "isButtonLink": true}]'::jsonb, 'WHALE_INVITE_01', true),
  ('PUSH_PAYSLIP_RESENT', 'PUSH', '급여명세서 다시 발송', 'PAYSLIP', '#{급여월} 급여명세서가 다시 발송되었습니다', '금액이 바뀌었을 수 있습니다. 눌러서 확인해 주세요.', '[{"name": "급여월", "label": "급여 기간의 달", "isRequired": true, "sampleValue": "7월"}]'::jsonb, NULL, true),
  ('EMAIL_PAYSLIP_SENT', 'EMAIL', '급여명세서 발송 메일', NULL, '[WHALE ERP] #{급여월} 급여명세서가 도착했습니다', '#{직원이름} 님, #{근무지}에서 #{급여월} 급여명세서를 보냈습니다.

직원 근무 앱 급여 탭에서 확인할 수 있습니다.', '[{"name": "직원이름", "label": "직원 이름", "isRequired": true, "sampleValue": "유하람"}, {"name": "근무지", "label": "근무지 점포 이름", "isRequired": true, "sampleValue": "모리커피 연남점"}, {"name": "급여월", "label": "급여 기간의 달", "isRequired": true, "sampleValue": "7월"}, {"name": "링크", "label": "바로가기 링크(공통 틀이 버튼으로 붙임)", "isRequired": true, "sampleValue": "https://…", "isButtonLink": true}]'::jsonb, NULL, true),
  ('EMAIL_PAYSLIP_RESENT', 'EMAIL', '급여명세서 다시 발송 메일', NULL, '[WHALE ERP] #{급여월} 급여명세서가 다시 발송되었습니다', '#{직원이름} 님, #{근무지}에서 #{급여월} 급여명세서를 다시 보냈습니다. 금액이 바뀌었을 수 있습니다.

직원 근무 앱 급여 탭에서 확인할 수 있습니다.', '[{"name": "직원이름", "label": "직원 이름", "isRequired": true, "sampleValue": "유하람"}, {"name": "근무지", "label": "근무지 점포 이름", "isRequired": true, "sampleValue": "모리커피 연남점"}, {"name": "급여월", "label": "급여 기간의 달", "isRequired": true, "sampleValue": "7월"}, {"name": "링크", "label": "바로가기 링크(공통 틀이 버튼으로 붙임)", "isRequired": true, "sampleValue": "https://…", "isButtonLink": true}]'::jsonb, NULL, true);

-- ── 검사 ──
DO $$
BEGIN
  IF (SELECT count(*) FROM "notification_templates") <> 40 THEN
    RAISE EXCEPTION '알림 템플릿이 40건이 아니다';
  END IF;
  IF (SELECT count(*) FROM "notification_templates" WHERE "channel" = 'NOTIFICATION') <> 10
     OR (SELECT count(*) FROM "notification_templates" WHERE "channel" = 'PUSH') <> 5
     OR (SELECT count(*) FROM "notification_templates" WHERE "channel" = 'EMAIL') <> 24
     OR (SELECT count(*) FROM "notification_templates" WHERE "channel" = 'ALIMTALK') <> 1 THEN
    RAISE EXCEPTION '채널별 건수가 맞지 않다(운영 알림 10 · 앱 푸시 5 · 메일 24 · 알림톡 1)';
  END IF;
  IF (SELECT string_agg("template_code", ',' ORDER BY "template_code") FROM "notification_templates" WHERE NOT "is_active")
     <> 'EMAIL_AFFILIATION_REJECTED,EMAIL_INQUIRY_RECEIVED,EMAIL_LEAD_ANSWERED,EMAIL_LEAD_RECEIVED' THEN
    RAISE EXCEPTION '사용 안 함 템플릿이 정한 4건이 아니다';
  END IF;
  IF (SELECT count(*) FROM "notification_templates" WHERE "channel" = 'PUSH' AND "preference_category" IS NOT NULL) <> 5 THEN
    RAISE EXCEPTION '앱 푸시 5건의 수신 설정 묶음이 다 채워지지 않았다';
  END IF;
  -- 본문 · 제목의 #{변수} 는 모두 변수 목록에 있다
  IF EXISTS (
    SELECT 1 FROM "notification_templates" t,
      regexp_matches(coalesce(t."title", '') || ' ' || t."body", '#\{([^}]*)\}', 'g') m
    WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(t."variables") v WHERE v->>'name' = m[1])
  ) THEN
    RAISE EXCEPTION '변수 목록에 없는 #{변수} 가 본문이나 제목에 있다';
  END IF;
  -- 필수 변수는 본문 · 제목에 있다 — 버튼으로 붙는 링크(isButtonLink)만 빼고
  IF EXISTS (
    SELECT 1 FROM "notification_templates" t, jsonb_array_elements(t."variables") v
    WHERE (v->>'isRequired')::boolean
      AND NOT coalesce((v->>'isButtonLink')::boolean, false)
      AND position('#{' || (v->>'name') || '}' IN coalesce(t."title", '') || t."body") = 0
  ) THEN
    RAISE EXCEPTION '필수 변수가 본문 · 제목에 없다';
  END IF;
END $$;
