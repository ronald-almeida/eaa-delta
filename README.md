# Checkout EAA Delta

Checkout responsivo do **Combo Vitalício EAA DELTA**, por **R$ 347,00**, com Pix pela Black Cat. Layout baseado na referência fornecida, logo do produto e SVG Hotmart no topo enviados pelo usuário. Fontes Hotmart Sans / Hotmart Display carregadas do CDN público da Hotmart, com os fallbacks solicitados. O processamento é Black Cat.

## Publicar na Vercel

1. Importe o repositório `ronald-almeida/eaa-delta` na Vercel.
2. Use o preset **Other**, Node.js **22.x ou superior**, diretório raiz do repositório. O `vercel.json` configura build e saída `public`.
3. Cadastre **BLACKCAT_API_KEY** nas variáveis de ambiente privadas de Production e, se necessário, Preview. Obtenha a chave no painel da Black Cat. Não a coloque no HTML, no GitHub ou em variáveis públicas.
4. Faça o deploy. Se cadastrar ou trocar a chave após um deploy, faça um novo deploy.
5. Valide uma cobrança autorizada na sua conta antes de divulgar o checkout. Os testes automatizados usam respostas simuladas; não comprovam credenciais, liquidação ou entrega do produto.

Não funciona como hospedagem exclusivamente estática (por exemplo GitHub Pages), pois a chave e as chamadas à Black Cat precisam permanecer no servidor.

## Rodar localmente

Requer Node.js 22.9+ (recomendado 24). Sem dependências externas ou instalação de pacotes.

```sh
cp .env.example .env.local
# Preencha BLACKCAT_API_KEY em .env.local
npm run dev
```

Acesse `http://localhost:3000`. No PowerShell use `Copy-Item .env.example .env.local`. Também é possível executar `node --env-file-if-exists=.env.local server.js` diretamente.

```sh
npm test
npm run build
```

## Fluxo

- Valida email, confirmação, nome, CPF/CNPJ com dígitos verificadores e telefone.
- `POST /api/pix` cria a venda em `https://api.blackcatoficial.com/api/sales/create-sale` usando o header privado `X-API-Key`.
- O servidor fixa `amount: 34700`, título do produto e valor unitário. Valores enviados pelo navegador são ignorados.
- O pop-up exibe `paymentData.copyPaste` (ou `qrCode`), imagem `qrCodeBase64` e validade. Se a imagem não vier, mantém disponível o código copia e cola.
- Copiar usa a área de transferência; em caso de bloqueio, seleciona o texto para cópia manual.
- O status é consultado a cada 12 segundos enquanto o pop-up estiver aberto e a aba visível, além da consulta manual. `PAID` só é exibido após confirmação da API e conferência da transação e do valor.
- A consulta usa um token assinado pelo servidor, sem permitir consultar transações arbitrárias. Nenhum dado pessoal é incluído nesse token.
- Pix expirado/cancelado permite gerar uma nova cobrança por ação explícita. Fechar e reabrir o pop-up reutiliza a cobrança da página.

## Sem banco de dados

Não há banco, gravação de Pix em disco, localStorage ou sessionStorage. A página conserva o Pix apenas na memória da aba; atualizar a página perde esse estado. O servidor usa memória temporária por até dez minutos para reduzir duplicação de chamadas, inclusive em falhas incertas. Os registros da transação pertencem ao processamento da Black Cat.

O cache de requisições e o limite de tentativas são locais a cada instância do servidor. Não oferecem idempotência ou limite global entre instâncias/reinícios. A documentação da Black Cat não estabelece garantia de idempotência para `externalRef`. Após falhas de rede, confira o painel antes de insistir em novas cobranças. Para tráfego público elevado, configure limites por IP no firewall da hospedagem.

## Limites da entrega

O checkout cria e consulta pagamentos. Não envia emails nem libera acesso ao curso; a entrega do produto precisa existir no processo do vendedor. A indicação de pagamento confirmado não dispara entrega automática. Nenhuma chave real é incluída no projeto.

Documentação utilizada: https://docs.blackcatoficial.com/
