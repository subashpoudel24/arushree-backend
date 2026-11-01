import { RolePermission, Setting } from '../models/Admin.js';
import { Role } from '../models/User.js';

// Staff, roles and the audit log are not listed: they stay with Super Admins only,
// so nobody can give themselves more power through this list.
export const PERMISSIONS = [
  'dashboard',
  'products.read',
  'products.write',
  'media.write',
  'media.delete',
  'orders',
  'customers',
  'coupons',
  'delivery',
  'reviews',
  'content',
  'settings',
] as const;
export type Permission = (typeof PERMISSIONS)[number];
export type EditableRole = 'manager' | 'editor';

export const DEFAULT_PERMISSIONS: Record<EditableRole, Permission[]> = {
  manager: [...PERMISSIONS],
  editor: ['products.read', 'media.write', 'reviews', 'content'],
};

export const permissionsFor = async (role: Role): Promise<string[]> => {
  if (role === 'super_admin') return [...PERMISSIONS, 'staff', 'audit'];
  if (role === 'customer') return [];
  const saved = await RolePermission.findOne({ role }).lean();
  return saved?.permissions ?? DEFAULT_PERMISSIONS[role];
};

export interface PaymentSettings {
  cod: boolean;
  esewa: boolean;
}

export const getPaymentSettings = async (): Promise<PaymentSettings> => {
  const saved = await Setting.findOne({ key: 'payments' }).lean();
  return { cod: true, esewa: true, ...(saved?.value as Partial<PaymentSettings> | undefined) };
};
