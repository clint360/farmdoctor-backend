-- ============================================
-- Missed Call → Expert Dispatch tables
-- ============================================

-- 1. Track missed/emergency calls from farmers
CREATE TABLE IF NOT EXISTS missed_calls (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  phone TEXT NOT NULL,
  city TEXT,                         -- farmer's city (from conversations table)
  status TEXT NOT NULL DEFAULT 'pending', -- pending, claimed, expired
  claimed_by_expert UUID REFERENCES experts(id),
  claimed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Track which experts were notified and their responses
CREATE TABLE IF NOT EXISTS expert_claims (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  missed_call_id UUID NOT NULL REFERENCES missed_calls(id),
  expert_id UUID NOT NULL REFERENCES experts(id),
  expert_phone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'notified', -- notified, accepted, declined, expired
  notified_at TIMESTAMPTZ DEFAULT NOW(),
  responded_at TIMESTAMPTZ,
  UNIQUE (missed_call_id, expert_id)
);

-- 3. Indexes
CREATE INDEX IF NOT EXISTS idx_missed_calls_phone ON missed_calls (phone);
CREATE INDEX IF NOT EXISTS idx_missed_calls_status ON missed_calls (status);
CREATE INDEX IF NOT EXISTS idx_expert_claims_missed ON expert_claims (missed_call_id);
CREATE INDEX IF NOT EXISTS idx_expert_claims_expert ON expert_claims (expert_phone);
