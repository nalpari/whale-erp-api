export const BATCH_JOB = {
  CONTRACT_EXPIRE: 'contract-expire',
  STAFF_RETIRE: 'staff-retire',
  LEAD_PURGE: 'lead-purge',
  TODO_DUE_SOON: 'todo-due-soon',
} as const;
export type BatchJobName = (typeof BATCH_JOB)[keyof typeof BATCH_JOB];
