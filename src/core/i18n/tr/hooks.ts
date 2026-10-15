import type { hookMessages as enHooks } from '../en/hooks.js';
import type { Message } from '../types.js';

export const hookMessages = {
  'hooks.refused.unknownVersion':
    "Hook'lar Claude Code {floor} veya daha yenisini gerektirir ve sürümü algılanamadı. Claude Code'u bir kez açın, sonra `ccinfobar install --hooks` komutunu yeniden çalıştırın. Durum satırı hook'lar olmadan kuruldu.",
  'hooks.refused.oldVersion':
    "Hook'lar Claude Code {floor} veya daha yenisini gerektirir (bulunan: {version}). Durum satırı hook'lar olmadan kuruldu.",
  'hooks.asyncOmitted':
    "Claude Code {version} bu hook'ları eşzamanlı çalıştırır, bu yüzden her istem bir Node başlangıcını bekler.",
  'hooks.badFlag': '--hooks değer almaz ya da yalnızca =permission alır',
  'hooks.runnerCommand':
    "Hook'lar durum satırı komutunu her olayda bir paket çalıştırıcısı (npx, bunx veya dlx) üzerinden çalıştırır; bu yavaştır ve ağı kullanabilir. ccinfobar'ı global olarak kurun ve bunun yerine --command ccinfobar verin.",
  'hooks.badArg': 'Beklenmeyen argüman "{arg}"; seçenekler değeri = ile alır, örneğin --hooks=permission',
  'hooks.dry.add': '  + hook {event}: {command}',
  'hooks.dry.keep': '  = hook {event} (zaten kurulu)',
  'hooks.dry.rewrite': '  ~ hook {event}: {from} → {command}',
  'hooks.dry.skipUnmanaged': '  - hook {event}: zaten var (yönetilmiyor)',
  'hooks.dry.skipVersion': '  - hook {event}: Claude Code {floor}+ gerekir',
  'hooks.dry.unknownVersion': "  - hook'lar: Claude Code sürümü algılanamadı; hook'lar {floor}+ gerektirir",
  'hooks.dry.oldVersion': "  - hook'lar: Claude Code {floor}+ gerekir (bulunan: {version})",
  'hooks.added': "✓ hook'lar eklendi: {events}",
  'hooks.kept': "  zaten kurulu hook'lar: {events}",
  'hooks.rewritten': "✓ hook'lar yeni komuta güncellendi: {events}",
  'hooks.skippedUnmanaged': '  zaten var (yönetilmiyor): {events}',
  'hooks.skippedVersion': '  atlandı (daha yeni bir Claude Code gerekir): {events}',
  'hooks.projectIgnored':
    "⚠ Hook'lar yalnızca kullanıcı ayarlarına yazılır; `ccinfobar install --hooks` komutunu --project olmadan çalıştırın.",
  'hooks.detected': '  Claude Code {version}',
  'hooks.removed': "✓ ccinfobar hook'ları kaldırıldı: {events}",
  'hooks.leftEdited': "  ccinfobar dışında değiştirilen hook'lara dokunulmadı: {events}",
  'hooks.none': "{file} dosyasında ccinfobar hook'u yok",
  'hooks.reason.notActive': "Önce ccinfobar'ı durum satırı olarak açın (yukarıdaki Kur).",
  'hooks.reason.unknownVersion':
    "Hook'lar Claude Code {floor} veya daha yenisini gerektirir ve sürümü algılanamadı. Claude Code'u bir kez açın, sonra editörü yeniden başlatın.",
  'hooks.reason.oldVersion':
    "Hook'lar Claude Code {floor} veya daha yenisini gerektirir (bulunan: {version}).",
  'hooks.badBody': 'enabled true ya da false olmalı; permission true ya da false olmalı veya hiç verilmemeli',
  'hooks.uninstallProject':
    "⚠ Hook'lar yalnızca kullanıcı ayarlarında bulunur; `--project`, --hooks seçeneğini yok sayar.",
  'progress.added':
    '✓ {events} için ilerleme işleyicileri eklendi (her istemden önce çalışırlar; yaklaşık 60-110 ms)',
  'progress.removed': '✓ İlerleme işleyicileri kaldırıldı',
  'progress.none': '{file} dosyasında ilerleme işleyicisi yok',
  'progress.tty':
    '✓ Terminal ilerlemesi tty kanalını kullanıyor: çubuğu durum satırı kendisi yazar, bu yüzden hook işleyicisi eklenmez (kurulu olanlar kaldırılır).',
  'progress.held':
    '✓ İlerleme kapatıldı. İşleyicileri, çubuk bir sonraki istemde temizlenene kadar kalır; onları kaldırmak için `ccinfobar uninstall --progress` komutunu yeniden çalıştırın.',
  'progress.refused.oldVersion':
    'Terminal ilerlemesi Claude Code {floor} veya daha yenisini gerektirir (bulunan: {version})',
  'progress.refused.unknownVersion':
    'Claude Code sürümü algılanamadı; terminal ilerlemesi {floor} veya daha yenisini gerektirir',
  'progress.dry.add': '  + {event} (ilerleme): {command}',
  'progress.tip':
    'İpucu: iki çubuk titremesin diye Claude Code ayarlarında "terminalProgressBarEnabled": false ayarlayın.',
  'progress.badFlag': '--progress değer almaz',
  'progress.projectIgnored':
    '⚠ Terminal ilerlemesi yalnızca kullanıcı ayarlarına yazılır; `ccinfobar install --progress` komutunu --project olmadan çalıştırın.',
  'progress.uninstallProject':
    '⚠ İlerleme işleyicileri yalnızca kullanıcı ayarlarında bulunur; `--project`, --progress seçeneğini yok sayar.',
  'edit.detachFailed':
    'Editör arka planda başlatılamadı. Bunun yerine bir terminalde `ccinfobar edit` çalıştırın.',
} satisfies Record<keyof typeof enHooks, Message>;
