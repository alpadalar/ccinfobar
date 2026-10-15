import type { doctorMessages as enDoctor } from '../en/doctor.js';
import type { Message } from '../types.js';

export const doctorMessages = {
  'doctor.configIssue': '  satır {line}, sütun {column}: {message}',
  'doctor.refreshHint':
    '  Zamana bağlı bileşenler ({widgets}) yalnızca Claude Code durum satırını yeniden çalıştırdığında güncellenir. 5 saniyede bir yenilemek için `ccinfobar install --refresh 5` çalıştırın; Claude Code hook olaylarında veya bir izin penceresi açıkken durum satırını yeniden çalıştırmaz.',
  'doctor.refreshHintRules':
    '  {items} üzerindeki zaman kuralları yalnızca Claude Code durum satırını yeniden çalıştırdığında değişir. 5 saniyede bir yenilemek için `ccinfobar install --refresh 5` çalıştırın.',
  'doctor.lineCut':
    '  ⚠ {line}. satır {need} sütun gerektiriyor ve "…" ile kesiliyor. widthOffset değerini düşürün, düşük öncelikli bileşenleri atmak için "overflow": "priority" ya da "overflow": "wrap" ayarlayın.',
  'doctor.lineCutMode':
    '  ⚠ {line}. satır {need} sütun gerektiriyor ve "overflow": "{mode}" ayarına rağmen hâlâ "…" ile kesiliyor. Bileşenleri başka bir satıra taşıyın ya da widthOffset değerini düşürün.',
  'doctor.jetbrains':
    '  JetBrains terminali algılandı. Emojilerin hizalanması için "glyphMode": "jetbrains" (veya "auto") ayarlayın.',
  'doctor.priorityTui':
    '  "overflow": "priority" tui stiline uygulanmaz; panel hücreleri kendi kırılma noktalarını kullanır.',
  'doctor.columnNote': '  (sütunlar UTF-16 kod birimi olarak sayılır)',
  'doctor.language': '  Dil: {name} ({id}, kaynak: {source})',
  'doctor.languageFrom.config': 'yapılandırma',
  'doctor.languageFrom.Intl': 'sistem yerel ayarı',
  'doctor.languageFrom.default': 'varsayılan',
  'doctor.languageDropped': '⚠ language "{value}" desteklenmiyor ve yok sayılıyor ({values} kullanın)',
  'doctor.unknownWidget': '⚠ {line}. satırda bilinmeyen bileşen türü "{type}"',
  'doctor.badOption': '⚠ {type}: "{key}" seçeneğinin değeri desteklenmiyor',
  'doctor.badRule': '⚠ Bileşen {id}: {key} yok sayıldı ({problem})',
  'doctor.hiddenByRule': 'kuralla gizlendi',
  'doctor.http.item': '  {line}. satırdaki http: {url}, gönderdiği env: {env}',
  'doctor.http.noEnv': 'yok',
  'doctor.http.noUrl': '⚠ {line}. satırdaki http: url ayarlı değil; öğe hiçbir şey göstermez',
  'doctor.http.badUrl': '⚠ {line}. satırdaki http: url: {error}; öğe hiçbir şey göstermez',
  'doctor.http.badHeader': '⚠ {line}. satırdaki http: {error} (bu başlık atlanır)',
  'doctor.http.refusedHeader': '⚠ {line}. satırdaki http: headers: {error}; öğe hiçbir şey göstermez',
  'doctor.http.badPath': '⚠ {line}. satırdaki http: path: {error}; öğe hiçbir şey göstermez',
  'doctor.http.plain':
    '⚠ {line}. satırdaki http: {host} şifresiz http kullanıyor, bu yüzden yanıt yolda okunabilir ya da değiştirilebilir. https kullanın.',
  'doctor.gitHardeningOff': '  Git sıkılaştırması kapalı (gitHardening: false)',
  'doctor.manifest': '  Manifest {file}: {count} kayıtlı değişiklik',
  'doctor.manifestEntry': '    {file} içinde {kind}',
  'doctor.backups': '  Yedekler {dir}',
  'doctor.winCommand':
    '⚠ statusLine komutunda ters eğik çizgi ya da tırnaklı bir ilk parça var; Git Bash onu çalıştıramayabilir. ccinfobar install komutunu yeniden çalıştırın.',
  'doctor.tmpPruned': '  {count} eski geçici dosya kaldırıldı',
  'doctor.noPayload':
    "  Henüz payload yok. ccinfobar kuruluyken Claude Code'u bir kez kullanın ya da `ccinfobar explain --scenario <name>` deneyin.",
  'doctor.row.workspaceHidden': 'gizli (çalışma alanı modu)',
  'doctor.limit.five_hour': '5 saatlik',
  'doctor.limit.seven_day': 'haftalık',
  'doctor.limit.both': '5 saatlik ve haftalık',
  'doctor.note.limitFull':
    '{names} kullanım limitiniz doldu (100%), bu yüzden Claude şu an yanıt veremiyor. Bağlam, önbellek ve token bileşenleri bir sonraki başarılı yanıttan sonra dolar.',
  'doctor.note.noReplies':
    'Bu oturumda henüz yanıt yok (maliyet $0, istem önbelleği yok). Bir mesaj gönderip doctor komutunu yeniden çalıştırın; bağlam, önbellek ve hız bileşenleri en az bir yanıt gerektirir.',
  'doctor.explainPointer': '  Ayrıntılar: `ccinfobar explain` (veya `ccinfobar explain <widget-id>`)',
  'doctor.hooks.off':
    "  Hook'lar: kapalı. Tur, izin ve alt ajan durumunu tam görmek için `ccinfobar install --hooks` çalıştırın.",
  'doctor.hooks.summary':
    "  Hook'lar: {count} tanesi ccinfobar tarafından kuruldu (Claude Code {versions} ile kaydedildi)",
  'doctor.hooks.entry': '    {event} (Claude Code {claudeCode})',
  'doctor.hooks.progressEntry': '    {event} (ilerleme), Claude Code {claudeCode}',
  'doctor.hooks.edited':
    "⚠ {event} hook'u ccinfobar dışında değiştirildi ya da kaldırıldı; ccinfobar ona dokunmuyor.",
  'doctor.hooks.missingBinary':
    "⚠ Hook komutu bulunamadı: {command} ({count} hook). Claude Code her olayda bir hook hatası gösterir. `ccinfobar install --hooks` komutunu yeniden çalıştırın ya da hook'ları kaldırmak için `ccinfobar uninstall` çalıştırın.",
  'doctor.hooks.disableAll':
    "⚠ {layer} ayarlarında ({file}) disableAllHooks açık: Claude Code hiçbir hook'u ve durum satırını çalıştırmıyor",
  'doctor.hooks.managedOnly':
    "⚠ Yönetilen ayarlarda ({file}) allowManagedHooksOnly açık: kullanıcı hook'ları yok sayılır ve yalnızca yönetilen bir statusLine çalışır",
  'doctor.hooks.managedNote':
    '  Yalnızca dosya tabanlı yönetilen ayarlar denetlendi (MDM veya kayıt defteri politikaları değil)',
  'doctor.hooks.lastEvent': '  Son hook olayı {age} önce (son payload oturumu)',
  'doctor.hooks.noEvents': '  Son payload oturumu için henüz hook olayı kaydedilmedi',
  'doctor.progress.ccBar':
    '⚠ Claude Code da kendi ilerleme çubuğunu çiziyor. İkisi titremesin diye {file} dosyasında "terminalProgressBarEnabled": false ayarlayın.',
  'doctor.progress.noHandlers':
    '⚠ Terminal ilerlemesi açık ama hook işleyicileri eksik. `ccinfobar install --progress` çalıştırın.',
  'doctor.progress.strayHandlers':
    '⚠ İlerleme hook işleyicileri kurulu ama ilerleme kapalı. `ccinfobar uninstall --progress` çalıştırın.',
  'doctor.progress.terminal':
    '⚠ Bu terminalin OSC 9;4 ilerlemesini gösterdiği bilinmiyor; yine de denemek için "progress.terminals": "always" ayarlayın.',
  'doctor.progress.oldClaude':
    '⚠ Terminal ilerlemesi Claude Code 2.1.141 veya daha yenisini gerektirir (bulunan: {version}).',
  'doctor.progress.ttyHandlers':
    '⚠ İlerleme tty kanalını kullanıyor, bu yüzden hook işleyicileri yalnızca istem gecikmesi ekler. Onları kaldırmak için `ccinfobar install --progress` çalıştırın.',
  'doctor.progress.ttyWindows': '⚠ "channel": "tty" Windows\'ta çalışmaz; "auto" kullanın.',
  'doctor.progress.tmux':
    '⚠ tmux içinde tty kanalı "tmuxPassthrough": true ve `set -g allow-passthrough on` gerektirir.',
} satisfies Record<keyof typeof enDoctor, Message>;
