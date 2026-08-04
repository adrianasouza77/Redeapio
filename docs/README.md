# Documentação do RedeApoio

Sistema de gestão de rede política em pirâmide — candidato → lideranças →
apoiadores, até 4 níveis. Node/Express + PostgreSQL em Docker Swarm.

---

## Por onde começar

### Vou instalar num servidor novo
→ [`01-instalacao-servidor-novo.md`](01-instalacao-servidor-novo.md)

Ubuntu do zero: Docker, Swarm, Traefik, Portainer, banco, aplicação, SSL e
backup automático. 40 a 60 minutos.

### Vou mudar de servidor (levando os dados)
→ [`01`](01-instalacao-servidor-novo.md) até o passo 9, depois
[`02-backup-e-migracao.md`](02-backup-e-migracao.md#migração-completa-servidor-antigo--servidor-novo)

As senhas dos usuários migram junto — são hashes guardados no banco.

### Eu administro o sistema e quero mudar alguma coisa
→ [`03-manual-do-dono.md`](03-manual-do-dono.md)

O que dá para fazer pelo painel, o que exige mexer no servidor, e o que precisa
de programador.

### Vou programar / corrigir um bug
→ [`04-referencia-tecnica.md`](04-referencia-tecnica.md), depois
[`05-rotinas-de-manutencao.md`](05-rotinas-de-manutencao.md)

### Sou um agente de IA assumindo o projeto
→ [`../CLAUDE.md`](../CLAUDE.md) → [`04`](04-referencia-tecnica.md) →
[`05`](05-rotinas-de-manutencao.md#contexto-para-um-agente-de-ia-que-assumir-o-projeto)

### Deu problema agora
→ [`03-manual-do-dono.md#quando-algo-dá-errado`](03-manual-do-dono.md#quando-algo-dá-errado)
(sintomas comuns) ou
[`05-rotinas-de-manutencao.md#diagnóstico-por-sintoma`](05-rotinas-de-manutencao.md#diagnóstico-por-sintoma)
(diagnóstico técnico)

---

## Os documentos

| Arquivo | Para quem | Conteúdo |
|---|---|---|
| [`01-instalacao-servidor-novo.md`](01-instalacao-servidor-novo.md) | quem instala | Ubuntu do zero até o sistema no ar |
| [`02-backup-e-migracao.md`](02-backup-e-migracao.md) | quem instala / administra | backup, restauração, troca de servidor, recuperação de desastre |
| [`03-manual-do-dono.md`](03-manual-do-dono.md) | dono / administrador | operação diária, o que muda onde, rotina semanal |
| [`04-referencia-tecnica.md`](04-referencia-tecnica.md) | programador / agente | arquitetura, dados, invariantes, endpoints, dívidas técnicas |
| [`05-rotinas-de-manutencao.md`](05-rotinas-de-manutencao.md) | programador / agente | ciclo de correção, roteiro de teste, diagnóstico |

Complementos na raiz do repositório:

- [`../CLAUDE.md`](../CLAUDE.md) — contexto curto, carregado automaticamente por agentes de IA
- [`../DEPLOY.md`](../DEPLOY.md) — histórico do deploy original (julho/2025)
- `../Manual-*.pdf` — manuais de uso por perfil, para os usuários finais

## Arquivos de infraestrutura

| Arquivo | O quê |
|---|---|
| `../docker-compose.yml` | stack do RedeApoio (colar no Portainer) |
| `../infra/traefik-stack.yml` | proxy reverso + SSL automático |
| `../infra/portainer-stack.yml` | painel de administração |
| `../build.sh` | builda a imagem no servidor e força o redeploy |
| `../scripts/backup-db.sh` | backup diário (cron) |
| `../scripts/restore-db.sh` | restauração e migração |

---

## Resumo em uma tela

- **Domínio:** definido pela variável `DOMAIN` da stack
- **Branch de produção:** `1.0`
- **Serviços no Swarm:** `redeapoio_redeapoio-app`, `redeapoio_redeapoio-postgres`
- **Volume dos dados:** `redeapoio_pgdata`
- **Backups:** `/var/backups/redeapoio/` (diário às 3h, 30 dias + cópia mensal)
- **Saúde da API:** `GET /api/health` → `{"ok":true}`

```bash
# Publicar uma alteração de código
cd /opt/redeapoiopolitico && bash scripts/backup-db.sh && git pull origin 1.0 && bash build.sh

# Ver o estado de tudo
docker service ls

# Logs da aplicação
docker service logs -f redeapoio_redeapoio-app
```
