import type { MetaFile } from '../../types.js';

export const custom: MetaFile = {
  widgets: {
    command: {
      name: 'Özel komut',
      description:
        'Bir kabuk komutu çalıştırır ve çıktının ilk satırını gösterir; payload stdin üzerinden gelir',
      sample: 'komut çıktısı',
    },
    link: {
      name: 'Bağlantı',
      description: 'Tıklanabilir bağlantı (OSC 8)',
      sample: 'belgeler',
    },
    env: {
      name: 'Ortam değişkeni',
      description: 'Bir ortam değişkeninin değeri',
    },
    http: {
      name: 'HTTP JSON değeri',
      description: 'Bir JSON uç noktasından arka planda alınan tek değer; satır onu hiç beklemez',
    },
  },
  options: {
    Command: 'Komut',
    'Timeout (ms)': 'Zaman aşımı (ms)',
    'Cache seconds': 'Önbellek süresi (saniye)',
    'Keep ANSI colors': 'ANSI renklerini koru',
    Text: 'Metin',
    URL: 'URL',
    'Variable name': 'Değişken adı',
    'http or https JSON endpoint; ${VAR} is allowed only in query values, for example ?key=${API_KEY}, and only over https or to localhost':
      "http ya da https JSON uç noktası; ${VAR} yalnızca sorgu değerlerinde kullanılabilir, örneğin ?key=${API_KEY}, ve yalnızca https üzerinden ya da localhost'a",
    'JSON path': 'JSON yolu',
    'Which value to show, for example $.data.balance or $.items[0].name':
      'Gösterilecek değer, örneğin $.data.balance ya da $.items[0].name',
    Format: 'Biçim',
    '{value} is replaced by the value, the rest is shown as is, for example ${value}':
      '{value} yerine değer gelir, gerisi olduğu gibi gösterilir, örneğin ${value}',
    'Fetch every (seconds)': 'Alma aralığı (saniye)',
    'Seconds between fetches, at least 30': 'İki istek arasındaki saniye, en az 30',
    'Request timeout, 1000 to 15000 ms': 'İstek zaman aşımı, 1000 ile 15000 ms arası',
    Headers: 'Başlıklar',
    'Name=$VAR entries, comma-separated, for example Authorization=Bearer $RELAY_TOKEN; values come only from env vars; the url must be https or localhost':
      'Virgülle ayrılmış Ad=$VAR girdileri, örneğin Authorization=Bearer $RELAY_TOKEN; değerler yalnızca ortam değişkenlerinden gelir; url https ya da localhost olmalı',
    Decimals: 'Ondalık basamak',
    'Digits after the point for numbers; -1 shows them as is':
      'Sayılarda noktadan sonraki basamak; -1 olduğu gibi gösterir',
    'Max text length': 'Metin uzunluğu sınırı',
    'Longer text values are cut with …': 'Daha uzun metin değerleri … ile kesilir',
  },
};
