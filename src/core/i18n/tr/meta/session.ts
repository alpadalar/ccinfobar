import type { MetaFile } from '../../types.js';

export const session: MetaFile = {
  widgets: {
    model: { name: 'Model', description: 'Geçerli modelin görünen adı' },
    provider: {
      name: 'Sağlayıcı',
      description: 'API sağlayıcısı: Bedrock, Vertex, bir API anahtarı ya da bir ağ geçidi sunucusu',
    },
    effort: { name: 'Çaba', description: 'Akıl yürütme çabası düzeyi', label: 'Çaba ' },
    thinking: {
      name: 'Düşünme',
      description: 'Genişletilmiş düşünmenin açık olup olmadığı',
      label: 'Düşünme ',
      sample: 'açık',
    },
    'fast-mode': { name: 'Hızlı mod', description: 'Hızlı mod etkinken görünür', sample: 'hızlı' },
    sandbox: {
      name: 'Sandbox',
      description: 'Etkin ayar katmanında Claude Code sandbox açıkken bir çip gösterir',
      sample: 'sandbox',
    },
    'output-style': { name: 'Çıktı stili', description: 'Etkin çıktı stili', label: 'Stil ' },
    'session-name': {
      name: 'Oturum adı',
      description: '/rename ile verilen ya da transkriptten alınan oturum başlığı',
      sample: 'durum satırı düzenlemesi',
    },
    'session-id': { name: 'Oturum kimliği', description: 'Oturum tanımlayıcısı', label: 'Oturum ' },
    'claude-version': { name: 'Claude sürümü', description: 'Claude Code sürümü' },
    'vim-mode': { name: 'Vim modu', description: 'Vim düzenleme açıkken geçerli vim modu' },
    'agent-name': { name: 'Ajan adı', description: 'Etkin ajanın adı (claude --agent)' },
    skills: {
      name: 'Beceriler',
      description: 'Bu oturumda kullanılan beceriler: sonuncusu, sayısı ya da bir liste',
      label: 'Beceri ',
    },
    'turn-timer': {
      name: 'Tur süresi',
      description:
        'Geçerli turun şu ana kadarki süresi ya da son turun süresi; hook ile kesin, yoksa transkriptten',
      label: 'Tur ',
    },
    'permission-wait': {
      name: 'İzin bekleme',
      description:
        'Bu turdaki son izin isteminin ne kadar beklediği (hook gerekir; iletişim kutusu açıkken Claude Code durum satırını gizler)',
      label: 'Bekleme ',
    },
  },
  options: {
    'Show model id': 'Model kimliğini göster',
    'Use profile model name': 'Profildeki model adını kullan',
    'Shows a model profile name (GLM-5.3) instead of a raw gateway model id':
      'Ham ağ geçidi model kimliği yerine model profilindeki adı (GLM-5.3) gösterir',
    'Show for first-party sessions': 'Birinci taraf oturumlarında göster',
    'Off: hidden for Claude subscription sessions': 'Kapalı: Claude aboneliği oturumlarında gizli',
    'Append +think when thinking is on': 'Düşünme açıkken +düşünme ekle',
    'Hide when off': 'Kapalıyken gizle',
    'Mark strict mode': 'Katı modu işaretle',
    'Hide default style': 'Varsayılan stili gizle',
    'Short (8 chars)': 'Kısa (8 karakter)',
    Show: 'Göster',
    'Latest skill': 'Son beceri',
    Count: 'Sayı',
    List: 'Liste',
    'List limit': 'Liste sınırı',
    'After the turn ends': 'Tur bitince',
    'Show last duration': 'Son süreyi göster',
    Hide: 'Gizle',
    'Show the tool name': 'Araç adını göster',
    'Ignore waits longer than (minutes)': 'Şundan uzunsa yok say (dakika)',
  },
};
