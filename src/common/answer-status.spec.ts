import { API_ENUMS } from '../enums/api-enums';
import { ANSWER_STATUS_LABELS, statusesOf } from './answer-status';

describe('답변 상태 거르기', () => {
  it('답변 대기는 접수 · 처리중, 답변 완료는 답변 완료다', () => {
    expect(statusesOf('WAITING')).toEqual(['RECEIVED', 'IN_PROGRESS']);
    expect(statusesOf('ANSWERED')).toEqual(['ANSWERED']);
  });

  // DTO 의 enumName 'InquiryAnswerStatus' 는 글자라, 키가 빠지거나 바뀌면 front 의 getEnum 이 404 를 받는다.
  it('GET /enums 에 InquiryAnswerStatus 로 실린다', () => {
    expect(Object.fromEntries(API_ENUMS.InquiryAnswerStatus)).toEqual(
      ANSWER_STATUS_LABELS,
    );
  });
});
