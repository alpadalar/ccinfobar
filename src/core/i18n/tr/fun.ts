import type { funMessages as enFun } from '../en/fun.js';
import type { Message } from '../types.js';

export const funMessages = {
  'fun.quip.context.calm.0': 'Düşünecek bol yer var',
  'fun.quip.context.calm.1': 'Bağlam taze, kafa rahat',
  'fun.quip.context.calm.2': 'Pencerede her şey sakin',
  'fun.quip.context.warm.0': 'Ortam ısınmaya başladı',
  'fun.quip.context.warm.1': 'Notların yarısı doldu',
  'fun.quip.context.warm.2': 'Bağlam yavaş yavaş ısınıyor',
  'fun.quip.context.hot.0': 'Masada yer kalmadı gibi',
  'fun.quip.context.hot.1': 'Biraz toparlamak iyi olur',
  'fun.quip.context.hot.2': 'Pencere epey kalabalıklaştı',
  'fun.quip.context.full.0': 'Sanırım sıkıştırma vakti',
  'fun.quip.context.full.1': 'Hafıza neredeyse dolu',
  'fun.quip.context.full.2': 'Ağzına kadar dolu',
  'fun.quip.usage.fresh.0': 'Daha bol bol kullanım var',
  'fun.quip.usage.fresh.1': 'Pencere daha yeni açıldı',
  'fun.quip.usage.fresh.2': 'Depo dolu, yol uzun',
  'fun.quip.usage.steady.0': 'Tempo yerinde, her şey yolunda',
  'fun.quip.usage.steady.1': 'Keyifli bir seyir',
  'fun.quip.usage.steady.2': 'Pencerenin yarısındayız',
  'fun.quip.usage.tight.0': 'Limit yaklaşıyor',
  'fun.quip.usage.tight.1': 'Biraz yavaşlamakta fayda var',
  'fun.quip.usage.tight.2': 'Kullanım azalıyor',
  'fun.quip.usage.limit.0': 'Limite ramak kaldı',
  'fun.quip.usage.limit.1': 'Bitmek üzere, çay molası',
  'fun.quip.usage.limit.2': 'Sıfırlama ufukta göründü',
} satisfies Record<keyof typeof enFun, Message>;
