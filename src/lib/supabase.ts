import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY; // USE A CHAVE SERVICE_ROLE AQUI!

if (!supabaseUrl || !supabaseKey) {
    throw new Error('Faltam variáveis de ambiente do Supabase (URL ou SERVICE_ROLE_KEY).');
}

export const supabase = createClient(supabaseUrl, supabaseKey);