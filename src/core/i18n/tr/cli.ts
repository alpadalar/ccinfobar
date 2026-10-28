import type { cliMessages as enCli } from '../en/cli.js';
import type { Message } from '../types.js';

export const cliMessages = {
  'cli.unknownCommand': 'Bilinmeyen komut "{command}". ccinfobar --help çalıştırın.',
  'cli.invalidJson': "ccinfobar: stdin'den gelen JSON geçersiz",
  'cli.edit.notCode':
    'Bu bir paylaşım kodu değil. Port seçmek için --port <n>, tarayıcıyı açmak için --open kullanın; kod oluşturmak için ccinfobar share',
  'cli.badInt': '{flag} için {min} ile {max} arasında bir tam sayı gerekir',
} satisfies Record<keyof typeof enCli, Message>;
