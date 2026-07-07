-- RedeApoio — schema inicial Postgres
-- Substitui o Supabase. UUIDs tipados nativamente (resolve na raiz os bugs
-- de comparação UUID vs string que existiam no filtro .or() client-side).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS usuarios (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome          TEXT NOT NULL,
  login         TEXT NOT NULL UNIQUE,
  senha_hash    TEXT NOT NULL,
  perfil        TEXT NOT NULL CHECK (perfil IN ('admin','candidato','lideranca','apoiador')),
  criado_por    UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  telefone      TEXT,
  regiao        TEXT,
  endereco      TEXT,
  cidade        TEXT,
  ativo         BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_usuarios_criado_por ON usuarios(criado_por);
CREATE INDEX IF NOT EXISTS idx_usuarios_perfil ON usuarios(perfil);

CREATE TABLE IF NOT EXISTS apoiadores (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome            TEXT NOT NULL,
  telefone        TEXT,
  nascimento      DATE,
  regiao          TEXT,
  endereco        TEXT,
  cidade          TEXT,
  estado          TEXT,
  titulo          TEXT,
  secao           TEXT,
  nivel           INT NOT NULL CHECK (nivel BETWEEN 1 AND 3),
  parent_id       UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  cadastrado_por  UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  lgpd_aceite     BOOLEAN NOT NULL DEFAULT false,
  lgpd_aceite_em  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_apoiadores_parent_id ON apoiadores(parent_id);
CREATE INDEX IF NOT EXISTS idx_apoiadores_cadastrado_por ON apoiadores(cadastrado_por);
CREATE INDEX IF NOT EXISTS idx_apoiadores_nome_lower ON apoiadores (lower(nome));

-- Adições incrementais e idempotentes (seguras em bancos já existentes, nunca
-- apagam dados — só acrescentam colunas novas com valor NULL/padrão):
ALTER TABLE apoiadores ADD COLUMN IF NOT EXISTS estado TEXT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS reset_password_token TEXT UNIQUE;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS reset_password_expires TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_usuarios_email ON usuarios (lower(email));
