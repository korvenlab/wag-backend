import express from 'express';
import { Server } from 'socket.io';
import http from 'http';
import cors from 'cors';
import makeWASocket, { 
    DisconnectReason, 
    makeCacheableSignalKeyStore,
    fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import PINO from 'pino';
import dotenv from 'dotenv';
import { google } from 'googleapis';
import { format, parseISO } from 'date-fns';
import Stripe from 'stripe';

// Configurações e Serviços
import { supabase } from './lib/supabase';
import { analyzeMessage } from './services/ai';
import { useSupabaseAuthState, clearAuthState } from './services/supabaseAuth'; 
import { checkAvailability, createEvent } from './services/calendar';

dotenv.config();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2023-10-16' });

// =================================================================================
// LÓGICA DE TENTATIVA (Retry Logic)
// =================================================================================
const withRetry = async <T>(operation: () => Promise<T>, maxRetries = 3, delayMs = 2000): Promise<T> => {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try { return await operation(); } 
        catch (error) {
            if (attempt === maxRetries) throw error; 
            await new Promise(res => setTimeout(res, delayMs)); 
        }
    }
    throw new Error("Falha após todas as tentativas.");
};

// =================================================================================
// CONFIGURAÇÃO SERVER E SOCKET
// =================================================================================
const app = express();
app.use(cors()); 

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const sessions = new Map<string, any>();

// =================================================================================
// 💰 STRIPE WEBHOOK (DEVE ESTAR ANTES DO EXPRESS.JSON)
// =================================================================================
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'] as string;
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET!);
    } catch (err: any) {
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object as Stripe.Checkout.Session;
        const clientId = session.client_reference_id;

        if (clientId) {
            console.log(`💰 Pagamento confirmado para: ${clientId}`);
            await supabase.from('clients').update({ 
                isSubscribed: true,
                stripeSubscriptionId: session.subscription 
            }).eq('id', clientId);
        }
    }
    res.json({ received: true });
});

app.use(express.json());

// =================================================================================
// 🧠 CACHE EM MEMÓRIA & HISTÓRICO MULTI-TENANT
// =================================================================================
const clientSettingsCache = new Map<string, { isAiEnabled: boolean, operatingHours: { start: string, end: string }, isSubscribed: boolean }>();
const msgHistory = new Map<string, string[]>();

const addToHistory = (clientId: string, phone: string, text: string) => {
    const uniqueKey = `${clientId}_${phone}`;
    if (!msgHistory.has(uniqueKey)) msgHistory.set(uniqueKey, []);
    
    const history = msgHistory.get(uniqueKey)!;
    history.push(text);
    if (history.length > 6) history.shift();
};

const getHistoryString = (clientId: string, phone: string) => {
    const uniqueKey = `${clientId}_${phone}`;
    return (msgHistory.get(uniqueKey) || []).join('\n');
};

// =================================================================================
// ROTAS GOOGLE OAUTH2 & STRIPE CHECKOUT
// =================================================================================
const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URL 
);

app.get('/auth/google', (req, res) => {
    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: ['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/userinfo.profile'],
        prompt: 'consent' 
    });
    res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
    const { code } = req.query;
    if (!code) return res.status(400).send("Erro: Nenhum código recebido.");

    try {
        const { tokens } = await oauth2Client.getToken(code as string);
        oauth2Client.setCredentials(tokens);

        const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
        const userInfo = await oauth2.userinfo.get();
        const userEmail = userInfo.data.email;
        const userName = userInfo.data.name;
        const userPicture = userInfo.data.picture;

        const authData = { accessToken: tokens.access_token, expiryDate: tokens.expiry_date, refreshToken: tokens.refresh_token || null };

        // Usa o Upsert do Supabase
        await supabase.from('clients').upsert({
            id: userEmail,
            email: userEmail,
            name: userName,
            photo: userPicture,
            googleAuth: authData,
            status: 'google_connected_waiting_whatsapp',
            updated_at: new Date().toISOString()
        });

        res.redirect(`${process.env.FRONTEND_URL}/?clientId=${userEmail}&status=success`);
    } catch (error) {
        res.status(500).send("Erro ao processar login.");
    }
});

app.post('/api/stripe/create-checkout', async (req, res) => {
    const { clientId } = req.body;
    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            mode: 'subscription',
            line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
            success_url: `${process.env.FRONTEND_URL}/?clientId=${clientId}&payment=success`,
            cancel_url: `${process.env.FRONTEND_URL}/?clientId=${clientId}`,
            client_reference_id: clientId, 
        });
        res.json({ url: session.url });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// =================================================================================
// WHATSAPP ENGINE (BAILEYS)
// =================================================================================
const startWhatsAppSession = async (clientId: string) => {
    if (sessions.has(clientId)) return;
    let isConnected = false;

    try {
        console.log(`[${clientId}] Iniciando WhatsApp...`);
        
        const { data: clientData, error: clientError } = await supabase
            .from('clients')
            .select('*')
            .eq('id', clientId)
            .single();
            
        if (clientError || !clientData) throw new Error("Cliente não encontrado.");
        
        // Bloqueio de Segurança
        if (!clientData.isSubscribed) {
            console.log(`⛔ [${clientId}] Sem assinatura ativa.`);
            io.to(clientId).emit('status', 'payment_required');
            return; 
        }
        
        clientSettingsCache.set(clientId, {
            isAiEnabled: clientData.isAiEnabled !== false,
            operatingHours: clientData.operatingHours || { start: '08:00', end: '18:00' },
            isSubscribed: true
        });
        
        const { state, saveCreds } = await useSupabaseAuthState(clientId);
        const { version } = await fetchLatestBaileysVersion();
        const logger = PINO({ level: 'silent' });

        const sock = makeWASocket({
            version, logger,
            auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
            printQRInTerminal: false,
            connectTimeoutMs: 60000,
            retryRequestDelayMs: 3000, 
            keepAliveIntervalMs: 15000, 
            browser: ["Mac OS", "Chrome", "121.0.0"], 
            markOnlineOnConnect: false, 
            generateHighQualityLinkPreview: true, 
            syncFullHistory: false,
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                io.to(clientId).emit('qr', qr);
                await supabase.from('clients').update({ status: 'waiting_qr' }).eq('id', clientId);
            }

            if (connection === 'close') {
                const error = lastDisconnect?.error as any;
                const statusCode = error?.output?.statusCode;
                
                const isFatalError = statusCode === DisconnectReason.loggedOut || statusCode === 401 || statusCode === 403 || statusCode === 405;

                sessions.delete(clientId);
                clientSettingsCache.delete(clientId);

                if (isFatalError) {
                    await clearAuthState(clientId);
                    await supabase.from('clients').update({ status: 'disconnected' }).eq('id', clientId);
                    io.to(clientId).emit('status', 'disconnected');
                } else if (!isConnected && statusCode === DisconnectReason.timedOut) {
                    await supabase.from('clients').update({ status: 'timeout' }).eq('id', clientId);
                    io.to(clientId).emit('status', 'timeout');
                } else {
                    setTimeout(() => startWhatsAppSession(clientId), 3000);
                }
            } 
            
            if (connection === 'open') {
                isConnected = true;
                io.to(clientId).emit('status', 'connected');
                await supabase.from('clients').update({ status: 'active' }).eq('id', clientId);
            }
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('messages.upsert', async ({ messages }) => {
            const msg = messages[0];
            if (!msg.message || msg.key.fromMe) return;

            const userPhone = msg.key.remoteJid!;
            if (userPhone.endsWith('@g.us') || userPhone === 'status@broadcast') return;

            const clientName = msg.pushName || "Cliente";
            const messageBody = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();
            if (!messageBody) return;

            const settings = clientSettingsCache.get(clientId);
            if (!settings || !settings.isAiEnabled || !settings.isSubscribed) return; 

            addToHistory(clientId, userPhone, `Cliente: ${messageBody}`);
            const historyContext = getHistoryString(clientId, userPhone);

            try {
                const aiResult = await withRetry(() => analyzeMessage(historyContext, messageBody, settings.isAiEnabled, settings.operatingHours), 3, 2000);

                if (aiResult?.isScheduling && aiResult.date) {
                    addToHistory(clientId, userPhone, `Bot: Verificando disponibilidade...`);
                    await sock.sendMessage(userPhone, { text: "⏳ Confirmando disponibilidade..." });
                    
                    const isFree = await withRetry(() => checkAvailability(clientId, aiResult.date), 3, 2000);

                    if (isFree) {
                        const sucesso = await withRetry(() => createEvent(clientId, clientName, userPhone, aiResult.date), 3, 2000);
                        if (sucesso) {
                            const dataFormatada = format(parseISO(aiResult.date), "dd/MM 'às' HH:mm");
                            await sock.sendMessage(userPhone, { text: `✅ Agendado para ${dataFormatada}.` });
                            msgHistory.delete(`${clientId}_${userPhone}`); 
                        } else {
                            await sock.sendMessage(userPhone, { text: "⚠️ Tive um erro técnico ao guardar no calendário. Tente novamente." });
                        }
                    } else {
                        await sock.sendMessage(userPhone, { text: "❌ Esse horário já está ocupado. Tente outro." });
                        addToHistory(clientId, userPhone, `Bot: Horário ocupado.`);
                    }
                } 
                else if (aiResult?.response) {
                    await sock.sendMessage(userPhone, { text: aiResult.response });
                    addToHistory(clientId, userPhone, `Bot: ${aiResult.response}`);
                }
            } catch (error) {
                await sock.sendMessage(userPhone, { text: "⚠️ Meus sistemas estão instáveis no momento. Tente novamente em breve." });
            }
        });

        sessions.set(clientId, sock);
    } catch (err) {
        console.error(`Erro sessão ${clientId}:`, err);
    }
};

// =================================================================================
// ROTAS DE SESSÃO E CONFIGURAÇÃO
// =================================================================================
app.post('/session/start', async (req, res) => {
    const { clientId, force } = req.body;
    if (!clientId) return res.status(400).json({ error: "ID necessário" });

    if (force) {
        if (sessions.has(clientId)) {
            sessions.get(clientId).ws?.close();
            sessions.delete(clientId);
            clientSettingsCache.delete(clientId);
        }
    }
    startWhatsAppSession(clientId);
    res.json({ status: 'A iniciar...' });
});

app.post('/session/whatsapp/logout', async (req, res) => {
    const { clientId } = req.body;
    try {
        if (sessions.has(clientId)) {
            sessions.get(clientId).ws?.close();
            sessions.delete(clientId);
            clientSettingsCache.delete(clientId);
        }
        await clearAuthState(clientId);
        await supabase.from('clients').update({ status: 'waiting_qr' }).eq('id', clientId);
        setTimeout(() => startWhatsAppSession(clientId), 2000);
        res.json({ message: "WhatsApp desconectado." });
    } catch (error) { res.status(500).json({ error: "Erro logout WhatsApp" }); }
});

app.post('/session/logout', async (req, res) => {
    const { clientId } = req.body;
    try {
        if (sessions.has(clientId)) {
            sessions.get(clientId).ws?.close();
            sessions.delete(clientId);
            clientSettingsCache.delete(clientId);
        }
        await clearAuthState(clientId);
        
        // Define o googleAuth como nulo para "deslogar" do google
        await supabase.from('clients').update({ googleAuth: null, status: 'disconnected' }).eq('id', clientId);
        res.json({ message: "Logout completo" });
    } catch (error) { res.status(500).json({ error: "Erro logout" }); }
});

app.post('/api/settings/ai-status', async (req, res) => {
    const { clientId, isAiEnabled } = req.body;
    try {
        await supabase.from('clients').update({ isAiEnabled }).eq('id', clientId);
        const currentSettings = clientSettingsCache.get(clientId);
        if (currentSettings) { currentSettings.isAiEnabled = isAiEnabled; }
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: "Erro" }); }
});

app.post('/session/hours', async (req, res) => {
    const { clientId, startTime, endTime } = req.body;
    try {
        const newHours = { start: startTime, end: endTime };
        await supabase.from('clients').update({ operatingHours: newHours }).eq('id', clientId);
        const currentSettings = clientSettingsCache.get(clientId);
        if (currentSettings) { currentSettings.operatingHours = newHours; }
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: "Erro" }); }
});

io.on('connection', (socket) => { socket.on('join', (clientId) => socket.join(clientId)); });
app.get('/health', (req, res) => res.send('Backend Online 🤖'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor a rodar na porta ${PORT}`));

// =================================================================================
// PROTEÇÃO CONTRA QUEDAS (GRACEFUL SHUTDOWN)
// =================================================================================
const gracefulShutdown = async (signal: string) => {
    console.log(`\n🛑 Sinal ${signal} recebido. Desligamento suave...`);
    for (const [clientId, sock] of sessions.entries()) {
        try { sock.ws?.close(); } catch (e) {}
    }
    setTimeout(() => process.exit(0), 2000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));