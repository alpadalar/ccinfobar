import type { MetaFile } from '../../types.js';

export const layout: MetaFile = {
  widgets: {
    text: {
      name: 'Metin',
      description: 'Sabit özel metin',
    },
    separator: {
      name: 'Ayırıcı',
      description: 'Elle konan ayırıcı; genel ayırıcı boşken kullanın',
    },
    flex: {
      name: 'Esnek boşluk',
      description: 'Sonraki bileşenleri sağ kenara iter',
    },
  },
  options: {
    Text: 'Metin',
    Character: 'Karakter',
  },
};
