# Deploy do RedeApoio no Portainer (Docker Swarm + Traefik)

Este projeto substitui o Vercel + Supabase por um stack próprio: Node/Express +
PostgreSQL, containerizado, seguindo o mesmo padrão já usado neste servidor
para outras stacks (gtw-banners, gtw-platform): Docker Swarm, rede externa
`network_public` mantida pelo Traefik, e certificado Let's Encrypt automático
via o certresolver `letsencryptresolver`.

## 0. Antes de tudo — rotacione a chave do Supabase

O arquivo `redeapoio-supabase.html` (versão antiga) tinha a **service_role key**
do Supabase hardcoded, publicada no Vercel. Qualquer pessoa que abrisse
"ver código-fonte" da página tinha acesso de administrador ao banco. Depois de
migrar os dados (passo 3), vá em **Supabase → Project Settings → API** e clique em
**"Roll" / "Reset"** na service_role key para invalidar a antiga.

## 1. Build da imagem no servidor

Como o Swarm não builda imagens a partir de `build:` no compose (só faz pull),
a imagem precisa ser buildada localmente no servidor antes do deploy — mesmo
fluxo do `gtw-banners`:

```bash
# via SSH, na pasta do projeto (depois de um git pull/clone da branch 1.0)
bash build.sh
```

Isso gera a imagem `redeapoio-app:latest` (backend + frontend em um único
container).

## 2. Subir a stack no Portainer

1. No Portainer, vá em **Stacks → Add stack**.
2. Nome: `redeapoio`.
3. Cole o conteúdo de `docker-compose.yml` deste repositório.
4. Em **Environment variables**, configure:
   - `DOMAIN` = `app.redeapoiopolitico.com.br`
   - `DB_PASSWORD` = uma senha forte
   - `JWT_SECRET` = string aleatória longa (gere com `openssl rand -hex 32`)
5. Clique em **Deploy the stack**.

Pré-requisitos que já devem existir no servidor (compartilhados com as outras
stacks, não precisa recriar):
- rede externa `network_public` (criada pela stack do Traefik)
- resolver `letsencryptresolver` configurado no Traefik

O container `redeapoio-app` aplica o schema do banco sozinho no primeiro boot
(com retry automático caso o Postgres ainda esteja subindo — `depends_on` não
garante ordem de start em modo Swarm). Não é necessário nenhum passo manual de
schema.

## 3. Migrar os dados do Supabase (rodar uma única vez)

Depois que a stack estiver de pé, rode a migração **de dentro do container do app**:

```bash
docker exec -it $(docker ps -q -f name=redeapoio_redeapoio-app) sh
# dentro do container:
SUPABASE_URL=https://bvpvsqzdvruachbgyvzq.supabase.co \
SUPABASE_SERVICE_KEY=<service_role_key_antiga> \
node scripts/migrate-from-supabase.js
```

O script:
- Importa todos os `usuarios` e `apoiadores` do Supabase, convertendo senhas em texto puro para hash bcrypt.
- Cria uma conta `admin` (login `adriana`) se ainda não existir, e imprime a senha temporária uma única vez no terminal — anote e troque depois pela tela "Esqueci minha senha".
- É seguro rodar mais de uma vez (usa `ON CONFLICT DO NOTHING`, não duplica nada).

Depois de confirmar que os dados migraram corretamente, **revogue a service_role key antiga no Supabase** (passo 0) — a partir daqui o Supabase não é mais usado.

## 4. Domínio e certificado

- Crie um registro DNS `A` para `app.redeapoiopolitico.com.br` apontando para o IP do servidor.
- O certificado SSL é emitido automaticamente pelo Traefik/Let's Encrypt via as labels já configuradas no `docker-compose.yml` (`traefik.http.routers.redeapoio.tls.certresolver=letsencryptresolver`) — não precisa de nenhuma configuração extra, desde que o DNS já esteja apontado antes do primeiro deploy (o Traefik só emite o certificado quando consegue validar o domínio).
- Se o nome da rede do Traefik ou do certresolver for diferente do que está documentado aqui, ajuste as labels do serviço `redeapoio-app` no `docker-compose.yml` antes de subir a stack.

## 5. Testar

- Acesse `https://app.redeapoiopolitico.com.br` e faça login com o candidato `dd43530d-2585-478e-97f7-36d379589dd1` (login `candidato` — a senha migrada é a mesma que já existia no Supabase).
- Confirme que todas as 6 lideranças (Pepa, Cabral, Dill, Alex, Jânio, Crislei) aparecem na tela de Usuários — o bug do filtro `.or()` não existe mais, pois a consulta agora roda no Postgres com UUID tipado.
- Teste a Central de Vagas com o login `admin` / `adriana` (revele a aba "Admin" clicando em "🔐 Acesso administrador" na tela de login).

## Atualizações futuras

Sempre que o código mudar: `git pull` no servidor, `bash build.sh` de novo, e no
Portainer clique em **Update the stack** (ou **Pull and redeploy**, se a opção
existir para imagens locais) para os containers pegarem a imagem nova.

## Backup

O volume `redeapoio_pgdata` contém todos os dados. Para fazer backup manual:

```bash
docker exec $(docker ps -q -f name=redeapoio_redeapoio-postgres) pg_dump -U redeapoio redeapoio > backup-$(date +%F).sql
```

Configure isso como uma rotina periódica (cron no host, ou um container auxiliar) assim que possível — o Supabase fazia backup automático disso, o Postgres self-hosted não faz sozinho.
