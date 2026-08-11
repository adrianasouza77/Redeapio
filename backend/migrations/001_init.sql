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
-- Faltava esta coluna: a tela "Usuários" (candidato editando lideranças/
-- apoiadores) e o PUT /usuarios/:id referenciam usuarios.estado, mas ela só
-- existia em "apoiadores" — causava "column estado does not exist" (500).
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS estado TEXT;
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
--
-- O nível da ficha criada aqui era SEMPRE 2 para quem não é liderança. Isso
-- tinha uma consequência que ninguém ligava ao reparo: o link pessoal de um
-- apoiador cadastra "o nível dele + 1", lido desta ficha. Um nível 3 que
-- ganhasse a ficha por aqui virava nível 2, e o link dele passava a cadastrar
-- gente no nível 3 em vez do 4 — os indicados apareciam no MESMO nível de quem
-- os indicou, e a tela de reorganização depois recusava arrumar ("o responsável
-- precisa estar exatamente um nível acima").
--
-- Agora o nível é deduzido de quem já está pendurado na pessoa: se os indicados
-- dela são nível 4, ela é nível 3. Quem ainda não indicou ninguém continua no
-- palpite antigo (2), que é o melhor disponível — mas aí o próprio app recusa
-- o link em vez de chutar, e o candidato corrige o nível pela tela da pirâmide.
INSERT INTO apoiadores (id, nome, telefone, regiao, endereco, cidade, titulo, zona, secao, nivel, parent_id, cadastrado_por)
SELECT u.id, u.nome, COALESCE(u.telefone, '—'), COALESCE(u.regiao, '—'), u.endereco, u.cidade,
       u.titulo, u.zona, u.secao,
       CASE
         WHEN u.perfil = 'lideranca' THEN 1
         ELSE LEAST(4, GREATEST(2, COALESCE(
           (SELECT MIN(f.nivel) - 1 FROM apoiadores f WHERE f.parent_id = u.id),
           2)))
       END,
       NULL, u.criado_por
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

-- Limites da pirâmide POR CANDIDATO. A tela de Configurações salvava só na
-- memória do navegador (voltava a 50/30/15/10 em todo reload) — agora persiste
-- aqui. NULL = usa o padrão global das variáveis LIMITE_NIVEL1..4 do servidor,
-- então quem nunca personalizou continua exatamente como antes.
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS limite_nivel1 INT CHECK (limite_nivel1 IS NULL OR limite_nivel1 BETWEEN 1 AND 100000);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS limite_nivel2 INT CHECK (limite_nivel2 IS NULL OR limite_nivel2 BETWEEN 1 AND 100000);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS limite_nivel3 INT CHECK (limite_nivel3 IS NULL OR limite_nivel3 BETWEEN 1 AND 100000);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS limite_nivel4 INT CHECK (limite_nivel4 IS NULL OR limite_nivel4 BETWEEN 1 AND 100000);

-- Coordenada de cada bairro, para o mapa da rede. É cache: descobrir a posição
-- de um bairro custa uma consulta ao serviço externo de geocodificação, que
-- limita a 1 chamada por segundo — sem guardar aqui, abrir o mapa com 90
-- bairros levaria um minuto e meio TODA vez, e o serviço acabaria bloqueando o
-- servidor. A chave é cidade+estado+bairro em minúsculas porque o mesmo bairro
-- é digitado de formas diferentes ("Canaã I", "canaa i") por quem cadastra.
--
-- encontrado=false grava a tentativa que falhou (bairro inexistente ou escrito
-- errado): sem isso o sistema tentaria de novo, para sempre, o que nunca vai dar
-- certo. tentativas serve para o candidato saber o que precisa ser corrigido.
CREATE TABLE IF NOT EXISTS geo_bairros (
  id            BIGSERIAL PRIMARY KEY,
  cidade        TEXT NOT NULL DEFAULT '',
  estado        TEXT NOT NULL DEFAULT '',
  bairro        TEXT NOT NULL,
  lat           DOUBLE PRECISION,
  lng           DOUBLE PRECISION,
  encontrado    BOOLEAN NOT NULL DEFAULT false,
  tentativas    INT NOT NULL DEFAULT 0,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_geo_bairros_chave
  ON geo_bairros (lower(cidade), lower(estado), lower(bairro));

-- Posição e retângulo de cada cidade da rede. Existe porque procurar o bairro
-- no Brasil inteiro dá resultado errado com cara de certo: "Centro" casou com
-- Uraí-PR numa campanha de Dourados-MS, e o mapa ficou com bolhas espalhadas
-- por três estados. Agora a cidade é localizada primeiro e a busca do bairro é
-- limitada ao retângulo dela — o que estiver fora simplesmente não é aceito.
CREATE TABLE IF NOT EXISTS geo_cidades (
  id            BIGSERIAL PRIMARY KEY,
  cidade        TEXT NOT NULL,
  estado        TEXT NOT NULL DEFAULT '',
  lat           DOUBLE PRECISION,
  lng           DOUBLE PRECISION,
  bbox_sul      DOUBLE PRECISION,
  bbox_norte    DOUBLE PRECISION,
  bbox_oeste    DOUBLE PRECISION,
  bbox_leste    DOUBLE PRECISION,
  encontrado    BOOLEAN NOT NULL DEFAULT false,
  tentativas    INT NOT NULL DEFAULT 0,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_geo_cidades_chave
  ON geo_cidades (lower(cidade), lower(estado));

-- As coordenadas gravadas antes desta correção foram obtidas procurando no
-- Brasil inteiro, então parte delas aponta para a cidade errada. Em vez de
-- apagar (regra do projeto: nada de DELETE sem filtro), a linha antiga fica
-- marcada como versão 1 e o app a trata como pendente — ela é sobrescrita pela
-- busca nova na primeira vez que alguém abrir o mapa.
ALTER TABLE geo_bairros ADD COLUMN IF NOT EXISTS versao_geo INT NOT NULL DEFAULT 1;

-- De onde veio a coordenada: 'busca' (descoberta automaticamente) ou 'manual'
-- (o candidato apontou no mapa, ou escolheu o nome certo na lista da cidade).
-- A distinção é o que impede o automático de desfazer o trabalho manual: a
-- posição marcada à mão nunca é sobrescrita nem invalidada por versao_geo.
ALTER TABLE geo_bairros ADD COLUMN IF NOT EXISTS origem TEXT NOT NULL DEFAULT 'busca';

-- Lista oficial de lugares de cada cidade, baixada de uma vez do OpenStreetMap
-- (Overpass). São ~257 nomes para Dourados. Serve para duas coisas: casar o
-- bairro do cadastro sem gastar uma consulta por bairro, e oferecer ao
-- candidato a lista real da cidade quando o nome digitado não bate com nada
-- ("PRQ ALVORADA" → Parque Alvorada, "Greenvile" → Green Ville).
CREATE TABLE IF NOT EXISTS geo_lugares (
  id            BIGSERIAL PRIMARY KEY,
  cidade        TEXT NOT NULL,
  estado        TEXT NOT NULL DEFAULT '',
  nome          TEXT NOT NULL,
  tipo          TEXT,
  lat           DOUBLE PRECISION NOT NULL,
  lng           DOUBLE PRECISION NOT NULL,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_geo_lugares_chave
  ON geo_lugares (lower(cidade), lower(estado), lower(nome));

-- Quando a lista daquela cidade foi baixada. NULL = ainda não foi. O Overpass
-- bloqueia quem consulta em sequência, então isso precisa ser feito uma vez só
-- por cidade e ficar guardado.
ALTER TABLE geo_cidades ADD COLUMN IF NOT EXISTS lugares_em TIMESTAMPTZ;

-- Mapa mental do candidato — ferramenta de gestão dele, não tem relação com a
-- pirâmide de apoiadores. A árvore inteira fica num único JSONB em vez de uma
-- linha por nó: o mapa é sempre lido e salvo por completo, por uma pessoa só,
-- e uma tabela de nós exigiria dezenas de consultas para montar a tela e uma
-- transação a cada arrastar de galho, sem ganho nenhum em troca.
CREATE TABLE IF NOT EXISTS mapas_mentais (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  candidato_id  UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  titulo        TEXT NOT NULL DEFAULT 'Novo mapa',
  dados         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mapas_mentais_candidato ON mapas_mentais(candidato_id);

-- Onde o mapa mental "acontece". O candidato monta a rede de contatos de um
-- lugar específico ("Brasília — Asa Norte"), e sem isso todos os mapas viravam
-- uma lista solta de nomes sem contexto nenhum. Os três campos são opcionais:
-- mapa de tema geral (ex.: "Diretório estadual") continua funcionando sem lugar.
ALTER TABLE mapas_mentais ADD COLUMN IF NOT EXISTS estado TEXT;
ALTER TABLE mapas_mentais ADD COLUMN IF NOT EXISTS cidade TEXT;
ALTER TABLE mapas_mentais ADD COLUMN IF NOT EXISTS bairro TEXT;
CREATE INDEX IF NOT EXISTS idx_mapas_mentais_lugar
  ON mapas_mentais (candidato_id, lower(COALESCE(estado,'')), lower(COALESCE(cidade,'')));

-- Dois jeitos de usar o mapa mental, porque a campanha tem os dois:
--   'livre' — quadro de ideias solto (o que já existia)
--   'geo'   — entra pelo mapa do Brasil: o candidato clica no estado e cai na
--             árvore daquele estado (MS › Dourados › Fulano). Pensado para
--             disputa de governador/senador, em que a rede é estadual.
-- O padrão é 'livre' para nenhum mapa já criado mudar de comportamento.
ALTER TABLE mapas_mentais ADD COLUMN IF NOT EXISTS tipo TEXT NOT NULL DEFAULT 'livre';
DO $$ BEGIN
  ALTER TABLE mapas_mentais ADD CONSTRAINT mapas_mentais_tipo_check CHECK (tipo IN ('livre','geo'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
