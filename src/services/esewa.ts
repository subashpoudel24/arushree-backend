import { createHmac, timingSafeEqual } from 'crypto';
import { env } from '../config/env.js';
import { OrderDocument } from '../models/Commerce.js';
import { roundMoney } from './cart.js';

export const isEsewaConfigured = () => !!(env.ESEWA_SECRET_KEY && env.ESEWA_PRODUCT_CODE);

const sign = (message: string) =>
  createHmac('sha256', env.ESEWA_SECRET_KEY ?? '').update(message).digest('base64');

const SIGNED_FIELDS = 'total_amount,transaction_uuid,product_code';

// Everything the browser posts to eSewa. The secret key itself never leaves the server.
export const buildEsewaForm = (order: OrderDocument) => {
  const uuid = order.esewa!.transactionUuid;
  const total = String(order.total);
  const code = env.ESEWA_PRODUCT_CODE!;
  return {
    action: env.ESEWA_FORM_URL,
    fields: {
      amount: String(roundMoney(order.total - order.deliveryCharge)),
      tax_amount: '0',
      total_amount: total,
      transaction_uuid: uuid,
      product_code: code,
      product_service_charge: '0',
      product_delivery_charge: String(order.deliveryCharge),
      success_url: `${env.FRONTEND_URL}/payment/success`,
      failure_url: `${env.FRONTEND_URL}/payment/failure?ref=${uuid}`,
      signed_field_names: SIGNED_FIELDS,
      signature: sign(`total_amount=${total},transaction_uuid=${uuid},product_code=${code}`),
    },
  };
};

export interface EsewaCallback {
  transactionUuid: string;
  transactionCode?: string;
  totalAmount: number;
}

// Returns null unless the redirect data carries a valid eSewa signature.
export const parseEsewaCallback = (data: string): EsewaCallback | null => {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object' || typeof body.signed_field_names !== 'string' || typeof body.signature !== 'string') {
    return null;
  }
  const names = body.signed_field_names.split(',');
  // Without this, an attacker could sign nothing useful and still pass.
  if (!['total_amount', 'transaction_uuid', 'product_code'].every((name) => names.includes(name))) return null;
  const message = names.map((name) => `${name}=${String(body[name] ?? '')}`).join(',');
  const expected = Buffer.from(sign(message));
  const actual = Buffer.from(body.signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  if (body.product_code !== env.ESEWA_PRODUCT_CODE) return null;

  return {
    transactionUuid: String(body.transaction_uuid),
    transactionCode: typeof body.transaction_code === 'string' ? body.transaction_code : undefined,
    // eSewa may format amounts like "1,000.0".
    totalAmount: Number(String(body.total_amount).replace(/,/g, '')),
  };
};

// Replaced in tests. Throws if eSewa cannot be reached, so "unknown" is never read as "failed".
export const esewaGateway = {
  async fetchStatus(transactionUuid: string, total: number): Promise<{ status: string; refId?: string }> {
    const url = new URL(env.ESEWA_STATUS_URL);
    url.searchParams.set('product_code', env.ESEWA_PRODUCT_CODE ?? '');
    url.searchParams.set('total_amount', String(total));
    url.searchParams.set('transaction_uuid', transactionUuid);
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (res.status === 404) return { status: 'NOT_FOUND' };
    if (!res.ok) throw new Error(`eSewa status check failed: ${res.status}`);
    const body = (await res.json()) as { status?: string; ref_id?: string };
    return { status: body.status ?? 'UNKNOWN', refId: body.ref_id ?? undefined };
  },
};
