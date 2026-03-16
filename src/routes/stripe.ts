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
    
    // 1. Pegamos a URL do Render e limpamos
    let rawUrl = process.env.FRONTEND_URL || 'https://wagbot.vercel.app';
    
    // 2. Removemos espaços, aspas ou barras duplicadas que podem vir do painel do Render
    const cleanUrl = rawUrl.trim().replace(/['"]+/g, '').replace(/\/+$/, '');

    // 3. Garantimos o protocolo HTTPS
    const finalUrl = cleanUrl.startsWith('http') ? cleanUrl : `https://${cleanUrl}`;

    console.log("🔗 Gerando checkout para URL:", finalUrl);

    if (!priceId) {
      throw new Error("STRIPE_PRICE_ID está faltando no servidor.");
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'subscription',
      customer_email: email,
      client_reference_id: userId,
      // Usamos a URL processada e garantida
      success_url: `${finalUrl}/dashboard?success=true`,
      cancel_url: `${finalUrl}/#precos`,
    });

    res.json({ url: session.url });
  } catch (error: any) {
    console.error("🔥 Erro detalhado no Stripe:", error.message);
    res.status(500).json({ 
      error: "Erro ao configurar URL de pagamento",
      details: error.message 
    });
  }
});

export default router;
