import { Setting } from '../models/Admin.js';

export const HOMEPAGE_SECTIONS = ['new_products', 'categories', 'featured', 'testimonials'] as const;

export interface ImageValue {
  url: string;
  publicId?: string;
  alt?: string;
}

export interface HomepageContent {
  noticeBar: { enabled: boolean; text: string; link?: string };
  showHighlights: boolean;
  highlights: { text: string; image?: ImageValue | null }[];
  banners: {
    heading: string;
    subheading: string;
    buttonText: string;
    buttonLink: string;
    desktopImage: ImageValue;
    mobileImage?: ImageValue;
    enabled: boolean;
  }[];
  sections: { key: (typeof HOMEPAGE_SECTIONS)[number]; enabled: boolean }[];
}

export interface SiteSettings {
  siteName: string;
  logo: ImageValue;
  phone: string;
  email: string;
  address: string;
  footerText: string;
  social: { facebook?: string; instagram?: string; tiktok?: string; youtube?: string };
  googleAnalyticsId?: string;
}

export const DEFAULT_HOMEPAGE: HomepageContent = {
  noticeBar: { enabled: false, text: '' },
  showHighlights: true,
  // Wording and icons from the old site.
  highlights: [
    { text: 'Classic and Trusted', image: { url: '/assets/images/classic_trusted_mob.svg' } },
    { text: 'Clinically tested', image: { url: '/assets/images/clinically_tested_icon_mobile.svg' } },
    { text: 'Skin Friendly', image: { url: '/assets/images/skinfriendly_mobile.svg' } },
  ],
  banners: [
    {
      // All the wording is part of this artwork, so the fields stay empty.
      heading: '',
      subheading: '',
      buttonText: '',
      buttonLink: '/shop',
      desktopImage: {
        url: '/assets/images/festive-banner.webp',
        alt: 'Festival greetings from Aarushree: get 15% off our products',
      },
      enabled: true,
    },
  ],
  sections: HOMEPAGE_SECTIONS.map((key) => ({ key, enabled: true })),
};

// Taken from the old site. Editable under Site settings.
export const DEFAULT_SITE: SiteSettings = {
  siteName: 'Aarushree Life Sciences',
  logo: { url: '/logo.svg' },
  phone: '9802320080 / 9843491898',
  email: 'contact@aarushreelifesciences.com',
  address: 'Mid-Baneshwor, Kathmandu, Nepal',
  footerText: 'Beauty is not just an appearance.',
  social: {
    facebook: 'https://www.facebook.com/als.kleida/',
    instagram: 'https://www.instagram.com/aarushree_life_sciences/',
  },
};

// The About text from the old site, shown until an About page is saved.
export const DEFAULT_PAGES: Record<string, { title: string; content: string }> = {
  about: {
    title: 'About us',
    content:
      '<h2>Our Journey</h2>' +
      '<p>We were aware and were in the state where we believe "Beauty is not just an Appearance" and later we realize there is a need of Perception, Vision and Action to define it and we started Aarushree Lifesciences with a statement;</p>' +
      '<p><strong>YOU STEP IN AND I JOINED TO DEFINE THE GLORIOUS VERSION OF US.</strong></p>' +
      '<p>In the background of Moral conscience and truth, we focus on the perception, vision and action to define the glorious version of beauty through Honesty and Clairvoyance with a Name; Aarushree Lifesciences since 2017.</p>' +
      "<h2>Let's talk about beauty</h2>" +
      '<p>Beauty can be defined as a quality in someone or something that makes it attractive and interesting in our eyes. It is a quality that makes us feel a sense of pleasure and appreciation.</p>' +
      '<p>Aarushree Lifesciences is committed to fulfil your need to retain glorious version of yourself by providing <strong>Best Quality</strong> products.</p>',
  },
  contact: { title: 'Contact us', content: '<p>We would love to hear from you.</p>' },
};

// These pages have their own web addresses, so they cannot be deleted or renamed.
export const SYSTEM_PAGES = ['about', 'contact'];

const read = async <T>(key: string, fallback: T): Promise<T> => {
  const saved = await Setting.findOne({ key }).lean();
  return saved ? { ...fallback, ...(saved.value as Partial<T>) } : fallback;
};

export const getHomepage = () => read<HomepageContent>('homepage', DEFAULT_HOMEPAGE);
export const getSiteSettings = () => read<SiteSettings>('site', DEFAULT_SITE);

export const imagesOfHomepage = (homepage: HomepageContent) =>
  [
    ...homepage.banners.flatMap((banner) => [banner.desktopImage?.publicId, banner.mobileImage?.publicId]),
    ...(homepage.highlights ?? []).map((item) => item.image?.publicId),
  ];
