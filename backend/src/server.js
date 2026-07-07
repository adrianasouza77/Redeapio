require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');

const { port, jwtSecret } = require('./config');

if (!jwtSecret) {
  console.error('JWT_SECRET não definido. Configure a variável de ambiente antes de iniciar.');
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/usuarios', require('./routes/usuarios'));
app.use('/api/apoiadores', require('./routes/apoiadores'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/public', require('./routes/public'));

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

app.listen(port, () => console.log(`RedeApoio backend rodando na porta ${port}`));
