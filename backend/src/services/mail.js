const nodemailer = require('nodemailer');

function escHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST,
  port:   parseInt(process.env.SMTP_PORT || '587', 10),
  secure: process.env.SMTP_PORT === '465',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

async function sendMail({ to, subject, html }) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER) return;
  // Deixa o erro propagar — quem chama decide se engole ou não.
  await transporter.sendMail({
    from: process.env.SMTP_FROM || '"RedeApoio" <naoresponda@redeapoiopolitico.com.br>',
    to,
    subject,
    html,
  });
}

// Versão silenciosa: nunca deixa o usuário saber se o e-mail existe ou não
// (evita enumeração de contas) nem quebra o fluxo se o SMTP falhar.
async function sendMailSilent(opts) {
  try {
    await sendMail(opts);
  } catch (err) {
    console.error('[mail] Falha ao enviar e-mail:', err.message);
  }
}

function baseLayout(content) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f7f8fc;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 0;">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;">
        <tr>
          <td style="background:#0f1f3d;padding:20px 28px;border-radius:10px 10px 0 0;">
            <span style="color:#fff;font-size:19px;font-weight:700;">Rede<span style="color:#c8a84b;">Apoio</span></span>
          </td>
        </tr>
        <tr>
          <td style="background:#fff;border:1px solid #dde2ee;border-top:none;padding:28px;border-radius:0 0 10px 10px;">
            ${content}
          </td>
        </tr>
        <tr>
          <td style="padding:16px 0;text-align:center;color:#9ca3af;font-size:12px;">
            RedeApoio — Gestão de Rede Política
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function btn(url, label) {
  return `<a href="${url}" style="display:inline-block;padding:12px 24px;background:#0f1f3d;color:#fff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:700;">${label}</a>`;
}

function tplResetSenha({ nome, link }) {
  return baseLayout(`
    <h2 style="margin:0 0 8px;font-size:20px;color:#0f1f3d;">Recuperação de senha</h2>
    <p style="color:#555;font-size:14px;margin:0 0 24px;line-height:1.6;">
      Olá, ${escHtml(nome)}. Recebemos uma solicitação para redefinir a senha da sua conta no RedeApoio.<br>
      Clique no botão abaixo para criar uma nova senha. O link é válido por <strong>1 hora</strong>.
    </p>
    ${btn(link, 'Redefinir minha senha')}
    <p style="color:#999;font-size:12px;margin-top:24px;">
      Se você não solicitou essa recuperação, ignore este e-mail — sua senha continua a mesma.<br>
      <a href="${link}" style="color:#999">${link}</a>
    </p>
  `);
}

module.exports = { sendMail, sendMailSilent, tplResetSenha };
