-- ============================================
-- Farm Doctor Platform Upgrade Migration
-- Run this against your Supabase database
-- ============================================

-- 1. Add platform column to conversations table
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS platform TEXT DEFAULT 'whatsapp';

-- 2. Create experts table
CREATE TABLE IF NOT EXISTS experts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  location TEXT NOT NULL,
  linkedin TEXT,
  cover_letter TEXT NOT NULL,
  payment_method TEXT NOT NULL DEFAULT 'mtn_momo',
  momo_number TEXT NOT NULL,
  amount_paid INTEGER NOT NULL DEFAULT 25000,
  currency TEXT NOT NULL DEFAULT 'XAF',
  status TEXT NOT NULL DEFAULT 'pending_review', -- pending_review, active, suspended
  subscription_expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Create subscriptions table
CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  phone TEXT NOT NULL UNIQUE,
  plan TEXT NOT NULL DEFAULT 'starter', -- starter, pro, cooperative
  status TEXT NOT NULL DEFAULT 'active', -- active, expired, cancelled
  payment_method TEXT NOT NULL DEFAULT 'mtn_momo',
  momo_number TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'XAF',
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Create messages table if not exists (for unified message logging)
CREATE TABLE IF NOT EXISTS messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'in', -- in, out
  type TEXT NOT NULL DEFAULT 'text', -- text, image, audio
  body TEXT,
  media_url TEXT,
  wa_message_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Indexes for performance
CREATE INDEX IF NOT EXISTS idx_experts_location ON experts (location);
CREATE INDEX IF NOT EXISTS idx_experts_status ON experts (status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_phone ON subscriptions (phone);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages (conversation_id);
CREATE INDEX IF NOT EXISTS idx_conversations_platform ON conversations (platform);
CREATE INDEX IF NOT EXISTS idx_conversations_phone ON conversations (phone);
