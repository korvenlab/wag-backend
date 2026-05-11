import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { cleanEnvString } from './supabaseEnv';

dotenv.config();

const supabaseUrl = cleanEnvString(process.env.SUPABASE_URL);
const supabaseKey = cleanEnvString(process.env.SUPABASE_SERVICE_ROLE_KEY);

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Faltam variáveis de ambiente do Supabase (URL ou SERVICE_ROLE_KEY).');
}

export const supabase = createClient(supabaseUrl, supabaseKey);