import { google } from 'googleapis';
import dotenv from 'dotenv';

dotenv.config();

// Cliente único reutilizável
const createOAuthClient = () => {
    return new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URL
    );
};

const oauth2Client = createOAuthClient();

/**
 * Gera a URL de autenticação.
 */
export const generateAuthUrl = (state?: string) => {
    return oauth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent', // Garante que o refresh_token venha sempre
        state: state,
        scope: [
            'https://www.googleapis.com/auth/calendar',
            'https://www.googleapis.com/auth/userinfo.email',
            'https://www.googleapis.com/auth/userinfo.profile'
        ]
    });
};

/**
 * Troca o código de autorização pelos tokens
 */
export const getTokensFromCode = async (code: string) => {
    const { tokens } = await oauth2Client.getToken(code);
    return tokens;
};

/**
 * NOVO: Renova o Access Token automaticamente usando o Refresh Token
 * Essencial para manter a IA conectada 24/7
 */
export const refreshAccessToken = async (refreshToken: string) => {
    try {
        const auth = createOAuthClient();
        auth.setCredentials({ refresh_token: refreshToken });
        
        const { credentials } = await auth.refreshAccessToken();
        return credentials; // Retorna novos tokens (novo access e nova validade)
    } catch (error: any) {
        console.error("❌ Erro ao renovar token do Google:", error.message);
        throw error;
    }
};

/**
 * Busca as informações do usuário
 */
export const getUserInfo = async (tokens: any) => {
    const auth = createOAuthClient();
    auth.setCredentials(tokens);
    
    const oauth2 = google.oauth2({ version: 'v2', auth });
    const userInfo = await oauth2.userinfo.get();
    
    return userInfo.data; 
};

/**
 * NOVO: Cria uma instância autenticada do Calendar pronta para uso
 */
export const getCalendarClient = (accessToken: string, refreshToken: string) => {
    const auth = createOAuthClient();
    auth.setCredentials({
        access_token: accessToken,
        refresh_token: refreshToken
    });
    return google.calendar({ version: 'v3', auth });
};
