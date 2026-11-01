import { HydratedDocument, Schema, Types, model } from 'mongoose';

export interface ICartItem {
  product: Types.ObjectId;
  quantity: number;
}

export interface ICart {
  user?: Types.ObjectId;
  guestHash?: string;
  items: ICartItem[];
  couponCode?: string;
  expiresAt?: Date; // Guest carts only.
}
export type CartDocument = HydratedDocument<ICart>;

const cartSchema = new Schema<ICart>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', unique: true, sparse: true },
    guestHash: { type: String, unique: true, sparse: true },
    items: {
      type: [
        {
          _id: false,
          product: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
          quantity: { type: Number, required: true, min: 1 },
        },
      ],
      default: [],
    },
    couponCode: { type: String },
    expiresAt: { type: Date, expires: 0 },
  },
  { timestamps: true }
);
export const Cart = model<ICart>('Cart', cartSchema);

export interface ICoupon {
  code: string;
  description: string;
  discountPercent: number;
  maxDiscount: number;
  validFrom: Date;
  validTill: Date;
  active: boolean;
  usageLimit: number;
  usedCount: number;
  perCustomerLimit: number;
  product?: Types.ObjectId;
}
export type CouponDocument = HydratedDocument<ICoupon>;

const couponSchema = new Schema<ICoupon>(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    description: { type: String, default: '', trim: true },
    discountPercent: { type: Number, required: true, min: 0, max: 100 },
    maxDiscount: { type: Number, required: true, min: 0 },
    validFrom: { type: Date, required: true },
    validTill: { type: Date, required: true },
    active: { type: Boolean, default: true },
    usageLimit: { type: Number, required: true, min: 0 },
    usedCount: { type: Number, default: 0, min: 0 },
    perCustomerLimit: { type: Number, default: 1, min: 1 },
    product: { type: Schema.Types.ObjectId, ref: 'Product' }, // Empty means the whole cart.
  },
  { timestamps: true }
);
export const Coupon = model<ICoupon>('Coupon', couponSchema);

interface ICouponRedemption {
  coupon: Types.ObjectId;
  user?: Types.ObjectId;
  phone?: string;
  order?: Types.ObjectId;
  discount: number;
}

const couponRedemptionSchema = new Schema<ICouponRedemption>(
  {
    coupon: { type: Schema.Types.ObjectId, ref: 'Coupon', required: true },
    user: { type: Schema.Types.ObjectId, ref: 'User' },
    // Records imported from the old site have no phone or order, only the customer.
    phone: { type: String },
    order: { type: Schema.Types.ObjectId, ref: 'Order' },
    discount: { type: Number, required: true },
  },
  { timestamps: true }
);
couponRedemptionSchema.index({ coupon: 1, user: 1 });
couponRedemptionSchema.index({ coupon: 1, phone: 1 });
export const CouponRedemption = model<ICouponRedemption>('CouponRedemption', couponRedemptionSchema);

interface IDeliveryCharge {
  province: string;
  district: string;
  city: string;
  charge: number;
}

const deliveryChargeSchema = new Schema<IDeliveryCharge>(
  {
    province: { type: String, required: true, lowercase: true, trim: true },
    district: { type: String, required: true, lowercase: true, trim: true },
    city: { type: String, required: true, lowercase: true, trim: true },
    charge: { type: Number, required: true, min: 0 },
  },
  { timestamps: true }
);
deliveryChargeSchema.index({ province: 1, district: 1, city: 1 }, { unique: true });
export const DeliveryCharge = model<IDeliveryCharge>('DeliveryCharge', deliveryChargeSchema);

export interface IAddress {
  firstName: string;
  lastName: string;
  phone: string;
  province: string;
  district: string;
  city: string;
  street?: string;
  landmark: string;
  additionalInfo?: string;
}

const addressFields = {
  firstName: { type: String, required: true, trim: true },
  lastName: { type: String, required: true, trim: true },
  phone: { type: String, required: true, trim: true },
  province: { type: String, required: true, lowercase: true, trim: true },
  district: { type: String, required: true, lowercase: true, trim: true },
  city: { type: String, required: true, lowercase: true, trim: true },
  street: { type: String, trim: true },
  landmark: { type: String, required: true, trim: true },
  additionalInfo: { type: String, trim: true },
};

const addressSchema = new Schema<IAddress & { user: Types.ObjectId }>(
  { ...addressFields, user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true } },
  { timestamps: true }
);
export const Address = model('Address', addressSchema);

export const ORDER_STATUSES = ['pending_payment', 'confirmed','shipped', 'out_for_delivery', 'delivered', 'canceled'] as const;
export const PAYMENT_STATUSES = ['unpaid', 'payment_pending', 'paid', 'refunded'] as const;

export interface IOrder {
  stockReleased: boolean;
  paymentExpiresAt?: Date;
  esewa?: { transactionUuid: string; transactionCode?: string; verifiedAt?: Date };
  orderNumber: string;
  ownerKey: string;
  idempotencyKey: string;
  user?: Types.ObjectId;
  email?: string;
  items: {
    product: Types.ObjectId;
    name: string;
    slug: string;
    imageUrl?: string;
    imagePublicId?: string;
    unitPrice: number;
    quantity: number;
    lineTotal: number;
    adminDiscountPercent?: number;
  }[];
  address: IAddress;
  subtotal: number;
  discount: number;
  couponCode?: string;
  deliveryCharge: number;
  total: number;
  paymentMethod: 'cod' | 'esewa';
  paymentStatus: (typeof PAYMENT_STATUSES)[number];
  status: (typeof ORDER_STATUSES)[number];
  hearAboutUs?: string;
  statusHistory: { status: string; at: Date; note?: string }[];
  createdAt: Date;
}
export type OrderDocument = HydratedDocument<IOrder>;

const orderSchema = new Schema<IOrder>(
  {
    orderNumber: { type: String, required: true, unique: true },
    ownerKey: { type: String, required: true },
    idempotencyKey: { type: String, required: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    email: { type: String, lowercase: true, trim: true },
    // Copied, so later product edits or deletions never change past orders.
    items: [
      {
        _id: false,
        product: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
        name: { type: String, required: true },
        slug: { type: String, required: true },
        imageUrl: String,
        imagePublicId: String,
        unitPrice: { type: Number, required: true },
        quantity: { type: Number, required: true, min: 1 },
        lineTotal: { type: Number, required: true },
        adminDiscountPercent: { type: Number, min: 0, max: 100 },
      },
    ],
    address: { type: new Schema(addressFields, { _id: false }), required: true },
    subtotal: { type: Number, required: true },
    discount: { type: Number, default: 0 },
    couponCode: String,
    deliveryCharge: { type: Number, required: true },
    total: { type: Number, required: true },
    paymentMethod: { type: String, enum: ['cod', 'esewa'], required: true },
    paymentStatus: { type: String, enum: PAYMENT_STATUSES, default: 'unpaid' },
    status: { type: String, enum: ORDER_STATUSES, default: 'confirmed' },
    hearAboutUs: { type: String, trim: true },
    statusHistory: { type: [{ _id: false, status: String, at: Date, note: String }], default: [] },
    stockReleased: { type: Boolean, default: false },
    paymentExpiresAt: { type: Date },
    esewa: {
      type: new Schema(
        { transactionUuid: { type: String, required: true }, transactionCode: String, verifiedAt: Date },
        { _id: false }
      ),
    },
  },
  { timestamps: true }
);
orderSchema.index({ ownerKey: 1, idempotencyKey: 1 }, { unique: true });
orderSchema.index({ 'esewa.transactionUuid': 1 }, { unique: true, sparse: true });
orderSchema.index({ status: 1, paymentExpiresAt: 1 });
orderSchema.index({ createdAt: -1 });
orderSchema.index({ status: 1, createdAt: -1 });
orderSchema.index({ 'items.imagePublicId': 1 });
export const Order = model<IOrder>('Order', orderSchema);
