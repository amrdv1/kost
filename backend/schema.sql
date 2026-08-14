-- Create extension for UUIDs
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Donations Table
CREATE TABLE IF NOT EXISTS donations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    stripe_payment_id VARCHAR UNIQUE,
    customer_name VARCHAR NOT NULL,
    message TEXT,
    amount DECIMAL(10, 2) NOT NULL,
    currency VARCHAR(3) DEFAULT 'UAH',
    
    -- Status tracking
    payment_status VARCHAR NOT NULL DEFAULT 'PENDING' CHECK (payment_status IN ('PENDING', 'PAID', 'FAILED')),
    audio_status VARCHAR NOT NULL DEFAULT 'PENDING_PAYMENT' CHECK (audio_status IN ('PENDING_PAYMENT', 'PENDING_MODERATION', 'APPROVED', 'REJECTED')),
    
    -- Audio Base64 Data
    audio_base64 TEXT NOT NULL,
    audio_type VARCHAR NOT NULL, -- e.g., 'audio/mpeg'
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
