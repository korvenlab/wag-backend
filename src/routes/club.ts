import express, { Router, Request, Response } from 'express';
import { supabase } from '../lib/supabase';
import { getUserFromBearerHeader } from '../lib/supabaseAuthUser';
import { profileHasWagooAccess } from '../lib/profileAccess';
import { profileSubscriptionTier } from '../lib/profileMultiBarber';
import {
  tierSupportsClub,
  tierSupportsPublicBooking,
} from '../lib/wagooSubscription';
import {
  clubClientPortalUrl,
  clubPaymentsReady,
  createClubAsaasCheckout,
  digitsPhone,
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
import {
  debitClubLedgerForPayout,
  getClubLedgerBalance,
} from '../lib/clubLedger';
import { asaasTransferPix } from '../lib/asaasClient';
import { log } from '../lib/logger';

type PixKeyType = 'CPF' | 'CNPJ' | 'EMAIL' | 'PHONE' | 'EVP';

function detectPixKeyType(raw: string): PixKeyType | null {
  const key = String(raw || '').trim();
  if (!key) return null;
  if (key.includes('@')) return 'EMAIL';
  const digits = key.replace(/\D/g, '');
  if (digits.length === 11 && /^\d+$/.test(digits)) return 'CPF';
  if (digits.length === 14 && /^\d+$/.test(digits)) return 'CNPJ';
  if (digits.length === 10 || digits.length === 11) {
    // telefone sem @ — se só dígitos e 10/11, PHONE (CPF também 11: preferir CPF se validar)
    // Heurística: 11 dígitos começando com DDD celular → ainda pode ser CPF. Usuário escolhe no painel.
  }
  // Chave aleatória EVP (UUID-like)
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)) {
    return 'EVP';
  }
  if (digits.length >= 10 && digits.length <= 13) return 'PHONE';
  return 'EVP';
}

function normalizePixKey(key: string, type: PixKeyType): string {
  const raw = key.trim();
  if (type === 'EMAIL') return raw.toLowerCase();
  if (type === 'CPF' || type === 'CNPJ' || type === 'PHONE') return raw.replace(/\D/g, '');
  return raw;
}

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
      'id, store_name, booking_slug, booking_published, has_paid, complimentary_access_until, subscription_tier, multi_barber_plan, club_payout_pix_key, club_payout_pix_key_type',
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

  const tier = profileSubscriptionTier(profile);
  if (!tierSupportsClub(tier)) {
    return {
      ok: false as const,
      status: 403,
      error: 'Assinatura Wagoo necessária para usar o Clube.',
    };
  }

  return { ok: true as const, userId: auth.user.id, profile };
}

async function loadPublishedSiteBySlug(slug: string) {
  const { data } = await supabase
    .from('profiles')
    .select(
      'id, store_name, booking_slug, booking_logo_url, booking_cover_url, booking_tagline, booking_phone, booking_address, booking_published, working_hours, subscription_tier, multi_barber_plan, has_paid',
    )
    .eq('booking_slug', slug)
    .maybeSingle();

  if (!data || !data.booking_published) return null;
  const tier = profileSubscriptionTier(data);
  if (!tierSupportsPublicBooking(tier)) return null;
  // Portal do clube: qualquer plano pago com Agenda Web publicada.
  if (!tierSupportsClub(tier)) return null;
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
  const ready = clubPaymentsReady();
  const balance = await getClubLedgerBalance(gate.userId);

  res.json({
    plan: plan ?? null,
    members: members ?? [],
    client_portal_url: slug ? clubClientPortalUrl(slug) : null,
    payment_link_url: slug ? clubClientPortalUrl(slug) : plan?.payment_link_url ?? null,
    connect_ready: ready, // legado UI: agora = Asaas configurado
    payments_ready: ready,
    provider: 'asaas',
    wagoo_fee_percent: WAGOO_APPLICATION_FEE_PERCENT,
    ledger_balance_brl: balance,
    payout_pix_key: gate.profile.club_payout_pix_key ?? null,
    payout_pix_key_type: gate.profile.club_payout_pix_key_type ?? null,
  });
});

/** Cria/atualiza plano do clube (cobrança Asaas — sem Stripe Connect). */
router.put('/me', express.json(), async (req: Request, res: Response) => {
  const gate = await requireOwner(req);
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

  if (!clubPaymentsReady()) {
    return res.status(503).json({
      error: 'Pagamentos do clube em configuração. Tente novamente em breve.',
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
  const portal = clubClientPortalUrl(slug);

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
        payment_link_url: portal,
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
        payment_link_url: portal,
      })
      .select('*')
      .single();
    if (error || !data) return res.status(500).json({ error: error?.message || 'Erro ao criar.' });
    plan = data as ClubPlanRow;
  }

  res.json({
    plan,
    client_portal_url: portal,
    payment_link_url: portal,
    payments_ready: true,
    provider: 'asaas',
    wagoo_fee_percent: WAGOO_APPLICATION_FEE_PERCENT,
  });
});

/** Salva chave PIX para saque automático do saldo do clube. */
router.put('/me/payout-pix', express.json(), async (req: Request, res: Response) => {
  const gate = await requireOwner(req);
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

  const rawKey = String(req.body?.pix_key ?? req.body?.club_payout_pix_key ?? '').trim();
  const typeRaw = String(req.body?.pix_key_type ?? req.body?.club_payout_pix_key_type ?? '')
    .trim()
    .toUpperCase();

  if (!rawKey) {
    await supabase
      .from('profiles')
      .update({
        club_payout_pix_key: null,
        club_payout_pix_key_type: null,
      })
      .eq('id', gate.userId);
    return res.json({ ok: true, payout_pix_key: null, payout_pix_key_type: null });
  }

  const allowed: PixKeyType[] = ['CPF', 'CNPJ', 'EMAIL', 'PHONE', 'EVP'];
  let type = (allowed.includes(typeRaw as PixKeyType) ? typeRaw : detectPixKeyType(rawKey)) as
    | PixKeyType
    | null;
  if (!type) {
    return res.status(400).json({ error: 'Tipo de chave PIX inválido.' });
  }

  const normalized = normalizePixKey(rawKey, type);
  await supabase
    .from('profiles')
    .update({
      club_payout_pix_key: normalized,
      club_payout_pix_key_type: type,
    })
    .eq('id', gate.userId);

  res.json({ ok: true, payout_pix_key: normalized, payout_pix_key_type: type });
});

/** Saque automático do saldo do clube via PIX (Asaas). */
router.post('/me/payout', express.json(), async (req: Request, res: Response) => {
  const gate = await requireOwner(req);
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

  if (!clubPaymentsReady()) {
    return res.status(503).json({ error: 'Saques temporariamente indisponíveis.' });
  }

  const pixKey = String(gate.profile.club_payout_pix_key || '').trim();
  const pixType = String(gate.profile.club_payout_pix_key_type || '').trim().toUpperCase() as PixKeyType;
  if (!pixKey || !pixType) {
    return res.status(400).json({
      error: 'Cadastre sua chave PIX em Clube antes de sacar.',
    });
  }

  const balance = await getClubLedgerBalance(gate.userId);
  const requested = Number(req.body?.amount_brl);
  const amount =
    Number.isFinite(requested) && requested > 0
      ? Math.round(requested * 100) / 100
      : balance;

  if (amount < 1) {
    return res.status(400).json({ error: 'Saldo insuficiente para saque (mín. R$ 1,00).' });
  }
  if (amount > balance + 0.001) {
    return res.status(400).json({
      error: `Saldo disponível: R$ ${balance.toFixed(2).replace('.', ',')}.`,
      ledger_balance_brl: balance,
    });
  }

  const transfer = await asaasTransferPix({
    value: amount,
    pixAddressKey: pixKey,
    pixAddressKeyType: pixType,
    description: `Repasse clube Wagoo`,
  });

  if (!transfer.ok) {
    return res.status(502).json({ error: transfer.error });
  }

  const debited = await debitClubLedgerForPayout({
    profileId: gate.userId,
    amountBrl: amount,
    asaasTransferId: transfer.data.id,
    description: 'Saque PIX clube',
  });

  if (!debited.ok) {
    log.error('CLUB', 'transfer ok mas ledger debit falhou', null, {
      transferId: transfer.data.id,
      profileId: gate.userId,
    });
    return res.status(500).json({
      error: 'Transferência enviada, mas falhou o registro interno. Contate o suporte.',
      transfer_id: transfer.data.id,
    });
  }

  const newBalance = await getClubLedgerBalance(gate.userId);
  res.json({
    ok: true,
    amount_brl: amount,
    transfer_id: transfer.data.id,
    transfer_status: transfer.data.status ?? null,
    ledger_balance_brl: newBalance,
    message: `Saque de R$ ${amount.toFixed(2).replace('.', ',')} enviado para sua chave PIX.`,
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

  const paymentsReady = clubPaymentsReady();

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
          payment_link_url: plan.payment_link_url || clubClientPortalUrl(slug),
          available: paymentsReady,
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

/** Cadastro + Checkout mensal Asaas — exige OTP no WhatsApp. */
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

  if (!clubPaymentsReady()) {
    return res.status(400).json({ error: 'Este salão ainda não aceita pagamento do clube.' });
  }

  const { data: plan } = await supabase
    .from('club_plans')
    .select('*')
    .eq('profile_id', site.id)
    .eq('active', true)
    .maybeSingle();

  if (!plan || Number(plan.price_brl) < 1) {
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

  const checkout = await createClubAsaasCheckout({
    plan: plan as ClubPlanRow,
    slug,
    storeName: String(site.store_name || ''),
    clientName,
    clientPhone,
    clientEmail,
    memberId: String(memberId),
  });

  if (!checkout.ok) return res.status(500).json({ error: checkout.error });
  res.json({ checkout_url: checkout.url, member_id: memberId, provider: 'asaas' });
});

export default router;
