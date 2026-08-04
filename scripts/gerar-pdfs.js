/**
 * gerar-pdfs.js — Converte a documentação de docs/*.md em PDF.
 *
 * Feito para o dono do sistema, que precisa dos manuais em PDF para ler,
 * imprimir ou repassar sem depender do GitHub.
 *
 * Como rodar (a partir da raiz do repositório):
 *
 *   npm install --no-save marked puppeteer-core
 *   node scripts/gerar-pdfs.js
 *
 * Os PDFs saem em docs/pdf/. Rode de novo sempre que a documentação mudar —
 * os arquivos são sobrescritos.
 *
 * Requer o Google Chrome instalado (não baixa navegador nenhum). Se o Chrome
 * estiver em outro lugar, aponte com a variável CHROME_PATH.
 */

const fs = require('fs');
const path = require('path');

let marked, puppeteer;
try {
  ({ marked } = require('marked'));
  puppeteer = require('puppeteer-core');
} catch {
  console.error('Faltam dependências. Rode antes:\n  npm install --no-save marked puppeteer-core');
  process.exit(1);
}

const RAIZ = path.join(__dirname, '..');
const ORIGEM = path.join(RAIZ, 'docs');
const DESTINO = path.join(ORIGEM, 'pdf');

// Título e nome de arquivo de cada documento. A ordem é a de leitura.
const DOCUMENTOS = [
  { md: 'README.md',                      saida: 'RedeApoio-00-Indice.pdf',                 titulo: 'Índice da Documentação',          publico: 'Por onde começar' },
  { md: '01-instalacao-servidor-novo.md',  saida: 'RedeApoio-01-Instalacao-Servidor.pdf',    titulo: 'Instalação em Servidor Novo',     publico: 'Para quem instala' },
  { md: '02-backup-e-migracao.md',         saida: 'RedeApoio-02-Backup-e-Migracao.pdf',      titulo: 'Backup, Restauração e Migração',  publico: 'Para quem instala e administra' },
  { md: '03-manual-do-dono.md',            saida: 'RedeApoio-03-Manual-do-Dono.pdf',         titulo: 'Manual do Dono do Sistema',       publico: 'Para o administrador do sistema' },
  { md: '04-referencia-tecnica.md',        saida: 'RedeApoio-04-Referencia-Tecnica.pdf',     titulo: 'Referência Técnica',              publico: 'Para programadores' },
  { md: '05-rotinas-de-manutencao.md',     saida: 'RedeApoio-05-Rotinas-Manutencao.pdf',     titulo: 'Rotinas de Manutenção e Correção', publico: 'Para programadores' },
];

function acharChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidatos = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  const achado = candidatos.find((c) => fs.existsSync(c));
  if (!achado) {
    console.error('Chrome não encontrado. Instale o Google Chrome ou defina CHROME_PATH.');
    process.exit(1);
  }
  return achado;
}

// Mesmo esquema de âncora que o GitHub usa, para que os links internos do
// markdown (#alguma-secao) continuem funcionando dentro do PDF.
function slug(texto) {
  return texto
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

function converter(md) {
  const renderer = new marked.Renderer();

  // marked não gera id em título; sem isso os links internos do PDF morrem.
  renderer.heading = function ({ tokens, depth }) {
    const texto = this.parser.parseInline(tokens);
    return `<h${depth} id="${slug(texto)}">${texto}</h${depth}>\n`;
  };

  // Referências entre documentos apontam para .md. Dentro do PDF o arquivo
  // vizinho é o .pdf correspondente — e quem lê o PDF não tem o .md em mãos,
  // então o texto visível também passa a mostrar o título do documento.
  renderer.link = function ({ href, title, tokens }) {
    let texto = this.parser.parseInline(tokens);
    let destino = href || '';
    const doc = DOCUMENTOS.find((d) => destino.split('#')[0].endsWith(d.md));
    if (doc) {
      const ancora = destino.includes('#') ? '#' + destino.split('#')[1] : '';
      destino = doc.saida + ancora;
      // Só troca quando o texto do link era o próprio nome do arquivo; frases
      // como "ver o manual do dono" continuam como o autor escreveu.
      if (texto.replace(/<[^>]+>/g, '').trim().endsWith(doc.md)) texto = doc.titulo;
    }
    return `<a href="${destino}"${title ? ` title="${title}"` : ''}>${texto}</a>`;
  };

  return marked.parse(md, { gfm: true, breaks: false, renderer });
}

function montarHtml({ titulo, publico, corpo, arquivoOrigem, data }) {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>${titulo}</title>
<style>
  /* Tipografia de sistema — nada de fonte externa, para o PDF sair igual
     mesmo gerado numa máquina sem internet. */
  :root {
    --navy: #0f1f3d;
    --gold: #c8a84b;
    --texto: #1f2430;
    --suave: #5b6478;
    --borda: #d8dde8;
    --fundo-suave: #f5f7fb;
  }
  * { box-sizing: border-box; }
  body {
    font-family: "Segoe UI", -apple-system, Roboto, Helvetica, Arial, sans-serif;
    font-size: 10.5pt; line-height: 1.62; color: var(--texto); margin: 0;
  }

  /* ── Capa ─────────────────────────────────────────── */
  .capa { break-after: page; padding-top: 34mm; }
  .capa .marca {
    font-family: Georgia, "Times New Roman", serif;
    font-size: 27pt; color: var(--navy); font-weight: 700; letter-spacing: -0.4pt;
  }
  .capa .marca span { color: var(--gold); }
  .capa .regua { height: 3px; background: var(--gold); width: 62px; margin: 16px 0 30px; }
  .capa h1 {
    font-family: Georgia, "Times New Roman", serif;
    font-size: 30pt; line-height: 1.2; color: var(--navy);
    margin: 0 0 14px; border: 0; padding: 0;
  }
  .capa .publico {
    display: inline-block; font-size: 10pt; color: var(--navy);
    background: #eef1f7; border: 1px solid var(--borda);
    border-radius: 20px; padding: 5px 15px; margin-bottom: 44px;
  }
  .capa .meta { font-size: 9pt; color: var(--suave); line-height: 1.9; }
  .capa .meta strong { color: var(--texto); font-weight: 600; }
  .capa .aviso {
    margin-top: 30mm; font-size: 8.5pt; color: var(--suave);
    border-top: 1px solid var(--borda); padding-top: 12px;
  }

  /* ── Títulos ──────────────────────────────────────── */
  h1, h2, h3, h4 { color: var(--navy); break-after: avoid; }
  h1 { font-size: 20pt; margin: 0 0 18px; padding-bottom: 9px; border-bottom: 2.5px solid var(--gold); }
  h2 { font-size: 14.5pt; margin: 26px 0 11px; padding-bottom: 5px; border-bottom: 1px solid var(--borda); }
  h3 { font-size: 11.8pt; margin: 20px 0 8px; }
  h4 { font-size: 10.5pt; margin: 16px 0 6px; color: var(--suave); text-transform: uppercase; letter-spacing: 0.4pt; }

  p { margin: 0 0 10px; }
  ul, ol { margin: 0 0 11px; padding-left: 20px; }
  li { margin-bottom: 4px; }
  li > ul, li > ol { margin-top: 4px; }

  a { color: var(--navy); text-decoration: none; border-bottom: 1px solid rgba(200,168,75,.55); }

  strong { font-weight: 650; }
  hr { border: 0; border-top: 1px solid var(--borda); margin: 24px 0; }

  /* ── Tabelas ──────────────────────────────────────── */
  table {
    width: 100%; border-collapse: collapse; margin: 12px 0 16px;
    font-size: 9.3pt; break-inside: avoid;
  }
  thead { background: var(--navy); }
  th {
    color: #fff; text-align: left; font-weight: 600;
    padding: 7px 9px; border: 1px solid var(--navy);
  }
  td { padding: 6px 9px; border: 1px solid var(--borda); vertical-align: top; }
  tbody tr:nth-child(even) { background: var(--fundo-suave); }

  /* ── Código ───────────────────────────────────────── */
  code {
    font-family: Consolas, "Courier New", monospace; font-size: 9pt;
    background: #eef1f7; padding: 1.5px 4px; border-radius: 3px; color: #23304d;
  }
  pre {
    background: #f7f9fc; border: 1px solid var(--borda); border-left: 3px solid var(--navy);
    border-radius: 4px; padding: 10px 12px; margin: 10px 0 14px;
    /* Comando longo não pode vazar da margem do papel. */
    white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere;
    break-inside: avoid;
  }
  pre code { background: none; padding: 0; font-size: 8.7pt; line-height: 1.5; color: #1f2937; }

  /* ── Citações e avisos ────────────────────────────── */
  blockquote {
    margin: 12px 0; padding: 9px 14px; background: #fdfaf1;
    border-left: 3px solid var(--gold); color: #4a4535; break-inside: avoid;
  }
  blockquote p:last-child { margin-bottom: 0; }

  /* ── Listas de verificação ────────────────────────── */
  ul:has(> li > input[type=checkbox]) { list-style: none; padding-left: 4px; }
  input[type=checkbox] {
    appearance: none; width: 10px; height: 10px; border: 1.3px solid var(--suave);
    border-radius: 2px; margin-right: 7px; vertical-align: -1px;
  }

  /* Evita título órfão no rodapé e primeira linha solta no topo. */
  p, li { orphans: 2; widows: 2; }
</style></head>
<body>
  <section class="capa">
    <div class="marca">Rede<span>Apoio</span></div>
    <div class="regua"></div>
    <h1>${titulo}</h1>
    <div class="publico">${publico}</div>
    <div class="meta">
      Documentação técnica e operacional do sistema RedeApoio<br>
      Gerado em <strong>${data}</strong><br>
      Origem: <strong>docs/${arquivoOrigem}</strong>
    </div>
    <div class="aviso">
      Este PDF é gerado automaticamente a partir da documentação do repositório.
      A versão sempre atual está em <strong>docs/${arquivoOrigem}</strong>, no GitHub —
      em caso de divergência, vale o que está lá.
    </div>
  </section>
  ${corpo}
</body></html>`;
}

(async () => {
  fs.mkdirSync(DESTINO, { recursive: true });

  const data = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
  const navegador = await puppeteer.launch({
    executablePath: acharChrome(),
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--font-render-hinting=none'],
  });

  try {
    for (const doc of DOCUMENTOS) {
      const origem = path.join(ORIGEM, doc.md);
      if (!fs.existsSync(origem)) {
        console.log(`  ! ${doc.md} não encontrado — pulando`);
        continue;
      }

      const html = montarHtml({
        titulo: doc.titulo,
        publico: doc.publico,
        corpo: converter(fs.readFileSync(origem, 'utf8')),
        arquivoOrigem: doc.md,
        data,
      });

      const pagina = await navegador.newPage();
      // setContent em vez de abrir file:// — evita problema de caminho com
      // espaços e acentos (este repositório mora em "PRODUÇÃO CLAUDE").
      await pagina.setContent(html, { waitUntil: 'load' });
      await pagina.emulateMediaType('print');

      const saida = path.join(DESTINO, doc.saida);
      await pagina.pdf({
        path: saida,
        format: 'A4',
        printBackground: true,
        margin: { top: '17mm', bottom: '17mm', left: '17mm', right: '17mm' },
        displayHeaderFooter: true,
        headerTemplate: `<div style="font-size:7pt;color:#9aa2b4;width:100%;padding:0 17mm;
          font-family:'Segoe UI',Arial,sans-serif;">
          <span style="float:left">RedeApoio — ${doc.titulo}</span></div>`,
        footerTemplate: `<div style="font-size:7pt;color:#9aa2b4;width:100%;padding:0 17mm;
          font-family:'Segoe UI',Arial,sans-serif;">
          <span style="float:left">${doc.md}</span>
          <span style="float:right">página <span class="pageNumber"></span> de <span class="totalPages"></span></span>
        </div>`,
      });
      await pagina.close();

      const kb = Math.round(fs.statSync(saida).size / 1024);
      console.log(`  ✓ ${doc.saida.padEnd(38)} ${String(kb).padStart(4)} KB`);
    }
  } finally {
    await navegador.close();
  }

  console.log(`\nPDFs gerados em docs/pdf/`);
})();
