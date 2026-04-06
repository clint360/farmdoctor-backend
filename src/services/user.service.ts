import { supabase } from './db/supabase.service';
import { logger } from '../utils/logger';

export interface TelegramUser {
  id?: string; // Supabase generated UUID
  chat_id: number;
  language: string | null;
  location: string | null;
  has_onboarded: boolean;
  onboarding_step: number;
  created_at?: string;
}

/**
 * Fetches user from DB. If not found, creates a new one.
 */
export const getUser = async (chat_id: number): Promise<TelegramUser> => {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('chat_id', chat_id)
      .single();

    if (error && error.code !== 'PGRST116') { // PGRST116 is 'not found'
      throw error;
    }

    if (data) {
      return data as TelegramUser;
    }

    // Create new user
    const newUser: TelegramUser = {
      chat_id,
      language: null,
      location: null,
      has_onboarded: false,
      onboarding_step: 0,
    };

    const { data: insertedData, error: insertError } = await supabase
      .from('users')
      .insert(newUser)
      .select()
      .single();

    if (insertError) throw insertError;
    return insertedData as TelegramUser;
  } catch (error) {
    logger.error(error, `Error fetching/creating user ${chat_id}`);
    return { chat_id, language: null, location: null, has_onboarded: false, onboarding_step: 0 };
  }
};

/**
 * Updates a user record in the DB.
 */
export const updateUser = async (chat_id: number, updates: Partial<TelegramUser>): Promise<void> => {
  try {
    const { error } = await supabase
      .from('users')
      .update(updates)
      .eq('chat_id', chat_id);

    if (error) throw error;
  } catch (error) {
    logger.error(error, `Error updating user ${chat_id}`);
  }
};
