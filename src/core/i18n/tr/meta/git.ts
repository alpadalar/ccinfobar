import type { MetaFile } from '../../types.js';

export const git: MetaFile = {
  widgets: {
    'git-branch': {
      name: 'Git dalı',
      description: 'Geçerli dal, HEAD ayrıksa kısa sha',
      hint: 'dal',
    },
    'git-sha': {
      name: 'Git commit',
      description: "Kısa commit hash'i",
    },
    'git-changes': {
      name: 'Git değişiklikleri',
      description: "HEAD'e göre eklenen ve silinen satırlar",
      hint: 'değişiklikler',
    },
    'git-status': {
      name: 'Git durumu',
      description: 'Çalışma ağacı temiz mi, değişmiş mi',
      hint: 'durum',
    },
    'git-staged': {
      name: 'Git hazır dosyalar',
      description: 'Commit için hazırlanmış dosyalar',
      label: 'Hazır ',
    },
    'git-unstaged': {
      name: 'Git değişen dosyalar',
      description: 'Değişmiş ama henüz hazırlanmamış dosyalar',
      label: 'Değişen ',
    },
    'git-untracked': {
      name: 'Git izlenmeyen dosyalar',
      description: 'Git tarafından izlenmeyen dosyalar',
      label: 'İzlenmeyen ',
    },
    'git-ahead-behind': {
      name: 'Git önde/geride',
      description: "Upstream'e göre öndeki ve geride kalan commit'ler",
    },
    'git-conflicts': {
      name: 'Git çakışmaları',
      description: 'Birleştirme çakışması olan dosyalar',
      label: 'Çakışma ',
      hint: 'çakışmalar',
    },
    'git-stash': {
      name: 'Git stash',
      description: 'Stash kayıtlarının sayısı',
      label: 'Stash ',
    },
    'git-operation': {
      name: 'Git işlemi',
      description: 'Süren merge, rebase, cherry-pick, revert ya da bisect',
      hint: 'işlem',
    },
    'git-repo': {
      name: 'Git deposu',
      description: 'Depo sahibi/adı',
      hint: 'depo',
    },
    'git-is-fork': {
      name: 'Git fork mu',
      description: 'Depo bir fork ise upstream ya da fork uzak deposuna bakarak işaretler',
      hint: 'fork',
    },
    'git-worktree': {
      name: 'Git worktree',
      description: "Bağlı worktree'nin adı",
      label: 'wt ',
    },
    pr: {
      name: 'Pull request',
      description: 'Pull request numarası ve inceleme durumu',
    },
    'workspace-repos': {
      name: 'Çalışma alanı depoları',
      description: 'Klasörün kendisi depo değilken git deposu olan alt klasörler',
      label: 'depolar: ',
    },
    'jj-bookmarks': {
      name: 'JJ yer imleri',
      description: 'Çalışma kopyasının yer imi olan en yakın atasındaki yer imleri',
      hint: 'yer imleri',
    },
    'jj-workspace': {
      name: 'JJ çalışma alanı',
      description: 'Geçerli jj çalışma alanının adı',
      hint: 'çalışma alanı',
    },
    'jj-revision': {
      name: 'JJ değişikliği',
      description: "Çalışma kopyasının kısa değişiklik ID'si",
    },
    'jj-description': {
      name: 'JJ açıklaması',
      description: 'Çalışma kopyası açıklamasının ilk satırı',
    },
    'jj-changes': {
      name: 'JJ değişiklikleri',
      description: 'Çalışma kopyası değişikliğinde eklenen ve silinen satırlar',
      hint: 'değişiklikler',
    },
  },
  options: {
    'Prefix with branch glyph': 'Başına dal simgesi koy',
    'Show counts': 'Sayıları göster',
    'Hide when zero': 'Sıfırsa gizle',
    'Name only': 'Yalnızca ad',
    'Clickable link': 'Tıklanabilir bağlantı',
    'CI checks (needs gh)': 'CI denetimleri (gh gerekir)',
    'Shows passing, failing or running checks from gh pr checks, refreshed in the background':
      'gh pr checks çıktısından geçen, başarısız ya da süren denetimleri gösterir; arka planda yenilenir',
    'Repos shown': 'Depo sınırı',
    'Show branch': 'Dalı göster',
    Sort: 'Sıralama',
    'By name': 'Ada göre',
    'Most recent first': 'En yeni önce',
    'Include hidden folders': 'Gizli klasörleri dahil et',
    'Hide empty git widgets': 'Boş git bileşenlerini gizle',
    'While repos are shown, the other git widgets hide instead of showing —':
      'Depolar gösterilirken diğer git bileşenleri — göstermek yerine gizlenir',
    'Mark repos with uncommitted changes': 'Değişikliği olan depoları işaretle',
    'Checked in the background': 'Arka planda denetlenir',
    'Owner only in a fork': 'Fork ise yalnızca sahip',
    Symbol: 'Simge',
    'Empty uses ⑂': 'Boşsa ⑂ kullanılır',
    'Show parent repo': 'Ana depoyu göster',
    'Bookmarks shown': 'Yer imi sınırı',
    Separator: 'Ayırıcı',
    'Hide the default workspace': 'Varsayılan çalışma alanını gizle',
    'Snapshot working copy': 'Anlık görüntü al',
    'Off reads the last snapshot and never writes to the repo':
      'Kapalıyken son anlık görüntüyü okur ve depoya hiç yazmaz',
    Show: 'Göster',
    Name: 'Ad',
    Branch: 'Dal',
    'Original branch': 'Özgün dal',
    Path: 'Yol',
    'Original directory': 'Özgün klasör',
    'Show origin branch': 'Kaynak dalı göster',
    'Append the branch the worktree was created from': 'Çalışma ağacının oluşturulduğu dalı ekler',
    'Branch and path fields fall back to the name when Claude Code did not send them':
      'Claude Code dal veya yol alanını göndermediğinde ad gösterilir',
    Style: 'Stil',
    'Folder name': 'Klasör adı',
    'Full path': 'Tam yol',
    '~ for home': 'Ev dizini için ~',
    'Abbreviated (~/p/acme-app)': 'Kısaltılmış (~/p/acme-app)',
    'Last N segments': 'Son N parça',
    Segments: 'Parça sayısı',
  },
};
