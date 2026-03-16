import { google } from 'googleapis';
import dotenv from 'dotenv';

dotenv.config();

const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URL
);

/**
 * Gera a URL de autenticação.
 * Adicionei 'prompt: consent' para garantir que o Refresh Token seja enviado.
 */
export const generateAuthUrl = (state?: string) => {
    return oauth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent', // ESSENCIAL: Garante o recebimento do refresh_token
        state: state,     // Útil para passar o ID do perfil/usuário e recuperar no callback
        scope: [
            'https://www.googleapis.com/auth/calendar',
            'https://www.googleapis.com/auth/userinfo.email',
            'https://www.googleapis.com/auth/userinfo.profile'
        ]
    });
};

/**
 * Troca o código de autorização pelos tokens (Access, Refresh, Expiry)
 */
export const getTokensFromCode = async (code: string) => {
    const { tokens } = await oauth2Client.getToken(code);
    return tokens;
};

/**
 * Busca as informações do usuário (Email, Nome, etc)
 */
export const getUserInfo = async (tokens: any) => {
    // É importante passar as credenciais do cliente aqui também
    const auth = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URL
    );
    auth.setCredentials(tokens);
    
    const oauth2 = google.oauth2({ version: 'v2', auth });
    const userInfo = await oauth2.userinfo.get();
    
    return userInfo.data; 
};
