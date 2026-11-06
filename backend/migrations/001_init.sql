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
-- que os apoiadores dela salvam parent_id = id do USUÁRIO — então a pirâmide
-- nunca conseguia achar os apoiadores de ninguém ("0 apoiadores" pra todo
-- mundo). Alinha o id da linha-espelho com o id do usuário correspondente.
--
-- Só quando a ficha candidata é ÚNICA. Em 02/10/2026 o app não subiu
-- ("duplicate key ... apoiadores_pkey" em todo boot, Bad Gateway): depois das
-- exclusões de fichas de 27 e 30/09, a equipe recadastrou gente pela tela e
-- uma pessoa com login ficou com duas fichas de mesmo nome. O UPDATE tentava
-- dar o id do usuário às DUAS — o NOT EXISTS abaixo não impede, porque olha a
-- tabela de antes do UPDATE, não linha a linha. Com duas ou mais, não dá para
-- saber qual é a verdadeira: fica como está e o candidato resolve em
-- "Buscar duplicados".
UPDATE apoiadores a
SET id = u.id
FROM usuarios u
WHERE u.perfil IN ('lideranca','apoiador')
  AND a.cadastrado_por = u.criado_por
  AND lower(a.nome) = lower(u.nome)
  AND a.nivel = CASE WHEN u.perfil = 'lideranca' THEN 1 ELSE 2 END
  AND a.id <> u.id
  AND NOT EXISTS (SELECT 1 FROM apoiadores a2 WHERE a2.id = u.id)
  AND (SELECT count(*) FROM apoiadores a3
       WHERE a3.cadastrado_por = u.criado_por
         AND lower(a3.nome) = lower(u.nome)
         AND a3.nivel = a.nivel) = 1;

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
-- gente no nível 3 em vez do 4 — os apoiadores apareciam no MESMO nível de quem
-- os cadastrou, e a tela de reorganização depois recusava arrumar ("o responsável
-- precisa estar exatamente um nível acima").
--
-- Agora o nível é deduzido de quem já está pendurado na pessoa: se os apoiadores
-- dela são nível 4, ela é nível 3. Quem ainda não cadastrou ninguém continua no
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

-- A reorganização de hierarquia ("mover o nível 2 para nível 3, sob outro
-- nível 2") falhava com "Erro interno" toda vez que o novo responsável não
-- tinha login. Motivo: parent_id nasceu como REFERENCES usuarios(id), de
-- quando só liderança podia ser responsável — mas hoje o responsável é
-- QUALQUER linha de "apoiadores", e a maioria (autocadastro de base, cadastro
-- feito pela liderança) nunca existe em "usuarios". O UPDATE batia na chave
-- estrangeira (23503) e virava 500. Por isso movia sob uma pessoa e sob outra
-- não, sem padrão aparente para quem usa — e nem o admin escapava.
--
-- Não dá para trocar a referência para apoiadores(id): parent_id também aponta
-- para o candidato/liderança emissora de link, que existe só em "usuarios".
-- Como o alvo legítimo está em duas tabelas diferentes, o banco não consegue
-- validar isso sozinho — quem valida é o app (PUT /apoiadores/:id confere que
-- o responsável está na rede e exatamente um nível acima). O ON DELETE SET
-- NULL que se perde aqui é reposto à mão nas rotas de exclusão.
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT con.conname FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = ANY(con.conkey)
    WHERE rel.relname = 'apoiadores' AND con.contype = 'f' AND att.attname = 'parent_id'
  LOOP
    EXECUTE format('ALTER TABLE apoiadores DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

-- Log de auditoria — quem fez o quê, com quem, quando. Só o Administrador
-- Geral lê (rotas em /api/admin/logs); candidato e liderança não têm acesso
-- nem à rota nem à tela.
--
-- Nenhuma coluna aqui tem chave estrangeira, e isso é deliberado: o log
-- precisa sobreviver à exclusão da pessoa. Com CASCADE, apagar um apoiador
-- apagaria junto a prova de que ele existiu (que é exatamente o que se quer
-- consultar depois); com RESTRICT, ninguém conseguiria mais excluir ninguém.
-- Por isso ator_nome/alvo_nome são gravados por cópia, e não por join.
CREATE TABLE IF NOT EXISTS auditoria (
  id            BIGSERIAL PRIMARY KEY,
  ocorrido_em   TIMESTAMPTZ NOT NULL DEFAULT now(),
  candidato_id  UUID,          -- workspace onde aconteceu (NULL: ação do admin fora de um workspace)
  ator_id       UUID,
  ator_nome     TEXT,
  ator_perfil   TEXT,
  como_admin    BOOLEAN NOT NULL DEFAULT false,  -- admin agindo dentro do workspace de um candidato
  acao          TEXT NOT NULL, -- 'login', 'apoiador.criar', 'apoiador.mover', ...
  alvo_tipo     TEXT,          -- 'apoiador' | 'usuario' | 'candidato' | 'config' | 'mapa' | 'sessao'
  alvo_id       UUID,
  alvo_nome     TEXT,
  detalhes      JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip            TEXT,
  user_agent    TEXT
);

-- Os três jeitos de consultar: a linha do tempo do workspace, o histórico de
-- uma pessoa específica (ícone de log na frente do apoiador) e o que um login
-- andou fazendo. DESC porque toda tela mostra o mais recente primeiro.
CREATE INDEX IF NOT EXISTS idx_auditoria_candidato ON auditoria (candidato_id, ocorrido_em DESC);
CREATE INDEX IF NOT EXISTS idx_auditoria_alvo ON auditoria (alvo_id, ocorrido_em DESC);
CREATE INDEX IF NOT EXISTS idx_auditoria_ator ON auditoria (ator_id, ocorrido_em DESC);

-- Apuração ao vivo: cruza o boletim de urna (BU) de cada seção, publicado pelo
-- TSE, com quantos apoiadores a rede tem cadastrados naquela seção. Só entra
-- aqui o TOTAL de votos do candidato por seção — dado público. Nada permite
-- saber em quem um eleitor específico votou: o voto é secreto por lei.
--
-- Configuração: qual eleição acompanhar e qual é o número do candidato nela.
-- ciclo + pleito são os códigos do portal de resultados do TSE ("ele2026" e o
-- código do turno). municipio só é preenchido em eleição municipal: vereador
-- e prefeito têm o mesmo número em cidades diferentes, então sem esse filtro
-- os votos do "11123" de outra cidade da mesma zona seriam somados ao nosso.
CREATE TABLE IF NOT EXISTS apuracao_config (
  candidato_id  UUID PRIMARY KEY REFERENCES usuarios(id) ON DELETE CASCADE,
  ciclo         TEXT NOT NULL,
  pleito        TEXT NOT NULL,
  uf            TEXT NOT NULL,
  municipio     TEXT,
  cargo         TEXT NOT NULL,
  numero        TEXT NOT NULL,
  ativo         BOOLEAN NOT NULL DEFAULT true,
  ultima_busca  TIMESTAMPTZ,
  ultimo_erro   TEXT,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Uma linha por seção JÁ apurada. Seção sem linha = "aguardando BU": não há
-- status guardado, porque o único estado que muda é a chegada do boletim.
-- ciclo/pleito na chave para o teste com uma eleição passada (2024) não se
-- misturar com a eleição de verdade. secao é sempre a seção PRINCIPAL da urna:
-- seções agregadas votam na mesma urna e saem no mesmo BU.
CREATE TABLE IF NOT EXISTS apuracao_secoes (
  candidato_id  UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  ciclo         TEXT NOT NULL,
  pleito        TEXT NOT NULL,
  zona          TEXT NOT NULL,
  secao         TEXT NOT NULL,
  municipio     TEXT,
  votos         INT  NOT NULL CHECK (votos >= 0),
  fonte         TEXT NOT NULL DEFAULT 'tse',
  apurado_em    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (candidato_id, ciclo, pleito, zona, secao)
);

-- ─── Nichos temáticos (o "mapa mental de nichos") ───────────────────────────
-- Área de interesse de cada pessoa da rede (Educação, Saúde, Inclusão...),
-- definida livremente por cada candidato. É uma dimensão independente de
-- papel e território: uma pessoa pode estar em vários nichos, e isso permite
-- cruzar depois ("a zona 18 é quase toda Saúde").
CREATE TABLE IF NOT EXISTS nichos (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  candidato_id  UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  nome          TEXT NOT NULL,
  cor           TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Nome único por campanha, sem diferenciar maiúscula ("saúde" = "Saúde").
CREATE UNIQUE INDEX IF NOT EXISTS idx_nichos_nome ON nichos (candidato_id, lower(nome));

-- Ligação N:N. Apagar o nicho ou a pessoa apaga só a ligação.
CREATE TABLE IF NOT EXISTS apoiador_nichos (
  apoiador_id  UUID NOT NULL REFERENCES apoiadores(id) ON DELETE CASCADE,
  nicho_id     UUID NOT NULL REFERENCES nichos(id) ON DELETE CASCADE,
  PRIMARY KEY (apoiador_id, nicho_id)
);
CREATE INDEX IF NOT EXISTS idx_apoiador_nichos_nicho ON apoiador_nichos (nicho_id);

-- Meta de votos que Líder, Coordenador e Mobilizador (níveis 1 a 3) dizem
-- conseguir entregar. NULL = ainda não declarou; o apoiador da base (nível 4)
-- não tem meta.
ALTER TABLE apoiadores ADD COLUMN IF NOT EXISTS meta_votos INT;
DO $$ BEGIN
  ALTER TABLE apoiadores ADD CONSTRAINT apoiadores_meta_votos_check CHECK (meta_votos IS NULL OR meta_votos BETWEEN 0 AND 10000000);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Eleitores aptos da seção (tamanho do eleitorado da urna), lido do mesmo BU.
-- É o "total de votantes históricos" que a especificação usa para apontar
-- meta irrealista. Comparecimento NÃO é guardado: a especificação da apuração
-- proíbe coletar dado de comparecimento — aptos diz quantos podem votar ali,
-- não quem foi votar.
ALTER TABLE apuracao_secoes ADD COLUMN IF NOT EXISTS aptos INT;

-- "Quem te indicou?" — campo opcional do Apoiador Orgânico que entra pelo
-- link geral do candidato (especificação, Tela 1). Texto livre, porque o
-- formulário é público: oferecer a lista de nomes da rede para escolher
-- exporia a rede inteira a quem abrisse o link. Vazio = orgânico puro. O
-- candidato lê o nome na ficha e, se quiser, pendura a pessoa sob quem indicou.
ALTER TABLE apoiadores ADD COLUMN IF NOT EXISTS indicado_por_texto TEXT;

-- ─── Desempenho eleitoral histórico ─────────────────────────────────────────
-- Qual eleição passada do candidato usar como referência (Tela 5).
CREATE TABLE IF NOT EXISTS historico_config (
  candidato_id  UUID PRIMARY KEY REFERENCES usuarios(id) ON DELETE CASCADE,
  ciclo         TEXT NOT NULL,
  eleicao       TEXT NOT NULL,
  uf            TEXT NOT NULL,
  cargo         TEXT NOT NULL,
  numero        TEXT NOT NULL,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Resultado oficial por município, de TODOS os candidatos do cargo (é o que
-- dá a posição no ranking e os concorrentes). Dado público do TSE, igual para
-- qualquer campanha — por isso não tem candidato_id: é cache compartilhado,
-- baixado uma vez e reaproveitado.
CREATE TABLE IF NOT EXISTS resultado_urna (
  ciclo         TEXT NOT NULL,
  eleicao       TEXT NOT NULL,
  municipio     TEXT NOT NULL,
  cargo         TEXT NOT NULL,
  numero        TEXT NOT NULL,
  nome          TEXT,
  partido       TEXT,
  votos         INT  NOT NULL,
  posicao       INT,
  eleito        BOOLEAN,
  fonte         TEXT NOT NULL DEFAULT 'TSE',
  importado_em  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (ciclo, eleicao, municipio, cargo, numero)
);

-- Eleitores aptos do município naquela eleição.
CREATE TABLE IF NOT EXISTS resultado_urna_municipio (
  ciclo          TEXT NOT NULL,
  eleicao        TEXT NOT NULL,
  municipio      TEXT NOT NULL,
  cargo          TEXT NOT NULL,
  aptos          INT,
  importado_em   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (ciclo, eleicao, municipio, cargo)
);

-- Uma versão anterior (que chegou a ir para o GitHub) gravava também o
-- comparecimento. A especificação da apuração proíbe guardar esse dado,
-- então o que tiver sido gravado é apagado. A coluna não é removida
-- (nada de DROP neste arquivo); fica vazia e nenhum código a lê. O WHERE
-- deixa de casar depois da primeira execução.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'apuracao_secoes' AND column_name = 'comparecimento') THEN
    UPDATE apuracao_secoes SET comparecimento = NULL WHERE comparecimento IS NOT NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'resultado_urna_municipio' AND column_name = 'comparecimento') THEN
    UPDATE resultado_urna_municipio SET comparecimento = NULL WHERE comparecimento IS NOT NULL;
  END IF;
END $$;

-- ─── Copiloto de IA ─────────────────────────────────────────────────────────
-- Cada leitura gerada fica guardada: reabrir o painel mostra a última sem
-- pagar outra chamada, e o histórico permite limitar quantas por dia.
CREATE TABLE IF NOT EXISTS ia_insights (
  id              BIGSERIAL PRIMARY KEY,
  candidato_id    UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  gerado_em       TIMESTAMPTZ NOT NULL DEFAULT now(),
  modelo          TEXT,
  resumo          JSONB NOT NULL DEFAULT '{}'::jsonb,
  insights        JSONB NOT NULL DEFAULT '[]'::jsonb,
  tokens_entrada  INT,
  tokens_saida    INT
);
CREATE INDEX IF NOT EXISTS idx_ia_insights_candidato ON ia_insights (candidato_id, gerado_em DESC);
-- Copiloto por tela (06/10/2026): a leitura passa a ser da tela que a pessoa
-- está vendo. chave = hash de candidato + tela + filtros (a mesma combinação é
-- a mesma leitura guardada); contexto = tela, filtros e o rótulo "Leitura
-- de: …"; versao_dados = impressão da rede/votos quando a leitura foi feita
-- (mudou, a tela marca como desatualizada). Leituras antigas ficam com
-- chave NULL e simplesmente não aparecem mais.
ALTER TABLE ia_insights ADD COLUMN IF NOT EXISTS tela TEXT;
ALTER TABLE ia_insights ADD COLUMN IF NOT EXISTS chave TEXT;
ALTER TABLE ia_insights ADD COLUMN IF NOT EXISTS contexto JSONB;
ALTER TABLE ia_insights ADD COLUMN IF NOT EXISTS versao_dados TEXT;
CREATE INDEX IF NOT EXISTS idx_ia_insights_chave ON ia_insights (candidato_id, chave, gerado_em DESC);

-- Assistente de ajuda: só a contagem de uso, para o limite diário por pessoa.
-- A pergunta e a resposta não são guardadas (podem conter dado pessoal colado
-- sem querer, e não servem para nada da campanha).
CREATE TABLE IF NOT EXISTS ia_ajuda_uso (
  id              BIGSERIAL PRIMARY KEY,
  usuario_id      UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT now(),
  modelo          TEXT,
  tokens_entrada  INT,
  tokens_saida    INT
);
CREATE INDEX IF NOT EXISTS idx_ia_ajuda_uso_usuario ON ia_ajuda_uso (usuario_id, criado_em DESC);

-- ─── Segurança ──────────────────────────────────────────────────────────────
-- Verificação em duas etapas (código do aplicativo autenticador). Opcional.
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS totp_segredo TEXT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS totp_ativo BOOLEAN NOT NULL DEFAULT false;
-- ─── Votos por seção (briefing de 05/10/2026) ───────────────────────────────
-- Boletim de urna COMPLETO de cada urna de um estado: todos os cargos e todos
-- os candidatos. Dado público do TSE, igual para qualquer campanha — por isso
-- não tem candidato_id: um estado é baixado uma vez e serve a todas as
-- campanhas e a qualquer candidato escolhido na tela (o próprio, um aliado, um
-- adversário). secao é sempre a seção PRINCIPAL da urna (as agregadas votam
-- na mesma urna e saem no mesmo BU).
--
-- cargos = { "<código do cargo>": { "v": {número: votos}, "l": {partido: votos
-- de legenda}, "b": brancos, "n": nulos, "vv": votos válidos } }. JSONB em vez
-- de uma linha por candidato: uma urna de 2026 tem ~150 pares cargo×número, e
-- São Paulo tem ~100 mil urnas — seriam 15 milhões de linhas num Postgres com
-- 512 MB; assim é uma linha por urna.
--
-- Comparecimento e brancos/nulos por seção são totais públicos da urna, não
-- dado de eleitor. A especificação da apuração ao vivo (que proibia guardar
-- comparecimento — ver o bloco de apuracao_secoes acima, que continua valendo
-- para aquela tabela) foi superada aqui pelo briefing de 05/10/2026, que pede
-- "% brancos + nulos" por seção para achar onde há eleitor desmobilizado.
CREATE TABLE IF NOT EXISTS tse_urnas (
  ciclo           TEXT NOT NULL,
  pleito          TEXT NOT NULL,
  uf              TEXT NOT NULL,
  zona            TEXT NOT NULL,
  secao           TEXT NOT NULL,
  municipio       TEXT NOT NULL,
  aptos           INT,
  comparecimento  INT,
  cargos          JSONB NOT NULL,
  coletado_em     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (ciclo, pleito, uf, zona, secao)
);

-- Andamento da varredura de um estado. refazer_desde: "baixar de novo" marca
-- a hora; urna coletada antes dela volta a ser pendente, sem apagar nada —
-- a tela continua mostrando o que já havia enquanto a nova volta corre.
CREATE TABLE IF NOT EXISTS tse_coletas (
  ciclo          TEXT NOT NULL,
  pleito         TEXT NOT NULL,
  uf             TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'coletando',
  total          INT,
  coletadas      INT NOT NULL DEFAULT 0,
  sem_bu         INT NOT NULL DEFAULT 0,
  erro           TEXT,
  refazer_desde  TIMESTAMPTZ,
  iniciado_por   UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  iniciado_em    TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em  TIMESTAMPTZ NOT NULL DEFAULT now(),
  concluido_em   TIMESTAMPTZ,
  PRIMARY KEY (ciclo, pleito, uf)
);

-- Local de votação de cada seção (dados abertos do TSE, "eleitorado por local
-- de votação"): escola, endereço, bairro e coordenada. É o que divide os
-- votos por bairro e põe cada escola no mapa. Também público e compartilhado.
CREATE TABLE IF NOT EXISTS tse_locais (
  ano            INT  NOT NULL,
  uf             TEXT NOT NULL,
  zona           TEXT NOT NULL,
  secao          TEXT NOT NULL,
  principal      TEXT NOT NULL,
  municipio      TEXT NOT NULL,
  local_numero   TEXT,
  local_nome     TEXT,
  endereco       TEXT,
  bairro         TEXT,
  cep            TEXT,
  lat            DOUBLE PRECISION,
  lng            DOUBLE PRECISION,
  eleitores      INT,
  PRIMARY KEY (ano, uf, zona, secao)
);

CREATE TABLE IF NOT EXISTS tse_locais_carga (
  ano           INT  NOT NULL,
  uf            TEXT NOT NULL,
  linhas        INT  NOT NULL,
  importado_em  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (ano, uf)
);

-- ─── Briefing "Votos por seção" v2 (05/10/2026) ─────────────────────────────
-- Etapa 1: o candidato é cadastrado UMA vez com o que identifica a votação
-- dele no TSE. O número sozinho não basta: repete entre cargos, anos e
-- municípios — a chave é ano + turno + cargo + UF + município + número.
-- cargo é o código do TSE (13 vereador, 11 prefeito, 7 dep. estadual,
-- 6 dep. federal, 5 senador, 3 governador). ciclo/pleito/eleicao são os
-- códigos do portal de resultados do TSE resolvidos na hora de salvar — é com
-- eles que a importação acha os boletins, sem ninguém digitar código.
-- faixa_verde/faixa_amarela: o sinal do relatório (briefing: verde ≥ 80%,
-- amarelo 50–79%, "faixas configuráveis por cliente").
CREATE TABLE IF NOT EXISTS candidato_dados (
  candidato_id   UUID PRIMARY KEY REFERENCES usuarios(id) ON DELETE CASCADE,
  ano            INT  NOT NULL CHECK (ano BETWEEN 2000 AND 2100),
  turno          INT  NOT NULL DEFAULT 1 CHECK (turno IN (1, 2)),
  cargo          INT  NOT NULL,
  numero         TEXT NOT NULL,
  partido        TEXT NOT NULL,
  uf             TEXT NOT NULL,
  abrangencia    TEXT NOT NULL CHECK (abrangencia IN ('municipio', 'municipios', 'estado')),
  nome_urna      TEXT,
  ciclo          TEXT,
  pleito         TEXT,
  eleicao        TEXT,
  faixa_verde    INT  NOT NULL DEFAULT 80 CHECK (faixa_verde BETWEEN 1 AND 1000),
  faixa_amarela  INT  NOT NULL DEFAULT 50 CHECK (faixa_amarela BETWEEN 0 AND 1000),
  atualizado_em  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Municípios da campanha, sempre pelo código do TSE (não o do IBGE: são
-- números diferentes). Um só para vereador/prefeito; vários nas campanhas
-- estaduais/federais com "municípios-alvo"; nenhum quando é o estado todo.
CREATE TABLE IF NOT EXISTS candidato_municipios (
  candidato_id       UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  cod_municipio_tse  TEXT NOT NULL,
  nome               TEXT NOT NULL,
  PRIMARY KEY (candidato_id, cod_municipio_tse)
);

-- Etapa 2: onde a pessoa VOTA (pode ser outra cidade da que ela mora) e,
-- opcional, a escola. Zona e seção já existiam. O título de eleitor deixa de
-- ser pedido (briefing: "zona e seção bastam e reduzem o risco LGPD"); a
-- coluna antiga fica, sem DROP — ver o bloco do título mais abaixo.
ALTER TABLE apoiadores ADD COLUMN IF NOT EXISTS municipio_votacao TEXT;
ALTER TABLE apoiadores ADD COLUMN IF NOT EXISTS municipio_votacao_nome TEXT;
ALTER TABLE apoiadores ADD COLUMN IF NOT EXISTS local_votacao TEXT;
ALTER TABLE apoiadores ADD COLUMN IF NOT EXISTS local_votacao_nome TEXT;

-- Etapa 3: histórico e auditoria de cada "Importar votos do TSE" (quem,
-- quando, de onde, resultado). Os votos em si não são copiados por candidato:
-- moram em tse_urnas, uma linha por urna com todos os candidatos, então
-- reimportar nunca duplica (é o mesmo upsert por urna) e um estado inteiro
-- não vira milhões de linhas.
CREATE TABLE IF NOT EXISTS importacoes_tse (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  candidato_id   UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  usuario_id     UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  usuario_nome   TEXT,
  arquivo        TEXT,
  ciclo          TEXT NOT NULL,
  pleito         TEXT NOT NULL,
  uf             TEXT NOT NULL,
  cargo          INT  NOT NULL,
  numero         TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'coletando',
  linhas         INT,
  secoes         INT,
  municipios     INT,
  total_votos    INT,
  total_oficial  INT,
  confere        BOOLEAN,
  erro           TEXT,
  iniciado_em    TIMESTAMPTZ NOT NULL DEFAULT now(),
  concluido_em   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_importacoes_tse_cand ON importacoes_tse (candidato_id, iniciado_em DESC);

-- Seção 7: rede com vários candidatos sob um Coordenador Geral.
-- O perfil novo entra na lista do CHECK. Só troca a restrição quando ela
-- ainda não conhece o perfil — depois da primeira vez, não faz nada.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'usuarios'::regclass AND conname = 'usuarios_perfil_check'
       AND pg_get_constraintdef(oid) LIKE '%coordenador_geral%'
  ) THEN
    ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_perfil_check;
    ALTER TABLE usuarios ADD CONSTRAINT usuarios_perfil_check
      CHECK (perfil IN ('admin', 'candidato', 'lideranca', 'apoiador', 'coordenador_geral'));
  END IF;
END $$;

-- O cliente contratante passa a ser a rede. coordenador_geral_id NULL = rede
-- de um candidato só (todo cliente que já existia vira isso, sem mudar nada
-- do que ele enxerga).
CREATE TABLE IF NOT EXISTS redes (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome                  TEXT NOT NULL,
  coordenador_geral_id  UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- rede_id vale para o candidato (e para o coordenador geral, que é dono dela).
-- rede_ver_outros: o candidato só enxerga os outros candidatos da rede se o
-- Coordenador Geral liberar (briefing: "salvo liberação do Coordenador Geral").
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS rede_id UUID REFERENCES redes(id) ON DELETE SET NULL;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS rede_ver_outros BOOLEAN NOT NULL DEFAULT false;

-- Migração: cada candidato que ainda não tem rede ganha uma só dele. A
-- condição rede_id IS NULL deixa de valer depois de aplicada.
DO $$
DECLARE c RECORD; r UUID;
BEGIN
  FOR c IN SELECT id, nome FROM usuarios WHERE perfil = 'candidato' AND rede_id IS NULL LOOP
    INSERT INTO redes (nome) VALUES ('Rede de ' || c.nome) RETURNING id INTO r;
    UPDATE usuarios SET rede_id = r WHERE id = c.id;
  END LOOP;
END $$;

-- A mesma pessoa apoiando mais de um candidato da rede, sem duplicar o
-- cadastro. A ficha (apoiadores) continua na pirâmide do candidato onde ela
-- foi cadastrada primeiro — é ela que guarda nome, telefone, zona e seção,
-- que valem para todos. Esta tabela guarda só os OUTROS vínculos: o papel
-- (nível), o superior e a meta naquele outro candidato. Uma pessoa pode ser
-- Líder de um e Mobilizador de outro. superior_id sem chave estrangeira pelo
-- mesmo motivo de apoiadores.parent_id (pode estar em usuarios ou apoiadores).
CREATE TABLE IF NOT EXISTS apoiador_candidatos (
  apoiador_id   UUID NOT NULL REFERENCES apoiadores(id) ON DELETE CASCADE,
  candidato_id  UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  nivel         INT  NOT NULL CHECK (nivel BETWEEN 1 AND 4),
  superior_id   UUID,
  meta_votos    INT CHECK (meta_votos IS NULL OR meta_votos BETWEEN 0 AND 10000000),
  ativo         BOOLEAN NOT NULL DEFAULT true,
  criado_por    UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (apoiador_id, candidato_id)
);
CREATE INDEX IF NOT EXISTS idx_apoiador_candidatos_cand ON apoiador_candidatos (candidato_id) WHERE ativo;

-- Importação só do que o candidato precisa (pedido da dona do sistema em
-- 05/10/2026: "não quero que fique baixando tudo"). municipios NULL = estado
-- inteiro (botão "Carregar o estado" de Votos por Seção); com lista, a carga
-- baixa só as urnas desses municípios — os do candidato, ou, na campanha de
-- estado todo, os municípios onde a rede tem gente votando.
ALTER TABLE tse_coletas ADD COLUMN IF NOT EXISTS municipios TEXT[];
ALTER TABLE importacoes_tse ADD COLUMN IF NOT EXISTS municipios_escopo TEXT[];

-- ═══════════════════════════════════════════════════════════════════════════
-- MÓDULO MANDATO (briefing "Rede Apoio — Módulo Mandato", novembro/2026)
-- ═══════════════════════════════════════════════════════════════════════════
-- O briefing veio escrito para Supabase (RLS, auth.uid(), tenant_id). Aqui não
-- há nada disso: o "tenant" é o candidato (candidato_id), e quem garante que o
-- Interno não vaza é o servidor (routes/mandato.js e routes/mandatoPublico.js),
-- como em todo o resto do sistema. As travas que o briefing manda pôr NO BANCO
-- estão aqui como CHECK: demanda com dado sensível nunca pública, e foto com
-- pessoas só publicada com autorização de imagem.

-- Dois perfis novos, só do mandato: Chefe de Gabinete (muda a visibilidade e
-- aprova minuta) e Equipe do Gabinete (atende demanda, agenda, cadastros).
-- Nenhum dos dois entra na pirâmide: não têm ficha em apoiadores e não veem a
-- rede da campanha — é a separação mandato × campanha da regra 7 do briefing.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'usuarios'::regclass AND conname = 'usuarios_perfil_check'
       AND pg_get_constraintdef(oid) LIKE '%chefe_gabinete%'
  ) THEN
    ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_perfil_check;
    ALTER TABLE usuarios ADD CONSTRAINT usuarios_perfil_check
      CHECK (perfil IN ('admin', 'candidato', 'lideranca', 'apoiador', 'coordenador_geral', 'chefe_gabinete', 'assessor'));
  END IF;
END $$;

-- Módulo cobrado à parte (decisão de 06/11/2026): só o admin liga, no Plano do
-- candidato. Desligado, nenhuma rota do mandato responde e a página pública some.
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS modulo_mandato BOOLEAN NOT NULL DEFAULT false;

-- Dados da página pública e prazo de resposta. codigo_publico é o endereço
-- curto da página (/?mandato=<codigo>), que vai no QR Code: o UUID do
-- candidato daria um QR denso demais para imprimir pequeno.
CREATE TABLE IF NOT EXISTS mandato_config (
  candidato_id         UUID PRIMARY KEY REFERENCES usuarios(id) ON DELETE CASCADE,
  codigo_publico       TEXT UNIQUE,
  nome_publico         TEXT,
  cargo_publico        TEXT,
  municipio_publico    TEXT,
  apresentacao         TEXT,
  contato_publico      TEXT,
  prazo_resposta_dias  INT NOT NULL DEFAULT 15 CHECK (prazo_resposta_dias BETWEEN 1 AND 90),
  atualizado_por       UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  atualizado_em        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Visibilidade módulo a módulo. Sem linha = 'interno' (o padrão de todos).
-- Na página pública, 'interno' quer dizer desligada e 'publico', ligada.
CREATE TABLE IF NOT EXISTS mandato_visibilidade (
  candidato_id    UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  modulo          TEXT NOT NULL CHECK (modulo IN ('demandas','agenda','proposicoes','emendas','trabalhos',
                                                  'enquetes','prestacao_contas','pagina_publica')),
  visibilidade    TEXT NOT NULL DEFAULT 'interno' CHECK (visibilidade IN ('interno','rede','publico')),
  atualizado_por  UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  atualizado_em   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (candidato_id, modulo)
);

-- Demandas e canal de contato. "tipo" é o tipo de manifestação do canal
-- direto (pedido, reclamação, sugestão...): é a mesma fila, com protocolo,
-- prazo e resposta registrada. O protocolo é único no sistema todo.
CREATE SEQUENCE IF NOT EXISTS mandato_protocolo_seq;
CREATE TABLE IF NOT EXISTS mandato_demandas (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  candidato_id         UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  protocolo            TEXT NOT NULL UNIQUE DEFAULT ('RA-' || to_char(now(), 'YYYY') || '-' ||
                         lpad(nextval('mandato_protocolo_seq')::text, 6, '0')),
  tipo                 TEXT NOT NULL DEFAULT 'pedido' CHECK (tipo IN ('pedido','reclamacao','sugestao','elogio','denuncia','informacao')),
  titulo               TEXT NOT NULL CHECK (char_length(titulo) BETWEEN 3 AND 200),
  descricao            TEXT,
  categoria            TEXT,
  bairro               TEXT,
  cidade               TEXT,
  nicho_id             UUID REFERENCES nichos(id) ON DELETE SET NULL,
  apoiador_origem_id   UUID REFERENCES apoiadores(id) ON DELETE SET NULL,
  origem               TEXT NOT NULL DEFAULT 'gabinete' CHECK (origem IN ('gabinete','rede','publico')),
  criado_por           UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  solicitante_nome     TEXT,
  solicitante_contato  TEXT,
  consentimento_em     TIMESTAMPTZ,
  consentimento_ip     TEXT,
  -- SHA-256 do código que o cidadão recebe junto do protocolo. O protocolo é
  -- sequencial (dá para adivinhar o do vizinho); sem o código, consultar o
  -- andamento pela página pública não mostra nada.
  codigo_acomp_hash    TEXT,
  dado_sensivel        BOOLEAN NOT NULL DEFAULT false,
  publicada            BOOLEAN NOT NULL DEFAULT false,
  -- O que aparece para o público. É separado do título porque o título de quem
  -- pediu costuma ter nome, rua e número da casa.
  titulo_publico       TEXT,
  status               TEXT NOT NULL DEFAULT 'recebida' CHECK (status IN ('recebida','em_analise','encaminhada',
                         'aguardando_resposta','em_execucao','respondida','concluida','indeferida','arquivada','cancelada')),
  prazo_em             TIMESTAMPTZ NOT NULL,
  responsavel_id       UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  encaminhada_para     TEXT,
  concluida_em         TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mandato_demanda_sensivel_nao_publica CHECK (NOT (dado_sensivel AND publicada)),
  CONSTRAINT mandato_demanda_publica_tem_titulo CHECK (NOT publicada OR char_length(coalesce(titulo_publico, '')) >= 3)
);
CREATE INDEX IF NOT EXISTS idx_mandato_demandas_cand ON mandato_demandas (candidato_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mandato_demandas_origem ON mandato_demandas (apoiador_origem_id);

-- Andamento: cada troca de status ou nota. É a resposta registrada que o
-- canal de contato exige; o que não for visível ao solicitante é nota interna.
CREATE TABLE IF NOT EXISTS mandato_demanda_andamentos (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  demanda_id           UUID NOT NULL REFERENCES mandato_demandas(id) ON DELETE CASCADE,
  status_de            TEXT,
  status_para          TEXT,
  nota                 TEXT,
  visivel_solicitante  BOOLEAN NOT NULL DEFAULT true,
  autor_id             UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  autor_nome           TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mandato_andamentos ON mandato_demanda_andamentos (demanda_id, created_at);

-- Proposições: indicação, requerimento, projeto de lei, moção e ofício.
CREATE TABLE IF NOT EXISTS mandato_proposicoes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  candidato_id    UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  tipo            TEXT NOT NULL CHECK (tipo IN ('indicacao','requerimento','projeto_lei','mocao','oficio')),
  numero          TEXT,
  ano             INT CHECK (ano IS NULL OR ano BETWEEN 1990 AND 2100),
  ementa          TEXT NOT NULL CHECK (char_length(ementa) BETWEEN 3 AND 1000),
  texto           TEXT,
  status          TEXT NOT NULL DEFAULT 'protocolada' CHECK (status IN ('em_elaboracao','protocolada','em_tramitacao',
                    'em_comissao','aprovada','rejeitada','sancionada','vetada','respondida','arquivada','retirada')),
  protocolada_em  DATE,
  bairro          TEXT,
  nicho_id        UUID REFERENCES nichos(id) ON DELETE SET NULL,
  resposta        TEXT,
  publicada       BOOLEAN NOT NULL DEFAULT false,
  criado_por      UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mandato_proposicoes_cand ON mandato_proposicoes (candidato_id, created_at DESC);

CREATE TABLE IF NOT EXISTS mandato_proposicao_demandas (
  proposicao_id  UUID NOT NULL REFERENCES mandato_proposicoes(id) ON DELETE CASCADE,
  demanda_id     UUID NOT NULL REFERENCES mandato_demandas(id) ON DELETE CASCADE,
  PRIMARY KEY (proposicao_id, demanda_id)
);

-- Emendas e recursos: SÓ registro e transparência (briefing 8.2). Não há
-- ligação nenhuma com apoiador, liderança ou voto — de propósito, nem coluna
-- para isso. Vereador não tem emenda de execução obrigatória: a fase
-- "indicada" é a indicação de recurso, e resposta_executivo acompanha o que
-- a Prefeitura respondeu.
CREATE TABLE IF NOT EXISTS mandato_emendas (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  candidato_id        UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  ano                 INT NOT NULL CHECK (ano BETWEEN 1990 AND 2100),
  numero              TEXT,
  objeto              TEXT NOT NULL CHECK (char_length(objeto) BETWEEN 3 AND 500),
  valor               NUMERIC(14,2) NOT NULL CHECK (valor >= 0),
  destino             TEXT,
  bairro              TEXT,
  nicho_id            UUID REFERENCES nichos(id) ON DELETE SET NULL,
  fase                TEXT NOT NULL DEFAULT 'indicada' CHECK (fase IN ('indicada','aprovada','empenhada','paga','executada','cancelada')),
  resposta_executivo  TEXT,
  descricao_publica   TEXT,
  publicada           BOOLEAN NOT NULL DEFAULT false,
  criado_por          UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mandato_emendas_cand ON mandato_emendas (candidato_id, ano DESC);

-- Trabalhos executados (obras e ações por bairro). Foto com pessoas só vai a
-- público com autorização de imagem — trava no banco, como pede o briefing.
CREATE TABLE IF NOT EXISTS mandato_trabalhos (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  candidato_id        UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  titulo              TEXT NOT NULL CHECK (char_length(titulo) BETWEEN 3 AND 200),
  descricao           TEXT,
  bairro              TEXT,
  nicho_id            UUID REFERENCES nichos(id) ON DELETE SET NULL,
  realizado_em        DATE,
  foto_url            TEXT,
  foto_tem_pessoas    BOOLEAN NOT NULL DEFAULT false,
  autorizacao_imagem  BOOLEAN NOT NULL DEFAULT false,
  demanda_id          UUID REFERENCES mandato_demandas(id) ON DELETE SET NULL,
  proposicao_id       UUID REFERENCES mandato_proposicoes(id) ON DELETE SET NULL,
  emenda_id           UUID REFERENCES mandato_emendas(id) ON DELETE SET NULL,
  publicado           BOOLEAN NOT NULL DEFAULT false,
  criado_por          UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mandato_foto_pessoas_autorizada
    CHECK (NOT (publicado AND foto_url IS NOT NULL AND foto_tem_pessoas AND NOT autorizacao_imagem))
);
CREATE INDEX IF NOT EXISTS idx_mandato_trabalhos_cand ON mandato_trabalhos (candidato_id, realizado_em DESC);

-- Agenda com o vereador: pedido de horário (da rede ou do cidadão) e os
-- compromissos que o próprio gabinete marca. O motivo nunca vai a público.
CREATE TABLE IF NOT EXISTS mandato_agenda (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  candidato_id         UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  origem               TEXT NOT NULL DEFAULT 'gabinete' CHECK (origem IN ('gabinete','rede','publico')),
  solicitante_id       UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  solicitante_nome     TEXT,
  solicitante_contato  TEXT,
  consentimento_em     TIMESTAMPTZ,
  motivo               TEXT NOT NULL CHECK (char_length(motivo) BETWEEN 3 AND 2000),
  preferencia          TEXT,
  status               TEXT NOT NULL DEFAULT 'pedido' CHECK (status IN ('pedido','confirmado','reagendado','recusado','realizado','cancelado')),
  marcado_para         TIMESTAMPTZ,
  local                TEXT,
  resposta             TEXT,
  atualizado_por       UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mandato_agenda_cand ON mandato_agenda (candidato_id, status, created_at DESC);

-- Enquetes sobre projetos. Só quem tem login na rede vota, um voto por pessoa.
-- O voto individual nunca sai do servidor: as rotas só devolvem totais, e o
-- recorte por bairro/nicho esconde grupo com menos de 3 votos.
CREATE TABLE IF NOT EXISTS mandato_enquetes (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  candidato_id   UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  pergunta       TEXT NOT NULL CHECK (char_length(pergunta) BETWEEN 3 AND 300),
  descricao      TEXT,
  proposicao_id  UUID REFERENCES mandato_proposicoes(id) ON DELETE SET NULL,
  encerra_em     TIMESTAMPTZ,
  publicada      BOOLEAN NOT NULL DEFAULT false,
  criado_por     UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS mandato_enquete_votos (
  enquete_id  UUID NOT NULL REFERENCES mandato_enquetes(id) ON DELETE CASCADE,
  usuario_id  UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  escolha     TEXT NOT NULL CHECK (escolha IN ('a_favor','contra','abstencao')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (enquete_id, usuario_id)
);

-- Biblioteca de modelos. Os modelos do RedeApoio (iguais para todos) estão no
-- código, em services/mandatoModelos.js; aqui ficam só os que o gabinete cria.
CREATE TABLE IF NOT EXISTS mandato_modelos (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  candidato_id  UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  tipo          TEXT NOT NULL CHECK (tipo IN ('indicacao','requerimento','projeto_lei','mocao','oficio')),
  titulo        TEXT NOT NULL CHECK (char_length(titulo) BETWEEN 3 AND 200),
  nicho         TEXT,
  corpo         TEXT NOT NULL,
  dicas         TEXT,
  criado_por    UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Minutas (regra 7 do projeto: a IA nunca age sozinha). Nasce 'rascunho';
-- só vira 'aprovado' por uma pessoa da equipe, com quem e quando gravados pelo
-- servidor. aprovado_hash é o SHA-256 do texto aprovado: editou depois, o
-- servidor devolve a minuta a rascunho, e nada usa texto que não bate com o
-- hash aprovado.
CREATE TABLE IF NOT EXISTS mandato_minutas (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  candidato_id   UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  tipo           TEXT NOT NULL CHECK (tipo IN ('indicacao','requerimento','projeto_lei','mocao','oficio')),
  titulo         TEXT NOT NULL,
  modelo_ref     TEXT,
  demanda_id     UUID REFERENCES mandato_demandas(id) ON DELETE SET NULL,
  pedido         TEXT,
  texto          TEXT NOT NULL,
  origem         TEXT NOT NULL DEFAULT 'manual' CHECK (origem IN ('ia','manual')),
  modelo_ia      TEXT,
  status         TEXT NOT NULL DEFAULT 'rascunho' CHECK (status IN ('rascunho','aprovado','descartado')),
  gerado_por     UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  editado_por    UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  editado_em     TIMESTAMPTZ,
  aprovado_por   UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  aprovado_nome  TEXT,
  aprovado_em    TIMESTAMPTZ,
  aprovado_hash  TEXT,
  proposicao_id  UUID REFERENCES mandato_proposicoes(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mandato_minuta_aprovacao_completa
    CHECK (status <> 'aprovado' OR (aprovado_por IS NOT NULL AND aprovado_em IS NOT NULL AND aprovado_hash IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_mandato_minutas_cand ON mandato_minutas (candidato_id, created_at DESC);

-- Perfil de atuação: a IA sugere (status 'sugerido'), o vereador escolhe
-- ('adotado', com quem e quando) e ajusta o texto. Foco criado à mão já nasce
-- adotado. Sugestão nunca dispara nada sozinha.
CREATE TABLE IF NOT EXISTS mandato_atuacao_focos (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  candidato_id   UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  recorte        TEXT NOT NULL CHECK (recorte IN ('bairro','nicho','tema')),
  alvo           TEXT NOT NULL CHECK (char_length(alvo) BETWEEN 1 AND 200),
  diagnostico    TEXT,
  acao           TEXT NOT NULL CHECK (char_length(acao) BETWEEN 3 AND 2000),
  origem         TEXT NOT NULL DEFAULT 'manual' CHECK (origem IN ('ia','manual')),
  status         TEXT NOT NULL DEFAULT 'sugerido' CHECK (status IN ('sugerido','adotado','descartado','concluido')),
  decidido_por   UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  decidido_nome  TEXT,
  decidido_em    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mandato_focos_cand ON mandato_atuacao_focos (candidato_id, status);

-- Uso da IA do mandato (minutas e perfil de atuação), para o teto diário.
-- Só quem, quando e tokens: o texto fica na minuta ou no foco.
CREATE TABLE IF NOT EXISTS mandato_ia_uso (
  id              BIGSERIAL PRIMARY KEY,
  candidato_id    UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  usuario_id      UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  tipo            TEXT NOT NULL,
  tokens_entrada  INT,
  tokens_saida    INT,
  usado_em        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mandato_ia_uso ON mandato_ia_uso (candidato_id, usado_em DESC);
