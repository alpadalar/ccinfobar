import type { importMessages as enImport } from '../en/import.js';
import type { Message } from '../types.js';

export const importMessages = {
  'import.cannotRead': '{file} konumundaki ccstatusline ayarları okunamıyor',
  'import.cannotParse': '{file} konumundaki claude-powerline yapılandırması ayrıştırılamıyor',
  'import.cannotReadTool': '{file} konumundaki {tool} yapılandırması okunamıyor',
  'import.tooLarge': '{file} 1 MB sınırından büyük, okunmadı',
  'import.tool.gsd': 'GSD durum satırı',
  'import.tool.custom': 'özel bir durum satırı',
  'import.note.noEquivalent': '{tool} bileşeni "{name}" için ccinfobar karşılığı yok, atlandı',
  'import.note.noSegment': '{tool} bölümü "{name}" için ccinfobar karşılığı yok, atlandı',
  'import.note.customColors': 'özel {tool} renkleri her bileşene ayrı ayrı kopyalandı',
  'import.note.defaultLayout': '{tool} yapılandırma dosyası bulunamadı, varsayılan düzeni içe aktarıldı',
  'import.note.selfUpdate': '{tool} bölümü "{name}" atlandı: ccinfobar kendini günceller',
  'import.note.usageApi':
    '{tool} bölümü "{name}": kullanım API seçenekleri ({options}) atlandı, ccinfobar token\'ınızı asla özel bir sunucuya göndermez',
  'import.note.iconColor': '{tool} bölümü "{name}": simge rengi atlandı, bileşenin tek rengi var',
  'import.note.commandDir': '{tool} yapılandırması durum satırı komutunun yanındaki dosyadan okundu: {file}',
  'import.note.themeFile': '{tool} teması "{name}" durum satırı komutunda seçili, şu dosyadan okundu: {file}',
  'import.note.themeBuiltin':
    '{tool} teması "{name}" durum satırı komutunda seçili, yerleşik tema içe aktarıldı',
  'import.note.themeUnknown':
    '{tool} teması "{name}" durum satırı komutunda seçili ama bulunamadı, varsayılan tema içe aktarıldı',
  'import.note.themeUnsafe':
    'durum satırı komutundaki {tool} teması "{name}" güvenli bir tema adı değil, yok sayıldı',
  'import.note.hideState': '{name}: "{state}" durumunda gizleme desteklenmiyor, bileşen görünür kalır',
  'import.note.targetDropped': '{kind} "{target}" onaylanmadığı için çıkarıldı',
  'import.note.unsafeLink': 'link "{url}" güvenli olmayan bir URL içeriyor, çıkarıldı',
  'import.targetsHeader': 'Bu düzen komut çalıştırıyor veya URL açıyor:',
  'import.target': '  {kind}: {target}',
  'import.keepPrompt': { one: 'Bu öğe korunsun mu?', other: 'Bu {count} öğe korunsun mu?' },
  'import.targetsDropped': {
    one: '{count} komut/URL öğesi çıkarıldı.',
    other: '{count} komut/URL öğesi çıkarıldı.',
  },
  'import.rerun': 'Korumak için şunu çalıştırın: {command}',
  'import.rerunAddFile':
    'Korumak için şunu çalıştırın: {command} (kaynak dosyanın yolunu --file ile ekleyin)',
  'import.spaces': '\u27e8{count} boşluk\u27e9',
  'import.targetLong': '  {kind}: {count} karakter, incelenemeyecek kadar uzun, çıkarıldı',
  'import.note.targetTooLong':
    '{count} karakterlik {kind} çıkarıldı (incelenemeyecek kadar uzun, --allow-commands ile korunur)',
  'import.approxHeader': 'Yaklaşık eşlenenler:',
  'import.dropHeader': 'Atlananlar:',
  'import.infoHeader': 'Notlar:',
  'import.dryRunHeader': 'Örnek verilerle önizleme:',
  'import.dryRunDone': 'Deneme çalıştırması: hiçbir şey yazılmadı.',
} satisfies Record<keyof typeof enImport, Message>;
