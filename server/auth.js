// Google sign-in. The browser gets an ID token from Google Identity Services
// and posts it here; the server verifies it, finds or creates the account and
// sets a session cookie, which also authorizes the call WebSocket.
// Without GOOGLE_CLIENT_ID (local development) everyone is the same local user.

import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

const COOKIE_NAME = 'lt_session';
const SESSION_MAX_AGE = 30 * 24 * 60 * 60;

export const LOCAL_USER = { id: 'local', email: null, name: '로컬 개발', picture: null, balanceSeconds: Infinity };

const hashToken = (token) => createHash('sha256').update(token).digest('hex');

function readCookie(req) {
  for (const pair of (req.headers.cookie ?? '').split(';')) {
    const [name, ...rest] = pair.trim().split('=');
    if (name === COOKIE_NAME) return rest.join('=');
  }
  return null;
}

function setCookie(req, res, value, maxAge) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`);
}

export function createAuth({ googleClientId, db, freeTrialSeconds, jwks = GOOGLE_JWKS }) {
  if (!googleClientId) {
    return { enabled: false, googleClientId: null, userFromRequest: async () => LOCAL_USER };
  }

  return {
    enabled: true,
    googleClientId,

    async userFromRequest(req) {
      const token = readCookie(req);
      return token ? db.userForSession(hashToken(token)) : null;
    },

    // Throws if the ID token is not a valid, verified Google account for this app.
    async login(req, res, credential) {
      const { payload } = await jwtVerify(String(credential ?? ''), jwks, {
        issuer: GOOGLE_ISSUERS,
        audience: googleClientId,
      });
      if (!payload.sub || !payload.email || payload.email_verified !== true) {
        throw new Error('Google account email is not verified');
      }
      const user = await db.upsertGoogleUser({
        sub: payload.sub,
        email: payload.email,
        name: payload.name ?? null,
        picture: payload.picture ?? null,
      }, freeTrialSeconds);
      const token = randomBytes(32).toString('base64url');
      await db.createSession(hashToken(token), user.id, SESSION_MAX_AGE);
      setCookie(req, res, token, SESSION_MAX_AGE);
      return user;
    },

    async logout(req, res) {
      const token = readCookie(req);
      if (token) await db.deleteSession(hashToken(token));
      setCookie(req, res, '', 0);
    },
  };
}
