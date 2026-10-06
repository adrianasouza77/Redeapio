# 4 — Referência técnica

Estado completo do sistema para quem vai mexer no código — pessoa ou agente.
Leia isto antes de alterar qualquer coisa.

---

## Stack

| Camada | Escolha | Observação |
|---|---|---|
| Runtime | Node.js 20 (alpine) | `backend/Dockerfile` |
| API | Express **4** | Express 4 não encaminha rejeição de Promise sozinho — ver `asyncHandler` |
| Banco | PostgreSQL 16 | UUID nativo, `pgcrypto` para `gen_random_uuid()` |
| Auth | JWT em cookie httpOnly | 12 h, `jsonwebtoken` + `bcryptjs` |
| Frontend | HTML + CSS + JS puro, **arquivo único** | `frontend/index.html`, ~2.440 linhas, sem build |
| E-mail | Nodemailer / SMTP | só recuperação de senha |
| Orquestração | Docker **Swarm** | não é Compose comum |
| Proxy / TLS | Traefik + Let's Encrypt | `infra/traefik-stack.yml` |
| Painel | Portainer CE | `infra/portainer-stack.yml` |

**Sem framework de frontend, sem bundler, sem TypeScript, sem suíte de testes.**
Isso é deliberado: o sistema é operado por quem não é programador, e um único
arquivo estático elimina toda a superfície de build.

---

## Mapa dos arquivos

```
docker-compose.yml            stack de produção (Portainer)
build.sh                      builda a imagem no servidor e força o redeploy
migrate.sh                    importação única do Supabase — histórico, não usar mais
.env.example                  referência das variáveis

infra/traefik-stack.yml       proxy reverso + SSL
infra/portainer-stack.yml     painel de administração
scripts/backup-db.sh          backup diário (cron)
scripts/restore-db.sh         restauração / migração

backend/
  Dockerfile                  copia backend/src, migrations, scripts e frontend/
  migrations/001_init.sql     schema COMPLETO — reaplicado a cada boot
  src/
    server.js                 bootstrap: migrações → rotas → estático → listen
    config.js                 porta, JWT, limites padrão, versão do termo
    db.js                     pool do pg + parser de DATE
    middleware/
      auth.js                 authRequired, requireRole
      workspace.js            impersonação do admin via ?as=<candidatoId>
    routes/
      auth.js                 login, /me, logout, esqueci/redefinir senha
      usuarios.js             CRUD de liderança/apoiador (candidato/admin)
      apoiadores.js           pirâmide: árvore, hierarquia, permissões  ← núcleo
      admin.js                candidatos, planos, contrato (só admin)
      public.js               autocadastro por link (SEM autenticação)
      conta.js                autoatendimento: senha, login, aceite do termo
      config.js               limites da pirâmide por candidato
      apuracao.js             apuração ao vivo (BU do TSE × cadastrados)
      votos.js                votos por seção: qualquer candidato, estado inteiro
      nichos.js               nichos temáticos da campanha
      historico.js            desempenho eleitoral histórico por município
      ia.js                   copiloto de IA
    services/mail.js          SMTP + template de recuperação
    services/tse.js           leitura do portal de resultados do TSE (BU por seção)
    services/apuracao.js      apuração ao vivo: cruzamento com a rede + laço de busca + metas
    services/votosSecao.js    votos por seção: carga do estado (BU completo) + consultas + mapa
    services/historico.js     resultado oficial por município × rede de hoje
    services/ia.js            resumo da rede + chamada à API da Anthropic
    utils/
      asyncHandler.js         obrigatório em toda rota async
      duplicidade.js          telefone/título/e-mail repetidos na mesma rede
      limites.js              limite do candidato, com fallback global
      nivelUsuario.js         nível real de quem está logado
      password.js             bcrypt + senha temporária via CSPRNG
      termoStatus.js          precisa aceitar termo? trocar senha?
      tituloEleitoral.js      dígito verificador do título (mod 11)
      nichos.js               regra de nicho e meta, igual nos quatro cadastros
      totp.js                 código da verificação em duas etapas (RFC 6238)

frontend/index.html           TUDO do frontend
docs/                         esta documentação
```

---

## Modelo de dados

Três tabelas. Todo o schema está em `backend/migrations/001_init.sql`.

### `usuarios` — quem tem login

`id` (UUID), `nome`, `login` (único), `senha_hash`, `perfil`
(`admin` | `candidato` | `lideranca` | `apoiador` | `coordenador_geral`), `criado_por`, `email`,
dados de contato e eleitorais, `ativo`, `senha_temporaria`,
`termo_versao_aceita`, `reset_password_token`/`_expires`, `plano`,
`periodo_contrato`, `data_desativacao`, `limite_nivel1..4`.

### `apoiadores` — todo mundo na pirâmide

`id` (UUID), dados pessoais, `nivel` (1 a 4), `parent_id` (quem é o
responsável), `cadastrado_por`, `lgpd_aceite`/`_em`/`_versao`.

### `mapas_mentais` — quadro de ideias do candidato

Ferramenta de gestão do candidato (estrutura política, grupos, compromissos).
**Não tem relação com a pirâmide**: aqui não existe nível, limite nem LGPD.

`id`, `candidato_id`, `titulo`, `tipo`, `dados` (JSONB), `estado`, `cidade`, `bairro`,
`atualizado_em`.

**Dois tipos de mapa** (`tipo`), porque a campanha usa os dois:

- **`geo`** — entra pelo mapa do Brasil. Estado cinza é estado sem ninguém;
  com contatos ele ganha azul, e o azul escurece conforme a quantidade.
  Clicar abre a árvore daquele estado (MS › Dourados › Fulano). Os galhos de
  primeiro nível são os estados, cada um com um campo `uf` no nó — é ele que
  liga o galho ao mapa. O galho nasce do clique: não existe montar 27 estados
  na mão antes de usar. Pensado para governador e senador, onde a rede é
  estadual e ver 27 galhos abertos ao mesmo tempo não ajuda.
- **`livre`** — quadro de ideias solto, sem mapa geográfico.

O desenho respeita `MM.foco`: no mapa `geo` a árvore é renderizada **a partir**
do estado em que o candidato entrou (`mmRaizVisivel()`), não da raiz. As
fronteiras vêm de `frontend/br-estados.json` (87 KB, malha do IBGE com a
precisão reduzida a 3 casas — é mapa de país inteiro), carregado só nessa tela.

**O lugar do mapa é uma cascata, e o alcance é escolha do candidato.** Ele
decide se o mapa é de um estado inteiro ("DF"), de uma cidade ("MS › Dourados")
ou de um bairro ("MS › Dourados › Centro") — e pode não ter lugar nenhum, para
mapa de tema. O que não se aceita é pular degrau: cidade só existe dentro de um
estado, bairro só dentro de uma cidade. `limparLugar()` descarta a parte de
baixo quando a de cima falta, porque "Centro" solto não identifica lugar
nenhum — foi esse tipo de registro que fez o mapa geográfico posicionar bairro
no estado errado.

O seletor de mapas agrupa até a **cidade**, não até o bairro: com um grupo por
bairro, o seletor ficaria mais comprido que a lista que deveria organizar. As
sugestões de cidade e bairro no formulário saem de `APOIADORES`, que é a mesma
gente que o candidato vai mapear.

A árvore inteira mora num único JSONB, e não numa linha por nó. O mapa é
sempre lido e salvo por completo, por uma pessoa só: uma tabela de nós
exigiria dezenas de consultas para montar a tela e uma transação a cada
arrastar de galho, sem ganho nenhum em troca.

O que chega do navegador **nunca é gravado como veio**: `limparDados()` em
`routes/mapas.js` reconstrói a árvore campo a campo, descarta propriedade
inventada, recusa cor fora da paleta e aplica os tetos (2000 nós, 20 níveis,
300 caracteres por item, 30 mapas por candidato). Sem isso, um laço no
frontend — ou alguém com o console aberto — encheria o banco.

No frontend o texto do item passa por `escapeHtml()` antes de virar HTML. É
texto livre digitado pelo próprio usuário e desenhado com `innerHTML`.

### `geo_bairros` — cache de coordenadas do mapa

Uma linha por `cidade + estado + bairro` (chave única em minúsculas, porque o
mesmo bairro é digitado de formas diferentes por quem cadastra): `lat`, `lng`,
`encontrado`, `tentativas`, `atualizado_em`.

É **só cache**. Apagar a tabela inteira não perde dado de campanha — o mapa
volta a descobrir as coordenadas na primeira vez que alguém abrir a tela.

Existe porque descobrir a posição de um bairro custa uma consulta ao Nominatim
(OpenStreetMap), que aceita **1 consulta por segundo**. Sem o cache, abrir o
mapa de uma campanha com 90 bairros levaria um minuto e meio *toda vez*, e o
serviço acabaria bloqueando o IP do servidor.

`encontrado = false` grava a tentativa que falhou (bairro digitado errado, ou
sem cidade preenchida). Sem isso o sistema tentaria de novo para sempre uma
busca que nunca vai dar certo.

`versao_geo` invalida cache sem apagar linha: subir `VERSAO_GEO` no código faz
todas as linhas antigas voltarem para a fila de pendentes. Foi assim que as
coordenadas erradas da primeira versão foram descartadas sem `DELETE`.

### `geo_cidades` — cache da cidade e do retângulo dela

`cidade + estado` (chave única), `lat`, `lng` e as quatro bordas do retângulo
(`bbox_*`). Também é só cache.

**Por que a cidade vem antes do bairro.** A primeira versão procurava o bairro
no Brasil inteiro e aceitava o primeiro resultado. Numa campanha de Dourados-MS
o bairro "Centro" casou com **Uraí-PR**, e o mapa espalhou bolhas por três
estados — errado, mas com cara de certo, que é o pior defeito possível num
relatório. Agora a cidade é localizada primeiro e a busca do bairro é presa ao
retângulo dela (`bounded=1&viewbox=...`); o que cair fora é descartado.

**Quatro tentativas, da mais confiável para a menos** (`localizarBairro`):

1. **Lista da cidade** (`geo_lugares`). O município inteiro é baixado numa única
   consulta ao Overpass e guardado — são ~257 nomes para Dourados. Casar o
   bairro contra essa lista **não gasta consulta nenhuma**, e é o caminho que
   resolve mais gente: 24 de 59 bairros reais de uma campanha.
2. **Nominatim** limitado ao retângulo da cidade.
3. **Photon**, que informa em qual bairro cada resultado fica. O resultado
   **não é aceito de cara**: só vale se esse bairro bater com o procurado.
4. **Pelas ruas dos apoiadores**. Bairro que ninguém conhece pelo nome ainda
   pode ser localizado pelos endereços de quem mora nele — a cobertura de ruas
   no OSM é muito melhor que a de bairros. Uma rua sozinha não vale: são
   necessárias duas caindo a menos de 3 km uma da outra, e a posição fica
   marcada como aproximada (bolha tracejada no mapa).

**A comparação de nomes nunca usa distância de edição.** Só variações que são o
mesmo nome escrito diferente: acento, caixa, palavra genérica ("Jardim",
"PRQ"), plural, espaço a mais, numeral romano x arábico, número de casa colado
no fim. Casar por semelhança parece esperto e recria o defeito original —
medido: "Jardim Maracanã" casaria com *Vila Mariana* e "Vila Rosa" com *Vila
Roma*, que existe e é outro bairro.

**O teto é a base de dados, não o código.** Cerca de **um terço** dos bairros de
uma campanha real não existe no OpenStreetMap sob nome nenhum — Guanabara,
Pelicano, Maracanã, Vila Rosa, Monte Líbano. Nenhuma busca vai encontrá-los.
Por isso existe `PUT /geo/bairro`: o candidato aponta no mapa (ou escolhe o
nome certo na lista da cidade) **uma vez**, aquilo vira `origem = 'manual'` e
nunca mais é sobrescrito nem invalidado por `versao_geo`.

**Caminho que NÃO funciona, já testado:** geocodificar por CEP. A BrasilAPI
devolve `location.coordinates`, mas é o centro da cidade disfarçado — dois CEPs
de bairros diferentes de Dourados (79825070 e 79814490) voltam com a mesma
coordenada. Guardar o CEP melhoraria o cadastro, mas não posiciona ninguém.

_(o que segue é o detalhe das duas fontes de busca por texto)_

**Nominatim e Photon erram diferente** (`localizarBairro`, passos 2 e 3):

1. **Nominatim** limitado ao retângulo da cidade. Quando acha, é o resultado
   mais confiável. Mas a maioria dos bairros brasileiros não está no índice de
   busca dele — numa amostra de 8 bairros de Dourados, só 3 foram encontrados.
2. **Photon** (outro índice do mesmo OpenStreetMap), que informa em qual bairro
   cada resultado fica. O resultado **não é aceito de cara**: só vale se o
   bairro que ele informa bater com o procurado, comparando sem acento, sem
   caixa e sem as palavras genéricas ("Jardim", "Vila", "Parque"...). Sem essa
   conferência, "Jardim Paulista" voltaria como uma pizzaria no Jardim América.

Com as duas, 6 dos 8 bairros da amostra são posicionados; os 2 restantes são
**recusados de propósito** e o mapa os agrupa numa bolha tracejada no centro da
cidade, dizendo que a posição é aproximada. Bairro sem cidade no cadastro nem
chega a ser procurado — buscar só pelo nome é exatamente o que trazia a cidade
errada.

### `apuracao_config` e `apuracao_secoes` — apuração ao vivo

Cruza o boletim de urna (BU) de cada seção, publicado pelo TSE, com quantos
apoiadores a rede cadastrou naquela seção. **Só entra o total de votos do
candidato por seção**, que é dado público: nada identifica o voto de ninguém.

`apuracao_config` (uma linha por candidato): `ciclo` (`ele2026`), `pleito`
(código do turno no TSE), `uf`, `municipio` (código TSE, só em eleição
municipal), `cargo` (como aparece no BU: `VEREADOR`, `DEPUTADO FEDERAL`...),
`numero`, `ativo`, `ultima_busca`, `ultimo_erro`.

`apuracao_secoes`: uma linha por seção **já apurada**, chave
`(candidato_id, ciclo, pleito, zona, secao)`. Seção sem linha = "aguardando
BU". `fonte` é `tse` ou `manual` (colado à mão, plano B).

Decisões que não são óbvias:

- **De onde vem o dado** (`services/tse.js`): o portal
  `resultados.tse.jus.br`, o mesmo do site e do app oficiais. Não há API
  documentada; o caminho é lista de seções do estado (`-cs.json`) → índice da
  seção (`-aux.json`) → BU em texto (`-imgbu.dat`, Latin-1). Conferido em
  set/2026 com a eleição de 2024: a soma das seções de Dourados bateu com o
  total oficial do candidato. Se o TSE mudar o formato, é esse arquivo que
  quebra — e o erro aparece na tela, nunca vira "0 votos".
- **Seção agregada**: duas seções que votam na mesma urna saem no mesmo BU.
  O cadastrado da agregada é contado na seção principal (campo `nsp` do TSE).
- **Município obrigatório para prefeito/vereador**: o mesmo número existe em
  cidades diferentes, e uma zona pode cobrir mais de um município.
- **Zona inteira**: busca todas as seções das zonas onde a rede tem alguém,
  não só as seções com cadastrado — é o que permite comparar os cadastrados
  da zona com o voto do candidato na zona toda.
- **Laço no servidor** (`services/apuracao.js`, `iniciar()`): a cada minuto,
  até 600 seções por candidato com `ativo`, 8 em paralelo; primeiro as seções
  com cadastrado. Seção apurada não é buscada de novo.
- **Trocar número, cargo ou município apaga** os resultados daquela eleição
  (eram de outra pessoa). Trocar de eleição não apaga: ciclo/pleito estão na chave.
- **Cobertura média** = soma dos votos das seções apuradas ÷ soma dos
  cadastrados dessas mesmas seções (regra da especificação, feita no
  navegador porque muda com o filtro de zona).

Para testar sem esperar a eleição: configurar a eleição de 2024 com o número
de algum candidato daquele ano.

### Nichos, meta de votos e papéis — o "mapa mental de nichos"

Especificação da dona (set/2026, "Mapa Mental de Nichos, IA e Diagnóstico
Eleitoral"). Três dimensões independentes de cada pessoa: **papel** (nível),
**território** (cidade/bairro/zona/seção, que já existiam) e **nicho**.

- **Papéis**: os níveis 1–4 passaram a se chamar Líder, Coordenador,
  Mobilizador e Apoiador Orgânico (`PAPEIS` no frontend). É só nome: a
  pirâmide, os limites e as permissões não mudaram.
- **`nichos`** (`candidato_id`, `nome`, `cor`) — criados pelo candidato na aba
  **Mapa Mental → Nichos da rede** (a especificação manda os nichos para a aba
  já existente); nome único por campanha sem diferenciar maiúscula.
- **`apoiador_nichos`** — N:N; apagar nicho ou pessoa apaga só a ligação.
- **`apoiadores.meta_votos`** — **obrigatória** para os níveis 1–3 (regra da
  especificação): o cadastro recusa sem ela; na edição, se o campo vier vazio,
  também recusa. Quem desce para o nível 4 perde a meta.
- **`apoiadores.indicado_por_texto`** — "Quem te indicou?", opcional, só no
  link geral do candidato para o nível 4. Texto livre de propósito: o
  formulário é público, e oferecer a lista de nomes da rede para escolher
  exporia a rede a quem abrisse o link.

`utils/nichos.js` concentra a regra, usada pelos quatro caminhos de cadastro
(painel da liderança, tela de usuários, link público, edição):

- nicho de outra campanha é descartado em silêncio;
- **obrigatório só quando a campanha tem nichos criados** — campanha que não
  usa nichos cadastra exatamente como antes;
- na edição, campo ausente = não mexer (tela antiga em cache não apaga nada).

`GET /apoiadores` devolve `nichos` (ids) em cada pessoa (`anexarNichos`, uma
consulta para a rede inteira).

### Meta × resultado (Telas 3 e 4)

Calculado em `services/apuracao.js` (`calcularMetas`) e mostrado dentro da
Apuração ao Vivo:

- **por zona**: soma das metas de quem mora na zona × votos do candidato na zona inteira;
- **por responsável**: meta da pessoa × votos nas urnas onde ela **e toda a
  equipe abaixo dela** votam (cada urna conta uma vez). É o mais perto que dá
  para chegar sem saber o voto de ninguém — e ninguém sabe: o voto é secreto.
- verde ≥ 80%, amarelo 50–79%, vermelho abaixo de 50% (faixas do briefing
  "Votos por seção" de 05/10/2026; até então eram 100% e 70%).

### `tse_urnas`, `tse_coletas`, `tse_locais` — Votos por Seção

Tela "📍 Votos por Seção" (briefing de 05/10/2026): Eleição › Cargo ›
Candidato — **qualquer** candidato, não só o da campanha — e a tela mostra
onde ele teve voto no estado inteiro, por cidade, bairro, escola e urna, no
mapa e em tabela, cruzado com onde a rede tem gente cadastrada.

A diferença para a apuração ao vivo: lá se busca **um número**, só nas zonas
da rede, e guarda-se só o voto dele. Aqui o **boletim inteiro** de cada urna
do estado é baixado uma vez (`services/votosSecao.js`), com todos os cargos e
candidatos, e qualquer consulta depois é só leitura do banco.

- **`tse_urnas`** — uma linha por urna (seção principal), sem `candidato_id`:
  dado público, compartilhado entre campanhas. `cargos` é JSONB
  `{ "<cód. cargo>": { v:{número:votos}, l:{partido:legenda}, b, n, vv } }`.
  Uma linha por urna em vez de uma por candidato: MS ocupa 8 MB; SP (~100 mil
  urnas) seria 15 milhões de linhas no outro formato.
- **`tse_coletas`** — andamento da carga de um estado (botão "Carregar o
  estado"). Laço único no servidor, 10 pedidos simultâneos ao TSE: MS (7.106
  urnas) leva ~4,5 min, AC (2.270) ~1,5 min. Retoma sozinho depois de reinício.
  "Atualizar do TSE" marca `refazer_desde` e baixa tudo de novo sem apagar.
- **`tse_locais`** — dados abertos do TSE ("eleitorado por local de votação"):
  escola, endereço, **bairro e latitude/longitude** de cada seção. O ZIP
  nacional tem ~90 MB; o servidor lê o índice do ZIP e baixa por `Range` só o
  CSV do estado (MS: 0,6 s). Em 2026 todas as 7.284 seções de MS vieram com
  bairro e coordenada.
- **Comparecimento, brancos e nulos são guardados aqui**, como total da urna.
  A especificação da apuração ao vivo proibia guardar comparecimento (e
  `apuracao_secoes` continua sem); o briefing de 05/10/2026 pede "% brancos +
  nulos" por seção, e a dona do sistema seguiu o briefing novo.
- **Válidos e nulos seguem o critério do TSE**, não o BU cru: voto em número
  que não está na lista oficial como válido (registro negado/anulado) vira
  nulo; "anulado sub judice" sai dos válidos e não entra nos nulos.
- **Conferido em 05/10/2026** contra o resultado oficial: os 712 candidatos dos
  5 cargos de MS e AC batem voto a voto, e válidos e brancos+nulos também.
  A tela mostra "✓ A soma das N urnas bate com o total oficial do TSE".
- **Mapa:** malha municipal do IBGE (mesma fonte do projeto eleicoes2026,
  casada pelo código IBGE `cdi` do `mun-e…-cm.json`) pintada por votos, % dos
  válidos, brancos+nulos ou "quem venceu em cada cidade"; aproximando, cada
  escola vira um círculo do tamanho dos votos, com borda dourada onde a rede vota.
- **Desempenho:** consulta de um candidato em MS ~0,3–0,9 s (resposta em gzip,
  ~200 KB); repetida, ~0,15 s (cache de 1 min amarrado ao andamento da carga
  — sem isso um resultado parcial era servido como final).

### Briefing "Votos por seção" v2 (05/10/2026) — candidato, importação, Prometido × Entregue e redes

Especificação da dona: `Briefing_Rede_Apoio_Votos_por_Secao_v2.pdf` e
`Manual_Cliente_Rede_Apoio_Votos_por_Secao.pdf`. Sem Supabase/RLS/`tenant_id`
(não existem neste projeto): o isolamento entre clientes é o de sempre, pelo
candidato dono da rede, e agora também pela rede.

**`candidato_dados` + `candidato_municipios`** (aba 🎯 Candidato): ano, turno,
cargo (código TSE: 13 vereador, 11 prefeito, 7 dep. estadual, 6 federal,
5 senador, 3 governador), número (texto), partido, UF, abrangência
(`municipio` | `municipios` | `estado`), nome de urna, faixas do sinal
(`faixa_verde`/`faixa_amarela`, padrão 80/50) e os códigos do portal do TSE
(`ciclo`/`pleito`/`eleicao`, resolvidos ao salvar — podem ficar nulos se o TSE
ainda não publicou a eleição; a importação tenta de novo). Município sempre
pelo código do TSE (o do IBGE é recusado). Dígitos por cargo: vereador e
estadual 5, federal 4, prefeito/governador/senador 2 ou 3. Salvar também
grava `apuracao_config`: a apuração ao vivo lê o mesmo cadastro.

**`importacoes_tse`** (botão "Importar votos do TSE"): histórico e auditoria
(quem, quando, origem, linhas, seções, municípios, total × oficial,
`confere`). Os votos **não** são copiados por candidato: ficam em `tse_urnas`
(uma linha por urna, todos os candidatos), então reimportar é o mesmo upsert e
nunca duplica. Decisões:
- **Só os municípios do candidato** (pedido da dona: "não quero que fique
  baixando tudo"): `tse_coletas.municipios` limita a carga. Campanha de estado
  todo baixa só os municípios onde a rede vota (pelo `municipio_votacao` ou pela
  zona/seção). Botão "Carregar o estado" de Votos por Seção continua baixando o
  estado inteiro (`municipios` NULL).
- **Fonte = boletim de urna**, não o ZIP `votacao_secao_{ANO}_{UF}` do briefing:
  mesmo número (conferido voto a voto), sai na noite da eleição e já traz
  brancos, nulos, comparecimento e aptos por seção.
- Confere com o total oficial só quando a importação cobre o que o oficial
  cobre (cidade inteira em vereador/prefeito); campanha estadual por
  municípios mostra o total do estado sem comparar.
- Conferido em 05/10/2026: vereadora 10222 de Dourados/2024 → 2.992 votos em
  534 seções = oficial; reimportar baixou só as 566 urnas da cidade.

**Onde a pessoa vota** (`apoiadores.municipio_votacao`/`_nome`,
`local_votacao`/`_nome`): nos cinco formulários, gravado por
`utils/votacao.js` num UPDATE logo depois de cada cadastro. Escolas vêm de
`tse_locais` pelo ano da eleição ou o mais próximo que o TSE tiver
(`anoLocais`: em out/2026 o arquivo de 2024 não estava mais no ar). **Título
de eleitor não é mais pedido nem gravado** (`titulo` fica nulo nos cadastros
novos; edição sem o campo não apaga o que existe — limpar os antigos é
decisão à parte, com backup).

**Relatório Prometido × Entregue** (`services/entrega.js`, aba ✅): por Líder,
Coordenador e Mobilizador, as urnas onde votam ele e toda a equipe abaixo
(mesma árvore da pirâmide: `parent_id` ou quem cadastrou) × votos do
candidato nelas. Meta = `meta_votos` ou, vazia, o tamanho da rede abaixo.
"Seção compartilhada" = a mesma urna na área de duas pessoas do mesmo nível;
conta inteira para as duas. Visão por zona/seção ordenada por % brancos+nulos
(÷ comparecimento; em senador de 2 vagas, ÷ 2×comparecimento). Filtros de
território valem para as urnas; nível/nicho/liderança para as linhas. Quem vê:
candidato (e admin/CG no workspace) tudo; Líder e Coordenador só a própria
rede, em cada candidato a que estão ligados; Mobilizador e Apoiador, 403.

**Cartão da pirâmide e ficha "Prometido × entregue"** (`GET /entrega/ao-vivo`):
pedido em áudio da dona — zona, seção, cadastros, votos e % da meta no próprio
cartão, e a ficha seção por seção com os nomes de quem vota em cada uma. Usa a
**apuração ao vivo** (`calcularMetas`), que já existe em produção e só busca as
zonas da rede. A Apuração ao Vivo ganhou a tabela por seção e os nomes por seção.

**Rede com vários candidatos** (`redes`, `usuarios.rede_id`,
`usuarios.rede_ver_outros`, `apoiador_candidatos`, perfil `coordenador_geral`):
- Todo candidato tem uma rede (o boot cria "Rede de X" para quem não tem);
  `coordenador_geral_id` nulo = rede de um candidato só, como sempre foi.
- O admin cria o Coordenador Geral (Central de Vagas → "Redes com vários
  candidatos") e põe candidatos na rede; o CG também cria candidatos.
- O CG entra nos candidatos da rede dele com o mesmo `?as=` do admin
  (`middleware/workspace.js`); `requireRole` deixa o CG passar onde o candidato
  passa **só dentro desse workspace**. Seletor de candidato no topo.
- **Vínculo** (`apoiador_candidatos`): a ficha fica na pirâmide do candidato
  onde a pessoa foi cadastrada primeiro; cada outro candidato guarda nível,
  superior (sem FK, como `parent_id`) e meta. `SQL_ARVORE_CANDIDATO` devolve
  a pessoa vinculada com esses campos trocados (`jsonb_populate_record`) e
  `vinculo = true`; sem vínculo, devolve exatamente o de antes. Quem é
  cadastrado num candidato debaixo de uma pessoa vinculada também vira vínculo
  (ficha sem `parent_id`), para não vazar para a pirâmide do outro.
- `PUT /apoiadores/:id` de pessoa vinculada: papel/superior/meta vão para o
  vínculo; os dados pessoais, para a ficha (a mesma para todos).
- Cadastro com telefone (só dígitos) de alguém de outro candidato da rede:
  409 com `vincular` (a tela oferece o vínculo); no link público, o vínculo é
  feito sozinho. Alerta quando a pessoa está em dois candidatos do **mesmo
  cargo** (metas competem); cargos diferentes ("dobradinha") é permitido.
- O termo de consentimento lista os candidatos da rede.

**Mapa (Fase 2)**: camada no Mapa da Rede com `GET /entrega?locais=1` —
escola do tamanho dos votos, cor pela entrega no local (votos ÷ metas de quem
vota ali) ou por brancos+nulos, escolas sem ninguém da rede (vazio territorial)
e os apoiadores de sempre. O Copiloto de IA recebe `votos_por_local` (maiores
escolas sem rede e metas maiores que os eleitores das seções) — só lê e sugere.

### `historico_config`, `resultado_urna`, `resultado_urna_municipio` — desempenho histórico (Tela 5)

Resultado oficial de uma eleição passada, por município, de **todos** os
candidatos do cargo (`services/historico.js`). `resultado_urna` não tem
`candidato_id` de propósito: é dado público igual para todas as campanhas,
baixado uma vez e reaproveitado (eleição encerrada não muda).

- Fonte: `<ciclo>/<eleicao>/dados/<uf>/<uf><mun>-c<cargo>-e<eleicao>-u.json`
  (com nome e partido) e `-v.json` (eleitores aptos; o único que existe para
  presidente). Eleições conferidas: 2024 (619/620) e 2022 (544–547).
- **Comparecimento não é guardado em lugar nenhum** — a especificação da
  apuração proíbe. Só os eleitores aptos (tamanho do eleitorado), que é o
  "total de votantes históricos" usado para apontar meta irrealista, por
  zona e pelas seções de cada responsável.
- **A posição é calculada pelos votos.** O campo `seq` do TSE parece ranking
  mas não é — em Dourados/2024 a vereadora com 2.992 votos vinha com `seq` 30.
- A rede é casada com o município pelo **nome da cidade sem acento**, dentro
  do estado. Cidade digitada errada fica fora (a tela mostra quantos).
- "Liderança formal" = Líder ou Coordenador (níveis 1 e 2).

### `ia_insights` — copiloto de IA

`services/ia.js`. Monta um **resumo só com contagens** (papéis, nichos,
territórios sem liderança, gargalos, metas, apuração e histórico quando
configurados) e chama a API da Anthropic (`@anthropic-ai/sdk`, modelo
`IA_MODELO`, padrão `claude-sonnet-5`, como pede a especificação) com saída
estruturada em JSON (`output_config.format`). **Nenhum nome, telefone ou
título sai do servidor.** Cada leitura é gravada (reabrir o painel não gasta
chamada) e há teto diário por campanha (`IA_LIMITE_DIA`). Sem
`ANTHROPIC_API_KEY`, tudo funciona e o painel avisa que falta ativar.
Segue o princípio [a IA nunca age sozinha](#ia-aprovacao-humana): só produz
alertas para leitura.

Desde 06/10/2026 (pedido da dona), de 3 a 8 alertas:

- **Território eleitoral é a seção, nunca a zona.** O rótulo é sempre
  `Zona 18 · Seção 123`: o número da seção se repete em toda zona, e somar a
  "Seção 10" de zonas diferentes mistura urnas sem relação. Cada seção leva a
  zona **dela** (`secoesDetalhe` da apuração), não a do responsável — a
  equipe pode votar em mais de uma zona. Na apuração, a agregada conta na
  principal, como em `services/apuracao.js`.
- **`por_lideranca`**: cada Líder (até 30, os de rede maior primeiro) com a
  própria rede nos 4 níveis, as seções onde ela está (`so_base` = seção só
  com Apoiador, sem Líder/Coordenador/Mobilizador), os Coordenadores dele e,
  com apuração, meta × votos nas urnas da equipe. O card é do tipo
  `rede_da_lideranca`.
- **Pessoas vão como código**, nunca nome: `Líder 3`, `Coordenador 3.1`,
  `Mobilizador 3.1.2` (o número diz de quem é equipe; sem Líder acima fica
  sob o `0`). Vale também para `votos_por_local`. O mapa código → pessoa é
  propriedade não enumerável do resumo e não entra no JSON;
  `trocarCodigos()` põe o nome no texto depois que a resposta volta. Código
  que a IA inventou fica como veio. Em `ia_insights`, `resumo` guarda só
  códigos e `insights` guarda o texto já com nome.
- Meta **não** é somada por seção no resumo: a de um Líder cobre a rede
  inteira, e somá-la na seção onde ele mora dava urna com meta dez vezes
  maior que os cadastrados. Meta × voto é por liderança.

### `ia_ajuda_uso` — assistente de ajuda

`services/ajuda.js` + `services/ajuda-base.md`. Botão "❓ Ajuda" para
**qualquer perfil com login**: chat que tira dúvida de **uso** do sistema.
Escopo fechado por exigência da dona (02/10/2026): só fala do RedeApoio, não
consulta dado de ninguém, não gera código nem texto de campanha.

- A IA **não recebe ferramenta nem dado da rede** — só o guia
  `ajuda-base.md` e o perfil de quem pergunta (ex.: "Coordenador"). É isso
  que garante que ela não vaza dado: não há de onde tirar, mesmo que alguém
  convença o modelo a tentar.
- O prompt (no próprio `ajuda.js`) recusa qualquer assunto fora do sistema
  com uma frase fixa; resposta com bloco de código é trocada por essa frase
  no servidor.
- **A pergunta e a resposta não são guardadas.** `ia_ajuda_uso` tem só
  quem, quando e tokens, para o teto diário por pessoa
  (`IA_AJUDA_LIMITE_DIA`). A conversa vive na memória da página e some ao
  sair.
- Modelo `IA_MODELO_AJUDA` (padrão `claude-opus-5-5`), esforço `low`,
  guia em cache de prompt, com `fallbacks: "default"` (se o filtro de
  segurança do modelo recusar por engano, a API tenta outro modelo).
- Dentro da [regra 7](#ia-aprovacao-humana): a resposta é texto lido só por
  quem perguntou; nada é enviado, publicado ou alterado.

**`ajuda-base.md` precisa acompanhar o `index.html`:** é tudo o que a IA
sabe. Tela, botão ou mensagem de erro que mudar e não for atualizada lá vira
resposta errada da ajuda.

### <a id="ia-aprovacao-humana"></a>Princípio obrigatório: a IA nunca age sozinha

Regra de arquitetura definida pela dona do sistema (set/2026), com base na
**Resolução TSE 23.748/2026**, em vigor para as eleições de 2026: nenhuma ação
de IA no RedeApoio pode agir, publicar ou enviar nada por conta própria. Se o
sistema disparar ou publicar algo gerado por IA sem aprovação humana, o
candidato que usa a plataforma corre risco jurídico-eleitoral — e isso cai
sobre a credibilidade da plataforma. **Não há exceção**, nem "só desta vez",
nem para envio agendado.

**A regra:**

1. Toda saída de IA é **rascunho** (conteúdo) ou **alerta** (leitura). Nunca
   um efeito.
2. Efeito prático — enviar mensagem, publicar, disparar em massa, gravar ou
   alterar dado da rede — só acontece **depois** que uma pessoa aprovar
   aquele item específico.
3. A aprovação fica **registrada**: quem aprovou e quando.

**Situação hoje:** o Copiloto (`services/ia.js`) já está dentro da regra — ele
só gera alertas para leitura. Nenhuma rota dele envia, publica ou altera a
rede; a única escrita é guardar a própria leitura em `ia_insights`. O
assistente de ajuda (`services/ajuda.js`) também: só devolve texto para quem
perguntou, sem ferramenta e sem acesso à rede.

**Padrão para qualquer módulo novo com IA** (a começar pela comunicação em
massa):

- tabela própria com `status` (`rascunho` → `aprovado` | `descartado`) — o
  conteúdo gerado nasce sempre `rascunho`;
- `aprovado_por` (id de `usuarios`) e `aprovado_em` (timestamp), preenchidos
  **pelo servidor** a partir da sessão, nunca vindos do navegador;
- o que é aprovado é o **texto exato** que será enviado: editou depois de
  aprovar, volta a `rascunho` e precisa de nova aprovação;
- a rota que produz o efeito (enviar, publicar) **recusa** qualquer item que
  não esteja `aprovado`, e confere isso no banco, não em parâmetro da tela;
- a aprovação entra também no log de auditoria (`registrar`, ação
  `ia.aprovar`), que sobrevive à exclusão do item;
- nada de job, laço de fundo ou agendamento que pegue saída de IA e aja com
  ela sem passar por esse estado `aprovado`.

Se uma funcionalidade nova "precisar" pular a aprovação, a resposta é não —
leve à dona do sistema antes de escrever código.

### Segurança (seção 9 da especificação)

- **Isolamento**: toda rota já filtra por candidato (`req.effectiveId`); as
  novas também. O que a especificação chama de RLS do Supabase não se aplica
  — o sistema é Postgres próprio, e o isolamento é feito no servidor.
- **O admin vê tudo, sempre** — decisão da dona do sistema, que é o suporte de
  todos os clientes. A especificação pedia que nem o admin lesse as campanhas
  "no dia a dia"; isso chegou a ser feito (bloqueio pelo candidato) e foi
  retirado antes de ir ao ar, porque impedia justamente o suporte. O controle
  virou transparência: cada abertura de workspace vira `workspace.abrir` no log
  (no máximo uma por 30 min por admin/campanha), e o candidato vê esse
  registro em Minha Conta. **Não reintroduza um bloqueio sem falar com ela.**
- **Verificação em duas etapas** (`utils/totp.js`, RFC 6238 escrito à mão com
  `crypto`, conferido com os vetores oficiais): opcional; ligar exige provar
  um código antes de valer, para ninguém se trancar fora.
- **Registro de acessos** (`GET /conta/acessos`): login, falhas, exportações
  (avisadas pela tela via `POST /conta/evento`, já que o arquivo é montado no
  navegador), aberturas do suporte e mudanças de segurança.
- **Não feito**, por decisão: criptografia de coluna do telefone (quebraria a
  checagem de duplicidade e a busca por telefone) — a proteção em repouso é a
  do disco do servidor, que é configuração da hospedagem.

### `termos_aceite` — trilha de auditoria da LGPD

Uma linha por aceite, **nunca sobrescrita**: `usuario_id` **ou** `apoiador_id`
(exatamente um dos dois, garantido por CHECK), `versao_termo`, `aceite_em`,
`ip`, `user_agent`.

### `auditoria` — log de tudo que acontece no sistema

`id` (BIGSERIAL, também é o cursor de paginação), `ocorrido_em`,
`candidato_id` (workspace onde aconteceu; NULL quando é o admin agindo fora de
um workspace), `ator_id`/`ator_nome`/`ator_perfil`, `como_admin`, `acao`,
`alvo_tipo`/`alvo_id`/`alvo_nome`, `detalhes` (JSONB), `ip`, `user_agent`.

Três decisões de projeto que não são óbvias:

- **Nenhuma chave estrangeira.** O log precisa sobreviver à exclusão da
  pessoa. Com `CASCADE`, apagar um apoiador apagaria junto a prova de que ele
  existiu — que é justamente o que se quer consultar depois; com `RESTRICT`,
  ninguém conseguiria mais excluir ninguém. Por isso `ator_nome` e `alvo_nome`
  são gravados **por cópia**, e não resolvidos por JOIN na hora da leitura.
- **`como_admin`** separa o que o candidato fez do que o admin fez atuando
  como ele (`?as=<id>`). Sem essa marca o log culparia o candidato por
  mudanças que ele não fez.
- **Gravação fora da transação da rota.** Se o log entrasse no mesmo client da
  transação, um `ROLLBACK` apagaria o registro da tentativa — que é exatamente
  o que se quer poder auditar. `utils/auditoria.js` também nunca lança: falha
  ao gravar vai para o console do servidor e a ação do usuário segue.

Só o **Administrador Geral** lê, por `GET /api/admin/logs` e
`GET /api/admin/logs/pessoa/:id`. Não há tela nem rota para os outros perfis.

---

## As invariantes que não podem ser quebradas

### 1. `apoiadores.id == usuarios.id` para quem tem login

**Esta é a regra mais importante do sistema.**

Toda liderança e todo apoiador com login existe em **duas** tabelas: em
`usuarios` (o acesso) e em `apoiadores` (a ficha na pirâmide). As duas linhas
**compartilham o mesmo UUID**.

Por quê: quem essa pessoa cadastra grava `apoiadores.parent_id = <id do usuário>`.
Se a ficha-espelho tivesse um id próprio (um `gen_random_uuid()` qualquer),
nenhuma consulta conseguiria ligar a pessoa aos apoiadores dela — todo mundo
apareceria com "0 apoiadores". **Foi exatamente esse o bug que existiu no
sistema original**, e as linhas 71-79 do `001_init.sql` são o reparo dos dados
antigos.

Consequência prática: **qualquer código novo que crie um usuário com login
precisa inserir a ficha em `apoiadores` passando o id explicitamente.** Nunca
deixe o default gerar.

Os três lugares que fazem isso hoje — use-os como modelo:
- `routes/usuarios.js` (candidato cria liderança/apoiador)
- `routes/public.js` (autocadastro de nível ≤ 3)
- `001_init.sql` (reparo de dados legados)

### 2. `001_init.sql` roda em TODO boot e precisa ser idempotente

Não existe sistema de versionamento de migração. O `server.js` lê o arquivo
inteiro e executa a cada inicialização do container.

Portanto, **toda instrução nova precisa poder rodar mil vezes sem efeito
colateral**:

- `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
- Constraint: dentro de `DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN NULL; END $$;`
- `UPDATE` de correção de dados: sempre com uma condição que deixa de valer
  depois de aplicado (ex: `WHERE a.titulo IS NULL`), senão ele sobrescreve
  edições legítimas do usuário a cada reinício
- **Nunca** `DROP TABLE`, `DROP COLUMN` ou `DELETE` sem filtro

### 3. Toda rota async precisa de `asyncHandler`

```js
router.get('/x', asyncHandler(async (req, res) => { ... }));
```

Express 4 não captura rejeição de Promise. Sem o wrapper, um erro de banco não
tratado deixa a requisição pendurada para sempre — o usuário vê um "carregando"
infinito, sem erro nenhum. Foi corrigido em massa no commit `60bf94c`.

### 4. Níveis 1 a 3 têm login; nível 4 não

`criaLogin = novoNivel <= 3` (`routes/public.js`). Nível 4 é só contato: existe
apenas em `apoiadores`, sem linha em `usuarios`.

### 5. `apoiadores.parent_id` **não tem** chave estrangeira — e não pode ter

O responsável de alguém na pirâmide pode estar em **duas tabelas diferentes**:
um apoiador comum (sem login) só existe em `apoiadores`; o candidato e a
liderança que emitiu o link só existem em `usuarios`. Nenhuma chave
estrangeira consegue apontar para dois lugares.

A coluna nasceu como `REFERENCES usuarios(id)`, de quando só liderança podia
ser responsável. Isso quebrou a reorganização de hierarquia: mover alguém para
baixo de um apoiador **sem login** violava a FK (erro `23503`) e o usuário via
apenas *"Erro interno. Tente novamente."*. Funcionava com um responsável e não
com outro, sem padrão aparente — e nem o admin escapava. A migração remove a
restrição.

Duas consequências que precisam ser lembradas em toda alteração:

1. **Quem valida é o app**, não o banco: `PUT /apoiadores/:id` confere que o
   responsável está na rede de quem edita e exatamente um nível acima.
2. **`ON DELETE SET NULL` se perdeu junto** — as rotas de exclusão
   (`DELETE /apoiadores/:id` e `DELETE /usuarios/:id`) precisam rodar
   `UPDATE apoiadores SET parent_id = NULL WHERE parent_id = <excluído>` **antes**
   do DELETE. Sem isso os apoiadores apontam para um id que não existe mais e
   somem da pirâmide sem aviso.

### 6. O driver do `pg` devolve DATE como string

`db.js` registra `types.setTypeParser(1082, val => val)`. Sem isso, uma data de
nascimento vira `Date` do JS, e ao serializar em JSON vira
`"1969-02-07T00:00:00.000Z"` — quebrando a exibição. Não remova.

---

## Autenticação e autorização

### Fluxo de sessão

1. `POST /api/auth/login` com `{ login, senha, perfil }` — aceita login **ou**
   e-mail no campo `login`; `perfil` vem da aba escolhida na tela
2. Valida bcrypt, checa `data_desativacao` do candidato dono da rede
3. Assina JWT (12 h) e devolve em cookie `httpOnly` + `sameSite: lax`
   (`secure` só em produção)
4. O frontend usa `credentials: 'include'` em todo `fetch`
5. `authRequired` lê o cookie; aceita `Authorization: Bearer` como alternativa
   para chamadas via curl/script

Um `401` em qualquer chamada faz o frontend deslogar automaticamente
(`api()` em `frontend/index.html`).

### Camadas de permissão

| Camada | Onde | O que faz |
|---|---|---|
| `authRequired` | `middleware/auth.js` | exige sessão válida |
| `requireRole(...)` | idem | restringe por perfil |
| `resolveWorkspace` | `middleware/workspace.js` | admin atua "como" candidato via `?as=<id>` |
| `podeGerenciar()` | `routes/apoiadores.js` | valida que o alvo está na árvore de quem pede |

`resolveWorkspace` define `req.effectiveId` / `req.effectivePerfil`. **Use
sempre esses dois** em vez de `req.user.id` quando a ação for sobre a rede —
é isso que faz a Central de Vagas funcionar.

### As duas consultas de árvore

Estão no topo de `routes/apoiadores.js` e concentram toda a lógica de "quem vê
quem":

- **`SQL_ARVORE_CANDIDATO`** — desce por `usuarios.criado_por` a partir do
  candidato e traz todos os `apoiadores` ligados a qualquer nó da árvore. Usada
  para candidato e admin.
- **`SQL_ARVORE_LIDERANCA`** — desce por `apoiadores.parent_id`. Necessária
  porque, depois que a liderança reorganiza a hierarquia, o `parent_id` passa a
  apontar para outro apoiador, e a primeira consulta perderia os níveis 3 e 4.

---

## Regras de negócio

### Limites da pirâmide

Cascata: `usuarios.limite_nivel1..4` do candidato → se `NULL`, cai nas
variáveis `LIMITE_NIVEL1..4` → se ausentes, `50 / 30 / 15 / 10`
(`utils/limites.js` + `config.js`).

Verificados em três pontos: cadastro autenticado, autocadastro por link (só no
modo pessoal, onde existe um pai definido) e reorganização de hierarquia.

### Duplicidade

Duas coisas diferentes, que são fáceis de confundir:

**Bloqueio no cadastro** — `utils/duplicidade.js`, **dentro da mesma rede de
candidato**: e-mail (em `usuarios`), telefone e título de eleitor (em
`apoiadores` — essa tabela cobre todo mundo, com e sem login).

**Conferência depois** — `GET /apoiadores/duplicados` (candidato/admin), a
tela "Cadastros duplicados". Agrupa por **quatro** critérios, cada grupo
rotulado com o que casou: nome, telefone, título de eleitor e e-mail de
acesso. Antes só olhava o nome, que é o critério mais fraco que existe numa
campanha (dois "José Carlos da Silva" na mesma cidade é rotina) — e a mesma
pessoa cadastrada duas vezes com o nome escrito diferente nunca aparecia.

Telefone e título são comparados **só pelos dígitos**: `(67) 99999-9999` e
`67999999999` são o mesmo telefone. Valor com menos de 8 dígitos é descartado
em vez de agrupado — a ficha-espelho de quem tem login nasce com telefone `—`
(ver `usuarios.js`), e sem esse corte toda liderança apareceria como duplicada
de todas as outras.

**O sistema não guarda CPF.** O que identifica o eleitor aqui é o título
(+ zona e seção). Se um dia entrar, precisa entrar em `usuarios`, `apoiadores`,
nos formulários, no export, em `duplicidade.js` e nos dois pontos acima.

### Busca global do administrador

`GET /api/admin/buscar?q=` responde "essa pessoa está em qual campanha?" —
procura nome, telefone, título, login e e-mail **atravessando todos os
workspaces**, e devolve o candidato dono de cada resultado e por qual campo
cada um casou.

É a **única** consulta do sistema que atravessa workspaces. Candidato e
liderança enxergam só a própria rede, de propósito: quando o mesmo
nome/telefone/título chega por duas campanhas, ninguém dentro delas consegue
perceber. Por isso a rota vive em `routes/admin.js`, atrás do
`requireRole('admin')` aplicado no topo do arquivo.

O CTE recursivo `dono` resolve de uma vez o candidato de cada usuário subindo
por `criado_por`; sem ele seria preciso uma consulta por resultado só para
descobrir de quem é a rede — que é justamente a informação procurada.

### Reorganização de hierarquia

`PUT /api/apoiadores/:id` com `nivel` + `parent_id`. Validações, nesta ordem:

1. Só liderança ou candidato/admin podem reorganizar
2. Nível destino ∈ {2, 3, 4}
3. O responsável precisa estar exatamente **um nível acima**
4. Não se pode pendurar alguém sob um descendente dele mesmo (evita ciclo)
5. O novo responsável não pode estourar o limite do nível dele

### Primeiro acesso obrigatório

`utils/termoStatus.js` responde duas perguntas a cada login:

- `precisaTrocarSenha` — `senha_temporaria = true`, quando a senha foi
  escolhida por outra pessoa
- `precisaAceitarTermo` — `termo_versao_aceita != TERMO_VERSAO` atual

Qualquer uma verdadeira bloqueia o painel até ser resolvida. **Admin fica de
fora** — não opera dados de terceiros.

### Encerramento de contrato

`data_desativacao` no candidato. No login (`routes/auth.js`), se a data já
passou, bloqueia **o candidato e toda a rede criada por ele**. Nada é apagado.

### Recuperação de senha

Token aleatório de 32 bytes; o banco guarda só o **SHA-256** dele, com validade
de 1 hora. O link vai por e-mail com o token em claro. Redefinir também zera
`senha_temporaria` — sem isso a pessoa cairia na tela de primeiro acesso logo
depois de já ter escolhido a senha.

---

## Endpoints

Todos sob `/api`. `[A]` = exige sessão.

### `/auth`
| Método | Rota | Quem | O quê |
|---|---|---|---|
| POST | `/login` | público | login ou e-mail + senha + perfil |
| GET | `/me` `[A]` | qualquer | dados da sessão |
| POST | `/logout` | qualquer | limpa o cookie |
| POST | `/esqueci-senha` | público | envia link (exige e-mail cadastrado) |
| POST | `/redefinir-senha` | público | consome o token |

### `/usuarios` `[A]`
| Método | Rota | Quem |
|---|---|---|
| GET | `/` | candidato, admin |
| GET | `/verificar-login?login=` | qualquer logado |
| POST | `/` | candidato, admin |
| PUT | `/:id` | candidato, admin |
| PUT | `/:id/senha` | candidato, admin |
| DELETE | `/:id` | candidato, admin |

### `/apoiadores` `[A]`
| Método | Rota | Quem |
|---|---|---|
| GET | `/` | qualquer (a árvore muda conforme o perfil) |
| GET | `/duplicados` | candidato, admin |
| GET | `/geo` | qualquer (só lê o cache, nunca consulta serviço externo) |
| POST | `/geo/resolver` | candidato, admin (lotes de 8 consultas externas) |
| GET | `/geo/lugares` | qualquer (lista oficial de lugares da cidade) |
| PUT | `/geo/bairro` | candidato, admin (posição marcada à mão) |
| POST | `/` | liderança, apoiador |
| PUT | `/:id` | quem passa em `podeGerenciar` |
| PUT | `/:id/senha` | idem (alvo precisa ter login) |
| POST | `/:id/acesso` | idem — cria o login **com o mesmo id da ficha** (nível 2 ou 3 sem login); recusa se a pessoa já tiver login em outra ficha (mesmo telefone/título) |
| DELETE | `/:id` | idem |

### `/mapas` `[A]` — candidato, admin
`GET /` (lista, sem o campo `dados`), `POST /`, `GET /:id`, `PUT /:id`
(título e/ou árvore), `DELETE /:id`. Todas escopadas por `req.effectiveId`,
então o admin só enxerga os mapas do workspace que abriu.

Fica em arquivo próprio (`routes/mapas.js`), contrariando a convenção de
concentrar rotas: `apoiadores.js` é o arquivo mais delicado do sistema
(árvore recursiva, permissões, limites) e não tem nada a ver com isto —
misturar aumentaria o risco de mexer na pirâmide sem querer.

### `/apuracao` `[A]` — candidato, admin
| Método | Rota | O quê |
|---|---|---|
| GET | `/` | painel: seções da rede, zonas, alertas de cadastro |
| GET | `/pleitos` | eleições publicadas pelo TSE (`ele-c.json`) |
| GET | `/municipios?ciclo=&pleito=&uf=` | municípios do estado naquela eleição |
| PUT | `/config` | eleição, UF, município, cargo, número, ativo |
| POST | `/buscar` | roda uma rodada de busca no TSE agora |
| POST | `/manual` | importa `zona;seção;votos` colado (plano B) |

Arquivo próprio (`routes/apuracao.js`), pelo mesmo motivo do `/mapas`.

### `/votos` `[A]` — candidato, admin
| Método | Rota | O quê |
|---|---|---|
| GET | `/eleicoes` | turnos publicados pelo TSE, com as eleições e cargos de cada um |
| GET | `/municipios?ciclo=&eleicao=&uf=` | municípios (código TSE + IBGE) |
| GET | `/candidatos?ciclo=&eleicao=&uf=&cargo=[&municipio=]` | lista oficial com foto, votos e situação |
| GET | `/coleta?ciclo=&pleito=&uf=` | andamento da carga do estado |
| POST | `/coleta` | começa (ou refaz, `refazer:true`) a carga do estado |
| GET | `/resultado?…&cargo=&numero=[&secoesDoMunicipio=]` | o candidato por cidade, bairro, local e seção, × rede |
| GET | `/lideres?ciclo=&pleito=&uf=&cargo=` | 1º e 2º de cada município (mapa "quem venceu") |
| GET | `/malha/:uf` | malha municipal do IBGE (cache de um dia) |

Prefeito e vereador exigem `municipio` (o número se repete de cidade em cidade).

### `/candidato` `[A]` — candidato, admin (CG no workspace)
`GET /` (dados + rede), `GET /eleicoes`, `GET /municipios?ciclo=&eleicao=&uf=`,
`GET /candidatos?…&cargo=[&municipio=]`, `PUT /` (salva e sincroniza a
apuração), `POST /importar`, `GET /importacao` (fecha a importação quando a
carga termina). Qualquer perfil da rede: `GET /votacao/municipios` e
`GET /votacao/locais?zona=&municipio=` (formulários). Públicos equivalentes:
`/public/votacao/municipios` e `/public/votacao/locais` (`?candidato=` ou `?lideranca=`).

### `/entrega` `[A]`
`GET /` (relatório; filtros `municipio zona bairro nivel nicho lideranca`,
`candidato=` para quem tem mais de um, `locais=1` para o mapa),
`GET /pessoa/:id` (ficha em cada candidato), `GET /ao-vivo` (cartões da
pirâmide, com a apuração ao vivo). Permissões no topo do arquivo.

### `/redes` `[A]`
`GET /` (rede, candidatos, alertas de mesmo cargo), `PUT /` (nome — CG),
`POST /candidatos` e `PUT /candidatos/:id` (`ver_outros`) — CG,
`POST /importar-todos` — CG, `GET /painel`, `GET /liderancas`,
`GET /dobradinha?a=&b=` (CG ou candidato liberado), `GET /pessoas?q=`,
`POST /vincular`, `PUT /vinculos/:apoiadorId`, `DELETE /vinculos/:apoiadorId`
(candidato no workspace). Liderança: `POST /apoiadores/vincular`.
Admin: `GET /admin/redes`, `POST /admin/coordenadores`,
`PUT /admin/candidatos/:id/rede`.

### `/nichos` `[A]`
`GET /` (qualquer perfil da rede lê), `POST /`, `PUT /:id`, `DELETE /:id` (candidato, admin).

### `/historico` `[A]` — candidato, admin
`GET /eleicoes`, `GET /` (visão por município), `GET /municipios`,
`GET /municipio/:codigo`, `PUT /config`.

### `/ia` `[A]` — candidato, admin
`GET /` (situação e última leitura), `POST /gerar`. Exceção: `GET /ajuda`
(situação e uso do dia) e `POST /ajuda` (`{ mensagens: [{role, content}] }`)
valem para **qualquer perfil logado** — ficam antes do `router.use` que
restringe o resto do arquivo.

### `/conta` — segurança `[A]`
`GET /seguranca`, `POST /2fa/iniciar` | `/2fa/ativar` | `/2fa/desativar`,
`GET /acessos` (só candidato), `POST /evento`.

### `/admin` `[A]` — só admin
`GET /candidatos`, `POST /candidatos`, `PUT /candidatos/:id/senha`,
`PUT /candidatos/:id/plano`, `PUT /candidatos/:id/login`,
`PUT /candidatos/:id/email`

| Método | Rota | O quê |
|---|---|---|
| GET | `/buscar?q=` | busca pessoa em **todos** os workspaces (mín. 3 caracteres, ou 4 dígitos) |
| GET | `/logs?candidato=&acao=&q=&antesDeId=` | linha do tempo do sistema; `acao` casa por prefixo (`apoiador` pega criar/editar/mover/excluir) |
| GET | `/logs/pessoa/:id` | histórico de uma pessoa — como alvo **e** como ator |

> `/logs` pagina por `antesDeId` (o `id` da última linha), não por OFFSET: o
> log cresce enquanto a tela está aberta e o OFFSET repetiria linhas.

### `/public` — **sem autenticação**
| Método | Rota | O quê |
|---|---|---|
| GET | `/lideranca/:id` | contexto do link pessoal |
| GET | `/convite?candidato=&nivel=` | contexto do link por nível |
| POST | `/autocadastro` | cria o cadastro (transação) |

> Estas três são a única superfície pública que escreve no banco. Qualquer
> alteração aqui merece atenção redobrada: validação de título, LGPD,
> duplicidade e limites são aplicados neste ponto.

### `/conta` `[A]`
`POST /aceitar-termo`, `PUT /senha` (pede a atual), `PUT /login` (idem)

### `/config` `[A]`
`GET /` (qualquer logado lê), `PUT /` (só candidato)

### Saúde
`GET /api/health` → `{"ok":true}`

---

## Frontend

Arquivo único, `frontend/index.html`. Organizado em blocos marcados por
comentários `// ═══`. Funções globais chamadas por `onclick` inline — **não é
um padrão a ser "modernizado"**: é o que mantém o arquivo sem build.

Estado global: `currentUser`, `currentRole`, `APOIADORES`, `CONFIG`,
`workspaceAdmin`.

Helpers do modo workspace (admin atuando como candidato) — use sempre estes ao
adicionar tela nova:

```js
papelEfetivo()   // 'candidato' quando o admin abre um workspace
idEfetivo()      // id do candidato do workspace, ou do usuário logado
wsQuery()        // '?as=<id>' para anexar à URL da API
```

### Organograma e mapa mental compartilham o motor

Duas telas desenham uma árvore grande dentro de uma janelinha e precisam do
mesmo comportamento. Em vez de duas cópias que divergem com o tempo, três
peças são compartilhadas:

- **`mmCalcularLayout(raiz, medir)`** — posição de cada nó.
- **`mmCaminho(x1,y1,x2,y2)`** — a ligação em ângulo reto entre pai e filho.
- **`pzAplicar` / `pzZoom` / `pzAjustar` / `pzLigarGestos`** — mover, aproximar,
  encaixar na tela e os gestos. Recebem o estado por parâmetro (`MM` ou `ORG`),
  então a mesma função serve as duas telas.

O **organograma** (`ORG`, dentro de Gráficos da Rede) monta a árvore a partir de
`APOIADORES` seguindo `parent_id`, com o candidato na raiz. Quem está sem
responsável — o caso de quem entra pelos links por nível do candidato — é
pendurado no candidato em vez de sumir do desenho.

Ele abre **recolhido do nível 2 para baixo** (`ORG_PROFUNDIDADE_ABERTA`): numa
rede de mil pessoas, abrir tudo desenha mil cartões medidos um a um pelo
navegador, e no celular isso trava. "Abrir tudo" acima de
`ORG_AVISO_ACIMA_DE` pede confirmação.

### Gráficos: agrupamento e detalhamento

`grupoGrafico` é `cidade`, `bairro` ou `zona`. Quando é `cidade`, clicar numa
linha do ranking define `cidadeFoco` e **todos os cards passam a olhar só
aquela cidade**, detalhando por bairro — `baseGrafico()` filtra e `chaveGrupo()`
troca para bairro. Sem isso, "Centro" de Dourados e "Centro" de Juti apareciam
somados na mesma fatia.

### Mapa mental: onde está a regra

Quase tudo é DOM e gesto, mas duas funções concentram a lógica e podem ser
testadas sem navegador:

- **`mmCalcularLayout(raiz, medir)`** devolve a posição de cada nó. `x` cresce
  um passo por nível; `y` empilha por folha e o pai fica centrado entre o
  primeiro e o último filho. Recebe a função de medida em vez de ler o DOM
  justamente para poder ser testada — a largura real vem de `offsetWidth`,
  porque nó de largura fixa ou corta nome comprido ou deixa um vazio enorme.
- **`mmCaminho(x1,y1,x2,y2)`** monta a ligação em ângulo reto com canto
  arredondado entre pai e filho.

Gestos usam **Pointer Events** (um só conjunto de handlers para mouse, dedo e
caneta). Com mouse e touch separados, o tablet dispara os dois e os dois
arrastos se atrapalham. O `touch-action:none` no viewport é o que impede o
navegador de roubar o gesto para rolar a página.

Tela cheia tenta a API nativa e cai numa classe CSS `position:fixed` quando
ela não existe — o Safari do iPhone não tem `requestFullscreen`, e é no
celular que a tela cheia mais faz falta.

O mapa salva sozinho ~1s depois da última mudança. Salvar a cada tecla
afogaria o servidor; salvar só no botão perderia trabalho.

### Endereço por tela (`#/exportar`, `#/mapa`)

`showPage()` grava a tela atual no `location.hash` e um listener de
`hashchange` faz o caminho de volta. `PAGINAS_POR_PAPEL` diz quais telas cada
perfil enxerga; endereço fora da lista cai na tela inicial do perfil em vez de
deixar a área de conteúdo em branco.

Isso resolve botão "voltar" do celular, F5 e link direto para uma tela — **não
é controle de acesso**. Quem impede alguém de ver dado alheio é o servidor,
que exige sessão (`authRequired`) e perfil (`requireRole`) em toda rota da API.
A lista do frontend é conveniência de navegação, e ponto.

`PAGINAS_SO_ADMIN` (`busca-pessoa`, `logs`) é somada à lista do perfil quando
`currentRole === 'admin'`. Precisa ser somada, e não ser uma lista à parte,
porque o admin dentro de um workspace navega com as páginas do **candidato** —
sem isso, abrir o log a partir da pirâmide cairia na tela inicial.

### Telas exclusivas do Administrador Geral

O menu `#nav-admin-extra` fica visível para o admin nas duas situações: na
Central de Vagas e **dentro** do workspace de um candidato (que esconde
`#nav-admin` e mostra o do candidato). Ele vem depois das outras seções na
marcação por um motivo prático: o menu do rodapé no celular usa a primeira
seção visível, e esta não pode roubar esse lugar.

- **Buscar pessoa** (`renderBuscaPessoa`) — resultados agrupados por campanha,
  com aviso em vermelho quando o mesmo termo aparece em mais de uma. Cada
  resultado diz **por qual campo** casou; sem isso, procurar por telefone
  devolve uma lista de nomes sem relação óbvia com o que foi digitado.
- **Log do sistema** (`renderLogs`) — `LOG_ACOES` traduz `auditoria.acao` para
  português; ação desconhecida (servidor mais novo que a tela) cai no genérico
  em vez de sumir da lista. `logDetalhes()` monta o "de → para" a partir do
  JSONB de `detalhes`.
- **Ícone 📜** na tabela de apoiadores, no modal de detalhe e na tela de
  duplicados → `abrirLogPessoa()`, o histórico daquele cadastro.

### Excel e PDF gerados no navegador, sem biblioteca

Não há bundler nem CDN para bibliotecas, então os dois formatos são escritos à
mão em `frontend/index.html`:

- **`criarXLSX(abas)`** monta o ZIP do `.xlsx` (método *store*, sem compressão)
  com CRC32 próprio. Vale o trabalho: renomear CSV para `.xls` faz o Excel
  abrir com aviso de "o formato não corresponde à extensão" e a campanha achar
  que o arquivo veio corrompido. Número sai como número (dá para somar).
- **`criarPDF(doc)`** escreve um PDF 1.4 usando Helvetica, fonte que todo
  leitor já traz embutida — por isso o arquivo sai pequeno e o sistema continua
  funcionando sem internet. Texto vai em `WinAnsiEncoding`, que cobre o
  português inteiro; a tabela de larguras do Helvetica está embutida para
  alinhar números à direita e cortar nome comprido no lugar certo.

Ao mexer nesses dois, rode o teste de mesa: gere um arquivo, abra no Excel e
num leitor de PDF de verdade. Erro de offset no `xref` (PDF) ou no diretório
central (ZIP) produz arquivo que *parece* certo e não abre.

### Armadilha de celular: nunca reescreva `input.value` a cada tecla

No Android (Gboard) e no iOS, o teclado digita em **modo composição**: mantém a
palavra em aberto enquanto sugere correções. Se um handler `oninput` reescrever
`this.value` nesse meio-tempo, **o teclado descarta a composição inteira e o
campo fica vazio** — a pessoa digita e nada aparece. No desktop o bug não
existe, porque teclado físico não usa composição.

Foi o que aconteceu com os campos de login (corrigido em `41b2acb`,
agosto/2026). O padrão correto está em `mascaraLogin()`:

1. Sai da função se `ev.isComposing` (ou se `data-compondo === '1'`)
2. Ouve `compositionstart` / `compositionend` no `document` para cobrir campos
   criados dinamicamente
3. Só atribui `input.value` se o texto realmente mudou
4. Restaura a posição do cursor com `setSelectionRange`

Os campos de login carregam `data-login`, que é como os listeners delegados os
encontram. **Ao criar qualquer campo novo com máscara, siga esse mesmo
padrão** — inclusive as máscaras numéricas, que hoje escapam só porque
`inputmode="numeric"` desliga as sugestões do teclado.

---

## Infraestrutura

### Por que Swarm e não Compose

O servidor já rodava outras stacks nesse modelo. O Swarm dá reinício
automático, limites de memória, `docker service scale` e as labels que o
Traefik lê.

**Consequência:** o Swarm **não builda imagens** — só baixa. Por isso
`build.sh` roda no servidor. E como o Swarm compara imagens pela *tag*
(`latest`), um "Update the stack" sozinho não troca o container; o `build.sh`
resolve isso com `docker service update --force`.

### Redes

- **`network_public`** (externa, criada pelo Traefik) — só o app está nela
- **`redeapoio_internal`** (`internal: true`) — Postgres e app. O banco não tem
  porta publicada e não alcança a internet

### Variáveis de ambiente

| Variável | Obrigatória | Efeito |
|---|---|---|
| `DOMAIN` | sim | Host das labels do Traefik |
| `DB_PASSWORD` | sim | senha do Postgres — gravada no volume no 1º boot |
| `JWT_SECRET` | sim | **o app não sobe sem ela** (`server.js` faz `exit(1)`) |
| `PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE` | sim | lidas direto pelo driver |
| `PUBLIC_URL` | sim | usada nos links de e-mail e de autocadastro |
| `SMTP_*` | não | sem elas, recuperação de senha falha em silêncio |
| `TERMO_VERSAO` | não | padrão `1.0` |
| `LIMITE_NIVEL1..4` | não | padrão 50/30/15/10 |
| `FRONTEND_DIR` | não | `/frontend` no container |
| `SUPABASE_*` | não | **histórico** — migração única já concluída |
| `ANTHROPIC_API_KEY` | não | liga o copiloto de IA; sem ela o resto funciona |
| `IA_MODELO` | não | padrão `claude-sonnet-5` |
| `IA_LIMITE_DIA` | não | leituras de IA por campanha por dia, padrão 30 |
| `IA_MODELO_AJUDA` | não | modelo do assistente de ajuda, padrão `claude-opus-5-5` |
| `IA_AJUDA_LIMITE_DIA` | não | perguntas à ajuda por pessoa por dia, padrão 40 |

> Variáveis discretas do Postgres em vez de uma `DATABASE_URL` montada: senhas
> fortes contendo `/ @ : #` quebrariam o parser de URL de conexão.

---

## <a id="limitacoes-conhecidas"></a>Limitações conhecidas e dívidas técnicas

Verificadas na leitura do código em 4 de agosto de 2026. Nada aqui está
quebrado a ponto de impedir o uso — são pontos a resolver quando houver espaço.

### 1. IP registrado no aceite do termo é o do proxy, não o do visitante

**Impacto: legal.** `routes/public.js` e `routes/conta.js` gravam `req.ip` em
`termos_aceite` como prova de consentimento (LGPD art. 8º, §2º). Mas o
`server.js` nunca chama `app.set('trust proxy', ...)`, então o Express usa o IP
do socket — que é o do container do Traefik. **Todos os aceites registrados até
hoje têm IP interno do Docker**, sem valor probatório.

Correção (uma linha, em `server.js`, antes das rotas):

```js
app.set('trust proxy', true);   // Traefik é quem preenche o X-Forwarded-For
```

Depende de o Traefik publicar as portas em `mode: host` — que é como
`infra/traefik-stack.yml` já faz, justamente por isso. Registros antigos não
são recuperáveis.

### 2. "Nome do Candidato" e "Idealizadora" não são salvos

Em Configurações, os dois campos só alteram o objeto `CONFIG` na memória do
navegador. `salvarConfig()` envia ao servidor apenas os limites. Recarregou,
voltou ao valor fixo. Precisaria de colunas em `usuarios` e de inclusão no
`PUT /api/config`.

### 3. Sem testes automatizados

Não há suíte. Toda validação é manual. O roteiro de teste está em
[`05-rotinas-de-manutencao.md`](05-rotinas-de-manutencao.md).

### 4. Sem versionamento de migração

`001_init.sql` cresce e é reaplicado inteiro a cada boot. Funciona e é seguro
enquanto tudo for idempotente, mas o boot fica gradualmente mais lento e um
erro de idempotência pode corromper dados silenciosamente a cada reinício.

### 5. Sem rate limiting

`POST /api/auth/login` e `POST /api/public/autocadastro` aceitam requisições
ilimitadas. Um `express-rate-limit` no login e no autocadastro seria a próxima
melhoria de segurança mais valiosa.

### 6. Senha mínima de 4 caracteres

Escolha deliberada, pelo público do sistema. Vale saber que é o menor
denominador de segurança em vigor.

### 7. `migrate.sh` e `SUPABASE_*` são resíduo histórico

A migração do Supabase foi concluída em julho de 2025. O script e as variáveis
não têm mais uso — podem ser removidos numa limpeza futura.

### 8. O repositório vive dentro do Google Drive (só no Windows da autora)

O Drive injeta arquivos `desktop.ini` dentro de `.git/refs/`, e o Git passa a
avisar `bad object refs/desktop.ini` em `git log --all` e `git branch -a`. É
cosmético — commits e push funcionam. Limpeza:

```powershell
Get-ChildItem .git -Recurse -Filter desktop.ini -Force | Remove-Item -Force
```

Não afeta o servidor: lá o clone é limpo.

---

## Histórico resumido

O sistema nasceu como página única no Vercel com Supabase, e a
`service_role key` estava **hardcoded no HTML publicado** — qualquer visitante
com "ver código-fonte" tinha acesso de administrador ao banco.

A branch `1.0` reescreveu tudo: Node/Express + Postgres próprio, containerizado
(commit `469c153`, julho/2025). Marcos desde então:

| Commit | Entrega |
|---|---|
| `469c153` | migração Vercel+Supabase → Docker+Postgres |
| `4d512fd` | adequação ao Swarm + Traefik |
| `6c956d9` | cookie httpOnly, CEP nacional, recuperação por e-mail |
| `bb3759c` | admin abre workspace de qualquer candidato |
| `5d1344e` | correção do bug de "0 apoiadores" (invariante do id-espelho) |
| `9132ed7` | validação do dígito verificador do título de eleitor |
| `11aee34` | 4º nível, LGPD versionada, plano e desativação de candidato |
| `3ba553a` | limites da pirâmide passam a persistir por candidato |
| `4029812` | design mobile: navegação estilo app |
| `711d738` | autocadastro vira login (níveis 2-3), data digitável |
| `bce98d4` | candidato gera links de cadastro por nível |
| `7de5947`, `6cb2653` | liderança redefine senha e edita login/e-mail da própria rede |
| `41b2acb` | correção do campo de login vazio no celular (composição do teclado) |

Histórico completo: `git log --oneline 1.0`.
