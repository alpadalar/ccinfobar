import type { importMessages as enImport } from '../en/import.js';
import type { Message } from '../types.js';

export const importMessages = {
  'import.cannotRead': '{file} konumundaki ccstatusline ayarları okunamıyor',
  'import.cannotParse': '{file} konumundaki claude-powerline yapılandırması ayrıştırılamıyor',
  'import.tooLarge': '{file} 1 MB sınırından büyük, okunmadı',
  'import.tool.gsd': 'GSD durum satırı',
  'import.tool.custom': 'özel bir durum satırı',
  'import.note.noEquivalent': '{tool} bileşeni "{name}" için ccinfobar karşılığı yok, atlandı',
  'import.note.noSegment': '{tool} bölümü "{name}" için ccinfobar karşılığı yok, atlandı',
  'import.note.customColors': 'özel {tool} renkleri her bileşene ayrı ayrı kopyalandı',
  'import.note.defaultLayout': '{tool} yapılandırma dosyası bulunamadı, varsayılan düzeni içe aktarıldı',
  'import.note.hideState': '{name}: "{state}" durumunda gizleme desteklenmiyor, bileşen görünür kalır',
} satisfies Record<keyof typeof enImport, Message>;
