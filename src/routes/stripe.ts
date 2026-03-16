import express, { Request, Response } from 'express';
import Stripe from 'stripe';

const router = express.Router();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
  // @ts-ignore
});

router.post('/create-checkout-session', async (req: Request, res: Response) => {
  try {
    const { email, userId } = req.body;
    const priceId = process.env.STRIPE_PRICE_ID;
    
    // Pegamos a URL e limpamos espaços em branco acidentais
    let frontendUrl = (process.env.FRONTEND_URL || '').trim();

    // FEATURE: Validação e correção automática de protocolo
    if (!frontendUrl.startsWith('http')) {
      // Se você esqueceu o https no Render, isso tenta corrigir ou avisar
      if (frontendUrl.includes('localhost')) {
        frontendUrl = `http://${frontendUrl}`;
      } else {
        frontendUrl = `https://${frontendUrl}`;
      }
    }

    if (!priceId) {
      return res.status(500).json({ error: "STRIPE_PRICE_ID não configurado no Render." });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'subscription',
      customer_email: email,
      client_reference_id: userId,
      // Usamos a URL limpa e validada
      success_url: `${frontendUrl}/dashboard?success=true`,
      cancel_url: `${frontendUrl}/pricing`,
    });

    res.json({ url: session.url });
  } catch (error: any) {
    console.error("🔥 Erro Stripe:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// ... (Webhook)
export default router;
