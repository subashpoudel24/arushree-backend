import { Schema, model } from 'mongoose';
import { IImage, imageSchema } from './Category.js';

interface IBlog {
  title: string;
  slug: string;
  excerpt: string;
  content: string;
  image?: IImage;
  authorName: string;
  authorImage?: IImage;
  status: 'draft' | 'published';
  publishedAt?: Date;
  seoTitle?: string;
  seoDescription?: string;
}

const blogSchema = new Schema<IBlog>(
  {
    title: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true },
    excerpt: { type: String, default: '', trim: true },
    content: { type: String, default: '' },
    image: { type: imageSchema },
    authorName: { type: String, default: '', trim: true },
    authorImage: { type: imageSchema },
    status: { type: String, enum: ['draft', 'published'], default: 'draft' },
    publishedAt: { type: Date },
    seoTitle: { type: String, trim: true },
    seoDescription: { type: String, trim: true },
  },
  { timestamps: true }
);
blogSchema.index({ status: 1, publishedAt: -1 });
export const Blog = model<IBlog>('Blog', blogSchema);

interface ITestimonial {
  authorName: string;
  authorImage?: IImage;
  rating: number;
  title: string;
  text: string;
  active: boolean;
  displayOrder: number;
}

const testimonialSchema = new Schema<ITestimonial>(
  {
    authorName: { type: String, required: true, trim: true },
    authorImage: { type: imageSchema },
    rating: { type: Number, required: true, min: 1, max: 5 },
    title: { type: String, default: '', trim: true },
    text: { type: String, required: true, trim: true },
    active: { type: Boolean, default: true },
    displayOrder: { type: Number, default: 0 },
  },
  { timestamps: true }
);
export const Testimonial = model<ITestimonial>('Testimonial', testimonialSchema);

interface IPage {
  title: string;
  slug: string;
  content: string;
  published: boolean;
  showInFooter: boolean;
  seoTitle?: string;
  seoDescription?: string;
}

const pageSchema = new Schema<IPage>(
  {
    title: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true },
    content: { type: String, default: '' },
    published: { type: Boolean, default: true },
    showInFooter: { type: Boolean, default: false },
    seoTitle: { type: String, trim: true },
    seoDescription: { type: String, trim: true },
  },
  { timestamps: true }
);
export const Page = model<IPage>('Page', pageSchema);

interface IContactMessage {
  name: string;
  email: string;
  subject: string;
  message: string;
  status: 'new' | 'read';
}

const contactMessageSchema = new Schema<IContactMessage>(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    subject: { type: String, default: '', trim: true },
    message: { type: String, required: true, trim: true },
    status: { type: String, enum: ['new', 'read'], default: 'new' },
  },
  { timestamps: true }
);
contactMessageSchema.index({ status: 1, createdAt: -1 });
export const ContactMessage = model<IContactMessage>('ContactMessage', contactMessageSchema);
