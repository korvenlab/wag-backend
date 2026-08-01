import Stripe from 'stripe';
import dotenv from 'dotenv';

dotenv.config();

const stripeKey = process.env.STRIPE_SECRET_KEY || '';
if (!stripeKey) {
  console.error('⚠️ AVISO: A variável STRIPE_SECRET_KEY não está configurada!');
}

export const stripe = new Stripe(stripeKey, { apiVersion: '2023-10-16' });

export function frontendBaseUrl(): string {
  return (process.env.FRONTEND_URL || '').trim().replace(/\/$/, '');
}
