import type { MetaFile } from '../../types.js';

export const cost: MetaFile = {
  widgets: {
    'session-cost': {
      name: 'Oturum maliyeti',
      description: "Bu oturumun toplam maliyeti, Claude Code'dan USD olarak ya da model profili fiyatlarıyla",
    },
    'cost-today': {
      name: 'Bugünkü maliyet',
      description: 'Bugünkü tüm oturumların tahmini maliyeti (yerel maliyet kaydından)',
      label: 'Bugün ~',
    },
    'cost-week': {
      name: 'Bu haftaki maliyet',
      description: 'Bu ISO haftasındaki tüm oturumların tahmini maliyeti, pazartesiden pazara, yerel saatle',
      label: 'Hafta ~',
    },
    'cost-project': {
      name: 'Proje maliyeti',
      description: 'Bu projenin tüm oturumlardaki tahmini maliyeti',
      label: 'Proje ~',
    },
    budget: {
      name: 'Bütçe',
      description: 'Günlük ya da oturum bütçenize göre tahmini harcama',
      label: 'Bütçe ',
    },
    'cost-rate': { name: 'Maliyet hızı', description: 'Saat başına USD harcama hızı' },
    'session-duration': { name: 'Oturum süresi', description: 'Bu oturumun gerçek geçen süresi' },
    'api-duration': { name: 'API süresi', description: 'API yanıtı beklenerek geçen süre', label: 'API ' },
    'lines-changed': { name: 'Değişen satırlar', description: 'Bu oturumda eklenen ve silinen satırlar' },
    'message-count': { name: 'Mesaj sayısı', description: 'Transkriptteki mesajlar', label: 'Mesaj ' },
  },
  options: {
    Decimals: 'Ondalık basamak',
    'Cost from': 'Maliyet kaynağı',
    'Profile prices the session tokens in the profile currency; auto is the pick for gateway users':
      'Model profili fiyatları oturumdaki token sayısını profilin para biriminde hesaplar; ağ geçidi kullananlar için üçüncü taraf seçeneği uygundur',
    'Model profile prices': 'Model profili fiyatları',
    'Profile for third-party providers': 'Üçüncü taraf sağlayıcılarda profil',
    Period: 'Dönem',
    'All: since the ledger started (rows are kept 400 days)':
      'Tümü: maliyet kaydı başladığından beri (satırlar 400 gün tutulur)',
    Today: 'Bugün',
    'This week': 'Bu hafta',
    'This month': 'Bu ay',
    All: 'Tümü',
    'Set the amount in Settings or with ccinfobar config set budget.daily 10':
      "Tutarı Ayarlar'da ya da ccinfobar config set budget.daily 10 ile belirleyin",
    'Today (budget.daily)': 'Bugün (budget.daily)',
    'This session (budget.session)': 'Bu oturum (budget.session)',
    Display: 'Görünüm',
    Bar: 'Çubuk',
    Format: 'Biçim',
    'Hide when no changes': 'Değişiklik yokken gizle',
  },
};
