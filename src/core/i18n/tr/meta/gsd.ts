import type { MetaFile } from '../../types.js';

export const gsd: MetaFile = {
  widgets: {
    'gsd-milestone': {
      name: 'GSD kilometre taşı',
      description: 'Geçerli GSD kilometre taşının sürümü ve adı',
      sample: 'v1.2 Faturalama',
    },
    'gsd-milestone-progress': {
      name: 'GSD kilometre taşı ilerlemesi',
      description: 'Kilometre taşı tamamlanma çubuğu (diskte biten plan ve aşamalar)',
    },
    'gsd-phase': {
      name: 'GSD aşaması',
      description: 'Geçerli GSD aşamasının numarası ve adı',
      label: 'Aşama ',
      hint: 'aşama',
      sample: '4/6 Fatura dışa aktarımı',
    },
    'gsd-status': {
      name: 'GSD durumu',
      description: 'Normalleştirilmiş GSD süreç durumu, evreye göre renkli',
      hint: 'durum',
      sample: 'yürütülüyor',
    },
    'gsd-plans': {
      name: 'GSD planları',
      description: 'Geçerli aşamada tamamlanan planlar',
      label: 'plan ',
      hint: 'planlar',
    },
    'gsd-plan-progress': {
      name: 'GSD plan ilerlemesi',
      description: 'Geçerli aşamanın plan tamamlanma çubuğu',
    },
    'gsd-next': {
      name: 'GSD sıradaki adım',
      description: 'Önerilen sıradaki GSD komutu',
      label: 'sıradaki: ',
    },
    'gsd-workstream': {
      name: 'GSD iş akışı',
      description: 'Etkin GSD iş akışının adı',
      label: 'akış ',
      sample: 'faturalama',
    },
    'gsd-blockers': {
      name: 'GSD engeller ve sorunlar',
      description:
        'STATE.md içinde Blockers/Concerns altındaki açık maddeler (çözülen ve üstü çizili maddeler atlanır)',
      sample: '⚠ 1 sorun',
    },
    'gsd-todos': {
      name: 'GSD yapılacaklar',
      description: 'Bekleyen GSD yapılacaklarının sayısı',
      sample: '2 yapılacak',
    },
    'gsd-requirements': {
      name: 'GSD gereksinimleri',
      description: 'Toplam içinden tamamlanan gereksinimler',
      label: 'şart ',
      hint: 'gereksinimler',
    },
    'gsd-last-command': {
      name: 'GSD son komut',
      description: 'Oturumda son çalıştırılan slash komutu',
    },
    'gsd-update': {
      name: 'GSD güncellemesi',
      description: "Bir GSD güncellemesi çıktığında ya da hook'lar eskidiğinde görünür",
      hint: 'güncelleme',
    },
    'gsd-task': {
      name: 'GSD geçerli görevi',
      description: 'Oturumda şu an süren görev',
      hint: 'geçerli görev',
      sample: 'GSD bileşenleri bağlanıyor',
    },
    'gsd-summary': {
      name: 'GSD özeti',
      description: 'Kilometre taşı, ilerleme ve aşama durumunu bir arada gösteren kısa bölüm',
      hint: 'özet',
      sample: 'v1.2 Faturalama [█████░░░░░] 50% · Aşama 4 yürütülüyor',
    },
  },
  options: {
    'Show milestone name': 'Kilometre taşı adını göster',
    'Show phase counts': 'Aşama sayılarını göster',
    'Show phase name': 'Aşama adını göster',
    'Show total phases': 'Toplam aşama sayısını göster',
    'Max name length': 'Ad uzunluğu sınırı',
    'Show when phase has no plans': 'Aşamada plan yokken göster',
    'Command prefix': 'Komut öneki',
    'Use /gsd: for older GSD versions': 'Eski GSD sürümleri için /gsd: kullanın',
    'Show first item text': 'İlk maddenin metnini göster',
    'Max length': 'Uzunluk sınırı',
    'Only GSD commands': 'Yalnızca GSD komutları',
  },
};
