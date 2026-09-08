# Catálogo

Site no celular para cadastrar produtos com **foto**, **quantidade** e **data de validade**. Os dados ficam no aparelho (uso rápido) e são gravados no Google Drive com a mesma service account do Fundo Bíblico.

O Google **não deixa** a service account gravar ficheiros numa pasta pessoal (como [esta Catalogo](https://drive.google.com/drive/folders/1Dq9o2-LJ_RKvSilpgEa_enXLus4QVylY)): a conta de serviço não tem cota no Drive normal. O Fundo Bíblico já usa um **Drive compartilhado**; o catálogo cria a pasta `Catalogo/` lá dentro.

## Antes de ligar

1. A pasta do `.env` tem de estar num Drive compartilhado, com `fondo-biblico-drive@projetoscci.iam.gserviceaccount.com` como **Editor**.
2. Copie `.env.example` para `.env`.
3. Cole `GOOGLE_SERVICE_ACCOUNT_JSON` a partir de `church-inventory-orders/.env` (Fundo Bíblico). O ID da pasta já aponta para o Drive compartilhado do Fundo Bíblico.

Não commite o `.env`.

## Como abrir

```bash
npm install
npm start
```

No computador: [http://localhost:3847](http://localhost:3847)

No celular (mesma rede Wi-Fi): use o endereço `http://SEU-IP:3847` que aparece no terminal.

## Uso

- Toque em **+** para fotografar e cadastrar
- Ajuste a quantidade com +/− no card
- Vencido = vermelho; vence em 7 dias = âmbar
- Menu (três pontos): exportar JSON (com fotos), exportar CSV (Excel) e importar JSON

A importação **acrescenta** produtos; não apaga o catálogo.

## No Drive

```
Documentos/          (Drive compartilhado do Fundo Bíblico)
  Catalogo/
    catalogo.json
    fotos/
      {id}.jpg
```
