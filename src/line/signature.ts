// LINE の Webhook 署名（X-Line-Signature）の検証。
// 本文（受け取ったバイト列そのもの）をチャネルシークレットで HMAC-SHA256 し、Base64 の署名と定数時間で比べる。

const encoder = new TextEncoder();

/** 長さが同じなら、どこで違っても同じ回数だけ比べる（途中で抜けない） */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

function decodeBase64(value: string): Uint8Array | null {
  // 正しい Base64（SHA-256 なら 44 文字）以外は、比べる前に不正とする
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) return null;
  try {
    const bin = atob(value);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export async function hmacSha256(secret: string, body: ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, body));
}

export async function verifyLineSignature(
  secret: string,
  body: ArrayBuffer | Uint8Array,
  signature: string | null | undefined,
): Promise<boolean> {
  if (!secret || !signature) return false;
  const provided = decodeBase64(signature);
  if (!provided) return false;
  const expected = await hmacSha256(secret, body);
  return timingSafeEqual(expected, provided);
}

/** 試験・手元の確かめで、正しい署名を作る */
export async function signLineBody(secret: string, body: string): Promise<string> {
  const mac = await hmacSha256(secret, encoder.encode(body));
  let bin = '';
  for (const b of mac) bin += String.fromCharCode(b);
  return btoa(bin);
}
