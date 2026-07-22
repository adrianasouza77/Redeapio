require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const pool = require('./db');
const { port, jwtSecret } = require('./config');

if (!jwtSecret) {
  console.error('JWT_SECRET não definido. Configure a variável de ambiente antes de iniciar.');
  process.exit(1);
}

// Em Docker Swarm o "depends_on" do compose não garante ordem de start,
// e stacks do Portainer não têm um checkout de repo confiável para bind-mount
// de arquivos de init do Postgres. Por isso o próprio app aplica o schema
// (idempotente, via IF NOT EXISTS) no boot, com retry até o Postgres subir.
async function aplicarMigracoes(tentativas = 20, esperaMs = 3000) {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '001_init.sql'), 'utf8');
  for (let i = 1; i <= tentativas; i++) {
    try {
      await pool.query(sql);
      console.log('Migrações aplicadas com sucesso.');
      return;
    } catch (err) {
      console.log(`Postgres ainda não disponível (tentativa ${i}/${tentativas}): ${err.message}`);
      await new Promise((r) => setTimeout(r, esperaMs));
    }
  }
  throw new Error('Não foi possível conectar ao Postgres após várias tentativas.');
}

const app = express();
// origin:true reflete o Origin da requisição (necessário para credentials:true,
// já que cookies com credenciais não podem usar Access-Control-Allow-Origin: *).
app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/usuarios', require('./routes/usuarios'));
app.use('/api/apoiadores', require('./routes/apoiadores'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/public', require('./routes/public'));
app.use('/api/conta', require('./routes/conta'));
app.use('/api/config', require('./routes/config'));

const frontendDir = process.env.FRONTEND_DIR || path.join(__dirname, '..', '..', 'frontend');
app.use(express.static(frontendDir));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(frontendDir, 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Erro interno. Tente novamente.' });
});

aplicarMigracoes()
  .then(() => app.listen(port, () => console.log(`RedeApoio backend rodando na porta ${port}`)))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
