export const PROJECT_HASH_RE = /^[0-9a-f]{16}$/;
export const isProjectHash = (v: string): boolean => PROJECT_HASH_RE.test(v);
