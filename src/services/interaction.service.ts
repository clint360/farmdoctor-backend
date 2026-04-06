import { supabase } from './db/supabase.service';
import { logger } from '../utils/logger';

export interface InteractionLog {
  user_id: string; // Foreign key linking to users.id
  type: 'image' | 'text' | 'voice';
  crop: string;
  issue: string;
}

/**
 * Logs a farmer communication event structurally inside Supabase
 */
export const logInteraction = async (payload: InteractionLog): Promise<void> => {
  try {
    const { error } = await supabase.from('interactions').insert(payload);
    if (error) {
      throw error;
    }
  } catch (error) {
    logger.error(error, `Error logging interaction for user ${payload.user_id}`);
  }
};
