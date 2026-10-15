export const jobsMessages = {
  'doctor.jobs.heading': '\nBackground jobs',
  'doctor.jobs.none': '  No background data yet',
  'doctor.jobs.ok': '  {key}: ok, {age} ago',
  'doctor.jobs.error': '  {key}: error: {error}, {age} ago',
  'doctor.jobs.retry': ', retry in {in}',
  'doctor.jobs.offTraffic': ', off (nonessential traffic)',
  'doctor.jobs.offAll': ', off (CCINFOBAR_NO_JOBS)',
  'doctor.jobs.unknownError': 'unknown error',
  'doctor.jobs.nonessential':
    '  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set: the usage, update and status jobs are off; http and gh jobs still run',
  'doctor.jobs.disabled': '  CCINFOBAR_NO_JOBS is set: every background job is off',
} as const;
