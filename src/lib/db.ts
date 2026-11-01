import mongoose from 'mongoose';
import { logger } from './logger.js';

mongoose.set('strictQuery', true);

export const connectDatabase = async (uri: string) => {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
  logger.info('Connected to MongoDB');
};

export const disconnectDatabase = () => mongoose.disconnect();
