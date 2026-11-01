import ExcelJS from 'exceljs';
import { Response } from 'express';
import PDFDocument from 'pdfkit';
import { OrderDocument } from '../models/Commerce.js';

const money = (value: number) => `Rs. ${value.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const title = (value: string) => value.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export const streamInvoice = (res: Response, order: OrderDocument) => {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="invoice-${order.orderNumber}.pdf"`);

  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  doc.pipe(res);

  doc.fontSize(20).text('Aarushree Life Sciences');
  doc.fontSize(14).moveDown(0.5).text('Invoice');
  doc.fontSize(10).moveDown(0.5);
  doc.text(`Order: ${order.orderNumber}`);
  doc.text(`Date: ${order.createdAt.toISOString().slice(0, 10)}`);
  doc.text(`Payment: ${order.paymentMethod === 'cod' ? 'Cash on delivery' : 'eSewa'} (${title(order.paymentStatus)})`);

  const a = order.address;
  doc.moveDown().fontSize(11).text('Deliver to');
  doc.fontSize(10).text(`${a.firstName} ${a.lastName}, ${a.phone}`);
  doc.text([a.street, a.landmark, title(a.city), title(a.district), title(a.province)].filter(Boolean).join(', '));

  const row = (y: number, cells: string[]) => {
    doc.text(cells[0], 50, y, { width: 270 });
    doc.text(cells[1], 330, y, { width: 40, align: 'right' });
    doc.text(cells[2], 380, y, { width: 80, align: 'right' });
    doc.text(cells[3], 470, y, { width: 75, align: 'right' });
  };

  let y = doc.y + 20;
  doc.font('Helvetica-Bold');
  row(y, ['Item', 'Qty', 'Price', 'Total']);
  doc.font('Helvetica');
  y += 18;
  for (const item of order.items) {
    if (y > 700) {
      doc.addPage();
      y = 50;
    }
    row(y, [item.name, String(item.quantity), money(item.unitPrice), money(item.lineTotal)]);
    y += Math.max(18, doc.heightOfString(item.name, { width: 270 }) + 6);
  }

  y += 10;
  const totals: [string, string][] = [
    ['Subtotal', money(order.subtotal)],
    ...(order.discount ? ([[`Discount${order.couponCode ? ` (${order.couponCode})` : ''}`, `-${money(order.discount)}`]] as [string, string][]) : []),
    ['Delivery', money(order.deliveryCharge)],
    ['Total', money(order.total)],
  ];
  totals.forEach(([label, value], index) => {
    if (index === totals.length - 1) doc.font('Helvetica-Bold');
    doc.text(label, 330, y, { width: 130, align: 'right' });
    doc.text(value, 470, y, { width: 75, align: 'right' });
    y += 16;
  });
  doc.font('Helvetica');
  doc.end();
};

// A customer-typed "=SUM(...)" must stay text, or a spreadsheet would run it as a formula.
const safeCell = (value: string | undefined) => {
  const text = value ?? '';
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
};

export const streamOrdersWorkbook = async (res: Response, orders: OrderDocument[]) => {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('Orders');
  sheet.columns = [
    { header: 'Order', key: 'orderNumber', width: 20 },
    { header: 'Date', key: 'date', width: 12 },
    { header: 'Customer', key: 'customer', width: 24 },
    { header: 'Phone', key: 'phone', width: 16 },
    { header: 'Email', key: 'email', width: 28 },
    { header: 'City', key: 'city', width: 16 },
    { header: 'Items', key: 'items', width: 40 },
    { header: 'Subtotal', key: 'subtotal', width: 10 },
    { header: 'Discount', key: 'discount', width: 10 },
    { header: 'Delivery', key: 'delivery', width: 10 },
    { header: 'Total', key: 'total', width: 10 },
    { header: 'Payment', key: 'payment', width: 10 },
    { header: 'Payment status', key: 'paymentStatus', width: 16 },
    { header: 'Status', key: 'status', width: 18 },
    { header: 'Heard about us', key: 'hearAboutUs', width: 18 },
  ];
  sheet.getRow(1).font = { bold: true };
  for (const order of orders) {
    sheet.addRow({
      orderNumber: order.orderNumber,
      date: order.createdAt.toISOString().slice(0, 10),
      customer: safeCell(`${order.address.firstName} ${order.address.lastName}`),
      phone: safeCell(order.address.phone),
      email: safeCell(order.email),
      city: safeCell(order.address.city),
      items: safeCell(order.items.map((item) => `${item.name} x ${item.quantity}`).join(', ')),
      subtotal: order.subtotal,
      discount: order.discount,
      delivery: order.deliveryCharge,
      total: order.total,
      payment: order.paymentMethod,
      paymentStatus: order.paymentStatus,
      status: order.status,
      hearAboutUs: safeCell(order.hearAboutUs),
    });
  }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="orders.xlsx"');
  await book.xlsx.write(res);
  res.end();
};
