import type { updateMessages as enUpdate } from '../en/update.js';
import type { Message } from '../types.js';

export const updateMessages = {
  'update.brewManual': '  Homebrew ile kurulmuş: `brew upgrade ccinfobar` çalıştırın',
  'update.brewRefused': 'Homebrew ile kurulmuş: `brew upgrade ccinfobar` çalıştırın',
  'update.kindBrew': 'Homebrew kurulumu',
  'update.brewSettingsHint':
    'Bu kopyayı Homebrew güncelliyor: `brew upgrade ccinfobar` çalıştırın. "Otomatik kur", "Haber ver" gibi davranır; ccinfobar kendisi kurmaz.',
} satisfies Record<keyof typeof enUpdate, Message>;
