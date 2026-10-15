import type { jobsMessages as enJobs } from '../en/jobs.js';
import type { Message } from '../types.js';

export const jobsMessages = {
  'doctor.jobs.heading': '\nArka plan işleri',
  'doctor.jobs.none': '  Henüz arka plan verisi yok',
  'doctor.jobs.ok': '  {key}: tamam, {age} önce',
  'doctor.jobs.error': '  {key}: hata: {error}, {age} önce',
  'doctor.jobs.retry': ', {in} sonra yeniden denenecek',
  'doctor.jobs.offTraffic': ', kapalı (zorunlu olmayan trafik)',
  'doctor.jobs.offAll': ', kapalı (CCINFOBAR_NO_JOBS)',
  'doctor.jobs.unknownError': 'bilinmeyen hata',
  'doctor.jobs.nonessential':
    '  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ayarlı: usage, update ve status işleri kapalı; http, gh ve repos işleri çalışmaya devam eder',
  'doctor.jobs.disabled': '  CCINFOBAR_NO_JOBS ayarlı: tüm arka plan işleri kapalı',
  'doctor.jobs.httpUrl': ' ({url})',
  'doctor.jobs.httpUnused': ' (şu an hiçbir http öğesi kullanmıyor)',
  'doctor.jobs.scrub':
    '  CLAUDE_CODE_SUBPROCESS_ENV_SCRUB ayarlı: Claude Code gizli görünen değişkenleri (örneğin *_TOKEN) durum satırı sürecinden kaldırabilir, bu yüzden bunlardan birini kullanan bir http başlığı "env NAME not set" bildirir',
} satisfies Record<keyof typeof enJobs, Message>;
