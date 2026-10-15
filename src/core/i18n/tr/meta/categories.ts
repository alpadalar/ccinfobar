import type { WidgetCategory } from '../../../types.js';

export const categories: Record<WidgetCategory, string> = {
  session: 'Oturum ve model',
  context: 'Bağlam penceresi',
  tokens: 'Token ve önbellek',
  cost: 'Maliyet ve süre',
  limits: 'Kullanım limitleri',
  charts: 'Grafikler',
  agents: 'Ajanlar ve görevler',
  gsd: 'GSD',
  git: 'Git',
  workspace: 'Çalışma alanı',
  system: 'Sistem',
  custom: 'Özel',
  fun: 'Eğlence',
  layout: 'Düzen',
};
