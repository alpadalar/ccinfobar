declare const __VERSION__: string;

export const VERSION = typeof __VERSION__ === 'string' ? __VERSION__ : '0.0.0-dev';
