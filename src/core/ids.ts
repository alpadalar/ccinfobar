export const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const DEVICE_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;

export const readableId = (id: string, platform: string): boolean =>
  ID_RE.test(id) && (platform !== 'win32' || !DEVICE_RE.test(id));

export const reservedId = (id: string): boolean => DEVICE_RE.test(id);

export const isFileId = (id: unknown): id is string =>
  typeof id === 'string' && ID_RE.test(id) && !DEVICE_RE.test(id);
