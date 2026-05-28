import crypto from 'node:crypto';

export const AUTH_HEADERS = {
  authorization: 'authorization',
  timestamp: 'x-oh-timestamp',
  signature: 'x-oh-signature',
};

export function normalizeBodyText(body) {
  if (body == null) return '';
  if (typeof body === 'string') return body;
  return JSON.stringify(body);
}

export function createSignature(secret, { timestamp, method, pathname, bodyText = '' }) {
  const normalizedPathname = String(pathname || '/').split('?')[0] || '/';
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(`${timestamp}\n${method.toUpperCase()}\n${normalizedPathname}\n${bodyText}`);
  return hmac.digest('hex');
}

export function createClientAuthHeaders({
  token = '',
  secret = '',
  method = 'POST',
  pathname = '/',
  body = '',
  timestamp = `${Date.now()}`,
} = {}) {
  const bodyText = normalizeBodyText(body);
  const headers = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (secret) {
    headers['X-OH-Timestamp'] = timestamp;
    headers['X-OH-Signature'] = createSignature(secret, {
      timestamp,
      method,
      pathname,
      bodyText,
    });
  }
  return headers;
}

export function extractBearerToken(authorizationHeader = '') {
  const match = authorizationHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

export function isLoopbackAddress(address = '') {
  const normalized = String(address).trim();
  return (
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '::ffff:127.0.0.1' ||
    normalized === 'localhost'
  );
}

export function getRemoteAddress(request) {
  const forwarded = String(request.headers['x-forwarded-for'] || '').split(',')[0].trim();
  if (forwarded) return forwarded;
  return request.socket?.remoteAddress || '';
}

export function verifyRequestAuth(request, {
  token = '',
  secret = '',
  allowLoopbackWithoutAuth = true,
  bodyText = '',
  method = request.method || 'GET',
  pathname = '/',
} = {}) {
  const normalizedPathname = String(pathname || '/').split('?')[0] || '/';
  const remoteAddress = getRemoteAddress(request);
  const loopback = isLoopbackAddress(remoteAddress);

  if (!token && !secret) {
    return { ok: true, required: false, mode: 'open', loopback, remoteAddress };
  }

  if (allowLoopbackWithoutAuth && loopback && !request.headers.authorization && !request.headers[AUTH_HEADERS.signature]) {
    return { ok: true, required: false, mode: 'loopback', loopback, remoteAddress };
  }

  const providedToken = extractBearerToken(request.headers.authorization || '');
  if (token && providedToken !== token) {
    return { ok: false, required: true, reason: 'invalid_token', loopback, remoteAddress };
  }

  if (secret) {
    const timestamp = String(request.headers[AUTH_HEADERS.timestamp] || '').trim();
    const signature = String(request.headers[AUTH_HEADERS.signature] || '').trim();
    const parsedTimestamp = Number(timestamp);

    if (!timestamp || !signature || !Number.isFinite(parsedTimestamp)) {
      return { ok: false, required: true, reason: 'missing_signature', loopback, remoteAddress };
    }

    const ageMs = Math.abs(Date.now() - parsedTimestamp);
    if (ageMs > 5 * 60 * 1000) {
      return { ok: false, required: true, reason: 'signature_expired', loopback, remoteAddress };
    }

    const expected = createSignature(secret, {
      timestamp,
      method,
      pathname: normalizedPathname,
      bodyText,
    });

    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      return { ok: false, required: true, reason: 'invalid_signature', loopback, remoteAddress };
    }
  }

  return { ok: true, required: true, mode: 'signed', loopback, remoteAddress };
}
