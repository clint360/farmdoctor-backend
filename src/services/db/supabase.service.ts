import { createClient } from '@supabase/supabase-js';
import { logger } from '../../utils/logger';

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_KEY || '';

if (!supabaseUrl || !supabaseKey) {
  logger.warn('Supabase URL or Key is missing from environment variables');
}

export const supabase = createClient(supabaseUrl, supabaseKey);
