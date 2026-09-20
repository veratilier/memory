const encoder = new TextEncoder();

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export async function hmac(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value))));
}

export async function sha256(value: string): Promise<string> {
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}

export async function safeEqual(left: string, right: string): Promise<boolean> {
  const leftHash = await crypto.subtle.digest('SHA-256', encoder.encode(left));
  const rightHash = await crypto.subtle.digest('SHA-256', encoder.encode(right));
  const a = new Uint8Array(leftHash);
  const b = new Uint8Array(rightHash);
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

// Cloudflare Workers' Web Crypto runtime rejects PBKDF2 iteration counts above
// 100,000. Keep the stored value explicit so hashes remain self-describing and
// can be migrated later if the runtime raises that ceiling.
const PASSWORD_ITERATIONS = 100_000;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PASSWORD_ITERATIONS },
    keyMaterial,
    256,
  );
  return `pbkdf2-sha256$${PASSWORD_ITERATIONS}$${bytesToBase64Url(salt)}$${bytesToBase64Url(new Uint8Array(derived))}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, iterationsValue, saltValue, expected] = encoded.split('$');
  const iterations = Number(iterationsValue);
  if (algorithm !== 'pbkdf2-sha256' || !Number.isInteger(iterations) || iterations < 100_000 || !saltValue || !expected) return false;
  try {
    const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
    const derived = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: Uint8Array.from(base64UrlToBytes(saltValue)), iterations },
      keyMaterial,
      256,
    );
    return safeEqual(bytesToBase64Url(new Uint8Array(derived)), expected);
  } catch {
    return false;
  }
}

export type Session = { sub: string; exp: number; nonce: string };

export async function createSession(secret: string, userId = 'user', ttlSeconds = 8 * 60 * 60): Promise<string> {
  const payload: Session = { sub: userId, exp: Math.floor(Date.now() / 1000) + ttlSeconds, nonce: crypto.randomUUID() };
  const encoded = bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
  return `${encoded}.${await hmac(encoded, secret)}`;
}

export async function readSession(token: string | undefined, secret: string): Promise<Session | null> {
  if (!token) return null;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra || !(await safeEqual(signature, await hmac(payload, secret)))) return null;
  try {
    const session = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload))) as Session;
    return typeof session.sub === 'string' && session.sub.length > 0 && session.exp > Math.floor(Date.now() / 1000) ? session : null;
  } catch {
    return null;
  }
}

export async function verifySession(token: string | undefined, secret: string): Promise<boolean> {
  return Boolean(await readSession(token, secret));
}

export async function createCsrfToken(session: string, purpose: string, secret: string): Promise<string> {
  return hmac(`csrf:${purpose}:${session}`, secret);
}

export async function verifyCsrfToken(token: string, session: string, purpose: string, secret: string): Promise<boolean> {
  if (!token || !session) return false;
  return safeEqual(token, await createCsrfToken(session, purpose, secret));
}

export function getCookie(request: Request, name: string): string | undefined {
  const cookies = request.headers.get('cookie')?.split(';') ?? [];
  for (const cookie of cookies) {
    const [key, ...parts] = cookie.trim().split('=');
    if (key === name) { try { return decodeURIComponent(parts.join('=')); } catch { return undefined; } }
  }
  return undefined;
}

export function assertSameOrigin(request: Request, expectedOrigin: string): boolean {
  const origin = request.headers.get('origin');
  if (origin) return origin === expectedOrigin;
  const referer = request.headers.get('referer');
  if (referer) {
    try { return new URL(referer).origin === expectedOrigin; } catch { return false; }
  }
  return request.headers.get('sec-fetch-site') === 'same-origin';
}

export const sessionCookie = (value: string, maxAge = 8 * 60 * 60) =>
  `__Host-memory-session=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
