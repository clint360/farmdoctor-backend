import { FastifyRequest, FastifyReply } from 'fastify';
import { getProducts, getProductById, createOrder } from '../services/chemist.service';
import { logger } from '../utils/logger';

// ─── GET /api/chemist/products ────────────────────────────────────────────────
export const handleGetProducts = async (
  request: FastifyRequest,
  reply: FastifyReply
) => {
  const query = request.query as { category?: string };
  try {
    const products = await getProducts(query.category?.trim());
    return reply.status(200).send({ success: true, data: products });
  } catch (error) {
    logger.error(error, '[chemist] handleGetProducts error');
    return reply.status(500).send({ success: false, message: 'Failed to fetch products' });
  }
};

// ─── GET /api/chemist/products/:id ───────────────────────────────────────────
export const handleGetProductById = async (
  request: FastifyRequest,
  reply: FastifyReply
) => {
  const params = request.params as { id: string };
  if (!params.id) {
    return reply.status(400).send({ success: false, message: 'Product ID is required' });
  }

  try {
    const product = await getProductById(params.id);
    if (!product) {
      return reply.status(404).send({ success: false, message: 'Product not found' });
    }
    return reply.status(200).send({ success: true, data: product });
  } catch (error) {
    logger.error(error, '[chemist] handleGetProductById error');
    return reply.status(500).send({ success: false, message: 'Failed to fetch product' });
  }
};

// ─── POST /api/chemist/orders ─────────────────────────────────────────────────
export const handleCreateOrder = async (
  request: FastifyRequest,
  reply: FastifyReply
) => {
  const body = request.body as {
    product_id?:   string;
    product_name?: string;
    farmer_name?:  string;
    phone?:        string;
    location?:     string;
    reason?:       string;
  };

  const { product_id, product_name, farmer_name, phone, location, reason } = body ?? {};

  if (!product_name?.trim() || !farmer_name?.trim() || !phone?.trim() || !location?.trim() || !reason?.trim()) {
    return reply.status(400).send({
      success: false,
      message: 'product_name, farmer_name, phone, location, and reason are required',
    });
  }

  try {
    const order = await createOrder({ product_id, product_name, farmer_name, phone, location, reason });
    return reply.status(201).send({ success: true, data: order });
  } catch (error) {
    logger.error(error, '[chemist] handleCreateOrder error');
    return reply.status(500).send({ success: false, message: 'Failed to submit order. Please try again.' });
  }
};
