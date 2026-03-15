import { google } from 'googleapis';
import dotenv from 'dotenv';

dotenv.config();

const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URL
);

// Adicionamos 'userinfo.email' e 'userinfo.profile' para saber quem é a pessoa
export const generateAuthUrl = () => {
    return oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: [
            'https://www.googleapis.com/auth/calendar',
            'https://www.googleapis.com/auth/userinfo.email',
            'https://www.googleapis.com/auth/userinfo.profile'
        ]
    });
};

export const getTokensFromCode = async (code: string) => {
    const { tokens } = await oauth2Client.getToken(code);
    return tokens;
};

// NOVA FUNÇÃO: Descobre quem é o dono do token
export const getUserInfo = async (tokens: any) => {
    const auth = new google.auth.OAuth2();
    auth.setCredentials(tokens);
    
    const oauth2 = google.oauth2({ version: 'v2', auth });
    const userInfo = await oauth2.userinfo.get();
    
    return userInfo.data; // Retorna email, nome, foto, etc.
};