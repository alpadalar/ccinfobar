import type { importMessages as enImport } from '../en/import.js';
import type { Message } from '../types.js';

export const importMessages = {
  'import.cannotRead': '{file} konumundaki ccstatusline ayarları okunamıyor',
  'import.cannotParse': '{file} konumundaki claude-powerline yapılandırması ayrıştırılamıyor',
  'import.cannotReadTool': '{file} konumundaki {tool} yapılandırması okunamıyor',
  'import.cannotParseTool': '{file} konumundaki {tool} yapılandırması ayrıştırılamıyor',
  'import.tooLarge': '{file} 1 MB sınırından büyük, okunmadı',
  'import.notFound': '{tool} yapılandırması bulunamadı ({file}); yolunu --file ile verin',
  'import.shownCommand': 'durum satırı komutundaki yol',
  'import.tool.gsd': 'GSD durum satırı',
  'import.tool.custom': 'özel bir durum satırı',
  'import.help.title': "Başka bir durum satırının düzenini ccinfobar'a aktarır",
  'import.help.tools': 'Araçlar',
  'import.help.fromCommand': 'durum satırı komutu',
  'import.help.footer':
    '--file verilmezse her aracın kendi varsayılan dosyası okunur. --dry-run eşlemeyi gösterir, hiçbir şey yazmaz.',
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
  'import.note.themeApprox': '{tool} teması "{name}", {theme} temasıyla yaklaşık olarak gösteriliyor',
  'import.note.themeMissing':
    '{tool} teması "{name}" için ccinfobar karşılığı yok, {theme} teması kullanıldı',
  'import.note.styleApprox': '{tool} stili "{name}", {style} stiliyle yaklaşık olarak gösteriliyor',
  'import.note.ignoredSettings': '{tool} ayarları içe aktarılmadı: {names}',
  'import.note.secretDropped': '{tool} ayarı "{name}" gizli bir değer içeriyor, kopyalanmadı',
  'import.note.fileIgnored': '{tool} ayarlarını durum satırı komutundan okur, --file yok sayıldı',
  'import.cshipNotFound': 'cship yapılandırması bulunamadı',
  'import.cshipNoLines': 'cship yapılandırmasında satır yok ({file})',
  'import.note.starshipConfig':
    '{tool} yapılandırması $STARSHIP_CONFIG içinden okundu: {file} (cship bunu yalnızca Starship modülleri için kullanır)',
  'import.note.noModule': '{tool} modülü "{name}" için ccinfobar karşılığı yok, atlandı',
  'import.note.moduleApprox': '{tool} modülü "{name}", {widget} bileşeniyle yaklaşık olarak gösteriliyor',
  'import.note.thresholdColors':
    '{tool} modülü "{name}": uyarı/kritik eşikleri ve stilleri ccinfobar eşik renklerine dönüştürüldü (%50\'den itibaren sarı, %80\'den itibaren kırmızı)',
  'import.note.noThreshold':
    '{tool} modülü "{name}": uyarı/kritik eşikleri atlandı, {widget} bileşeninin eşik renkleri yok',
  'import.note.moduleOptions':
    '{tool} modülü "{name}": {options} içe aktarılmadı, bileşen kendi biçimini kullanır',
  'import.note.unknownStyle': '{tool} "{name}" stili: {tokens} desteklenmiyor, yok sayıldı',
  'import.note.fillChar': '{tool} dolgu karakteri "{symbol}" boşluk olarak gösterilir',
  'import.note.starshipPrompt':
    '{tool} $starship_prompt atlandı: ccinfobar Starship çalıştırmaz; "starship prompt" çalıştıran bir command bileşeni bunu gösterebilir (oluşturulmadı)',
  'import.note.starshipModule':
    'Starship modülü "{name}" için ccinfobar karşılığı yok, atlandı; "starship module {name}" çalıştıran bir command bileşeni bunu gösterebilir (oluşturulmadı)',
  'import.note.spanLiteral':
    '{tool} stilli metni "{text}" yazıldığı gibi gösterilir: [ ] içindeki değişkenler açılmaz',
  'import.note.emptySpans': {
    one: '{tool}: görünür metni olmayan {count} stilli parça (powerline geçişi) atlandı',
    other: '{tool}: görünür metni olmayan {count} stilli parça (powerline geçişleri) atlandı',
  },
  'import.note.gapsReplaced':
    '{tool}: {gaps} ile ayrılan modüller artık en sık kullanılan ayracı ({separator}) kullanıyor',
  'import.note.hudIgnored': '{file} bir JSON nesnesi değil, yok sayıldı',
  'import.note.hudApprox': '{tool} "{name}", {widget} bileşeniyle yaklaşık olarak gösteriliyor',
  'import.note.hudShownAlways':
    '{tool} ayarı "{name}" = {value}, {widget} bileşenini bu değerin altında gizler; ccinfobar onu her zaman gösterir',
  'import.note.hudNoThreshold':
    '{tool} ayarı "{name}" = {value} atlandı, {widget} bileşeninin eşik renkleri yok',
  'import.note.hudContextThresholds':
    "{tool} bağlam eşikleri %{warn}/%{critical}, ccinfobar eşik renklerine dönüştürüldü (%50'den itibaren sarı, %80'den itibaren kırmızı)",
  'import.note.hudBreakdown':
    '{tool} token dökümü her zaman gösterilir ({tool} bunu yalnızca bağlam %{value} ve üzerindeyken gösterir)',
  'import.note.hudExternalUsage':
    '{tool} ayarı "{name}" atlandı: ccinfobar kullanım verisini yalnızca Claude Code\'dan alır, başka dosya okumaz ve yazmaz',
  'import.note.hudLanguage': '{tool} dili "{name}" içe aktarılmadı: ccinfobar kendi dil ayarını korur',
  'import.note.hudExtraCmd':
    '{tool}, --extra-cmd komutunu yalnızca CLAUDE_HUD_ALLOW_EXTRA_CMD ayarlıysa çalıştırır; bu değişken ortamınızda veya settings.json içinde ayarlı değil',
  'import.note.hideState': '{name}: "{state}" durumunda gizleme desteklenmiyor, bileşen görünür kalır',
  'import.note.targetDropped': '{kind} "{target}" onaylanmadığı için çıkarıldı',
  'import.note.targetChanged':
    '{kind} "{target}" temizlenirken değişti: satır sonları boşluk oldu, kaçış ve kontrol karakterleri çıkarıldı',
  'import.note.unsafeLink': 'bağlantı "{url}" güvenli olmayan bir URL içeriyor, çıkarıldı',
  'import.kind.command': 'komut',
  'import.kind.http': 'http',
  'import.kind.link': 'bağlantı',
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
  'import.rerunAddCommand':
    'Korumak için şunu çalıştırın: {command} (önceki durum satırı komutunuzu --command ile ekleyin)',
  'import.rerunAddBoth':
    'Korumak için şunu çalıştırın: {command} (kaynak dosyanın yolunu --file, önceki durum satırı komutunuzu --command ile ekleyin)',
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
