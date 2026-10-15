import type { previewMessages as enPreview } from '../en/preview.js';
import type { Message } from '../types.js';

export const previewMessages = {
  'preview.unknownScenario': 'Bilinmeyen senaryo "{name}". Senaryolar:',
  'preview.scenarioLine': '  {id}  {description}',
  'preview.scenarioWithLast': '--scenario ve --last birlikte kullanılamaz',
  'preview.scenariosHeader': 'Senaryolar (--scenario <name> ile kullanın):',
  'preview.badGlyphMode':
    'Bilinmeyen glif modu "{mode}". normal, single-width, paste-safe, jetbrains veya auto kullanın.',
} satisfies Record<keyof typeof enPreview, Message>;
