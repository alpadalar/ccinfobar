import type { reportMessages as enReport } from '../en/report.js';
import type { Message } from '../types.js';

export const reportMessages = {
  'report.col.day': 'Gün',
  'report.col.week': 'Hafta',
  'report.col.month': 'Ay',
  'report.col.project': 'Proje',
  'report.project.unknown': 'bilinmeyen proje',
  'report.col.sessions': 'Oturum',
  'report.col.input': 'Girdi',
  'report.col.output': 'Çıktı',
  'report.col.cacheRead': 'Önbellek okuma',
  'report.col.cacheWrite': 'Önbellek yazma',
  'report.col.total': 'Toplam',
  'report.col.cost': 'Tahmini maliyet',
  'report.col.active': 'Aktif',
  'report.subtotal': 'ara toplam',
  'report.total': 'toplam',
  'report.partialMark': '*',
  'report.tokensMark': '+',
  'report.empty': '{dir} içinde kullanım bulunamadı',
  'report.badPeriod': 'Bilinmeyen dönem "{value}". day, week ya da month kullanın.',
  'report.badSince':
    'Geçersiz --since değeri "{value}". YYYY-MM-DD ya da gün, hafta veya ay sayısı kullanın (7d, 4w, 3m).',
  'report.badUntil':
    'Geçersiz --until değeri "{value}". YYYY-MM-DD ya da gün, hafta veya ay sayısı kullanın (7d, 4w, 3m).',
  'report.badOrder': 'Başlangıç tarihi {value}, bitiş tarihinden sonra.',
  'report.badFormat': 'Bilinmeyen biçim "{value}". table, csv ya da json kullanın.',
  'report.formatConflict': 'Tek bir çıktı biçimi seçin: --format, --csv ya da --json.',
  'report.projectValue':
    '--project bir değer ister: proje yolunun bir parçası ya da geçerli proje için "." yazın.',
  'report.progress': {
    one: 'Transkriptler taranıyor: {count} dosya, {mb} MB',
    other: 'Transkriptler taranıyor: {count} dosya, {mb} MB',
  },
  'report.rebuilt': {
    one: 'Maliyet kaydı özeti yeniden oluşturuldu ve {count} transkript yeniden okundu',
    other: 'Maliyet kaydı özeti yeniden oluşturuldu ve {count} transkript yeniden okundu',
  },
  'report.reread': {
    one: '{count} transkript yeniden okundu; yeniden oluşturulacak maliyet kaydı henüz yok',
    other: '{count} transkript yeniden okundu; yeniden oluşturulacak maliyet kaydı henüz yok',
  },
  'report.rebuildFailed': 'Maliyet kaydı özeti yeniden yazılamadı.',
  'report.keptDeleted': {
    one: 'Silinmiş {count} transkriptin geçmişi korundu',
    other: 'Silinmiş {count} transkriptin geçmişi korundu',
  },
  'report.note.estimate':
    'Maliyetler liste fiyatlarıyla yapılmış tahminlerdir; abonelikte ödediğiniz tutarı göstermez.',
  'report.note.ledger-since':
    'Maliyet kaydı {date} tarihinde başlıyor; önceki maliyetler transkriptlerden tahmin edildi.',
  'report.note.unpriced': {
    one: '{models} için fiyat yok ({count} istek); maliyetleri hesaba katılmadı.',
    other: '{models} için fiyat yok ({count} istek); maliyetleri hesaba katılmadı.',
  },
  'report.note.non-usd': '{currency} cinsinden maliyetler USD toplamlarına dahil değil: {amount}.',
  'report.note.profile-price': '{vendor} modellerinin fiyatları yerleşik {vendor} profilinden alındı.',
  'report.note.partial': '* Kısmi maliyet: maliyet kaydı geç başladı ya da bazı isteklerin fiyatı yok.',
  'report.note.approx-project': {
    one: '{count} oturumun projesi klasör adından tahmin edildi.',
    other: '{count} oturumun projesi klasör adından tahmin edildi.',
  },
  'report.note.ledger-only': {
    one: '{count} oturumun maliyeti var ama transkripti kalmadı; token ve süre sütunlarında — görünür.',
    other: '{count} oturumun maliyeti var ama transkripti kalmadı; token ve süre sütunlarında — görünür.',
  },
  'report.note.tokens-partial':
    '+ Token ve süre, satırda maliyeti olup transkripti kalmayan oturumları içermez.',
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
  'report.note.keys-lost': {
    one: 'Rapor indeksi istek anahtarlarını kaybetti; silinmiş {count} transkriptten kopyalanan istekler iki kez sayılabilir.',
    other:
      'Rapor indeksi istek anahtarlarını kaybetti; silinmiş {count} transkriptten kopyalanan istekler iki kez sayılabilir.',
  },
  'report.note.old-zone': {
    one: 'Silinmiş {count} transkriptin günleri, okunduğu saat dilimine göre kalıyor.',
    other: 'Silinmiş {count} transkriptin günleri, okundukları saat dilimine göre kalıyor.',
  },
} satisfies Record<keyof typeof enReport, Message>;
