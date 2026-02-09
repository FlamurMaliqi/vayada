-- ============================================
-- Shared Auth Database Schema
-- ============================================
-- This database is shared between the marketplace and booking engine.
-- It contains all authentication, user, and consent-related tables.

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- Users table (authentication + profile information)
-- ============================================
CREATE TABLE public.users (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  name text NOT NULL,
  type text NOT NULL CHECK (type = ANY (ARRAY['hotel'::text, 'creator'::text, 'admin'::text])),
  status text NOT NULL DEFAULT 'pending'::text CHECK (status = ANY (ARRAY['pending'::text, 'verified'::text, 'rejected'::text, 'suspended'::text])),
  avatar text,
  email_verified boolean NOT NULL DEFAULT false,
  terms_accepted_at timestamp with time zone,
  privacy_accepted_at timestamp with time zone,
  terms_version text,
  privacy_version text,
  marketing_consent boolean DEFAULT false,
  marketing_consent_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT users_pkey PRIMARY KEY (id)
);

CREATE INDEX idx_users_email ON public.users(email);
CREATE INDEX idx_users_type ON public.users(type);
CREATE INDEX idx_users_status ON public.users(status);
CREATE INDEX idx_users_email_verified ON public.users(email_verified);

-- ============================================
-- Password Reset Tokens
-- ============================================
CREATE TABLE public.password_reset_tokens (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  expires_at timestamp with time zone NOT NULL,
  used boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT password_reset_tokens_pkey PRIMARY KEY (id)
);

CREATE INDEX idx_password_reset_tokens_user_id ON public.password_reset_tokens(user_id);
CREATE INDEX idx_password_reset_tokens_token ON public.password_reset_tokens(token);
CREATE INDEX idx_password_reset_tokens_expires_at ON public.password_reset_tokens(expires_at);

-- ============================================
-- Email Verification Codes
-- ============================================
CREATE TABLE public.email_verification_codes (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  email text NOT NULL,
  code text NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  used boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT email_verification_codes_pkey PRIMARY KEY (id)
);

CREATE INDEX idx_email_verification_codes_email ON public.email_verification_codes(email);
CREATE INDEX idx_email_verification_codes_code ON public.email_verification_codes(code);
CREATE INDEX idx_email_verification_codes_expires_at ON public.email_verification_codes(expires_at);
CREATE INDEX idx_email_verification_codes_email_code ON public.email_verification_codes(email, code) WHERE used = false;

-- ============================================
-- Email Verification Tokens
-- ============================================
CREATE TABLE public.email_verification_tokens (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  expires_at timestamp with time zone NOT NULL,
  used boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT email_verification_tokens_pkey PRIMARY KEY (id)
);

CREATE INDEX idx_email_verification_tokens_user_id ON public.email_verification_tokens(user_id);
CREATE INDEX idx_email_verification_tokens_token ON public.email_verification_tokens(token);
CREATE INDEX idx_email_verification_tokens_expires_at ON public.email_verification_tokens(expires_at);

-- ============================================
-- Cookie Consent
-- ============================================
CREATE TABLE public.cookie_consent (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  visitor_id text NOT NULL,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  necessary boolean DEFAULT true NOT NULL,
  functional boolean DEFAULT false NOT NULL,
  analytics boolean DEFAULT false NOT NULL,
  marketing boolean DEFAULT false NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX idx_cookie_consent_visitor_id ON public.cookie_consent(visitor_id);
CREATE INDEX idx_cookie_consent_user_id ON public.cookie_consent(user_id);

-- ============================================
-- Consent History (audit trail)
-- ============================================
CREATE TABLE public.consent_history (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  consent_type text NOT NULL,
  consent_given boolean NOT NULL,
  version text,
  ip_address text,
  user_agent text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX idx_consent_history_user_id ON public.consent_history(user_id);
CREATE INDEX idx_consent_history_consent_type ON public.consent_history(consent_type);
CREATE INDEX idx_consent_history_created_at ON public.consent_history(created_at);

-- ============================================
-- GDPR Requests
-- ============================================
CREATE TABLE public.gdpr_requests (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid REFERENCES users(id) ON DELETE SET NULL NOT NULL,
  request_type text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  requested_at timestamp with time zone DEFAULT now() NOT NULL,
  processed_at timestamp with time zone,
  expires_at timestamp with time zone,
  download_token text,
  cancellation_reason text,
  ip_address text,
  CONSTRAINT valid_request_type CHECK (request_type IN ('export', 'deletion')),
  CONSTRAINT valid_status CHECK (status IN ('pending', 'processing', 'completed', 'cancelled', 'expired'))
);

CREATE INDEX idx_gdpr_requests_user_id ON public.gdpr_requests(user_id);
CREATE INDEX idx_gdpr_requests_status ON public.gdpr_requests(status);
CREATE INDEX idx_gdpr_requests_download_token ON public.gdpr_requests(download_token);

-- ============================================
-- Default Admin User
-- ============================================
-- Password: Vayada123 (bcrypt hash)
INSERT INTO users (email, password_hash, name, type, status, email_verified)
VALUES (
    'admin@vayada.com',
    '$2b$12$.sbVRdLMnCadYEkfLx1cJuxVbMT3ilI6ji5dcb2ZERVsH3vGGfOpG',
    'Admin User',
    'admin',
    'verified',
    true
)
ON CONFLICT (email) DO UPDATE
SET
    type = 'admin',
    status = 'verified',
    password_hash = EXCLUDED.password_hash,
    updated_at = now();
