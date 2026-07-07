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
  zona            TEXT,
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
ALTER TABLE apoiadores ADD COLUMN IF NOT EXISTS zona TEXT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS titulo TEXT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS zona TEXT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS secao TEXT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS reset_password_token TEXT UNIQUE;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS reset_password_expires TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_usuarios_email ON usuarios (lower(email));

-- Bug estrutural do app original: a linha-espelho de uma liderança/apoiador
-- em "apoiadores" (a que faz ela aparecer na pirâmide de Rede de Apoio)
-- sempre ganhava um id aleatório próprio, em vez do id do usuário real. Só
-- que os indicados dela salvam parent_id = id do USUÁRIO — então a pirâmide
-- nunca conseguia achar os indicados de ninguém ("0 indicados" pra todo
-- mundo). Alinha o id da linha-espelho com o id do usuário correspondente.
UPDATE apoiadores a
SET id = u.id
FROM usuarios u
WHERE u.perfil IN ('lideranca','apoiador')
  AND a.cadastrado_por = u.criado_por
  AND lower(a.nome) = lower(u.nome)
  AND a.nivel = CASE WHEN u.perfil = 'lideranca' THEN 1 ELSE 2 END
  AND a.id <> u.id
  AND NOT EXISTS (SELECT 1 FROM apoiadores a2 WHERE a2.id = u.id);

-- Conserta lacuna de dados já existente no Supabase de origem: algumas
-- lideranças foram criadas fora do fluxo normal do app (ex: direto pelo
-- painel do Supabase) e nunca ganharam a linha-espelho em "apoiadores" —
-- a tela de Usuários não é afetada, pois lista direto da tabela "usuarios".
-- Idempotente: roda em todo boot, mas só insere quem realmente está faltando.
INSERT INTO apoiadores (id, nome, telefone, regiao, endereco, cidade, nivel, parent_id, cadastrado_por)
SELECT u.id, u.nome, COALESCE(u.telefone, '—'), COALESCE(u.regiao, '—'), u.endereco, u.cidade,
       CASE WHEN u.perfil = 'lideranca' THEN 1 ELSE 2 END, NULL, u.criado_por
FROM usuarios u
WHERE u.perfil IN ('lideranca','apoiador')
  AND u.criado_por IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM apoiadores a WHERE a.id = u.id)
ON CONFLICT (id) DO NOTHING;
