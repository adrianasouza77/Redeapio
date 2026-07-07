// Migração única: puxa os dados reais do Supabase (REST API) e grava no Postgres novo.
// Senhas em texto puro são convertidas para hash bcrypt durante a importação — nenhuma
// senha de usuário fica salva em claro no banco novo.
//
// Uso:
//   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... DATABASE_URL=... node scripts/migrate-from-supabase.js
require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Defina SUPABASE_URL e SUPABASE_SERVICE_KEY antes de rodar a migração.');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function fetchSupabase(tabela) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${tabela}?select=*`, {
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
  });
  if (!resp.ok) throw new Error(`Falha ao buscar ${tabela}: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

async function main() {
  console.log('Buscando dados do Supabase...');
  const [usuarios, apoiadores] = await Promise.all([
    fetchSupabase('usuarios'),
    fetchSupabase('apoiadores'),
  ]);
  console.log(`  ${usuarios.length} usuários, ${apoiadores.length} apoiadores encontrados.`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    console.log('Importando usuários...');
    for (const u of usuarios) {
      const senhaHash = await bcrypt.hash(String(u.senha), 10);
      await client.query(
        `INSERT INTO usuarios (id, nome, login, senha_hash, perfil, criado_por, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (id) DO NOTHING`,
        [u.id, u.nome, u.login.trim().toLowerCase(), senhaHash, u.perfil, u.criado_por || null, u.created_at]
      );
    }

    console.log('Importando apoiadores...');
    for (const a of apoiadores) {
      await client.query(
        `INSERT INTO apoiadores (id, nome, telefone, nascimento, regiao, endereco, cidade, titulo, secao, nivel, parent_id, cadastrado_por, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (id) DO NOTHING`,
        [
          a.id, a.nome, a.telefone || null, a.nascimento || null, a.regiao || null,
          a.endereco || null, a.cidade || null, a.titulo || null, a.secao || null,
          a.nivel, a.parent_id || null, a.cadastrado_por || null, a.created_at,
        ]
      );
    }

    const jaExisteAdmin = await client.query("SELECT id FROM usuarios WHERE perfil = 'admin' LIMIT 1");
    let senhaAdmin = null;
    if (!jaExisteAdmin.rows[0]) {
      senhaAdmin = Array.from({ length: 10 }, () =>
        'ABCDEFGHJKMNPQRSTWXYZabcdefghjkmnpqrstwxyz23456789@#'[Math.floor(Math.random() * 52)]
      ).join('');
      const hashAdmin = await bcrypt.hash(senhaAdmin, 10);
      await client.query(
        "INSERT INTO usuarios (nome, login, senha_hash, perfil) VALUES ('Adriana Souza', 'adriana', $1, 'admin')",
        [hashAdmin]
      );
    }

    await client.query('COMMIT');
    console.log('Migração concluída com sucesso.');
    if (senhaAdmin) {
      console.log('\n=== CONTA DE ADMINISTRADOR CRIADA ===');
      console.log('Login: adriana');
      console.log(`Senha temporária: ${senhaAdmin}`);
      console.log('Troque essa senha assim que possível (tela de recuperação de senha).\n');
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erro na migração, nada foi salvo:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
