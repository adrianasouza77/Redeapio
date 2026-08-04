# RedeApoio — contexto do projeto

Sistema de gestão de rede política em pirâmide: candidato → lideranças →
apoiadores (4 níveis). Em produção, usado por campanhas reais.

**Branch de produção: `1.0`.** A `main` está desatualizada (versão antiga
Vercel/Supabase) — não trabalhe nela.

## Leia antes de mexer no código

1. [`docs/04-referencia-tecnica.md`](docs/04-referencia-tecnica.md) — arquitetura, modelo de dados, invariantes, endpoints, limitações conhecidas
2. [`docs/05-rotinas-de-manutencao.md`](docs/05-rotinas-de-manutencao.md) — ciclo de correção, roteiro de teste, diagnóstico por sintoma

Índice completo em [`docs/README.md`](docs/README.md).

## Stack

Node 20 + Express **4** + PostgreSQL 16. Frontend em **arquivo único**
(`frontend/index.html`, HTML+CSS+JS puro, sem build). Docker **Swarm** +
Traefik + Portainer. Sem TypeScript, sem bundler, sem testes automatizados —
tudo isso é deliberado.

## Regras que não podem ser quebradas

1. **`apoiadores.id == usuarios.id`** para quem tem login. Toda liderança e
   apoiador com acesso existe nas duas tabelas com o **mesmo UUID** — é o que
   liga a pessoa aos indicados dela (`apoiadores.parent_id`). Ao criar um
   usuário com login, sempre insira a ficha em `apoiadores` passando o `id`
   explicitamente. Ignorar isso faz toda a pirâmide mostrar "0 indicados".

2. **`backend/migrations/001_init.sql` roda a cada boot do container.** Não há
   versionamento de migração. Toda instrução nova precisa ser idempotente
   (`IF NOT EXISTS`, `DO $$ ... EXCEPTION WHEN duplicate_object`). Nunca
   `DROP`/`DELETE` sem filtro. `UPDATE` de correção precisa de condição que
   deixe de valer depois de aplicada.

3. **Toda rota async precisa de `asyncHandler`.** Express 4 não captura
   rejeição de Promise — sem o wrapper, a requisição fica pendurada e o usuário
   vê "carregando" infinito.

4. **Nunca reescreva `input.value` a cada tecla no frontend.** Teclado de
   celular digita em modo composição; reescrever o value nesse meio-tempo faz o
   campo ficar vazio. Siga o padrão de `mascaraLogin()` (guarda
   `ev.isComposing` + listeners de `compositionstart`/`compositionend`).

5. **Use `req.effectiveId` / `req.effectivePerfil`** (definidos por
   `middleware/workspace.js`) em vez de `req.user.*` quando a ação for sobre a
   rede — é o que faz o admin conseguir atuar como candidato via `?as=<id>`.

6. **Não modernize o frontend.** Arquivo único com `onclick` inline é escolha
   de projeto: introduzir build quebra o fluxo de deploy.

## Convenções

- Comentários de código e mensagens de commit **em português**, explicando o
  **porquê** da decisão, não o que a linha faz
- Os comentários existentes são a memória do projeto: quase todo trecho
  estranho é a correção de um bug real. Leia antes de refatorar
- Rota nova vai no arquivo de rotas existente; tela nova vai no `index.html`
- Reproduza o bug antes de corrigir — vários só aparecem no celular ou num
  perfil específico

## Deploy

O Swarm não builda imagens. No servidor:
`git pull origin 1.0 && bash build.sh` (o script força o serviço a pegar a
imagem nova). Mudança de variável de ambiente é pelo Portainer.

**Sempre `bash scripts/backup-db.sh` antes de mexer em produção.**

## Verificar o frontend antes de commitar

```bash
node -e "const fs=require('fs');const h=fs.readFileSync('frontend/index.html','utf8');[...h.matchAll(/<script>([\s\S]*?)<\/script>/g)].forEach((s,i)=>{try{new Function(s[1]);console.log('#'+i+' OK')}catch(e){console.log('#'+i+' ERRO: '+e.message);process.exit(1)}})"
```
