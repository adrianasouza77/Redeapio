// Biblioteca de modelos do Módulo Mandato (briefing, item 2.2): indicação,
// requerimento, projeto de lei, moção e ofício, com dicas e exemplos por nicho.
//
// Estes são os modelos "do RedeApoio", iguais para todo vereador. Ficam no
// código, e não no banco, porque o 001_init.sql roda a cada boot: um texto
// semeado lá ou nunca seria corrigido (ON CONFLICT DO NOTHING) ou apagaria a
// cada reinício o que alguém tivesse ajustado. Os modelos que o gabinete cria
// moram em mandato_modelos. O id dos daqui começa com "g:".
//
// Os textos são ponto de partida. Cada Câmara tem o seu Regimento Interno e
// o seu padrão de redação; o gabinete confere antes de protocolar. Entre
// colchetes, o que precisa ser preenchido.

const TIPOS = {
  indicacao: 'Indicação',
  requerimento: 'Requerimento',
  projeto_lei: 'Projeto de Lei',
  mocao: 'Moção',
  oficio: 'Ofício',
};

const MODELOS = [
  {
    id: 'g:indicacao-geral', tipo: 'indicacao', titulo: 'Indicação — serviço ou obra no bairro', nicho: null,
    corpo: `INDICAÇÃO Nº [número]/[ano]

O Vereador que esta subscreve, no uso de suas atribuições regimentais, INDICA ao Excelentíssimo Senhor Prefeito Municipal, por intermédio da [Secretaria Municipal competente], a necessidade de [descrever o serviço ou a obra: ex. "realizar a recuperação asfáltica"] na [rua/avenida/praça], no bairro [bairro], [ponto de referência].

JUSTIFICATIVA

[Explicar o problema em linguagem objetiva: desde quando acontece, quantas pessoas são afetadas, riscos à segurança ou à saúde.]

A medida atende a pedido dos moradores da região e contribui para [benefício esperado].

Sala das Sessões, [cidade], [data].

[Nome do Vereador]
Vereador`,
    dicas: `• Indicação é sugestão ao Executivo: não obriga a Prefeitura, mas deixa o pedido registrado e público.
• Diga o lugar exato (rua, número aproximado, ponto de referência) — é o que mais atrasa a resposta.
• Uma indicação por assunto: misturar pedidos dificulta o acompanhamento.
• Anexe foto quando o Regimento permitir.
• Ligue a indicação à demanda de origem no RedeApoio para avisar quem pediu.`,
  },
  {
    id: 'g:indicacao-saude', tipo: 'indicacao', titulo: 'Indicação — atendimento na unidade de saúde', nicho: 'Saúde',
    corpo: `INDICAÇÃO Nº [número]/[ano]

O Vereador que esta subscreve INDICA ao Excelentíssimo Senhor Prefeito Municipal, por intermédio da Secretaria Municipal de Saúde, a necessidade de [ampliar o horário de atendimento / reforçar a equipe médica / garantir o abastecimento de medicamentos] na [nome da unidade de saúde], localizada no bairro [bairro].

JUSTIFICATIVA

A unidade atende cerca de [número] moradores dos bairros [bairros]. Hoje [descrever a situação: fila, falta de profissional, falta de medicamento], o que obriga a população a [consequência: procurar a UPA, esperar semanas].

A medida reduz a sobrecarga do pronto atendimento e garante o direito à saúde previsto no art. 196 da Constituição Federal.

Sala das Sessões, [cidade], [data].

[Nome do Vereador]
Vereador`,
    dicas: `• Números convencem: quantas pessoas a unidade atende, quanto tempo dura a espera.
• Não cite nome de paciente nem diagnóstico — é dado sensível (LGPD).
• Combine com um requerimento de informação à Secretaria se precisar de dados oficiais.`,
  },
  {
    id: 'g:indicacao-infraestrutura', tipo: 'indicacao', titulo: 'Indicação — iluminação, pavimentação ou drenagem', nicho: 'Infraestrutura',
    corpo: `INDICAÇÃO Nº [número]/[ano]

O Vereador que esta subscreve INDICA ao Excelentíssimo Senhor Prefeito Municipal, por intermédio da Secretaria Municipal de [Obras / Infraestrutura / Serviços Urbanos], a necessidade de [instalação de iluminação pública / pavimentação / limpeza e desobstrução da rede de drenagem] na [rua/avenida], entre [ponto inicial] e [ponto final], no bairro [bairro].

JUSTIFICATIVA

[Descrever: trecho escuro à noite, buracos, alagamentos após chuva.] A situação coloca em risco [pedestres, estudantes, motoristas] e foi relatada por moradores da região.

Sala das Sessões, [cidade], [data].

[Nome do Vereador]
Vereador`,
    dicas: `• Para iluminação, informe o número do poste quando existir.
• Para alagamento, diga em que época acontece e até onde a água chega.
• Depois da resposta da Prefeitura, registre o trabalho executado com foto (sem pessoas, ou com autorização).`,
  },
  {
    id: 'g:indicacao-seguranca', tipo: 'indicacao', titulo: 'Indicação — segurança e ronda', nicho: 'Segurança',
    corpo: `INDICAÇÃO Nº [número]/[ano]

O Vereador que esta subscreve INDICA ao Excelentíssimo Senhor Prefeito Municipal, para que, por meio da [Guarda Municipal / Secretaria de Segurança] e em articulação com a Polícia Militar, seja intensificado o patrulhamento preventivo no bairro [bairro], em especial nas proximidades de [escola, praça, ponto de ônibus], no período [manhã/tarde/noite].

JUSTIFICATIVA

Moradores relatam [descrever a situação de forma geral, sem identificar vítimas]. O reforço da presença do poder público inibe ocorrências e devolve à comunidade o uso do espaço público.

Sala das Sessões, [cidade], [data].

[Nome do Vereador]
Vereador`,
    dicas: `• Nunca identifique vítima, testemunha ou suspeito no texto: o documento é público.
• Policiamento ostensivo é do Estado: a indicação ao Prefeito pede articulação, não ordena a PM.`,
  },
  {
    id: 'g:requerimento-informacao', tipo: 'requerimento', titulo: 'Requerimento de informação ao Executivo', nicho: null,
    corpo: `REQUERIMENTO Nº [número]/[ano]

O Vereador que esta subscreve, com fundamento no art. [artigo] do Regimento Interno desta Casa e no art. [artigo] da Lei Orgânica do Município, REQUER, após ouvido o Plenário, que seja oficiado ao Excelentíssimo Senhor Prefeito Municipal solicitando as seguintes informações:

1. [Pergunta objetiva 1 — ex.: "Qual o cronograma previsto para a obra de ..."]
2. [Pergunta objetiva 2 — ex.: "Qual o valor contratado e a empresa responsável?"]
3. [Pergunta objetiva 3]

JUSTIFICATIVA

Cabe ao Poder Legislativo fiscalizar os atos do Executivo. As informações solicitadas são necessárias para [motivo: acompanhar a obra, responder aos moradores, avaliar a política pública].

Sala das Sessões, [cidade], [data].

[Nome do Vereador]
Vereador`,
    dicas: `• Perguntas numeradas e fechadas são respondidas mais rápido e com menos evasivas.
• Confira na Lei Orgânica o prazo de resposta do Executivo e acompanhe pelo status da proposição.
• Pergunte por documentos (contrato, cronograma) em vez de opiniões.`,
  },
  {
    id: 'g:requerimento-educacao', tipo: 'requerimento', titulo: 'Requerimento — vagas e estrutura escolar', nicho: 'Educação',
    corpo: `REQUERIMENTO Nº [número]/[ano]

O Vereador que esta subscreve REQUER, após ouvido o Plenário, que seja oficiado à Secretaria Municipal de Educação solicitando:

1. O número de crianças em lista de espera por vaga em creche/CEI no bairro [bairro] e região;
2. A previsão de abertura de novas vagas ou de construção/ampliação de unidade;
3. As condições atuais da estrutura da [nome da escola] ([cobertura, banheiros, acessibilidade, merenda]).

JUSTIFICATIVA

Famílias da região relatam [descrever]. O acesso à educação infantil é direito previsto no art. 208, IV, da Constituição Federal.

Sala das Sessões, [cidade], [data].

[Nome do Vereador]
Vereador`,
    dicas: `• Peça o dado oficial da lista de espera: é o número que embasa um projeto ou uma emenda depois.
• Não cite nome de criança ou família no requerimento.`,
  },
  {
    id: 'g:projeto-lei-geral', tipo: 'projeto_lei', titulo: 'Projeto de Lei — estrutura básica', nicho: null,
    corpo: `PROJETO DE LEI Nº [número]/[ano]

"[Ementa: o que a lei faz, em uma frase — ex.: Institui o Programa Municipal de ...]"

A CÂMARA MUNICIPAL DE [MUNICÍPIO] APROVA:

Art. 1º Fica [instituído / criado / autorizado] [objeto da lei], no âmbito do Município de [município].

Art. 2º [Objetivos ou definição do que a lei regula.]
I – [objetivo];
II – [objetivo].

Art. 3º [Como funciona: quem participa, quais os critérios.]

Art. 4º As despesas decorrentes da execução desta Lei correrão por conta de dotações orçamentárias próprias, suplementadas se necessário.

Art. 5º Esta Lei entra em vigor na data de sua publicação.

Sala das Sessões, [cidade], [data].

[Nome do Vereador]
Vereador

JUSTIFICATIVA

[Explicar o problema, os dados que o comprovam, experiências de outras cidades e o benefício esperado.]`,
    dicas: `• Vereador não pode propor lei que crie despesa obrigatória ou órgão no Executivo (vício de iniciativa): prefira programas, datas, diretrizes e direitos.
• Ementa curta e clara: é o que aparece na pauta e na página pública.
• Peça parecer da assessoria jurídica da Câmara antes de protocolar.
• Pesquise se já existe lei municipal sobre o tema para não duplicar.`,
  },
  {
    id: 'g:projeto-lei-data', tipo: 'projeto_lei', titulo: 'Projeto de Lei — data ou semana no calendário oficial', nicho: 'Cultura e esporte',
    corpo: `PROJETO DE LEI Nº [número]/[ano]

"Institui, no Calendário Oficial do Município de [município], a [Semana/Dia] Municipal de [tema], e dá outras providências."

A CÂMARA MUNICIPAL DE [MUNICÍPIO] APROVA:

Art. 1º Fica instituída a [Semana/Dia] Municipal de [tema], a ser celebrada anualmente [na semana que compreende o dia X / no dia X de mês].

Art. 2º A data tem por objetivo [conscientizar / valorizar / incentivar] [público ou tema].

Art. 3º Durante a [semana/data] poderão ser realizadas atividades como palestras, eventos esportivos e culturais, em parceria com entidades da sociedade civil.

Art. 4º Esta Lei entra em vigor na data de sua publicação.

Sala das Sessões, [cidade], [data].

[Nome do Vereador]
Vereador

JUSTIFICATIVA

[Por que o tema merece a data, quem será beneficiado, entidades envolvidas.]`,
    dicas: `• Projeto de data comemorativa raramente tem vício de iniciativa — bom primeiro projeto.
• Use "poderão ser realizadas": obrigar a Prefeitura a fazer evento cria despesa.`,
  },
  {
    id: 'g:mocao-aplauso', tipo: 'mocao', titulo: 'Moção de aplauso / congratulação', nicho: null,
    corpo: `MOÇÃO DE APLAUSO Nº [número]/[ano]

O Vereador que esta subscreve, na forma regimental, apresenta à Mesa MOÇÃO DE APLAUSO a [nome da pessoa, entidade ou equipe], pelo [motivo: trabalho realizado, conquista, data de fundação].

JUSTIFICATIVA

[Contar brevemente a história e o que foi feito pela comunidade.]

Pelo exposto, solicito a aprovação desta Moção e o envio de cópia ao homenageado.

Sala das Sessões, [cidade], [data].

[Nome do Vereador]
Vereador`,
    dicas: `• Confirme com a pessoa homenageada se ela autoriza o uso do nome (é documento público).
• Moção não substitui ação: use para reconhecer trabalho já feito.`,
  },
  {
    id: 'g:mocao-repudio', tipo: 'mocao', titulo: 'Moção de apelo', nicho: null,
    corpo: `MOÇÃO DE APELO Nº [número]/[ano]

O Vereador que esta subscreve, na forma regimental, apresenta à Mesa MOÇÃO DE APELO ao [órgão/autoridade: Governo do Estado, concessionária, ministério] para que [pedido objetivo].

JUSTIFICATIVA

[Descrever o problema que depende de outro ente — ex.: rodovia estadual, serviço de concessionária — e o impacto na população do município.]

Sala das Sessões, [cidade], [data].

[Nome do Vereador]
Vereador`,
    dicas: `• Use quando a solução não é da Prefeitura (rodovia estadual, energia, telefonia).
• Encaminhe também por ofício para o órgão responsável.`,
  },
  {
    id: 'g:oficio-secretaria', tipo: 'oficio', titulo: 'Ofício a secretaria ou órgão público', nicho: null,
    corpo: `OFÍCIO Nº [número]/[ano] – GAB. VER. [nome]

[Cidade], [data].

A Sua Senhoria o(a) Senhor(a)
[Nome do(a) Secretário(a)]
[Cargo] — [Secretaria/Órgão]

Assunto: [assunto em uma linha]

Senhor(a) Secretário(a),

Cumprimentando-o(a), encaminho a Vossa Senhoria a solicitação de [descrever o pedido], referente a [local/bairro], conforme demanda registrada em nosso gabinete sob o protocolo [protocolo RedeApoio].

[Detalhar a situação e o que se espera como resposta.]

Certo de contar com a atenção de Vossa Senhoria, aguardo retorno no prazo de [prazo] dias e coloco o gabinete à disposição.

Atenciosamente,

[Nome do Vereador]
Vereador`,
    dicas: `• Ofício é comunicação direta do gabinete: mais rápido que indicação, mas sem votação em plenário.
• Cite o protocolo da demanda: ajuda a cobrar e a responder quem pediu.
• Guarde a resposta recebida como andamento da demanda.`,
  },
  {
    id: 'g:oficio-assistencia', tipo: 'oficio', titulo: 'Ofício — assistência social', nicho: 'Assistência social',
    corpo: `OFÍCIO Nº [número]/[ano] – GAB. VER. [nome]

[Cidade], [data].

A Sua Senhoria o(a) Senhor(a)
[Nome]
Secretário(a) Municipal de Assistência Social

Assunto: Solicitação de visita técnica / inclusão em programa social

Senhor(a) Secretário(a),

Encaminho a Vossa Senhoria pedido de [visita técnica do CRAS / avaliação para inclusão em programa / atendimento], referente a família residente no bairro [bairro], cujos dados seguem em anexo reservado, conforme demanda registrada sob o protocolo [protocolo].

Atenciosamente,

[Nome do Vereador]
Vereador`,
    dicas: `• Dados da família vão em anexo reservado, nunca no corpo do ofício.
• Marque a demanda como "dado sensível" no RedeApoio: ela nunca poderá ser publicada.`,
  },
];

function modelosGlobais() { return MODELOS; }
function modeloGlobal(id) { return MODELOS.find((m) => m.id === id) || null; }

module.exports = { TIPOS, modelosGlobais, modeloGlobal };
