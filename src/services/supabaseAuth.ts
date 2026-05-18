import { 
    initAuthCreds, 
    BufferJSON, 
    SignalDataTypeMap 
} from '@whiskeysockets/baileys';
import { supabase } from '../lib/supabase';

export const useSupabaseAuthState = async (clientId: string) => {
    
    // 1. Tenta carregar as credenciais principais
    const { data: credsRow, error: credsError } = await supabase
        .from('whatsapp_creds')
        .select('creds_data')
        .eq('client_id', clientId)
        .single();

    let creds: any;

    if (credsRow && credsRow.creds_data) {
        creds = JSON.parse(JSON.stringify(credsRow.creds_data), BufferJSON.reviver);
    } else {
        creds = initAuthCreds();
    }

    // 2. Função para salvar credenciais principais
    const saveCreds = async () => {
        const json = JSON.parse(JSON.stringify(creds, BufferJSON.replacer));
        const { error } = await supabase
            .from('whatsapp_creds')
            .upsert({ client_id: clientId, creds_data: json });
            
        if (error) console.error(`[SupabaseAuth] Erro ao salvar creds para ${clientId}:`, error);
    };

    return {
        state: {
            creds,
            keys: {
                // Função para ler chaves do banco de dados
                get: async (type: keyof SignalDataTypeMap, ids: string[]) => {
                    const data: any = {};
                    await Promise.all(ids.map(async (id) => {
                        const keyId = `${type}-${id}`;
                        const { data: row } = await supabase
                            .from('whatsapp_keys')
                            .select('key_data')
                            .eq('client_id', clientId)
                            .eq('key_id', keyId)
                            .single();
                            
                        if (row && row.key_data) {
                            data[id] = JSON.parse(JSON.stringify(row.key_data), BufferJSON.reviver);
                        }
                    }));
                    return data;
                },
                // Função para salvar chaves no banco de dados (Batch Upsert)
                set: async (data: any) => {
                    const upserts = [];
                    const deletes = [];

                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const keyId = `${category}-${id}`;
                            
                            if (value) {
                                const jsonValue = JSON.parse(JSON.stringify(value, BufferJSON.replacer));
                                upserts.push({ client_id: clientId, key_id: keyId, key_data: jsonValue });
                            } else {
                                deletes.push(keyId);
                            }
                        }
                    }

                    // Executa inserções
                    if (upserts.length > 0) {
                        await supabase.from('whatsapp_keys').upsert(upserts);
                    }
                    
                    // Executa deleções
                    if (deletes.length > 0) {
                        await supabase.from('whatsapp_keys')
                            .delete()
                            .eq('client_id', clientId)
                            .in('key_id', deletes);
                    }
                }
            }
        },
        saveCreds
    };
};

export const clearAuthState = async (clientId: string) => {
    try {
        // Apaga as chaves. O ON DELETE CASCADE na tabela resolveria sozinho se
        // apagássemos o client, mas como queremos manter o client, apagamos as chaves manualmente.
        await supabase.from('whatsapp_creds').delete().eq('client_id', clientId);
        await supabase.from('whatsapp_keys').delete().eq('client_id', clientId);
        console.log(`[SupabaseAuth] 🧹 Chaves de criptografia do WhatsApp de ${clientId} limpas com sucesso.`);
    } catch (error) {
        console.error(`[SupabaseAuth] ❌ Erro ao limpar chaves do WhatsApp de ${clientId}:`, error);
        throw error;
    }
};