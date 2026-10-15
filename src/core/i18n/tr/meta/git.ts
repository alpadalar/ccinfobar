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
    'Hide empty git widgets in a workspace folder': 'Çalışma alanı klasöründe boş git bileşenlerini gizle',
    'Mark repos with uncommitted changes (background check)':
      'Commit edilmemiş değişikliği olan depoları işaretle (arka planda denetlenir)',
  },
};
