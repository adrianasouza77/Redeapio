const { Pool, types } = require('pg');

// Por padrão o driver converte colunas DATE em objetos Date do JS, e ao virar
// JSON isso vira um timestamp completo ("1969-02-07T00:00:00.000Z") em vez de
// só a data — quebrando a formatação de nascimento. OID 1082 = tipo "date".
types.setTypeParser(1082, (val) => val);

// Usa variáveis discretas (PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE), lidas
// automaticamente pelo driver — evita montar uma connection string única, onde
// caracteres especiais na senha (/, @, :, # etc.) quebrariam o parser de URL.
const pool = new Pool();

module.exports = pool;
