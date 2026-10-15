import type { MetaFile } from '../../types.js';

export const limits: MetaFile = {
  widgets: {
    'five-hour-usage': {
      name: 'Beş saatlik kullanım',
      description: '5 saatlik kullanım limitinden kullanılan pay',
      label: '5h ',
    },
    'five-hour-reset': {
      name: 'Beş saatlik sıfırlanma',
      description: 'Beş saatlik pencerenin sıfırlanmasına kalan süre',
      label: 'Sıfırlanma ',
    },
    'weekly-usage': {
      name: 'Haftalık kullanım',
      description: 'Haftalık kullanım limitinden kullanılan pay',
      label: '7d ',
    },
    'weekly-reset': {
      name: 'Haftalık sıfırlanma',
      description: 'Haftalık pencerenin sıfırlanmasına kalan süre',
      label: 'Sıfırlanma ',
    },
    'weekly-model-usage': {
      name: 'Haftalık model limiti',
      description: 'Planınızda varsa tek bir modelin (örneğin Fable) haftalık limiti',
    },
    'weekly-model-reset': {
      name: 'Haftalık model sıfırlanması',
      description: 'Tek bir modelin haftalık limitinin sıfırlanmasına kalan süre',
      label: 'Sıfırlanma ',
    },
    'weekly-sonnet-usage': {
      name: 'Haftalık Sonnet kullanımı',
      description: 'Haftalık Sonnet limitinden kullanılan pay',
      label: 'Sonnet ',
    },
    'weekly-opus-usage': {
      name: 'Haftalık Opus kullanımı',
      description: 'Haftalık Opus limitinden kullanılan pay',
      label: 'Opus ',
    },
    'spend-limit': {
      name: 'Harcama limiti',
      description: 'Ek kullanım harcaması ve limiti',
      label: 'Harcama ',
    },
    'usage-pace': {
      name: 'Kullanım temposu',
      description: 'Pencere boyunca eşit tüketime göre kullanım',
      label: 'Tempo ',
    },
    'usage-projection': {
      name: 'Kullanım tahmini',
      description: 'Mevcut tempoyla pencerenin sonunda beklenen kullanım',
    },
    'limit-eta': {
      name: 'Limite kalan süre',
      description: 'Mevcut tempoyla bir kullanım limitinin dolmasına (100%) kalan süre',
      label: 'Tahmin ',
      sample: '1h 12m içinde 100%',
    },
    'limit-risk': {
      name: 'Limit riski',
      description: 'Bir kullanım limitinin sıfırlanmadan önce dolacağı tahmin edilince uyarı rozeti',
    },
  },
  options: {
    Display: 'Görünüm',
    Percent: 'Yüzde',
    Bar: 'Çubuk',
    'Show even pace': 'Eşit tempoyu göster',
    'Adds where an even burn would be by now: 60%/40%, and a ◆/◇ marker in bars':
      'Eşit tüketimle şu an nerede olunacağını ekler: 60%/40%; çubuklarda ◆/◇ işareti',
    'Show clock time': 'Saati göster',
    Model: 'Model',
    'Model name such as Fable; empty shows whichever model has a weekly limit':
      'Fable gibi bir model adı; boş bırakılırsa haftalık limiti olan model gösterilir',
    Window: 'Pencere',
    '5 hours': '5 saat',
    '7 days': '7 gün',
    Pace: 'Tempo',
    'Window: average since the window started. Recent: trend of the last 30 minutes (5h) or 12 hours (7d)':
      'Pencere ortalaması: pencere başladığından beri. Son eğilim: son 30 dakika (5h) ya da 12 saat (7d)',
    'Window average': 'Pencere ortalaması',
    'Recent trend': 'Son eğilim',
    'Whichever runs out first': 'Önce dolan',
    'Hide when safe': 'Güvenliyken gizle',
    'Warn at (%)': 'Uyarı eşiği (%)',
    'Show the chip from this projected percentage': 'Tahmin bu yüzdeye ulaşınca rozeti gösterir',
  },
};
