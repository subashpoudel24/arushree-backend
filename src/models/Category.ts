import { Schema, model } from 'mongoose';

export const SECTIONS = ['skincare', 'oral-care'] as const;

export interface IImage {
  url: string;
  publicId?: string;
  alt?: string;
}

export const imageSchema = new Schema<IImage>(
  {
    url: { type: String, required: true },
    publicId: { type: String },
    alt: { type: String, trim: true },
  },
  { _id: false }
);

interface ICategory {
  name: string;
  slug: string;
  section: (typeof SECTIONS)[number];
  image?: IImage;
  displayOrder: number;
  active: boolean;
}

const categorySchema = new Schema<ICategory>(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true },
    section: { type: String, enum: SECTIONS, required: true, index: true },
    image: { type: imageSchema },
    displayOrder: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export const Category = model<ICategory>('Category', categorySchema);
