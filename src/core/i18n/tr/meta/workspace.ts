import type { MetaFile } from '../../types.js';

export const workspace: MetaFile = {
  widgets: {
    cwd: {
      name: 'Geçerli dizin',
      description: 'Geçerli çalışma dizini',
    },
    'project-dir': {
      name: 'Proje dizini',
      description: "Claude Code'un başlatıldığı dizin",
    },
  },
  options: {
    Style: 'Stil',
    'Folder name': 'Klasör adı',
    'Full path': 'Tam yol',
    '~ for home': 'Ev dizini için ~',
    'Abbreviated (~/p/acme-app)': 'Kısaltılmış (~/p/acme-app)',
    'Last N segments': 'Son N parça',
    Segments: 'Parça sayısı',
    'Added folders': 'Eklenen klasörler',
    Off: 'Kapalı',
    Count: 'Sayı',
    Names: 'Adlar',
    'Folders added with /add-dir, as a count or as names':
      '/add-dir ile eklenen klasörler, sayı ya da ad olarak',
  },
};
