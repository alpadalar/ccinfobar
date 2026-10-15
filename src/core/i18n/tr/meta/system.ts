import type { MetaFile } from '../../types.js';

export const system: MetaFile = {
  widgets: {
    clock: {
      name: 'Saat',
      description: 'Geçerli yerel saat',
    },
    date: {
      name: 'Tarih',
      description: 'Geçerli yerel tarih',
    },
    hostname: {
      name: 'Makine adı',
      description: 'Bilgisayarın ağdaki adı (hostname)',
    },
    username: {
      name: 'Kullanıcı adı',
      description: 'Geçerli işletim sistemi kullanıcısı',
    },
    memory: {
      name: 'Bellek',
      description: 'Sistem belleği kullanımı',
      label: 'Bellek ',
    },
    'env-counts': {
      name: 'Ortam sayıları',
      description:
        "Yapılandırma dosyalarına göre etkin CLAUDE.md, AGENTS.md, kural, MCP sunucusu ve hook'lar",
      sample: 'CLAUDE.md 2 · kural 3 · MCP 4 · hook 5',
    },
    'load-average': {
      name: 'Yük ortalaması',
      description: "Sistem yük ortalaması (Windows'ta yok)",
      label: 'Yük ',
    },
    'terminal-width': {
      name: 'Terminal genişliği',
      description: 'Algılanan terminal genişliği (sütun)',
      label: 'Sütun ',
    },
    platform: {
      name: 'Platform',
      description: 'İşletim sistemi',
    },
    'service-status': {
      name: 'Servis durumu',
      description: 'Claude durum sayfasının göstergesi ve süren olay, arka planda denetlenir',
      sample: '⚠ büyük: Elevated errors on Opus +1',
    },
  },
  options: {
    'Show seconds': 'Saniyeyi göster',
    '12-hour clock': '12 saat biçimi',
    Format: 'Biçim',
    'Oct 12': '12 Eki',
    'used/total GB': 'kullanılan/toplam GB',
    Percent: 'Yüzde',
    'Show CLAUDE.md': "CLAUDE.md'yi göster",
    'Show AGENTS.md': "AGENTS.md'yi göster",
    'Show rules': 'Kuralları göster',
    'Show MCP servers': 'MCP sunucularını göster',
    'Show hooks': "Hook'ları göster",
    'Hide zero counts': 'Sıfır olanları gizle',
    'MCP health (only when Claude Code exposes it)': 'MCP sağlığı (yalnızca Claude Code sunuyorsa)',
    'Show 1/5/15 minute averages': '1/5/15 dakikalık ortalamaları göster',
    'Check every (seconds)': 'Denetim aralığı (saniye)',
    'Seconds between checks, 120 to 600': 'İki denetim arasındaki saniye, 120 ile 600 arası',
    Components: 'Servisler',
    'Only count incidents on these components, comma-separated, for example Claude Code, API':
      'Yalnızca bu servislerdeki olayları say, virgülle ayrılmış, örneğin Claude Code, API',
    'Show incident name': 'Olay adını göster',
    'Off shows only the indicator, for example ⚠ major':
      'Kapalıyken yalnızca gösterge görünür, örneğin ⚠ büyük',
    'Show when all is well': 'Sorun yokken de göster',
    'Shows ✓ Claude OK instead of hiding the widget': 'Bileşeni gizlemek yerine ✓ Claude sorunsuz gösterir',
    'Max name length': 'Ad uzunluğu sınırı',
    'Longer incident names are cut with …': 'Daha uzun olay adları … ile kesilir',
  },
};
