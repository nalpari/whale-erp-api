export const BATCH_JOB = {
  CONTRACT_EXPIRE: 'contract-expire',
  CONTRACT_FILES: 'contract-files',
  STAFF_RETIRE: 'staff-retire',
  LEAD_PURGE: 'lead-purge',
  TODO_DUE_SOON: 'todo-due-soon',
  WORK_SCHEDULE_PURGE: 'work-schedule-purge',
  ATTENDANCE_PURGE: 'attendance-purge',
  PUBLIC_HOLIDAY_SYNC: 'public-holiday-sync',
  EXCEL_EXPORT: 'excel-export',
  EXCEL_DOWNLOAD_PURGE: 'excel-download-purge',
  BULK_EXPORT: 'bulk-export',
  BULK_EXPORT_FILE_PURGE: 'bulk-export-file-purge',
  CONTRACT_PURGE: 'contract-purge',
  TAX_PROFILE_PURGE: 'tax-profile-purge',
  ACCOUNT_CHANGE_PURGE: 'account-change-purge',
} as const;
export type BatchJobName = (typeof BATCH_JOB)[keyof typeof BATCH_JOB];
