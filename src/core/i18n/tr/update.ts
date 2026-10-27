import type { updateMessages as enUpdate } from '../en/update.js';
import type { Message } from '../types.js';

export const updateMessages = {
  'update.brewManual': '  Homebrew ile kurulmuş: `{command}` çalıştırın',
  'update.brewRefused': 'Homebrew ile kurulmuş: `{command}` çalıştırın',
  'update.kindBrew': 'Homebrew kurulumu',
  'update.brewSettingsHint':
    'Bu kopyayı Homebrew güncelliyor: `{command}` çalıştırın. "Otomatik kur", "Haber ver" gibi davranır; ccinfobar kendisi kurmaz.',
  'update.rejected': '⬆ ccinfobar {version} denetimi geçemedi, {current} sürümünde kalındı · ccinfobar doctor',
} satisfies Record<keyof typeof enUpdate, Message>;
