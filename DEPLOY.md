# Deploy do RedeApoio no Portainer

Este projeto substitui o Vercel + Supabase por um stack próprio: Node/Express +
PostgreSQL, tudo em containers Docker, pronto para rodar como uma Stack no Portainer.

## 0. Antes de tudo — rotacione a chave do Supabase

O arquivo `redeapoio-supabase.html` (versão antiga) tinha a **service_role key**
do Supabase hardcoded, publicada no Vercel. Qualquer pessoa que abrisse
"ver código-fonte" da página tinha acesso de administrador ao banco. Depois de
migrar os dados (passo 3), vá em **Supabase → Project Settings → API** e clique em
**"Roll" / "Reset"** na service_role key para invalidar a antiga.

## 1. Preparar o `.env`

Copie o exemplo e preencha:

```bash
cp .env.example .env
```

- `POSTGRES_PASSWORD`: senha forte para o Postgres novo.
- `JWT_SECRET`: gere com `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`.
- `PUBLIC_URL`: `https://app.redeapoiopolitico.com.br`.
- `SUPABASE_URL` / `SUPABASE_SERVICE_KEY`: só necessários para a migração de dados (passo 3), pode apagar depois.

**Nunca** commite o `.env` (já está no `.gitignore`).

## 2. Subir a stack no Portainer

1. No Portainer, vá em **Stacks → Add stack**.
2. Dê o nome `redeapoio`.
3. Cole o conteúdo de `docker-compose.yml` deste repositório (ou aponte para o repo Git, se o Portainer tiver acesso a ele).
4. Em **Environment variables**, adicione as mesmas chaves do seu `.env` (Portainer tem um campo próprio para isso — não precisa subir o arquivo `.env`).
5. Clique em **Deploy the stack**.

Isso sobe dois containers:
- `db`: Postgres 16, com o schema (`backend/migrations/001_init.sql`) aplicado automaticamente na primeira inicialização.
- `app`: a API Node + o frontend estático, na porta 3000.

## 3. Migrar os dados do Supabase (rodar uma única vez)

Depois que a stack estiver de pé, rode a migração **de dentro do container `app`**
(assim ele já enxerga o Postgres pela rede interna `redeapoio_net`):

```bash
docker exec -it <nome-do-container-app> sh
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

## 4. Apontar o domínio

- Crie um registro DNS `A` (ou `CNAME`) para `app.redeapoiopolitico.com.br` apontando para o IP do servidor onde o Portainer roda.
- Se você usa **Traefik** como proxy reverso (comum em setups Portainer): descomente as `labels` do serviço `app` no `docker-compose.yml`, ajuste a rede `traefik_public` para o nome real da sua rede do Traefik, e remova o mapeamento `ports: 3000:3000` (o Traefik expõe via rede interna).
- Se você usa **Nginx Proxy Manager** ou outro proxy: mantenha a porta `3000:3000` publicada e crie um proxy host apontando `app.redeapoiopolitico.com.br` → `<ip-do-servidor>:3000`, com SSL (Let's Encrypt) habilitado no proxy.

## 5. Testar

- Acesse `https://app.redeapoiopolitico.com.br` e faça login com o candidato `dd43530d-2585-478e-97f7-36d379589dd1` (login `candidato` — a senha migrada é a mesma que já existia no Supabase).
- Confirme que todas as 6 lideranças (Pepa, Cabral, Dill, Alex, Jânio, Crislei) aparecem na tela de Usuários — o bug do filtro `.or()` não existe mais, pois a consulta agora roda no Postgres com UUID tipado.
- Teste a Central de Vagas com o login `admin` / `adriana` (revele a aba "Admin" clicando em "🔐 Acesso administrador" na tela de login).

## Backup

O volume `db_data` contém todos os dados. Para fazer backup manual:

```bash
docker exec <nome-do-container-db> pg_dump -U redeapoio redeapoio > backup-$(date +%F).sql
```

Configure isso como uma rotina periódica (cron no host, ou um container auxiliar) assim que possível — o Supabase fazia backup automático disso, o Postgres self-hosted não faz sozinho.
