import type { MetaFile } from '../../types.js';

export const context: MetaFile = {
  widgets: {
    'context-percentage': {
      name: 'Bağlam yüzdesi',
      description: 'Bağlam penceresinin kullanılan ya da kalan kısmı, yüzde olarak',
      label: 'Bğl ',
    },
    'context-bar': {
      name: 'Bağlam çubuğu',
      description: 'Bağlam penceresi kullanımını gösteren ilerleme çubuğu',
      label: 'Bğl ',
    },
    'context-length': {
      name: 'Bağlam uzunluğu',
      description: 'Bağlam penceresinde şu an bulunan token',
      label: 'Bğl ',
    },
    'context-window-size': {
      name: 'Bağlam penceresi boyutu',
      description: 'Bağlam penceresinin en büyük boyutu',
      label: 'Pencere ',
    },
    compactions: {
      name: 'Sıkıştırmalar',
      description: 'Bu oturumdaki bağlam sıkıştırma sayısı',
      label: 'Sıkıştırma ',
    },
  },
  options: {
    Mode: 'Mod',
    Used: 'Kullanılan',
    Remaining: 'Kalan',
    'Percentage of': 'Yüzde tabanı',
    "Usable matches Claude Code's auto-compact threshold; reserve subtracts the output reserve below":
      "Otomatik sıkıştırmadan önce, Claude Code'un otomatik sıkıştırma eşiğine denk gelir; çıktı payı seçeneği aşağıdaki payı düşer",
    'Full window': 'Tüm pencere',
    'Before auto-compact': 'Otomatik sıkıştırmadan önce',
    'Minus output reserve': 'Çıktı payı düşülmüş',
    'Output reserve tokens': 'Çıktı payı (token)',
    'Approximate: tokens Claude Code keeps for output (20,000 in Claude Code 2.1.299, may change)':
      "Yaklaşık: Claude Code'un çıktı için ayırdığı token (Claude Code 2.1.299 sürümünde 20,000; değişebilir)",
    'Show window size': 'Pencere boyutunu göster',
    'Show when zero': 'Sıfırken göster',
  },
};
