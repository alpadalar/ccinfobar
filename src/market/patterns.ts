// GitHub token and login
export const GITHUB_TOKEN_RE = /^[A-Za-z0-9_]{20,255}$/;
export const LOGIN_RE = /^[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}$/;

// marketplace session token as stored and sent; Authorization header
export const SESSION_TOKEN_RE = /^[\x21-\x7e]{1,512}$/;
export const BEARER_RE = /^Bearer ([0-9a-f]{64})$/;
