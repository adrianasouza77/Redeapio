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
INSERT INTO apoiadores (id, nome, telefone, regiao, endereco, cidade, titulo, zona, secao, nivel, parent_id, cadastrado_por)
SELECT u.id, u.nome, COALESCE(u.telefone, '—'), COALESCE(u.regiao, '—'), u.endereco, u.cidade,
       u.titulo, u.zona, u.secao,
       CASE WHEN u.perfil = 'lideranca' THEN 1 ELSE 2 END, NULL, u.criado_por
FROM usuarios u
WHERE u.perfil IN ('lideranca','apoiador')
  AND u.criado_por IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM apoiadores a WHERE a.id = u.id)
ON CONFLICT (id) DO NOTHING;

-- Preenche título/zona/seção na ficha-espelho quando ela existia de antes
-- desses campos serem adicionados (fica com os 3 vazios) e o usuário já tem
-- o dado. Só preenche o que está vazio — nunca sobrescreve uma edição feita
-- direto na ficha (tela "Todos os Apoiadores"), pra não apagar dado editado
-- por lá em cada boot.
UPDATE apoiadores a
SET titulo = u.titulo, zona = u.zona, secao = u.secao
FROM usuarios u
WHERE a.id = u.id
  AND u.perfil IN ('lideranca','apoiador')
  AND a.titulo IS NULL AND a.zona IS NULL AND a.secao IS NULL
  AND (u.titulo IS NOT NULL OR u.zona IS NOT NULL OR u.secao IS NOT NULL);

-- 4º nível da pirâmide: a liderança passa a poder reorganizar manualmente
-- quem responde a quem (nível 2/3/4), então o teto sai de 3 para 4. Busca
-- dinamicamente o nome da constraint (em vez de supor "apoiadores_nivel_check")
-- pra não depender do nome que o Postgres deu automaticamente na criação.
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT con.conname FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = ANY(con.conkey)
    WHERE rel.relname = 'apoiadores' AND con.contype = 'c' AND att.attname = 'nivel'
  LOOP
    EXECUTE format('ALTER TABLE apoiadores DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE apoiadores ADD CONSTRAINT apoiadores_nivel_check CHECK (nivel BETWEEN 1 AND 4);

-- Consentimento LGPD versionado (autocadastro público de apoiadores).
ALTER TABLE apoiadores ADD COLUMN IF NOT EXISTS lgpd_versao TEXT;

-- Primeiro acesso obrigatório (senha temporária) e aceite do termo de uso
-- para quem loga no sistema (candidato/liderança/apoiador). "false" por
-- padrão pra não afetar quem já usa o sistema hoje — só passa a "true" nos
-- pontos que entregam senha que a pessoa não escolheu (criação de conta ou
-- reset feito por outra pessoa).
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS senha_temporaria BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS termo_versao_aceita TEXT;

-- Trilha de auditoria do consentimento LGPD (art. 8º, §2º — o ônus da prova
-- do consentimento é do controlador). Nunca é sobrescrita: cada aceite vira
-- uma linha nova, com versão do termo, IP e dispositivo.
CREATE TABLE IF NOT EXISTS termos_aceite (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id   UUID REFERENCES usuarios(id) ON DELETE CASCADE,
  apoiador_id  UUID REFERENCES apoiadores(id) ON DELETE CASCADE,
  versao_termo TEXT NOT NULL,
  aceite_em    TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip           TEXT,
  user_agent   TEXT,
  CHECK ((usuario_id IS NOT NULL) <> (apoiador_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_termos_aceite_usuario ON termos_aceite(usuario_id);
CREATE INDEX IF NOT EXISTS idx_termos_aceite_apoiador ON termos_aceite(apoiador_id);

-- Plano contratado do candidato, período do contrato e data de desativação —
-- só o admin edita. "teste" + sem data_desativacao é o padrão, então todo
-- candidato que já existia antes desta coluna existir continua sem nenhuma
-- limitação (DEFAULT se aplica também às linhas já existentes).
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS plano TEXT NOT NULL DEFAULT 'teste';
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS periodo_contrato TEXT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS data_desativacao TIMESTAMPTZ;
DO $$ BEGIN
  ALTER TABLE usuarios ADD CONSTRAINT usuarios_plano_check
    CHECK (plano IN ('teste','vereador','prefeito_dep_estadual','deputado_federal_senador'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE usuarios ADD CONSTRAINT usuarios_periodo_contrato_check
    CHECK (periodo_contrato IS NULL OR periodo_contrato IN ('mensal','trimestral','semestral'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
