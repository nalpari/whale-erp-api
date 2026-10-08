export const BATCH_JOB = {
  CONTRACT_EXPIRE: 'contract-expire',
  STAFF_RETIRE: 'staff-retire',
} as const;
export type BatchJobName = (typeof BATCH_JOB)[keyof typeof BATCH_JOB];
