import type { benchMessages as enBench } from '../en/bench.js';
import type { Message } from '../types.js';

export const benchMessages = {
  'bench.title': 'ccinfobar {version} bench',
  'bench.node': '  Node      {node}',
  'bench.os': '  Sistem    {os} {release} ({platform}/{arch})',
  'bench.cpu': '  İşlemci   {model} × {count}',
  'bench.priority': '  Öncelik   {priority}',
  'bench.scenario': '  Senaryo   {scenario}',
  'bench.runs': '  Tekrar    satır başına {runs}',
  'bench.gitRepo': '  cwd       bir git deposu',
  'bench.notGitRepo': '  cwd       git deposu değil',
  'bench.niceWarning':
    "⚠ Öncelik 0'ın üzerinde, bu yüzden sonuçlar normalden yavaş. Bench'i normal öncelikte (nice 0) çalıştırın, örneğin kabuğunuzda `renice -n 0 -p $$` çalıştırdıktan sonra.",
  'bench.windowsNote': "Not: Windows'ta süreç başlatma daha yavaştır; sayılar POSIX ile karşılaştırılamaz.",
  'bench.col.row': 'satır',
  'bench.col.n': 'n',
  'bench.col.median': 'medyan',
  'bench.col.p95': 'p95',
  'bench.col.min': 'min',
  'bench.col.max': 'maks',
  'bench.unit': '(süreler ms cinsinden)',
  'bench.row.control': 'node -e 0',
  'bench.row.cold': 'soğuk',
  'bench.row.warm': 'sıcak',
  'bench.row.warmNoCache': 'sıcak, derleme önbelleği kapalı',
  'bench.row.hook': 'hook UserPromptSubmit',
  'bench.overhead': 'ccinfobar ek yükü = sıcak medyanı − kontrol medyanı = {ms} ms',
  'bench.hookOverhead': 'hook ek yükü = hook medyanı − kontrol medyanı = {ms} ms',
  'bench.failed': 'Bench çalıştırması "{row}", {code} çıkış koduyla başarısız oldu',
  'bench.badRuns': '--runs 1 ile 1000 arasında bir sayı gerektirir',
  'bench.noEntry': 'Bench, çalıştırılacak ccinfobar giriş betiğini bulamıyor.',
} satisfies Record<keyof typeof enBench, Message>;
