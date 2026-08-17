# ClassApp → Immich Sync — Especificação

**Status: implementado e testado ponta a ponta** (login manual, sync incremental, tags em cascata, timestamp EXIF, dedup) rodando em Docker. Este documento descreve o funcionamento atual e serve de referência para manutenção.

## 1. Objetivo

Utilitário de linha de comando (Node.js/TypeScript), executado sob demanda pelo usuário, que:

1. Extrai fotos anexadas a mensagens do ClassApp (API GraphQL interna do site web) para as duas filhas do usuário.
2. Faz upload incremental dessas fotos para um servidor Immich.
3. Marca cada foto enviada com uma tag em cascata por filha: `ClassApp` (pai) → `ClassApp/Bárbara`, `ClassApp/Giovana` (filhas).
4. Ajusta o timestamp (EXIF `DateTimeOriginal`/`CreateDate`) para **meio-dia (12:00) da data da mensagem** no ClassApp — a mensagem não carrega hora exata de captura da foto, e "meio-dia" evita ambiguidade de fuso na ordenação por dia.
5. Nunca reenvia fotos já importadas em execuções anteriores (dedup por `attachmentId` do ClassApp, com checkpoint salvo a cada foto).

Tudo roda dentro de um container Docker (Node + Chromium), sem agendamento automático — execução sob demanda via `docker compose exec`.

## 2. Uso do dia a dia

```bash
docker compose up -d                                # sobe o container (fica em background; idempotente)
docker compose exec classapp-sync npm run login     # só quando a sessão expirar (veja seção 4)
docker compose exec classapp-sync npm run sync       # sincronização incremental
```

Durante `npm run login`, acesse `http://localhost:6080` (noVNC) para ver e controlar o Chromium que abre dentro do container e fazer o login manual (email/senha + código de confirmação por email, quando solicitado). O processo detecta o login automaticamente (sem precisar apertar Enter em lugar nenhum) assim que captura o token de acesso no tráfego de rede.

`docker-compose.yml` monta `./data` do host em `/data` no container — é ali que ficam `session.json` (token de sessão) e `state.json` (registro incremental), então esses arquivos sobrevivem a rebuilds/restarts do container.

## 3. Arquitetura

```
┌──────────────────────────────────────────────────────────────┐
│ Container Docker (Node 20 + Chromium, supervisord)            │
│  Xvfb (:99) + x11vnc + noVNC (porta 6080, configurável)       │
│                                                                │
│  ┌──────────────┐   ┌──────────────────┐   ┌────────────────┐│
│  │ session.ts   │──▶│ classapp/         │──▶│ sync/run.ts    ││
│  │ (Puppeteer,  │   │ client.ts         │   │ (orquestração) ││
│  │  login manual,│   │ (GraphQL direto,  │   │                ││
│  │  perfil       │   │  Bearer token)    │   └───────┬────────┘│
│  │  persistente) │   └──────────────────┘           │         │
│  └──────────────┘                                    ▼         │
│                                              ┌────────────────┐│
│                                              │ immich/         ││
│                                              │ client.ts       ││
│                                              │ (upload, tags)  ││
│                                              └────────────────┘│
│                                                                │
│  Bind mount (./data no host → /data no container):            │
│   - /data/chrome-profile   (perfil do Chromium)               │
│   - /data/session.json     (accessToken/refreshToken/clientId)│
│   - /data/state.json       (registro incremental de sync)     │
└──────────────────────────────────────────────────────────────┘
```

Dois modos de execução, mesmo container:

- `npm run login` — abre Chromium visível via noVNC. O usuário loga manualmente. `session.ts` escuta todas as respostas de rede da página e procura recursivamente por `accessToken`/`refreshToken` em qualquer resposta GraphQL (funciona tanto para login direto quanto para o fluxo com OTP, sem depender do nome exato da mutation usada). `client_id` é extraído da própria URL da requisição. Resultado salvo em `/data/session.json`.
- `npm run sync` — não abre navegador; usa o token salvo para chamar diretamente a API GraphQL do ClassApp, buscar mensagens novas, baixar fotos e enviar ao Immich.

## 4. API do ClassApp

Documentada em detalhe em [`docs/classapp-api.md`](docs/classapp-api.md), via engenharia reversa (DevTools/Network). Resumo:

- Endpoint único GraphQL: `POST https://web.classapp.com.br/graphql?client_id=<id>&tz_offset=<min>&locale=<pt|en>`.
- Autenticação via header `Authorization: Bearer <accessToken>` (não cookie).
- Perfis das filhas: `viewer.entities` filtrado por `type === "STUDENT"`.
- Mensagens por aluno: paginadas (`limit`/`offset`), mais recentes primeiro — a paginação **para automaticamente** ao cruzar a data do último sync, sem varrer o histórico todo a cada execução incremental.
- Fotos de uma mensagem: `message.medias(type: IMAGE)` → `{ id, uri, mimetype, origName }`. `origName` é usado como nome do arquivo no Immich.
- Download das imagens (`images.classapp.com.br`): **confirmado, não exige autenticação**.

O `classapp/client.ts` é isolado dos demais módulos justamente para que, se o ClassApp mudar sua API no futuro, só ele precise ser ajustado.

## 5. Gerenciamento de sessão (login manual + expiração)

- `npm run login` grava `accessToken`, `refreshToken` (se presente) e `clientId` em `/data/session.json`.
- `npm run sync` carrega esse arquivo e usa o `accessToken` como Bearer em todas as chamadas GraphQL.
- Detecção de sessão expirada: tanto HTTP 401/403 quanto erros GraphQL (`errors[].extensions.code === "UNAUTHENTICATED"` ou mensagem contendo "auth"/"token"/"unauthorized") disparam `SessionExpiredError`, que interrompe o sync e imprime:
  ```
  [ERRO] Sessão do ClassApp expirada ou inválida.
  Rode `npm run login`, acesse http://localhost:6080 e faça login novamente.
  ```
- Não há retry automático de login (código de confirmação por email exige ação humana). Um `refreshToken` é capturado mas ainda não há mutation de refresh implementada — ver seção 8.

## 6. Sincronização incremental

Estado persistido em `/data/state.json`, **salvo a cada foto importada com sucesso** (não só ao final) — uma interrupção no meio do processo não perde progresso nem força reimportar tudo:

```jsonc
{
  "lastSyncAt": "2026-08-17T20:00:00.000Z",
  "importedAttachments": [
    { "messageId": "165056883", "attachmentId": "141330639", "immichAssetId": "...", "importedAt": "..." }
  ]
}
```

Fluxo de cada execução de `npm run sync`:

1. Para cada filha, buscar mensagens desde `lastSyncAt` (com margem de 1 dia, para cobrir mensagens tardias). Se `lastSyncAt` é nulo (primeira execução), busca o histórico completo.
2. Para mensagens com `imagesCount > 0`, buscar os anexos de imagem.
3. Para cada anexo não presente em `importedAttachments`:
   - Baixar a foto.
   - Ajustar EXIF (`DateTimeOriginal`/`CreateDate` = meio-dia da data da mensagem).
   - Enviar ao Immich (`deviceAssetId` estável = `classapp-<attachmentId>`, permitindo que o próprio Immich detecte reenvios duplicados).
   - Aplicar a tag em cascata `ClassApp/<PrimeiroNome>`.
   - Registrar no estado e salvar `state.json` imediatamente.
4. Ao final, atualizar `lastSyncAt` e imprimir resumo (novas / já existentes / falhas).

Deduplicação primária é por `attachmentId` do ClassApp (local, via `state.json`); o `deviceAssetId` estável no Immich é uma segunda camada de proteção contra duplicatas caso o estado local seja perdido/reconstruído.

## 7. Integração com Immich

- Autenticação: API Key (Configurações → API Keys no Immich), via `IMMICH_BASE_URL`/`IMMICH_API_KEY`.
- Upload: `POST /assets`, multipart, com o EXIF já ajustado no arquivo antes do envio.
- Tags em cascata: `ensureTag(path)` em `immich/client.ts` casa/cria tags pelo campo `value` (caminho completo, ex: `ClassApp/Bárbara`), permitindo que o Immich monte a hierarquia `ClassApp` → `ClassApp/Bárbara` automaticamente. O nome da filha vem do primeiro nome do perfil do ClassApp, normalizado (`BARBÁRA KANN THEYS` → `Bárbara`).

## 8. Configuração (`.env`, não versionado)

```
IMMICH_BASE_URL=https://immich.example.com/api
IMMICH_API_KEY=xxxxx
IMMICH_TAG_PREFIX=ClassApp

CLASSAPP_BASE_URL=https://classapp.com.br
CLASSAPP_GRAPHQL_URL=https://web.classapp.com.br/graphql
CLASSAPP_LOCALE=pt

TZ=America/Sao_Paulo
NOVNC_PORT=6080
DATA_DIR=/data
```

Ver `.env.example` para o template.

## 9. Estrutura do projeto

```
ClassApp-to-immich/
├── docker-compose.yml          # bind mount ./data:/data, porta noVNC
├── Dockerfile                  # multi-stage: build TS, runtime com Chromium+noVNC
├── docker/supervisord.conf     # Xvfb + x11vnc + noVNC
├── .env.example / .env (local, não versionado)
├── tsconfig.json
├── docs/
│   └── classapp-api.md         # API GraphQL do ClassApp, documentada via engenharia reversa
├── src/
│   ├── types.ts                # tipos compartilhados
│   ├── classapp/
│   │   ├── session.ts          # login manual via Puppeteer, captura automática do token
│   │   └── client.ts           # cliente GraphQL do ClassApp
│   ├── immich/
│   │   └── client.ts           # upload, tags em cascata
│   ├── sync/
│   │   ├── state.ts            # leitura/escrita incremental de state.json
│   │   └── run.ts              # orquestração do fluxo de sync
│   ├── exif.ts                 # ajuste de timestamp EXIF (exiftool-vendored)
│   └── cli.ts                  # entrypoints `login` / `sync`
├── package.json
└── SPEC.md
```

## 10. Dependências

- `puppeteer-core` + Chromium do container — login manual.
- `axios` — chamadas GraphQL ao ClassApp e REST ao Immich.
- `form-data` — upload multipart ao Immich.
- `exiftool-vendored` — ajuste de EXIF.
- `dotenv` — configuração.
- `typescript`/`@types/node` (dev) — build para `dist/`.
- Estado em JSON simples (sem banco de dados; volume de mensagens não justifica).

## 11. Limitações conhecidas / próximos passos possíveis

- **Refresh automático de token**: um `refreshToken` é capturado no login, mas ainda não há mutation de refresh implementada — hoje, ao expirar, é sempre necessário `npm run login` manual de novo. Investigar se vale a pena no futuro.
- **Heurística de sessão expirada**: a detecção de erro GraphQL de autenticação (`extensions.code === "UNAUTHENTICATED"` ou regex em mensagem) foi implementada por inferência; ainda não observamos um erro real de expiração em produção para validar 100%. Se `npm run sync` falhar de forma inesperada sem cair no fluxo de "sessão expirada", pode ser esse o motivo — ajustar `client.ts` conforme o formato real do erro.
- **Tipos de anexo**: escopo atual cobre apenas imagens (`medias(type: IMAGE)`); vídeos e arquivos (PDF etc.) do ClassApp não são sincronizados.
- **Falhas transitórias de upload**: já observamos ao menos um caso de erro HTTP 400 pontual do Immich que se resolveu sozinho numa nova tentativa (não investigado a fundo — não houve recorrência). Não há retry automático dentro de uma mesma execução; rodar `npm run sync` de novo reprocessa só o que falhou.
