import express, { Router, Request, Response } from 'express';
import { supabase } from '../lib/supabase';
import { getUserFromBearerHeader } from '../lib/supabaseAuthUser';
import { profileHasWagooAccess } from '../lib/profileAccess';
import { profileSubscriptionTier } from '../lib/profileMultiBarber';
import { tierSupportsPublicBooking } from '../lib/wagooSubscription';
import {
  clubClientPortalUrl,
  createClubCheckoutSession,
  digitsPhone,
  ensureClubStripeAssets,
  findActiveClubMemberByPhone,
  type ClubPlanRow,
} from '../services/clubMembership';
import {
  extractClubToken,
  requestClubOtp,
  validateClubAccessSession,
  verifyClubOtp,
  type ClubOtpPurpose,
} from '../services/clubOtp';
import { WAGOO_APPLICATION_FEE_PERCENT } from '../lib/connectFees';

const OTP_PURPOSES = new Set<ClubOtpPurpose>([
  'subscribe',
  'member_access',
  'club_benefit',
]);

const router = Router();

const DAYS_ORDER = [
  'Segunda-feira',
  'Terça-feira',
  'Quarta-feira',
  'Quinta-feira',
  'Sexta-feira',
  'Sábado',
  'Domingo',
] as const;

function formatWorkingHoursPublic(raw: unknown): {
  day: string;
  open: boolean;
  slots: string[];
}[] {
  const wh = (raw && typeof raw === 'object' ? raw : {}) as Record<
    string,
    {
      startTime?: string;
      endTime?: string;
      isTurno1Active?: boolean;
      startTime2?: string;
      endTime2?: string;
      isTurno2Active?: boolean;
      startTime3?: string;
      endTime3?: string;
      isTurno3Active?: boolean;
    }
  >;

  return DAYS_ORDER.map((day) => {
    const d = wh[day] || {};
    const slots: string[] = [];
    if (d.isTurno1Active && d.startTime && d.endTime) {
      slots.push(`${d.startTime}–${d.endTime}`);
    }
    if (d.isTurno2Active && d.startTime2 && d.endTime2) {
      slots.push(`${d.startTime2}–${d.endTime2}`);
    }
    if (d.isTurno3Active && d.startTime3 && d.endTime3) {
      slots.push(`${d.startTime3}–${d.endTime3}`);
    }
    return { day, open: slots.length > 0, slots };
  });
}

async function requireOwner(req: Request) {
  const auth = await getUserFromBearerHeader(supabase, req.headers.authorization);
  if (!auth.ok) {
    return {
      ok: false as const,
      status: 401,
      error:
        auth.reason === 'missing_token'
          ? 'Faça login e envie Authorization: Bearer.'
          : 'Sessão inválida.',
    };
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select(
      'id, store_name, booking_slug, booking_published, has_paid, complimentary_access_until, subscription_tier, multi_barber_plan, stripe_connect_account_id, stripe_connect_charges_enabled',
    )
    .eq('id', auth.user.id)
    .maybeSingle();

  if (!profile) return { ok: false as const, status: 404, error: 'Perfil não encontrado.' };

  if (
    !profileHasWagooAccess({
      has_paid: profile.has_paid,
      complimentary_access_until: profile.complimentary_access_until,
    })
  ) {
    return { ok: false as const, status: 403, error: 'Assinatura activa necessária.' };
  }

  return { ok: true as const, userId: auth.user.id, profile };
}

async function loadPublishedSiteBySlug(slug: string) {
  const { data } = await supabase
    .from('profiles')
    .select(
      'id, store_name, booking_slug, booking_logo_url, booking_cover_url, booking_tagline, booking_phone, booking_address, booking_published, working_hours, subscription_tier, multi_barber_plan, has_paid, stripe_connect_account_id, stripe_connect_charges_enabled',
    )
    .eq('booking_slug', slug)
    .maybeSingle();

  if (!data || !data.booking_published) return null;
  if (!tierSupportsPublicBooking(profileSubscriptionTier(data))) return null;
  return data;
}

/** Painel do dono: plano + membros. */
router.get('/me', async (req: Request, res: Response) => {
  const gate = await requireOwner(req);
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

  const [{ data: plan }, { data: members }] = await Promise.all([
    supabase.from('club_plans').select('*').eq('profile_id', gate.userId).maybeSingle(),
    supabase
      .from('club_members')
      .select(
        'id, client_name, client_phone, client_email, status, current_period_end, created_at',
      )
      .eq('profile_id', gate.userId)
      .order('created_at', { ascending: false })
      .limit(100),
  ]);

  const slug = gate.profile.booking_slug as string | null;
  const ready =
    Boolean(gate.profile.stripe_connect_account_id) &&
    Boolean(gate.profile.stripe_connect_charges_enabled);

  res.json({
    plan: plan ?? null,
    members: members ?? [],
    client_portal_url: slug ? clubClientPortalUrl(slug) : null,
    payment_link_url: plan?.payment_link_url ?? null,
    connect_ready: ready,
    wagoo_fee_percent: WAGOO_APPLICATION_FEE_PERCENT,
  });
});

/** Cria/atualiza plano e (re)gera Payment Link Stripe. */
router.put('/me', express.json(), async (req: Request, res: Response) => {
  const gate = await requireOwner(req);
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

  const connectId = gate.profile.stripe_connect_account_id as string | null;
  const chargesOk = Boolean(gate.profile.stripe_connect_charges_enabled);
  if (!connectId || !chargesOk) {
    return res.status(400).json({
      error: 'Conecte a conta em Pagamentos e termine o cadastro Stripe antes de ativar o clube.',
    });
  }

  const slug = String(gate.profile.booking_slug || '').trim();
  if (!slug) {
    return res.status(400).json({
      error: 'Defina o link da loja (slug) em Agenda Web antes de ativar o clube.',
    });
  }

  const name = String(req.body?.name ?? 'Clube Ilimitado').trim() || 'Clube Ilimitado';
  const description = String(
    req.body?.description ?? 'Assinatura mensal com cortes ilimitados.',
  ).trim();
  const price = Number(req.body?.price_brl ?? req.body?.price);
  const active = req.body?.active !== undefined ? Boolean(req.body.active) : true;

  if (!Number.isFinite(price) || price < 1) {
    return res.status(400).json({ error: 'Informe um valor mensal válido (mín. R$ 1).' });
  }

  const priceRounded = Math.round(price * 100) / 100;

  const { data: existing } = await supabase
    .from('club_plans')
    .select('*')
    .eq('profile_id', gate.userId)
    .maybeSingle();

  let plan: ClubPlanRow;
  if (existing) {
    const { data, error } = await supabase
      .from('club_plans')
      .update({
        name,
        description,
        price_brl: priceRounded,
        active,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id)
      .select('*')
      .single();
    if (error || !data) return res.status(500).json({ error: error?.message || 'Erro ao salvar.' });
    plan = data as ClubPlanRow;
  } else {
    const { data, error } = await supabase
      .from('club_plans')
      .insert({
        profile_id: gate.userId,
        name,
        description,
        price_brl: priceRounded,
        active,
      })
      .select('*')
      .single();
    if (error || !data) return res.status(500).json({ error: error?.message || 'Erro ao criar.' });
    plan = data as ClubPlanRow;
  }

  const ensured = await ensureClubStripeAssets({
    plan,
    connectAccountId: connectId,
    storeName: String(gate.profile.store_name || ''),
    slug,
  });

  if (!ensured.ok) {
    return res.status(500).json({ error: ensured.error });
  }

  res.json({
    plan: ensured.plan,
    client_portal_url: clubClientPortalUrl(slug),
    payment_link_url: ensured.plan.payment_link_url,
    wagoo_fee_percent: WAGOO_APPLICATION_FEE_PERCENT,
  });
});

/** Página pública do clube + horários da loja. */
router.get('/public/:slug', async (req: Request, res: Response) => {
  const slug = String(req.params.slug || '').trim();
  if (!slug) return res.status(400).json({ error: 'Slug inválido.' });

  const site = await loadPublishedSiteBySlug(slug);
  if (!site) return res.status(404).json({ error: 'Loja não encontrada ou não publicada.' });

  const { data: plan } = await supabase
    .from('club_plans')
    .select('id, name, description, price_brl, active, payment_link_url')
    .eq('profile_id', site.id)
    .eq('active', true)
    .maybeSingle();

  const connectReady =
    Boolean(site.stripe_connect_account_id) && Boolean(site.stripe_connect_charges_enabled);

  res.json({
    store: {
      name: site.store_name,
      slug: site.booking_slug,
      logo_url: site.booking_logo_url,
      cover_url: site.booking_cover_url,
      tagline: site.booking_tagline,
      phone: site.booking_phone,
      address: site.booking_address,
    },
    schedule: formatWorkingHoursPublic(site.working_hours),
    club: plan
      ? {
          id: plan.id,
          name: plan.name,
          description: plan.description,
          price_brl: Number(plan.price_brl),
          payment_link_url: plan.payment_link_url,
          available: connectReady,
        }
      : null,
    booking_url: `${(process.env.FRONTEND_URL || 'https://wagoobot.com').replace(/\/$/, '')}/a/${slug}`,
    wagoo_fee_percent: WAGOO_APPLICATION_FEE_PERCENT,
  });
});

/** Envia OTP no WhatsApp do salão. */
router.post('/public/:slug/otp/send', express.json(), async (req: Request, res: Response) => {
  const slug = String(req.params.slug || '').trim();
  const phone = digitsPhone(String(req.body?.phone ?? ''));
  const purposeRaw = String(req.body?.purpose || '').trim() as ClubOtpPurpose;

  if (!slug) return res.status(400).json({ error: 'Slug inválido.' });
  if (!OTP_PURPOSES.has(purposeRaw)) {
    return res.status(400).json({ error: 'Finalidade do código inválida.' });
  }
  if (phone.length < 10) {
    return res.status(400).json({ error: 'Informe um WhatsApp válido com DDD.' });
  }

  const site = await loadPublishedSiteBySlug(slug);
  if (!site) return res.status(404).json({ error: 'Loja não encontrada.' });

  let shouldSend = true;
  if (purposeRaw === 'member_access' || purposeRaw === 'club_benefit') {
    const active = await findActiveClubMemberByPhone(String(site.id), phone);
    if (purposeRaw === 'club_benefit') {
      shouldSend = Boolean(active);
    } else {
      // member_access: envia se existir qualquer registro (ativo ou não)
      const { data: anyMember } = await supabase
        .from('club_members')
        .select('id')
        .eq('profile_id', site.id)
        .in('client_phone', [phone, ...(phone.startsWith('55') ? [phone.slice(2)] : [`55${phone}`])])
        .limit(1)
        .maybeSingle();
      shouldSend = Boolean(anyMember || active);
    }
  }

  const result = await requestClubOtp({
    profileId: String(site.id),
    phone,
    purpose: purposeRaw,
    storeName: site.store_name ? String(site.store_name) : null,
    shouldSend,
  });

  if (!result.ok) return res.status(400).json({ error: result.error });

  // Resposta uniforme (anti-enumeração + UX)
  res.json({
    ok: true,
    message:
      purposeRaw === 'subscribe'
        ? 'Enviamos um código no WhatsApp informado. Digite-o abaixo.'
        : 'Se este WhatsApp for de um membro, enviamos um código. Digite-o abaixo.',
    cooldown_seconds: result.cooldown_seconds ?? null,
  });
});

/** Confirma OTP e devolve token de sessão (24h). */
router.post('/public/:slug/otp/verify', express.json(), async (req: Request, res: Response) => {
  const slug = String(req.params.slug || '').trim();
  const phone = digitsPhone(String(req.body?.phone ?? ''));
  const code = String(req.body?.code ?? '');
  const purposeRaw = String(req.body?.purpose || '').trim() as ClubOtpPurpose;

  if (!slug) return res.status(400).json({ error: 'Slug inválido.' });
  if (!OTP_PURPOSES.has(purposeRaw)) {
    return res.status(400).json({ error: 'Finalidade do código inválida.' });
  }

  const site = await loadPublishedSiteBySlug(slug);
  if (!site) return res.status(404).json({ error: 'Loja não encontrada.' });

  const verified = await verifyClubOtp({
    profileId: String(site.id),
    phone,
    purpose: purposeRaw,
    code,
  });

  if (!verified.ok) return res.status(400).json({ error: verified.error });

  res.json({
    club_token: verified.club_token,
    expires_at: verified.expires_at,
    phone,
  });
});

/** Consulta membro — exige OTP (token) no WhatsApp. */
router.get('/public/:slug/member', async (req: Request, res: Response) => {
  const slug = String(req.params.slug || '').trim();
  const phone = digitsPhone(String(req.query.phone || ''));
  if (!slug || !phone) {
    return res.status(400).json({ error: 'Informe o telefone.' });
  }

  const site = await loadPublishedSiteBySlug(slug);
  if (!site) return res.status(404).json({ error: 'Loja não encontrada.' });

  const token = extractClubToken({
    headers: req.headers as Record<string, unknown>,
    query: req.query as Record<string, unknown>,
  });
  const okSession = await validateClubAccessSession({
    profileId: String(site.id),
    phone,
    token,
    purposes: ['member_access', 'club_benefit', 'subscribe'],
  });

  if (!okSession) {
    return res.status(401).json({
      error: 'Confirme o WhatsApp com o código que enviamos.',
      needs_otp: true,
    });
  }

  const phoneList = [phone];
  if (phone.startsWith('55') && phone.length >= 12) phoneList.push(phone.slice(2));
  else if (phone.length === 10 || phone.length === 11) phoneList.push(`55${phone}`);

  const { data: member } = await supabase
    .from('club_members')
    .select(
      'id, client_name, client_phone, status, current_period_start, current_period_end',
    )
    .eq('profile_id', site.id)
    .in('client_phone', phoneList)
    .maybeSingle();

  if (!member) {
    return res.json({ member: null });
  }

  const end = member.current_period_end ? new Date(member.current_period_end) : null;
  const now = new Date();
  let days_left: number | null = null;
  if (end && !Number.isNaN(end.getTime())) {
    days_left = Math.max(0, Math.ceil((end.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
  }

  res.json({
    member: {
      ...member,
      days_left,
      is_active: member.status === 'active',
    },
  });
});

/** Cadastro + Checkout mensal (cartão) — exige OTP no WhatsApp. */
router.post('/public/:slug/subscribe', express.json(), async (req: Request, res: Response) => {
  const slug = String(req.params.slug || '').trim();
  const clientName = String(req.body?.name ?? req.body?.client_name ?? '').trim();
  const clientPhone = digitsPhone(String(req.body?.phone ?? req.body?.client_phone ?? ''));
  const clientEmail = String(req.body?.email ?? req.body?.client_email ?? '')
    .trim()
    .toLowerCase() || null;

  if (!slug) return res.status(400).json({ error: 'Slug inválido.' });
  if (!clientName || clientName.length < 2) {
    return res.status(400).json({ error: 'Informe seu nome.' });
  }
  if (clientPhone.length < 10) {
    return res.status(400).json({ error: 'Informe um WhatsApp válido com DDD.' });
  }

  const site = await loadPublishedSiteBySlug(slug);
  if (!site) return res.status(404).json({ error: 'Loja não encontrada.' });

  const token = extractClubToken({
    headers: req.headers as Record<string, unknown>,
    body: req.body as Record<string, unknown>,
  });
  const phoneVerified = await validateClubAccessSession({
    profileId: String(site.id),
    phone: clientPhone,
    token,
    purposes: ['subscribe'],
  });
  if (!phoneVerified) {
    return res.status(401).json({
      error: 'Confirme seu WhatsApp com o código enviado antes de assinar.',
      needs_otp: true,
    });
  }

  const connectId = site.stripe_connect_account_id as string | null;
  if (!connectId || !site.stripe_connect_charges_enabled) {
    return res.status(400).json({ error: 'Este salão ainda não aceita pagamento do clube.' });
  }

  const { data: plan } = await supabase
    .from('club_plans')
    .select('*')
    .eq('profile_id', site.id)
    .eq('active', true)
    .maybeSingle();

  if (!plan?.stripe_price_id) {
    return res.status(400).json({ error: 'Clube não está disponível nesta loja.' });
  }

  const phoneList = [clientPhone];
  if (clientPhone.startsWith('55') && clientPhone.length >= 12) {
    phoneList.push(clientPhone.slice(2));
  } else if (clientPhone.length === 10 || clientPhone.length === 11) {
    phoneList.push(`55${clientPhone}`);
  }

  const { data: existing } = await supabase
    .from('club_members')
    .select('id, status')
    .eq('profile_id', site.id)
    .in('client_phone', phoneList)
    .maybeSingle();

  if (existing?.status === 'active') {
    return res.status(400).json({
      error: 'Você já tem assinatura ativa neste salão. Consulte pelo WhatsApp abaixo.',
      already_active: true,
    });
  }

  let memberId = existing?.id;
  if (memberId) {
    await supabase
      .from('club_members')
      .update({
        client_name: clientName,
        client_phone: clientPhone,
        client_email: clientEmail,
        status: 'pending',
        club_plan_id: plan.id,
        updated_at: new Date().toISOString(),
      })
      .eq('id', memberId);
  } else {
    const { data: created, error } = await supabase
      .from('club_members')
      .insert({
        profile_id: site.id,
        club_plan_id: plan.id,
        client_name: clientName,
        client_phone: clientPhone,
        client_email: clientEmail,
        status: 'pending',
      })
      .select('id')
      .single();
    if (error || !created) {
      return res.status(500).json({ error: error?.message || 'Não foi possível cadastrar.' });
    }
    memberId = created.id;
  }

  const checkout = await createClubCheckoutSession({
    plan: plan as ClubPlanRow,
    connectAccountId: connectId,
    slug,
    clientName,
    clientPhone,
    clientEmail,
    memberId: String(memberId),
  });

  if (!checkout.ok) return res.status(500).json({ error: checkout.error });
  res.json({ checkout_url: checkout.url, member_id: memberId });
});

export default router;
