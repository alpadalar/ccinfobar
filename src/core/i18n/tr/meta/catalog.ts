import type { CatalogMeta } from '../../types.js';

export const catalog: CatalogMeta = {
  themes: {
    classic: { description: 'Her bileşen kendi renginde, ince çizgi ayraçlar' },
    minimal: { description: 'Sakin gri metin, beyaz değerler, geniş aralık' },
    mono: { description: 'Hiç renk yok, nokta ayraçlar' },
    neon: { description: 'Kategoriye göre canlı truecolor metin, kalın' },
    pastel: { description: 'Kategoriye göre yumuşak pastel metin' },
    amber: { description: 'Retro kehribar terminal' },
    matrix: { description: 'Yeşil fosfor tonları' },
    blocks: { description: 'Kategoriye göre düz renkli bloklar' },
    slate: { description: 'Tek bir koyu arduvaz arka plan üzerinde renkli metin' },
    paper: { description: 'Açık bloklar üzerinde koyu metin, açık renkli terminaller için' },
    powerline: { description: '16 terminal renginde klasik powerline okları' },
    nord: { description: 'Kutup mavileri, powerline' },
    dracula: { description: 'Dracula paleti, powerline' },
    gruvbox: { description: 'Sıcak retro tonlar, powerline' },
    'tokyo-night': { description: 'Neon şehir gecesi, powerline' },
    solarized: { description: 'Solarized vurgular, powerline' },
    monochrome: { description: 'Gri tonları, powerline' },
    dark: { description: 'Koyu griler ve pas rengi dizin, claude-powerline projesinden' },
    light: { description: 'Açık renkli terminaller için parlak bölümler, claude-powerline projesinden' },
    'rose-pine': { description: 'Soluk çam ve gül tonları, claude-powerline projesinden' },
    'catppuccin-latte': { description: 'Catppuccin Latte, açık pasteller' },
    'catppuccin-frappe': { description: 'Catppuccin Frappé' },
    'catppuccin-macchiato': { description: 'Catppuccin Macchiato' },
    'catppuccin-mocha': { description: 'Powerline oklarıyla Catppuccin Mocha' },
    everforest: { description: 'Yumuşak orman yeşilleri' },
    kanagawa: { description: 'Kanagawa dalgasının mürekkep tonları' },
    panel: { description: 'Kategori renkleriyle yuvarlak köşeli kutu panel' },
    catppuccin: { description: 'Yuvarlak kapsüllerde Mocha pastelleri' },
    bubblegum: { description: '16 terminal renginde parlak kapsüller' },
    'one-dark': { description: 'One Dark kapsülleri' },
  },
  styles: {
    text: { name: 'Metin', description: 'Terminal arka planı üzerinde renkli metin' },
    blocks: { name: 'Bloklar', description: 'Renkli arka plan blokları' },
    powerline: { name: 'Powerline', description: 'Oklarla birleşen bloklar (Nerd Font)' },
    capsule: { name: 'Kapsül', description: 'Yuvarlak kapsüller (Nerd Font)' },
    tui: { name: 'Panel', description: 'İsteğe bağlı duyarlı ızgaralı, çerçeveli panel' },
  },
  presets: {
    default: {
      name: 'Varsayılan',
      description: 'Model, git ve bağlam, kullanım limitleri ve GSD kuruluysa bir GSD satırı',
    },
    cockpit: {
      name: 'Kokpit',
      description: 'Geliştirici panosu: yol ve git, GSD, model ve süre, bağlam ve token, kullanım limitleri',
    },
    dashboard: {
      name: 'Pano',
      description:
        'Kutulu genel bakış: köşede model, kullanım hücreleri, tam genişlikte bağlam çubuğu, token grafiği, görevler ve alt ajanlar',
    },
    minimal: { name: 'Minimal', description: 'Tek, kompakt bir satır' },
    gsd: { name: 'GSD odaklı', description: "GSD'nin izlediği her şey ve bağlam" },
    powerline: {
      name: 'Powerline',
      description: 'Tokyo Night temasıyla powerline okları (Nerd Font gerekir)',
    },
    full: { name: 'Her şey', description: 'Geniş terminaller için yoğun satırlar' },
    cost: {
      name: 'Maliyet takibi',
      description: 'Oturum, günlük ve haftalık maliyet, harcama hızı ve bir bütçe çubuğu',
    },
    limits: {
      name: 'Limitler',
      description: 'Tempo, tahmin ve sıfırlanma süreleriyle beş saatlik ve haftalık limitler',
    },
    git: {
      name: 'Git odaklı',
      description: 'Depo, dal, eşitleme, hazır ve değişen dosyalar, stash, worktree ve PR',
    },
    workspace: {
      name: 'Çalışma alanı',
      description: 'Proje klasöründeki her depo, dalı ve değişiklik işaretiyle',
    },
    compact: {
      name: 'Kompakt',
      description: 'Tek, yoğun bir satır: model, yol, git, bağlam, maliyet ve 5h limiti',
    },
    'two-line': {
      name: 'İki satır',
      description: 'Üstte model, yol, git ve süre; altta bağlam, token, önbellek, maliyet ve limitler',
    },
    agents: {
      name: 'Ajan etkinliği',
      description:
        "Claude'un o an yaptıkları: tur süresi, araçlar, alt ajanlar, izin beklemeleri ve görevler",
    },
    charts: {
      name: 'Grafikler',
      description: 'Bağlam, token hızı, çıktı hızı, harcama hızı ve kullanım için küçük grafikler',
    },
    session: {
      name: 'Oturum özeti',
      description: 'Oturum adı, kimliği ve süresi, bağlam boyutu, token, önbellek isabetleri ve mesajlar',
    },
  },
  bundles: {
    'catppuccin-cockpit': {
      name: 'Mocha kokpit',
      description: 'Catppuccin Mocha powerline renklerinde Kokpit düzeni',
    },
    'nord-minimal': {
      name: 'Nord minimal',
      description: 'Serin Nord powerline renklerinde tek, kompakt bir satır',
    },
    'dracula-powerline': {
      name: 'Dracula okları',
      description: 'Dracula renklerinde Powerline düzeni (Nerd Font gerekir)',
    },
    'gruvbox-git': {
      name: 'Gruvbox git',
      description: 'Sıcak Gruvbox powerline renklerinde Git odaklı düzen',
    },
    'tokyo-night-limits': {
      name: 'Tokyo limitler',
      description: 'Tokyo Night renklerinde tempo ve tahminle kullanım limitleri',
    },
    'mono-compact': {
      name: 'Mono kompakt',
      description: 'Renksiz ve powerline glifsiz tek, yoğun bir satır; düz terminaller için',
    },
    'everforest-workspace': {
      name: 'Everforest depo',
      description: 'Yumuşak Everforest renklerinde proje klasöründeki her depo',
    },
    'kanagawa-agents': {
      name: 'Kanagawa ajanlar',
      description: 'Kanagawa renklerinde tur süresi, araçlar, alt ajanlar ve görevler',
    },
    'rose-pine-two-line': {
      name: 'Rosé iki satır',
      description: 'Rosé Pine renklerinde dengeli, iki satırlık bir düzen',
    },
    'one-dark-cost': {
      name: 'One Dark maliyet',
      description: 'One Dark kapsüllerinde bütçe çubuğuyla oturum, günlük ve haftalık maliyet',
    },
    'solarized-gsd': {
      name: 'Solarized GSD',
      description: "Solarized renklerinde GSD'nin izlediği her şey",
    },
    'panel-dashboard': {
      name: 'Kutulu pano',
      description: 'Kullanım hücreleri, bağlam çubuğu ve token grafiğiyle kutulu pano',
    },
    'paper-default': {
      name: 'Paper varsayılan',
      description: 'Açık renkli terminaller için açık Paper bloklarında varsayılan düzen',
    },
    'neon-charts': {
      name: 'Neon grafikler',
      description: 'Canlı Neon renklerinde bağlam, token, hız, harcama ve kullanım için küçük grafikler',
    },
    'amber-session': {
      name: 'Amber oturum',
      description: 'Retro kehribar terminal görünümünde oturum özeti',
    },
  },
  scenarios: {
    'fresh-session': { label: 'Yeni oturum', description: 'İlk yanıttan önce yeni bir oturum' },
    'context-full': { label: 'Bağlam neredeyse dolu', description: 'Bağlam penceresi yaklaşık %94 dolu' },
    'near-5h-limit': {
      label: '5 saatlik limite yakın',
      description: "Beş saatlik limitin %92'si kullanıldı, 25 dakika içinde sıfırlanır",
    },
    'near-7d-limit': {
      label: 'Haftalık limite yakın',
      description: "Haftalık limitin %80'i kullanıldı, 1 gün içinde sıfırlanır",
    },
    'many-subagents': {
      label: 'Çok sayıda alt ajan',
      description: 'Sekiz alt ajan: beşi çalışıyor, üçü bitti',
    },
    'gsd-project': { label: 'GSD projesi', description: 'GSD planlaması süren bir proje' },
    'no-git': { label: 'Git deposu yok', description: 'Git deposu olmayan bir klasör' },
    'api-key-user': {
      label: 'API anahtarı kullanıcısı',
      description: 'API anahtarıyla faturalandırılıyor, bu yüzden plan limiti yok',
    },
    'bedrock-user': {
      label: 'Bedrock kullanıcısı',
      description: 'Amazon Bedrock üzerinde Claude, bu yüzden plan limiti yok',
    },
    'gateway-glm': {
      label: 'GLM ağ geçidi',
      description: 'Z.ai Anthropic ağ geçidi üzerinden GLM-5.3, profil penceresi ve fiyatlarıyla',
    },
    'over-budget': { label: 'Bütçe aşıldı', description: 'Günlük $3 bütçe aşıldı' },
    'workspace-folder': {
      label: 'Çalışma alanı klasörü',
      description: 'Kendisi depo olmayan, birkaç depo içeren bir klasör',
    },
    'waiting-permission': {
      label: 'İzin bekleme',
      description: 'Bu turdaki son izin istemi 42 sn bekledi',
    },
    'service-incident': {
      label: 'Hizmet sorunu',
      description: "Claude'da büyük bir sorun var: Claude Opus'ta hatalar arttı",
    },
    'pr-ci-failing': {
      label: 'CI denetimleri başarısız PR',
      description:
        '#128 numaralı pull request onaylı ama 2 CI denetimi başarısız (ci seçeneğiyle pr gösterir)',
    },
  },
  styleGroups: {
    colors: 'Renkler',
    text: 'Kalın, soluk, italik',
    bars: 'Çubuk ve grafik seçenekleri',
    label: 'Etiket ayarları',
  },
};
