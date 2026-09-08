# 2 — Backup, restauração e migração entre servidores

Tudo que envolve mover ou proteger os dados: backup automático, restauração,
e a mudança completa de um servidor para outro sem perder cadastro nem senha.

---

## O que precisa de backup (e o que não precisa)

| O que | Precisa de backup? | Por quê |
|---|---|---|
| **Banco Postgres** (volume `redeapoio_pgdata`) | **SIM — é tudo** | usuários, apoiadores, senhas, aceites de LGPD |
| Variáveis da stack no Portainer | **SIM** | `DB_PASSWORD` e `JWT_SECRET` não estão no repositório |
| Certificados do Traefik (volume `traefik_certs`) | opcional | são reemitidos sozinhos; ajuda a não bater no limite semanal |
| Código da aplicação | não | está no GitHub, branch `1.0` |
| Imagem Docker | não | é reconstruída com `bash build.sh` |
| Volume do Portainer | não | só configuração do painel, refeita em minutos |

**A conclusão prática:** com o dump do banco + as variáveis da stack anotadas,
você consegue reconstruir o sistema inteiro do zero em qualquer servidor.

---

## Backup automático diário

Já instalado no passo 12 da instalação. Confira que está de pé:

```bash
crontab -l | grep backup-db
ls -lh /var/backups/redeapoio/
tail -20 /var/log/redeapoio-backup.log
```

O que o `scripts/backup-db.sh` faz a cada execução:

1. Localiza o container do Postgres
2. Gera um dump no formato custom (`-Fc`, já comprimido)
3. **Valida o arquivo** — tamanho mínimo e leitura do índice pelo próprio
   Postgres. Um dump corrompido é apagado em vez de ficar dando falsa
   segurança
4. No dia 1º de cada mês, guarda uma cópia permanente em `mensal/`
5. Apaga os diários com mais de 30 dias (a pasta `mensal/` nunca é limpa)

### Cópia para fora do servidor

Backup guardado só no mesmo servidor do banco não protege contra o cenário
mais comum de perda total: o servidor sumir. No fim do `scripts/backup-db.sh`
há duas opções comentadas — descomente uma:

**Para outro servidor via SSH:**

```bash
# no servidor do RedeApoio, uma vez:
ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_backup
ssh-copy-id -i ~/.ssh/id_backup.pub usuario@ip-do-outro-servidor
# depois descomente a linha do scp no script
```

**Para nuvem (Google Drive, OneDrive, S3, Backblaze) via rclone:**

```bash
curl https://rclone.org/install.sh | sudo bash
rclone config      # assistente interativo; dê ao remoto o nome "remoto"
# depois descomente a linha do rclone no script
```

### Teste de restauração — faça a cada 3 meses

Um backup que nunca foi restaurado é uma suposição, não uma garantia. A cada
trimestre, restaure o backup mais recente num servidor de teste (ou numa VM
descartável) e confirme que o sistema abre e os dados estão lá. Vale marcar no
calendário.

---

## Backup manual (antes de qualquer mudança arriscada)

Rode isso antes de atualizar código, mexer em configuração ou fazer uma
exclusão em massa:

```bash
bash /opt/redeapoiopolitico/scripts/backup-db.sh
```

Leva poucos segundos e já deixa a saída pronta para restaurar.

---

## Restaurar um backup

```bash
# Ver o que existe
ls -lh /var/backups/redeapoio/

# Restaurar
bash /opt/redeapoiopolitico/scripts/restore-db.sh /var/backups/redeapoio/redeapoio-2026-08-04_0300.dump
```

O script pede confirmação digitada (`RESTAURAR`), tira o app do ar durante a
operação e — antes de sobrescrever qualquer coisa — **salva o estado atual**
num arquivo `ANTES-DA-RESTAURACAO-*.dump`. Se a restauração não trouxer o que
você esperava, dá para voltar exatamente de onde saiu.

Ao final ele mostra as contagens (`X usuários / Y apoiadores / Z aceites`) —
compare com o que você esperava antes de considerar concluído.

---

## Migração completa: servidor antigo → servidor novo

Roteiro para trocar de servidor mantendo todos os cadastros, senhas e
históricos. **As senhas dos usuários continuam funcionando** — elas são hashes
bcrypt guardados no banco e viajam junto no dump.

### Antes de começar — anote do servidor ANTIGO

No Portainer antigo, **Stacks → redeapoio → Editor**, copie os valores de:

- `DB_PASSWORD`
- `JWT_SECRET`
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`
- `DOMAIN`

> **Sobre reaproveitar os segredos:** você pode gerar um `DB_PASSWORD` novo
> sem problema (o banco novo nasce com ele). Já o `JWT_SECRET`, se for
> diferente, derruba as sessões abertas — todo mundo precisa fazer login de
> novo. Não é grave, mas escolha conscientemente.

### Etapa 1 — Montar o servidor novo

Siga [`01-instalacao-servidor-novo.md`](01-instalacao-servidor-novo.md) até o
**passo 9**, com duas diferenças:

- No passo 4 (DNS), use um **subdomínio temporário** — ex:
  `novo.seudominio.com.br` — para não derrubar o sistema que está em produção
- **Pule o passo 10** (criar administrador). As contas virão no backup

Ao final, o servidor novo tem a stack no ar com o banco vazio.

### Etapa 2 — Gerar o dump no servidor antigo

```bash
ssh root@IP_DO_SERVIDOR_ANTIGO
bash /opt/redeapoiopolitico/scripts/backup-db.sh
ls -lh /var/backups/redeapoio/
```

Anote o nome do arquivo mais recente.

### Etapa 3 — Transferir o arquivo

**Opção A — direto entre os servidores** (mais rápido; rode no servidor antigo):

```bash
scp /var/backups/redeapoio/redeapoio-AAAA-MM-DD_HHMM.dump \
    root@IP_DO_SERVIDOR_NOVO:/var/backups/redeapoio/
```

**Opção B — passando pelo seu computador** (quando não há SSH direto entre os
dois). No PowerShell do Windows:

```powershell
scp root@IP_ANTIGO:/var/backups/redeapoio/redeapoio-AAAA-MM-DD_HHMM.dump .
scp .\redeapoio-AAAA-MM-DD_HHMM.dump root@IP_NOVO:/var/backups/redeapoio/
```

Confirme a integridade comparando o hash nos dois lados — um arquivo truncado
na transferência só apareceria como problema na hora de restaurar:

```bash
# nos DOIS servidores, o resultado precisa ser idêntico
sha256sum /var/backups/redeapoio/redeapoio-AAAA-MM-DD_HHMM.dump
```

### Etapa 4 — Restaurar no servidor novo

```bash
ssh root@IP_DO_SERVIDOR_NOVO
bash /opt/redeapoiopolitico/scripts/restore-db.sh \
     /var/backups/redeapoio/redeapoio-AAAA-MM-DD_HHMM.dump
```

Confira as contagens exibidas ao final contra o servidor antigo:

```bash
# rode nos DOIS, os números têm que bater
docker exec $(docker ps -q -f name=redeapoio_redeapoio-postgres) \
  psql -U redeapoio -d redeapoio -tAc \
  "SELECT (SELECT count(*) FROM usuarios) || ' / ' ||
          (SELECT count(*) FROM apoiadores) || ' / ' ||
          (SELECT count(*) FROM termos_aceite)"
```

### Etapa 5 — Testar pelo subdomínio temporário

Antes de mexer no DNS de produção, valide o servidor novo de ponta a ponta em
`https://novo.seudominio.com.br`:

- [ ] Login do administrador
- [ ] Login de um candidato
- [ ] Login de uma liderança
- [ ] A pirâmide de Rede de Apoio mostra os apoiadores corretamente
- [ ] "Todos os Apoiadores" lista todo mundo
- [ ] Cadastrar um apoiador de teste — e depois excluí-lo
- [ ] Gerar um link de cadastro e abri-lo **pelo celular**
- [ ] "Esqueci minha senha" envia o e-mail (se o SMTP estiver configurado)
- [ ] Exportar CSV

> ⚠️ Enquanto o servidor antigo continuar recebendo cadastros, o banco do novo
> vai ficando desatualizado. Se o teste demorar dias, refaça as etapas 2 a 4
> logo antes da virada, para pegar os dados mais recentes.

### <a id="virada-de-dns"></a>Etapa 6 — Virada de DNS

Escolha um horário de baixo movimento (madrugada ou domingo).

1. **Baixe o TTL com antecedência.** No painel de DNS, coloque o TTL do
   registro `app` em **300 segundos** e espere pelo menos o tempo do TTL antigo
   (geralmente algumas horas). Sem isso, provedores de internet podem continuar
   mandando gente para o servidor velho por até 24 h.

2. **Congele o servidor antigo** para ninguém cadastrar num banco que será
   descartado:
   ```bash
   # no servidor ANTIGO
   docker service scale redeapoio_redeapoio-app=0
   ```

3. **Dump final e transferência** — repita as etapas 2, 3 e 4 com o app já
   parado. Agora o dump está definitivamente completo.

4. **Ajuste o domínio no servidor novo:** Portainer → Stacks → redeapoio →
   Editor → mude `DOMAIN` para o domínio de produção
   (`app.seudominio.com.br`) → **Update the stack**.

5. **Troque o registro A** no painel de DNS para o IP do servidor novo.

6. **Acompanhe a emissão do certificado:**
   ```bash
   # no servidor NOVO
   docker service logs -f traefik_traefik | grep -i acme
   ```
   Costuma levar de 30 segundos a 2 minutos depois que o DNS propaga.

7. **Refaça o checklist da etapa 5**, agora no domínio definitivo.

8. **Ative o backup automático no servidor novo** (passo 12 da instalação) —
   é o esquecimento mais comum numa migração.

### Etapa 7 — Desligar o servidor antigo

**Espere de 7 a 15 dias antes de cancelar.** Nesse período o servidor antigo é
a sua rede de segurança se algo aparecer só depois.

Antes de cancelar em definitivo:

- [ ] Guarde um dump final em local externo (nuvem ou seu computador)
- [ ] Confirme que o backup automático do servidor novo já gerou pelo menos
      3 arquivos
- [ ] Confirme que ninguém mais acessa o IP antigo
- [ ] Salve as variáveis da stack antiga num gerenciador de senhas

---

## Restaurar num servidor totalmente novo (recuperação de desastre)

Cenário: o servidor foi perdido e você só tem o arquivo de backup.

1. Instale um servidor do zero: [`01-instalacao-servidor-novo.md`](01-instalacao-servidor-novo.md), passos 1 a 9
2. Pule o passo 10 (criar administrador)
3. Envie o arquivo de backup para `/var/backups/redeapoio/`
4. `bash scripts/restore-db.sh <arquivo>`
5. Aponte o DNS
6. Reative o backup automático (passo 12)

Se você perdeu também o `DB_PASSWORD`, tudo bem: o banco novo nasce com a senha
que você definir agora. O que **não** dá para recriar é o dump — por isso a
cópia externa importa tanto.

---

## Comandos de referência rápida

```bash
# Backup manual agora
bash /opt/redeapoiopolitico/scripts/backup-db.sh

# Listar backups
ls -lh /var/backups/redeapoio/ /var/backups/redeapoio/mensal/

# Restaurar
bash /opt/redeapoiopolitico/scripts/restore-db.sh <arquivo.dump>

# Ver o que tem dentro de um dump, sem restaurar
docker exec -i $(docker ps -q -f name=redeapoio_redeapoio-postgres) \
  pg_restore -l < /var/backups/redeapoio/arquivo.dump | head -40

# Contagens atuais do banco
docker exec $(docker ps -q -f name=redeapoio_redeapoio-postgres) \
  psql -U redeapoio -d redeapoio -tAc \
  "SELECT 'usuarios: ' || count(*) FROM usuarios
   UNION ALL SELECT 'apoiadores: ' || count(*) FROM apoiadores
   UNION ALL SELECT 'aceites: ' || count(*) FROM termos_aceite"

# Tamanho do banco
docker exec $(docker ps -q -f name=redeapoio_redeapoio-postgres) \
  psql -U redeapoio -d redeapoio -tAc \
  "SELECT pg_size_pretty(pg_database_size('redeapoio'))"
```
