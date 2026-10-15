import type { MetaFile } from '../../types.js';

export const charts: MetaFile = {
  widgets: {
    'token-rate-graph': {
      name: 'Token hızı grafiği',
      description: 'Son birkaç dakikada dakika başına token, kayan bir mini grafik olarak',
      label: 'Tok/m ',
    },
    'output-speed-graph': {
      name: 'Çıktı hızı grafiği',
      description: 'Claude yazarken saniye başına çıktı token, kayan bir mini grafik olarak',
      label: 'Hız ',
    },
    'context-graph': {
      name: 'Bağlam grafiği',
      description: 'Bağlam penceresinin zaman içindeki doluluğu',
      label: 'Bağlam ',
    },
    'usage-graph': {
      name: 'Kullanım grafiği',
      description: '5 saatlik ya da haftalık kullanımınızın zaman içindeki seyri',
      label: '5h ',
    },
    'cost-graph': {
      name: 'Harcama hızı grafiği',
      description: 'Son birkaç dakikada saat başına dolar',
      label: '$/h ',
    },
    'activity-strip': {
      name: 'Etkinlik şeridi',
      description:
        "Claude'un tüm oturumlarınızda meşgul olduğu zamanlar, 15 dakikalık dilimlerle (yerel maliyet kaydından)",
      label: 'Etkinlik ',
    },
  },
  options: {
    Points: 'Nokta sayısı',
    'How many samples the graph shows; one sample every few seconds':
      'Grafiğin gösterdiği örnek sayısı; birkaç saniyede bir örnek alınır',
    'Show value': 'Değeri göster',
    Window: 'Pencere',
    '5 hours': '5 saat',
    '7 days': '7 gün',
    Slots: 'Dilim sayısı',
    'How many cells (4 to 96); 36 cells of 15 minutes is 9 hours':
      'Hücre sayısı (4 ile 96 arası); 15 dakikalık 36 hücre 9 saat eder',
    'Slot size': 'Dilim boyu',
    '15 minutes': '15 dakika',
    '30 minutes': '30 dakika',
    '1 hour': '1 saat',
    Mode: 'Mod',
    Intensity: 'Yoğunluk',
    Presence: 'Var ya da yok',
  },
};
