// Optional password gate for deployments. When APP_PASSWORD is set, the
// browser asks for it once (HTTP Basic auth), then a cookie carries the
// session so the WebSocket handshake is authorized too.

import { createHash, timingSafeEqual } from 'node:crypto';

const COOKIE_NAME = 'lt_auth';
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function createAuth(password) {
  if (!password) return null;
  const token = createHash('sha256').update(`langtutor:${password}`).digest('hex');

  const hasCookie = (req) => (req.headers.cookie ?? '').split(';').some((pair) => {
    const [name, ...rest] = pair.trim().split('=');
    return name === COOKIE_NAME && safeEqual(rest.join('='), token);
  });

  const hasBasicAuth = (req) => {
    const [scheme, encoded] = (req.headers.authorization ?? '').split(' ');
    if (scheme !== 'Basic' || !encoded) return false;
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    return safeEqual(decoded.slice(decoded.indexOf(':') + 1), password);
  };

  return {
    // Returns true if the request may proceed; otherwise answers 401 itself.
    checkHttp(req, res) {
      if (hasCookie(req)) return true;
      if (!hasBasicAuth(req)) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="LangTutor", charset="UTF-8"' })
          .end('Password required');
        return false;
      }
      const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}${secure}`);
      return true;
    },

    checkUpgrade(req) {
      return hasCookie(req) || hasBasicAuth(req);
    },
  };
}
