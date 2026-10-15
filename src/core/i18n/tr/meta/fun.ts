import type { MetaFile } from '../../types.js';

export const fun: MetaFile = {
  widgets: {
    pet: {
      name: 'Evcil hayvan',
      description: 'Bağlama, 5h kullanımına ve boşta geçen süreye tepki veren küçük bir yaratık',
    },
    kaomoji: {
      name: 'Kaomoji',
      description: 'Ruh haline göre bir yüz: mutlu, meşgul, yorgun, dolu ya da uykuda',
    },
    quip: {
      name: 'Espri',
      description: 'Bağlam ya da 5h kullanım düzeyine göre kısa bir söz, her 30 dakikada yenilenir',
      sample: 'Düşünecek bol yer var',
    },
  },
  options: {
    Species: 'Tür',
    Cat: 'Kedi',
    Blob: 'Jöle',
    Ghost: 'Hayalet',
    Personality: 'Kişilik',
    Cheerful: 'Neşeli',
    Grumpy: 'Huysuz',
    Stoic: 'Soğukkanlı',
    'Based on': 'Ölçüt',
    'Context window': 'Bağlam penceresi',
    '5h usage': '5h kullanımı',
    'Max length': 'Uzunluk sınırı',
    'Longer lines are cut': 'Daha uzun sözler kesilir',
  },
};
