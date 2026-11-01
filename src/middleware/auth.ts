import { NextFunction, Request, Response } from 'express';
import { forbidden, unauthorized } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { AuditLog } from '../models/Admin.js';
import { Permission, permissionsFor } from '../services/permissions.js';
import { Role, STAFF_ROLES, User, UserDocument } from '../models/User.js';
import { ACCESS_COOKIE, SESSION_HINT_COOKIE, verifyAccessToken } from '../services/tokens.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: UserDocument;
    }
  }
}

// Loads the user on every request so blocking or demoting takes effect immediately.
export const requireAuth = async (req: Request, _res: Response, next: NextFunction) => {
  const token = req.cookies?.[ACCESS_COOKIE];
  if (!token) return next(unauthorized());
  const userId = verifyAccessToken(token);
  if (!userId) return next(unauthorized('Your session expired.'));
  const user = await User.findById(userId);
  if (!user) return next(unauthorized());
  if (user.status === 'blocked') return next(forbidden('This account has been blocked.'));
  req.user = user;
  next();
};

// For routes open to guests. The hint cookie outlives the short access token, so a
// signed-in customer whose token just expired gets a 401 and refreshes, instead of
// silently being shown an empty guest cart.
export const optionalAuth = async (req: Request, res: Response, next: NextFunction) => {
  if (req.cookies?.[ACCESS_COOKIE] || req.cookies?.[SESSION_HINT_COOKIE]) {
    return requireAuth(req, res, next);
  }
  next();
};

export const requireRole =
  (...roles: Role[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) return next(forbidden());
    next();
  };

export const requireStaff = requireRole(...STAFF_ROLES);

// Read on every request, so a permission change applies immediately.
export const requirePermission =
  (permission: Permission | 'staff' | 'audit') => async (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    const allowed = await permissionsFor(req.user.role);
    if (!allowed.includes(permission)) return next(forbidden());
    next();
  };

// Records every successful admin change after the response is sent.
export const auditWrites = (req: Request, res: Response, next: NextFunction) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  res.on('finish', () => {
    if (res.statusCode >= 400 || !req.user) return;
    void AuditLog.create({
      actor: req.user._id,
      actorName: req.user.name,
      actorEmail: req.user.email,
      method: req.method,
      path: req.originalUrl.split('?')[0],
      fields: req.body && typeof req.body === 'object' ? Object.keys(req.body).slice(0, 50) : [],
      status: res.statusCode,
      ip: req.ip,
    }).catch((err) => logger.error({ err }, 'Could not write audit log'));
  });
  next();
};
