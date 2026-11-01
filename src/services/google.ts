import { OAuth2Client } from 'google-auth-library';
import { env } from '../config/env.js';

export interface GoogleProfile {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string;
  picture?: string;
}

const client = new OAuth2Client();

export const googleVerifier = {
  async verify(idToken: string): Promise<GoogleProfile | null> {
    if (!env.GOOGLE_CLIENT_ID) return null;
    try {
      const ticket = await client.verifyIdToken({ idToken, audience: env.GOOGLE_CLIENT_ID });
      const payload = ticket.getPayload();
      if (!payload?.sub || !payload.email) return null;
      return {
        sub: payload.sub,
        email: payload.email,
        emailVerified: payload.email_verified === true,
        name: payload.name ?? payload.email,
        picture: payload.picture,
      };
    } catch {
      return null;
    }
  },
};
