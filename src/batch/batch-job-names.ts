export const BATCH_JOB = { CONTRACT_EXPIRE: 'contract-expire' } as const;
export type BatchJobName = (typeof BATCH_JOB)[keyof typeof BATCH_JOB];
