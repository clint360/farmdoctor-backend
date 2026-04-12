import { supabase } from './db/supabase.service';
import { logger } from '../utils/logger';

// ─── Products ─────────────────────────────────────────────────────────────────

export async function getProducts(category?: string) {
  let query = supabase
    .from('products')
    .select('id, name, description, image_url, category, price, unit, in_stock, created_at')
    .eq('in_stock', true)
    .order('created_at', { ascending: false });

  if (category && category !== 'all') {
    query = query.eq('category', category);
  }

  const { data, error } = await query;
  if (error) {
    logger.error(error, '[chemist] getProducts error');
    throw new Error('Failed to fetch products');
  }
  return data ?? [];
}

export async function getProductById(id: string) {
  const { data, error } = await supabase
    .from('products')
    .select('id, name, description, image_url, category, price, unit, in_stock, created_at')
    .eq('id', id)
    .single();

  if (error) {
    logger.error(error, '[chemist] getProductById error');
    return null;
  }
  return data;
}

// ─── Orders ───────────────────────────────────────────────────────────────────

export interface CreateOrderPayload {
  product_id?: string;
  product_name: string;
  farmer_name: string;
  phone: string;
  location: string;
  reason: string;
}

export async function createOrder(payload: CreateOrderPayload) {
  const { data, error } = await supabase
    .from('chemist_orders')
    .insert([
      {
        product_id:   payload.product_id ?? null,
        product_name: payload.product_name.trim(),
        farmer_name:  payload.farmer_name.trim(),
        phone:        payload.phone.trim(),
        location:     payload.location.trim(),
        reason:       payload.reason.trim(),
      },
    ])
    .select()
    .single();

  if (error) {
    logger.error(error, '[chemist] createOrder error');
    throw new Error('Failed to create order');
  }
  return data;
}
