import type { MetaFile } from '../../types.js';

export const tokens: MetaFile = {
  widgets: {
    'tokens-input': {
      name: 'Girdi token',
      description: 'Bu oturumdaki toplam girdi token',
      label: 'Girdi ',
    },
    'tokens-output': {
      name: 'Çıktı token',
      description: 'Bu oturumdaki toplam çıktı token',
      label: 'Çıktı ',
    },
    'tokens-cached': {
      name: 'Önbellek token',
      description: 'Önbellek okuma ve yazma token',
      label: 'Önbellek ',
    },
    'tokens-total': { name: 'Toplam token', description: 'Girdi artı çıktı token', label: 'Token ' },
    'cache-hit-rate': {
      name: 'Önbellek isabet oranı',
      description: 'İstem önbelleği isabet oranı',
      label: 'İsabet ',
    },
    'cache-timer': {
      name: 'Önbellek sayacı',
      description: 'İstem önbelleğinin süresi dolmadan önce kalan zaman',
      label: 'Önbellek ',
    },
    'cache-miss-cause': {
      name: 'Önbellek ıskası nedeni',
      description: 'Son istem önbelleği ıskasının nedeni',
      label: 'Iska ',
      sample: 'araçlar değişti (+2/-0)',
    },
    performance: {
      name: 'Performans',
      description:
        'Ana istek başına önbellek isabet oranı ve ortalama API süresi (~: ilk yanıta kadar geçen süre)',
      label: 'Perf ',
    },
    'output-speed': { name: 'Çıktı hızı', description: 'Son çıktı hızı, saniye başına token' },
  },
  options: {
    Off: 'Kapalı',
    'Cold cost': 'Soğuk maliyet',
    Tokens: 'Token',
    Cost: 'Maliyet',
    'What a re-cache would cost if the cache went cold, as tokens or at the cache-write price for the TTL':
      'Önbellek soğursa yeniden önbelleklemenin bedeli; token olarak ya da TTL için önbellek yazma fiyatıyla',
    'Show TTL': 'TTL göster',
    'Append the cache lifetime, for example 41m/1h': 'Önbellek ömrünü ekler, örneğin 41m/1h',
    Show: 'Göster',
    'Latest: only while the last request missed the cache. Summary: misses/requests and the top causes':
      'Yalnızca son ıska: son istek önbelleği ıskaladıysa gösterir. Özet: ıska/istek sayısı ve en sık nedenler',
    Summary: 'Özet',
    'Top causes': 'En sık nedenler',
    'How many causes the summary lists': 'Özette listelenen neden sayısı',
    'Latest miss only': 'Yalnızca son ıska',
    Always: 'Her zaman',
    'Time is the average API time per main request; ~ marks the transcript fallback, the average time from a prompt to its first reply':
      'Süre, ana istek başına ortalama API süresidir; ~ transkript yedeğini, yani bir istemden ilk yanıtına kadar geçen ortalama süreyi gösterir',
    'Hit rate and time': 'İsabet oranı ve süre',
    'Hit rate': 'İsabet oranı',
    Time: 'Süre',
    Display: 'Görünüm',
    'Badge colors the widget by the worse of the two values':
      'Rozet, bileşeni iki değerden kötü olana göre renklendirir',
    Text: 'Metin',
    'Traffic-light badge': 'Trafik ışığı rozeti',
    'Hit rate warning': 'İsabet oranı uyarısı',
    'Badge warns below this hit rate, in %': 'Rozet, isabet oranı bunun altına inince uyarır (yüzde)',
    'Time warning': 'Süre uyarısı',
    'Badge warns above this average time, in seconds': 'Rozet, ortalama süre bunu aşınca uyarır (saniye)',
    'Show misses': 'Iskaları göster',
    'Append the cache miss count': 'Önbellek ıskası sayısını ekler',
  },
};
