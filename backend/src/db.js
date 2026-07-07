const { Pool } = require('pg');

// Usa variáveis discretas (PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE), lidas
// automaticamente pelo driver — evita montar uma connection string única, onde
// caracteres especiais na senha (/, @, :, # etc.) quebrariam o parser de URL.
const pool = new Pool();

module.exports = pool;
