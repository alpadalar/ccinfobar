import type { installMessages as enInstall } from '../en/install.js';
import type { Message } from '../types.js';

export const installMessages = {
  'install.installing': 'ccinfobar {version} kuruluyor',
  'install.wrote': '✓ {file} dosyasında statusLine "{command}" olarak ayarlandı',
  'install.foreignHeader': '{file} dosyasında başka bir araca ait bir statusLine zaten var.',
  'install.current': '  mevcut:   {command}',
  'install.proposed': '  önerilen: {command}',
  'install.refreshDiff': '  refreshInterval: {current} -> {proposed}',
  'install.refreshHint':
    'Zamana bağlı bileşenler ({widgets}) yalnızca Claude Code durum satırını yeniden çalıştırdığında güncellenir. 5 saniyede bir yenilemek için `--refresh 5` ekleyin; Claude Code hook olaylarında yeniden çalıştırmaz; izin istemi veya yardım menüsü açıkken durum satırını gizler.',
  'install.refreshHintRules':
    '{items} üzerindeki zaman kuralları yalnızca Claude Code durum satırını yeniden çalıştırdığında değişir. 5 saniyede bir yenilemek için `--refresh 5` ekleyin.',
  'install.refreshHintRotation':
    'Saatlik veya dakikalık tema döngüsü temayı yalnızca Claude Code durum satırını yeniden çalıştırdığında değiştirir; `ccinfobar install --refresh 5` boşta da zamanında değiştirir.',
  'install.refreshOne': "refreshInterval 1, Node'u her saniye başlatır; genellikle 5 yeterlidir.",
  'install.paddingDiff': '  padding: {current} -> {proposed}',
  'install.replacePrompt': 'Değiştirilsin mi?',
  'install.kept': 'Mevcut statusLine korundu. Hiçbir şey değiştirilmedi.',
  'install.subagentsProjectIgnored':
    '--subagents yalnızca kullanıcı ayarları için geçerli; --project ile yok sayıldı.',
  'install.subagentsUninstallProject':
    '--subagents yalnızca kullanıcı ayarları için geçerli; --project ile yok sayıldı.',
  'install.dry.subagentAdd': 'alt ajan subagentStatusLine "{command}" olarak ayarlanacak',
  'install.dry.subagentRewrite': 'subagentStatusLine "{from}" değerinden "{command}" değerine güncellenecek',
  'install.dry.subagentReplace': 'subagentStatusLine "{from}" yerine "{command}" yazılacak (önce sorulur)',
  'install.dry.subagentKeep': 'subagentStatusLine zaten ccinfobar çalıştırıyor',
  'install.subagentReplacePrompt': 'Mevcut alt ajan subagentStatusLine ({command}) değiştirilsin mi?',
  'install.subagentsKept': 'Mevcut alt ajan subagentStatusLine korundu.',
  'install.subagentsAdded': '✓ alt ajan subagentStatusLine "{command}" olarak ayarlandı',
  'install.subagentsRewritten': '✓ alt ajan subagentStatusLine "{command}" olarak güncellendi',
  'install.subagentsReplaced':
    '✓ alt ajan subagentStatusLine "{command}" olarak ayarlandı ({previous} değiştirildi; uninstall geri getirir)',
  'install.subagentsRemoved': '✓ alt ajan subagentStatusLine kaldırıldı',
  'install.subagentsRestored': '✓ alt ajan subagentStatusLine "{command}" değerine geri döndü',
  'install.subagentsKeptEdited': 'subagentStatusLine elle değiştirilmiş; korundu',
  'install.subagentsNone': '{file} içinde ccinfobar subagentStatusLine yok',
  'install.replaced': 'Değiştirilen: {command}',
  'install.dryRun': 'Deneme çalıştırması: hiçbir şey yazılmadı.',
  'install.dryRunGlobal': 'Önce ccinfobar {version} npm ile kurulacak.',
  'install.dryRunFile': '{file} dosyasında statusLine ayarlanacak',
  'install.dryRunProjects': {
    one: "GSD'nin durum satırı {count} projede de değiştirilecek:",
    other: "GSD'nin durum satırı {count} projede de değiştirilecek:",
  },
  'install.unset': 'ayarlı değil',
  'install.stale':
    'Kurulum sırasında {file} dosyasındaki statusLine değişti; hiçbir şey yazılmadı. install komutunu yeniden çalıştırın.',
  'install.unchanged': "statusLine zaten ccinfobar'ı çalıştırıyor; değiştirilecek bir şey yok.",
  'install.backup': '  Yedek: {file}',
  'install.legacyPrompt':
    "Bu statusLine ccinfobar'dan söz ediyor ama ccinfobar tarafından kaydedilmemiş: {command}. ccinfobar'a ait sayılsın mı?",
  'install.unsafePath':
    "{path} için güvenli bir komut oluşturulamıyor, yol şu karakterleri içeriyor: {chars}. ccinfobar'ı bunları içermeyen bir yola taşıyın.",
  'install.projectsTaken': {
    one: "✓ GSD'nin durum satırı {count} projede de değiştirildi:",
    other: "✓ GSD'nin durum satırı {count} projede de değiştirildi:",
  },
  'install.manifestReadOnly':
    '{file} daha yeni bir ccinfobar tarafından yazılmış ya da bozuk; hiçbir ayar değiştirilmiyor. Devam etmek için dosyayı başka bir yere taşıyın.',
  'install.manifestBusy':
    'Başka bir ccinfobar komutu {file} dosyasını güncelliyor; biraz sonra yeniden deneyin.',
  'install.needsConfirm': "Önce mevcut statusLine'ın değiştirilmesini onaylayın.",
  'install.confirmNeedsCurrent': "Onaylı bir kurulum, kendisine gösterilen statusLine'ı göndermelidir.",
  'install.prompt.yes': '[E/h]',
  'install.prompt.no': '[e/H]',
  'install.importManual': 'Mevcut durum satırınız: {tool}. Ayarları otomatik olarak içe aktarılamıyor.',
  'install.importSkipped':
    "ccinfobar'ın zaten bir yapılandırması var, bu yüzden önceki durum satırı içe aktarılmadı; içe aktarmak için `ccinfobar install --import` çalıştırın.",
  'install.importPrompt': "Mevcut durum satırınız: {tool}. Düzeni ccinfobar'a aktarılsın mı?",
  'install.noCommand':
    "✗ Claude Code'un çalıştıracağı bir ccinfobar kurulumu yok. Şununla kurun: npm install -g ccinfobar",
  'install.projectWins': '  Artık {file} dosyasındaki "{command}" yerine bu çalışıyor.',
  'install.projectLocal':
    '  settings.local.json git dışında kalır; `ccinfobar uninstall --project` bunu geri alır.',
  'install.config': '  Yapılandırma: {file}',
  'install.bringsBack': '  `ccinfobar uninstall` ile {tool} geri gelir.',
  'install.projectOwn': '⚠ {file} kendi statusLine ayarını içeriyor ve bu projede o geçerli.',
  'install.projectHint':
    '  Bu projede de ccinfobar kullanmak için burada `{command} install --project` çalıştırın.',
  'install.customize': '  `{command} edit` (tarayıcı) veya `{command} tui` (terminal) ile özelleştirin.',
  'install.setup.updating': 'Global ccinfobar {old} sürümünden {version} sürümüne güncelleniyor ...',
  'install.setup.global': 'ccinfobar {version} global olarak kuruluyor (atlamak için --no-global) ...',
  'install.setup.installed': '✓ Kuruldu: {bin}',
  'install.setup.notOnPath':
    '  {dir} PATH içinde değil; `ccinfobar` komutunu doğrudan yazabilmek için ekleyin.',
  'install.setup.updateFailed': '⚠ Global ccinfobar {old} güncellenemedi: {error}',
  'install.setup.globalFailed': '⚠ Global kurulum başarısız oldu: {error}',
  'install.setup.missingGlobal':
    '⚠ {bin} konumundaki global ccinfobar eksik bir dosyayı gösteriyor ve kullanılmıyor; `npm install -g ccinfobar@latest` ile yeniden kurun ya da `npm rm -g ccinfobar` ile kaldırın',
  'install.setup.staleGlobal':
    '⚠ Global ccinfobar {old}, {version} sürümünden eski ve kullanılmıyor; `npm install -g ccinfobar@latest` ile güncelleyin ya da `npm rm -g ccinfobar` ile kaldırın',
  'install.setup.pinned': 'ccinfobar {version} sürümünün sabit bir kopyası {dir} klasörüne kuruluyor ...',
  'install.setup.failed': '✗ ccinfobar kurulamadı: {error}',
  'install.setup.notFound': 'npm tamamlandı ama ccinfobar bulunamadı',
  'install.setup.noPermission': "npm'in global klasörüne yazma izni yok (EACCES)",
  'install.setup.npmFailed': 'npm install başarısız oldu',
  'install.settings.cannotParse': '{file} ayrıştırılamıyor: {reason}',
  'install.settings.notObject': 'bir JSON nesnesi değil',
  'install.settings.changed': '{file} yazılırken değişti; yeniden deneyin',
  'uninstall.restoredExact': "✓ {file} dosyası ccinfobar'dan önceki haline birebir döndürüldü",
  'uninstall.restoredPrevious': '✓ Önceki statusLine geri getirildi: {command}',
  'uninstall.removed': '✓ ccinfobar, {file} dosyasından kaldırıldı',
  'uninstall.deletedFile': '✓ {file} dosyası kaldırıldı; dosyayı ccinfobar oluşturmuştu',
  'uninstall.foreign': "{file} dosyasındaki statusLine ccinfobar'a ait değil; dokunulmadı: {command}",
  'uninstall.goneRestored':
    'statusLine {file} dosyasından zaten kaldırılmıştı; öncekisi geri getirildi: {command}',
  'uninstall.goneNothing': 'statusLine {file} dosyasından zaten kaldırılmıştı; yapılacak bir şey yok',
  'uninstall.notInstalled': 'ccinfobar {file} dosyasında kurulu değil',
  'uninstall.releasedProjects': {
    one: '✓ {count} projenin kendi durum satırı geri verildi',
    other: '✓ {count} projenin kendi durum satırı geri verildi',
  },
  'editor.planTitle': "ccinfobar'ı Claude Code'a kur",
  'editor.planCurrent': 'Mevcut durum satırı',
  'editor.planProposed': 'Yeni durum satırı',
  'editor.planReplace': 'Değiştir',
  'editor.planCancel': 'Mevcudu koru',
  'editor.installed': 'Kuruldu. Yedekler {dir} klasöründe',
  'editor.refreshHint':
    'Bu bileşenler yalnızca Claude Code durum satırını yenilediğinde güncellenir: {widgets}. Claude Code hook olaylarında yeniden çalıştırmaz; izin istemi veya yardım menüsü açıkken durum satırını gizler.',
  'editor.refreshUse': '{n} saniyede bir yenile',
  'tui.replaceQuestion': '"{current}", "{proposed}" ile değiştirilsin mi?',
  'tui.installed': 'Kuruldu: statusLine "{command}" komutunu çalıştırıyor. Yedekler {dir} klasöründe',
} satisfies Record<keyof typeof enInstall, Message>;
