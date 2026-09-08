# 3 — Manual do dono do sistema

Para quem administra o RedeApoio no dia a dia. Explica o que dá para mudar
sozinho pelo painel, o que exige mexer no servidor, e o que só um programador
consegue fazer.

---

## Como o sistema é organizado

### Os quatro perfis

| Perfil | O que faz | Quem cria |
|---|---|---|
| **Administrador** | Cria candidatos, define plano e data de encerramento do contrato, entra no "workspace" de qualquer candidato para ajudar | criado direto no banco (só na instalação) |
| **Candidato** | Dono de uma rede. Cria lideranças, vê tudo da própria rede, gera links de cadastro, define os limites da pirâmide | o Administrador |
| **Liderança** (nível 1) | Cadastra e gerencia a própria rede abaixo dela | o Candidato |
| **Apoiador** (níveis 2 e 3) | Mesma coisa, um degrau abaixo | quem está acima, ou autocadastro por link |

Um detalhe importante: **redes de candidatos diferentes não se enxergam**. As
verificações de duplicidade (telefone, título, e-mail) valem só dentro da rede
de um mesmo candidato.

### A pirâmide

```
Candidato
   └── Nível 1 — Liderança          (tem login)
         └── Nível 2 — Apoiador     (tem login)
               └── Nível 3          (tem login)
                     └── Nível 4    (SEM login — só contato)
```

Quem está no nível 4 não acessa o sistema: é o fim da linha, cadastrado apenas
como contato da campanha.

### Os dois tipos de link de cadastro

**Link pessoal** — a liderança ou apoiador clica em "Gerar link de cadastro" e
compartilha. Quem se cadastra entra **um nível abaixo de quem enviou** e já
fica pendurado na pessoa certa.

**Link por nível** — só o candidato gera, em "Links de cadastro". Cria um link
para cada nível (1 a 4). Quem se cadastra entra **sem responsável**, e o
candidato organiza depois em "Todos os Apoiadores", editando o cadastro e
escolhendo embaixo de quem a pessoa fica.

---

## O que você muda sozinho, pelo painel

### Limites da pirâmide

**Entrar como candidato → Configurações → Limites da Pirâmide**

Define quantas pessoas cada nível pode cadastrar. Vale para toda a rede daquele
candidato — inclusive para as lideranças e apoiadores dele. O padrão é
50 / 30 / 15 / 10.

Cada candidato tem os seus. O administrador consegue ajustar entrando no
workspace do candidato (Central de Vagas → Abrir).

> ⚠️ **Os campos "Nome do Candidato" e "Idealizadora", na mesma tela, não são
> salvos.** Eles só mudam a exibição até você recarregar a página. Está
> registrado como limitação conhecida em
> [`04-referencia-tecnica.md`](04-referencia-tecnica.md#limitacoes-conhecidas).

### Criar um candidato novo

**Entrar como administrador → Central de Vagas → Novo Candidato**

O sistema gera uma senha temporária e mostra **uma única vez** — copie na hora.
No primeiro login o candidato é obrigado a trocá-la e a aceitar o termo LGPD.

### Plano e data de encerramento do contrato

**Central de Vagas → ✏️ no candidato**

Define plano (teste, vereador, prefeito/dep. estadual, dep. federal/senador),
período (mensal, trimestral, semestral) e **data de desativação**.

Passada a data de desativação, **o candidato e toda a rede criada por ele**
ficam impedidos de entrar, com a mensagem "Acesso encerrado. Entre em contato
com o suporte." Nada é apagado — basta limpar ou adiar a data para liberar de
novo.

### Redefinir a senha de alguém

Três caminhos, dependendo de quem você é:

| Você é | Redefine a senha de | Onde |
|---|---|---|
| Administrador | qualquer candidato | Central de Vagas → 🔑 |
| Candidato | suas lideranças e apoiadores | Usuários → 🔑 |
| Liderança / Apoiador | os apoiadores da própria rede | Todos os Apoiadores → editar |

A senha nova sempre entra como **temporária**: a pessoa é obrigada a trocá-la
no próximo login.

### Corrigir login ou e-mail

- **Administrador** corrige login e e-mail de candidatos na Central de Vagas
- **Candidato** corrige login e e-mail de lideranças e apoiadores em Usuários
- **Liderança** corrige os dos apoiadores da própria rede
- **Cada um** troca o próprio login e senha em Minha Conta (pedindo a senha
  atual como confirmação)

Regra do login: **só letras minúsculas, números, ponto, hífen e underline**.
Sem espaços e sem acentos. O campo já converte automaticamente enquanto se
digita.

### Encontrar cadastros duplicados

**Candidato → Todos os Apoiadores → Cadastros duplicados**

Agrupa por nome parecido. O sistema já bloqueia telefone e título de eleitor
repetidos dentro da mesma rede no momento do cadastro; esta tela pega os que
entraram antes dessa trava ou com dados ligeiramente diferentes.

### Exportar os dados

**Candidato → Exportar Dados** (CSV para Excel, ou JSON).

---

## O que exige acesso ao servidor (mas não é programação)

Tudo aqui é feito no **Portainer → Stacks → redeapoio → Editor →
Environment variables**, seguido de **Update the stack**. O sistema fica fora
do ar por 10 a 30 segundos a cada atualização.

| Variável | Para que serve |
|---|---|
| `DOMAIN` | Endereço do sistema. Mudou o domínio? Mude aqui **e** aponte o DNS |
| `SMTP_HOST` `SMTP_PORT` `SMTP_USER` `SMTP_PASS` `SMTP_FROM` | Conta de e-mail que envia o "Esqueci minha senha" |
| `TERMO_VERSAO` | Versão do termo LGPD. **Ver abaixo** |
| `LIMITE_NIVEL1` a `LIMITE_NIVEL4` | Padrão de limites para candidatos que nunca personalizaram |
| `JWT_SECRET` | Segredo das sessões. Trocar desloga todo mundo (útil se vazar) |

### Forçar todo mundo a aceitar o termo de novo

Sempre que o texto do termo LGPD mudar de forma relevante, **suba a
`TERMO_VERSAO`** (de `1.0` para `1.1`, por exemplo) e atualize a stack.

No próximo login, todos são obrigados a ler e aceitar de novo — e cada aceite
vira uma linha nova na tabela `termos_aceite`, com data, IP e dispositivo.
Aceites antigos nunca são apagados: é essa trilha que serve de prova de
consentimento perante a LGPD (art. 8º, §2º).

---

## O que precisa de um programador

Estas mudanças exigem editar código, `git push`, e rodar `bash build.sh` no
servidor:

- **Texto do termo LGPD** — está em `frontend/index.html`, função
  `textoTermoCompleto()`. Ao alterar, suba também a `TERMO_VERSAO`
- Qualquer texto, rótulo ou cor da interface
- Campos novos no cadastro
- Regras novas de permissão ou de negócio
- Novos relatórios ou gráficos
- Aumentar a pirâmide para mais de 4 níveis

### Como uma alteração de código chega ao ar

```bash
ssh root@IP_DO_SERVIDOR
cd /opt/redeapoiopolitico

bash scripts/backup-db.sh   # sempre antes
git pull origin 1.0
bash build.sh               # rebuilda E reinicia o serviço sozinho
```

O `build.sh` percebe que o serviço já está rodando e força a troca pela imagem
nova. **Não é preciso mexer no Portainer** para uma atualização de código —
só para mudança de variável de ambiente.

Depois de atualizar, teste no navegador. Se algo quebrou:

```bash
docker service logs --tail 100 redeapoio_redeapoio-app
```

E para voltar à versão anterior:

```bash
git log --oneline -5           # veja o código do commit anterior
git checkout <codigo-do-commit>
bash build.sh
```

---

## Rotina recomendada

### Toda semana (5 minutos)

```bash
ssh root@IP_DO_SERVIDOR
docker service ls                        # tudo 1/1?
ls -lh /var/backups/redeapoio/ | tail -5 # backup de ontem existe?
df -h /                                  # disco abaixo de 80%?
```

### Todo mês

- Conferir se os certificados renovaram (o cadeado no navegador, sem aviso)
- `apt update && apt upgrade -y` e reiniciar em horário de baixo movimento
- Revisar a Central de Vagas: contratos vencendo, candidatos inativos

### A cada 3 meses

- **Testar uma restauração de backup** em servidor de teste. Backup que nunca
  foi restaurado é suposição, não garantia
- Conferir se a cópia externa dos backups está funcionando

---

## Quando algo dá errado

| Sintoma | Primeiro a verificar |
|---|---|
| Site não abre | `docker service ls` — algum serviço fora do `1/1`? |
| "Sessão expirada" toda hora | `JWT_SECRET` mudou, ou o serviço está reiniciando em loop |
| E-mail de recuperação não chega | variáveis SMTP; `docker service logs redeapoio_redeapoio-app \| grep mail` |
| Cadeado quebrado / aviso de certificado | `docker service logs traefik_traefik \| grep -i acme` |
| Campo do celular não aceita digitação | ver [`05-rotinas-de-manutencao.md`](05-rotinas-de-manutencao.md) — já houve um caso assim, corrigido em agosto de 2026 |
| Pessoa não consegue entrar | contrato vencido (Central de Vagas), conta inativa, ou login com espaço/acento |

**Antes de pedir ajuda, colete isto** — economiza uma rodada inteira de
perguntas:

```bash
docker service ls
docker service ps redeapoio_redeapoio-app --no-trunc | head -5
docker service logs --tail 50 redeapoio_redeapoio-app
df -h /
free -h
```

---

## Onde ficam as senhas e segredos

| O quê | Onde está guardado |
|---|---|
| Senha do banco (`DB_PASSWORD`) | Portainer → Stacks → redeapoio → Editor |
| Segredo das sessões (`JWT_SECRET`) | idem |
| Senha do e-mail (`SMTP_PASS`) | idem |
| Senhas dos usuários | banco, como hash bcrypt — **ninguém consegue ler** |
| Senha do Portainer | definida na instalação |
| Acesso SSH | painel da hospedagem |

Guarde `DB_PASSWORD`, `JWT_SECRET` e o acesso do Portainer num gerenciador de
senhas. **Eles não estão no repositório do GitHub** e não há como recuperá-los
se forem perdidos junto com o servidor.

As senhas dos usuários são armazenadas como hash bcrypt: nem você, nem um
programador, nem alguém que roube o banco consegue descobrir a senha de
alguém. A única saída, quando alguém esquece, é gerar uma nova.
