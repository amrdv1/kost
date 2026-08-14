-- Supabase / PostgreSQL Schema for Sound Donation System

-- ENUM for Audio Status
CREATE TYPE audio_status AS ENUM ('PENDING_MODERATION', 'APPROVED', 'REJECTED');

-- ENUM for Payment Status
CREATE TYPE payment_status AS ENUM ('PENDING_PAYMENT', 'PAID', 'FAILED');

-- Donations Table
CREATE TABLE public.donations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stripe_payment_id VARCHAR UNIQUE,
    customer_name VARCHAR NOT NULL,
    message TEXT,
    amount DECIMAL(10, 2) NOT NULL,
    currency VARCHAR DEFAULT 'GBP',
    payment_status payment_status DEFAULT 'PENDING_PAYMENT',
    
    -- Audio related fields
    audio_url TEXT NOT NULL,
    audio_duration_seconds INTEGER,
    audio_status audio_status DEFAULT 'PENDING_MODERATION',
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable RLS (Row Level Security)
ALTER TABLE public.donations ENABLE ROW LEVEL SECURITY;

-- Allow public read access to APPROVED donations
CREATE POLICY "Allow public read access for APPROVED donations" 
ON public.donations 
FOR SELECT 
USING (audio_status = 'APPROVED');

-- Allow public inserts for initial donations
CREATE POLICY "Allow public insert for donations"
ON public.donations
FOR INSERT
WITH CHECK (true);

-- Allow authenticated admins full access
CREATE POLICY "Allow authenticated admins full access" 
ON public.donations 
FOR ALL 
TO authenticated 
USING (true) 
WITH CHECK (true);

-- Realtime Setup
alter publication supabase_realtime add table public.donations;

-- ==========================================
-- STORAGE CONFIGURATION
-- ==========================================

-- Insert a storage bucket for sounds
INSERT INTO storage.buckets (id, name, public) VALUES ('sounds', 'sounds', true);

-- Allow public uploads to the 'sounds' bucket
CREATE POLICY "Allow public uploads to sounds bucket"
ON storage.objects FOR INSERT TO public WITH CHECK (bucket_id = 'sounds');

-- Allow public read access to the 'sounds' bucket
CREATE POLICY "Allow public read access to sounds bucket"
ON storage.objects FOR SELECT TO public USING (bucket_id = 'sounds');
