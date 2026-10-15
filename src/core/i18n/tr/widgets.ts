import type { widgetMessages as enWidgets } from '../en/widgets.js';
import type { Message } from '../types.js';

export const widgetMessages = {
  'loading.default': 'yükleniyor…',
  'widget.cache.off': 'kapalı',
  'widget.cache.cold': 'soğuk',
  'widget.performance.miss': 'ıska',
  'widget.limit.safe': 'güvenli',
  'widget.limit.reached': 'limit doldu',
  'widget.turn.last': 'son {time}',
  'widget.env.hooksOff': 'hook kapalı',
  'widget.provider.bedrock': 'Bedrock',
  'widget.provider.vertex': 'Vertex',
  'widget.provider.foundry': 'Foundry',
  'widget.provider.mantle': 'Mantle',
  'widget.provider.anthropicAws': 'AWS',
  'widget.provider.apiKey': 'API anahtarı',
  'widget.provider.firstParty': 'Claude',
  'widget.provider.via': '{label}, {host} üzerinden',
  'widget.status.ok': '✓ Claude sorunsuz',
  'widget.status.okText': 'Claude sorunsuz',
  'widget.pr.ciPassText': 'tamam',
} satisfies Record<keyof typeof enWidgets, Message>;
