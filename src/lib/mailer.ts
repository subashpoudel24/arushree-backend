import nodemailer from 'nodemailer';
import { env } from '../config/env.js';
import { logger } from './logger.js';

export interface Mail {
  to: string;
  subject: string;
  html: string;
}

const transport = env.SMTP_HOST
  ? nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    })
  : null;

export const mailer = {
  async send(mail: Mail) {
    if (!transport) {
      // env validation guarantees this branch never runs in production.
      logger.warn({ to: mail.to, subject: mail.subject, html: mail.html }, 'SMTP not set: email not sent');
      return;
    }
    await transport.sendMail({ from: env.MAIL_FROM, ...mail });
  },
};

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const orderEmail = (
  to: string,
  order: { orderNumber: string; total: number; items: { name: string; quantity: number }[] },
  heading: string,
  trackLink: string
): Mail => ({
  to,
  subject: `${heading} - ${order.orderNumber}`,
  html:
    `<p>${escapeHtml(heading)}.</p>` +
    `<p>Order number: <strong>${escapeHtml(order.orderNumber)}</strong></p>` +
    `<ul>${order.items.map((item) => `<li>${escapeHtml(item.name)} x ${item.quantity}</li>`).join('')}</ul>` +
    `<p>Total: Rs. ${order.total}</p>` +
    `<p><a href="${escapeHtml(trackLink)}">Track your order</a></p>`,
});

export const contactNotificationEmail = (
  to: string,
  message: { name: string; email: string; subject: string; message: string }
): Mail => ({
  to,
  subject: 'New message from the website',
  html:
    `<p>From: ${escapeHtml(message.name)} (${escapeHtml(message.email)})</p>` +
    `<p>Subject: ${escapeHtml(message.subject)}</p>` +
    `<p>${escapeHtml(message.message).replace(/\n/g, '<br>')}</p>`,
});

export const passwordResetEmail = (to: string, name: string, link: string): Mail => ({
  to,
  subject: 'Reset your Aarushree password',
  html:
    `<p>Hello ${escapeHtml(name)},</p>` +
    `<p>Use the link below to choose a new password. It expires in 1 hour and can be used once.</p>` +
    `<p><a href="${escapeHtml(link)}">Reset my password</a></p>` +
    `<p>If you did not request this, you can ignore this email.</p>`,
});
