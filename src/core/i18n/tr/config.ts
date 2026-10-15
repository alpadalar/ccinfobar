import type { configMessages as enConfig } from '../en/config.js';
import type { Message } from '../types.js';

export const configMessages = {
  'safe.line': 'ccinfobar: {line}. satırda yapılandırma hatası, ccinfobar doctor çalıştırın',
  'safe.render': 'ccinfobar: görüntüleme hatası, ccinfobar doctor çalıştırın',
  'config.issue': '{file} yapılandırmasında satır {line}, sütun {column} konumunda hata var: {message}',
  'config.refuseBroken':
    '{file} üzerine yazılmıyor: dosya ayrıştırılamıyor. Dosyayı düzeltin ya da ccinfobar doctor çalıştırın.',
  'config.notObject': 'yapılandırma bir JSON nesnesi olmalı',
  'config.linesNotArray': '"lines" bir dizi olmalı',
  'json.unexpectedChar': 'Beklenmeyen karakter {char}',
  'json.unexpectedEnd': 'Beklenmeyen dosya sonu',
  'json.trailingComma': 'Sonda fazladan virgül',
  'json.expectedColon': 'Anahtardan sonra ":" bekleniyordu',
  'json.expectedCommaOrClose': '"," veya "{close}" bekleniyordu',
  'json.expectedKey': 'Dize türünde bir anahtar bekleniyordu',
  'json.unterminatedString': 'Kapatılmamış dize',
  'json.badEscape': 'Geçersiz kaçış dizisi',
  'json.controlChar': 'Dize içinde kontrol karakteri',
  'json.badNumber': 'Geçersiz sayı',
  'json.trailingData': 'JSON değerinden sonra beklenmeyen veri',
  'json.empty': 'Dosya boş',
  'cfg.usage': 'Kullanım: ccinfobar config get|set|unset <path> [value] [--config <file>]',
  'cfg.missing': '{path} yolunda değer yok',
  'cfg.badPath': 'Geçersiz yol "{path}"',
  'cfg.protoSegment': '"{segment}" yol parçasına izin verilmiyor',
  'cfg.rejected': 'Reddedildi: {path} doğrulamadan geçmezdi',
  'cfg.badRule': '{path}: {problem}',
  'cfg.set': '✓ {path} ayarlandı',
  'cfg.unset': '✓ {path} kaldırıldı',
  'cfg.resetDefault': '✓ {path} varsayılana döndü: {value}',
  'cfg.brokenFile':
    '{file} yapılandırması ayrıştırılamıyor (satır {line}, sütun {column}). ccinfobar doctor çalıştırın.',
  'cfg.readError': '{file} okunamıyor: {message}',
  'cfg.writeError': '{file} yazılamıyor: {message}',
  'editor.configBroken':
    'config.json dosyasında satır {line}, sütun {column} konumunda hata var: {message}. Dosyayı düzeltip yeniden yükleyin; editör dosyanın üzerine yazmaz.',
  'tui.configBroken':
    '{file} yapılandırmasında satır {line}, sütun {column} konumunda hata var: {message}. Önce düzeltin; TUI dosyanın üzerine yazmaz.',
} satisfies Record<keyof typeof enConfig, Message>;
