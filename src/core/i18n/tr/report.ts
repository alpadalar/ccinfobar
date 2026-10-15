import type { reportMessages as enReport } from '../en/report.js';
import type { Message } from '../types.js';

export const reportMessages = {
  'report.col.day': 'Gün',
  'report.col.week': 'Hafta',
  'report.col.month': 'Ay',
  'report.col.project': 'Proje',
  'report.col.sessions': 'Oturum',
  'report.col.input': 'Girdi',
  'report.col.output': 'Çıktı',
  'report.col.cacheRead': 'Önbellek okuma',
  'report.col.cacheWrite': 'Önbellek yazma',
  'report.col.total': 'Toplam',
  'report.col.cost': 'Maliyet (tah.)',
  'report.col.active': 'Aktif',
  'report.subtotal': 'ara toplam',
  'report.total': 'toplam',
  'report.partialMark': '*',
  'report.empty': '{dir} içinde kullanım bulunamadı',
  'report.note.estimate':
    'Maliyetler liste fiyatlarıyla yapılmış tahminlerdir; abonelikte ödediğiniz tutarı göstermez.',
  'report.note.ledger-since':
    'Maliyet kaydı {date} tarihinde başlıyor; önceki maliyetler transkriptlerden tahmin edildi.',
  'report.note.unpriced': {
    one: '{models} için fiyat yok ({count} istek); maliyeti sayılmadı.',
    other: '{models} için fiyat yok ({count} istek); maliyetleri sayılmadı.',
  },
  'report.note.non-usd': '{currency} cinsinden maliyetler USD toplamlarına dahil değil: {amount}.',
  'report.note.profile-price': '{vendor} modellerinin fiyatları yerleşik {vendor} profilinden alındı.',
  'report.note.partial': '* Kısmi maliyet: maliyet kaydı geç başladı ya da bazı isteklerin fiyatı yok.',
  'report.note.approx-project': {
    one: '{count} oturumun projesi klasör adından tahmin edildi.',
    other: '{count} oturumun projesi klasör adından tahmin edildi.',
  },
  'report.note.ledger-only': {
    one: '{count} oturumun maliyeti var ama transkripti kalmadı; token ve süre — gösterir.',
    other: '{count} oturumun maliyeti var ama transkripti kalmadı; token ve süre — gösterir.',
  },
  'report.note.file-cap': {
    one: '{count} transkript dosyasından sonra durduruldu; bazı kullanımlar eksik olabilir.',
    other: '{count} transkript dosyasından sonra durduruldu; bazı kullanımlar eksik olabilir.',
  },
  'report.note.line-skipped': {
    one: 'Çok uzun {count} transkript satırı atlandı.',
    other: 'Çok uzun {count} transkript satırı atlandı.',
  },
  'report.note.deleted-transcripts': {
    one: 'Silinmiş {count} transkript rapor indeksinden sayılmaya devam ediyor.',
    other: 'Silinmiş {count} transkript rapor indeksinden sayılmaya devam ediyor.',
  },
  'report.note.rebuild-kept': {
    one: 'Yeniden oluşturma, silinmiş {count} transkripti eski indeksten korudu.',
    other: 'Yeniden oluşturma, silinmiş {count} transkripti eski indeksten korudu.',
  },
} satisfies Record<keyof typeof enReport, Message>;
