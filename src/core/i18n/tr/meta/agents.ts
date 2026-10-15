import type { MetaFile } from '../../types.js';

export const agents: MetaFile = {
  widgets: {
    'todo-list': {
      name: 'Görev listesi',
      description: "Claude'un bu oturumdaki yapılacaklar listesi: biten, geçerli ve sıradaki adımlar",
      label: 'Görevler ',
      sample: '2/5 ▸ GSD bileşenleri bağlanıyor…',
    },
    agents: {
      name: 'Alt ajanlar',
      description:
        'Geçerli turdaki alt ajanlar tablo olarak: ne yaptıkları, son araçları, hız, token, süre ve model',
      sample: '▸ explore · Kod tabanında ara   2,411 t/m · 3.2k · sonnet',
    },
    'agent-count': {
      name: 'Alt ajan sayısı',
      description: 'Bu turda kaç alt ajanın çalıştığı ve kaçının bittiği',
      label: 'Ajanlar ',
      sample: '2 çalışıyor · 1 bitti',
    },
    'tool-activity': {
      name: 'Araç etkinliği',
      description: 'Çalışan araç ve son araç sayıları, transkriptten',
    },
  },
  options: {
    Display: 'Görünüm',
    'Full list': 'Tam liste',
    'Count and current step': 'Sayı ve geçerli adım',
    'Max items': 'Öğe sınırı',
    'Hide finished steps': 'Biten adımları gizle',
    'Show last tool': 'Son aracı göster',
    'Only running agents': 'Yalnızca çalışan ajanlar',
    'Max agents': 'Ajan sınırı',
    Show: 'Göster',
    'Running tool and counts': 'Çalışan araç ve sayılar',
    'Running tool': 'Çalışan araç',
    'Tool counts': 'Araç sayıları',
    'Count tools of': 'Sayım kapsamı',
    'This turn': 'Bu tur',
    'This session': 'Bu oturum',
    'Max tools': 'Araç sınırı',
    'Group MCP tools by server': 'MCP araçlarını sunucuya göre grupla',
    'Show the running tool argument': 'Çalışan aracın argümanını göster',
  },
};
