import { Schema, Types, model } from 'mongoose';
import { IImage, imageSchema } from './Category.js';

export interface IProduct {
  name: string;
  slug: string;
  shortDescription: string;
  description: string;
  price: number;
  compareAtPrice?: number;
  stock: number;
  status: 'draft' | 'published';
  featured: boolean;
  images: IImage[];
  specifications: { title: string; description: string }[];
  categories: Types.ObjectId[];
  ratingAverage: number;
  ratingCount: number;
  seoTitle?: string;
  seoDescription?: string;
  createdAt: Date;
  updatedAt: Date;
}

const productSchema = new Schema<IProduct>(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true },
    shortDescription: { type: String, default: '', trim: true },
    description: { type: String, default: '' },
    price: { type: Number, required: true, min: 0 },
    compareAtPrice: { type: Number, min: 0 },
    stock: { type: Number, required: true, min: 0, default: 0 },
    status: { type: String, enum: ['draft', 'published'], default: 'draft' },
    featured: { type: Boolean, default: false },
    images: { type: [imageSchema], default: [] },
    specifications: {
      type: [{ _id: false, title: String, description: String }],
      default: [],
    },
    categories: [{ type: Schema.Types.ObjectId, ref: 'Category', index: true }],
    ratingAverage: { type: Number, default: 0 },
    ratingCount: { type: Number, default: 0 },
    seoTitle: { type: String, trim: true },
    seoDescription: { type: String, trim: true },
  },
  { timestamps: true }
);

productSchema.index({ status: 1, createdAt: -1 });
productSchema.index({ status: 1, price: 1 });
productSchema.index({ status: 1, featured: 1 });

export const Product = model<IProduct>('Product', productSchema);
