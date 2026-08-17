# ClassApp — endpoints internos (engenharia reversa)

Descoberto via DevTools/Network em `classapp.com.br` (frontend) chamando a API em
`web.classapp.com.br`. A API é **GraphQL**, um único endpoint para tudo.

## Endpoint

```
POST https://web.classapp.com.br/graphql?client_id=<CLIENT_ID>&tz_offset=<MINUTOS>&locale=<pt|en>
Content-Type: application/json
```

- `client_id`: string fixa gerada pelo frontend (parece um identificador de instalação/browser, não uma credencial de conta). Capturado uma vez durante o login e reaproveitado nas chamadas seguintes da mesma sessão.
- `tz_offset`: offset de fuso em minutos, com sinal invertido em relação ao `Date.getTimezoneOffset()` do JS (ex: America/Sao_Paulo UTC-3 → `-180`).
- `locale`: `pt` ou `en`, não parece afetar dados, só textos de erro/i18n.

Como o corpo usa GraphQL, **não precisamos replicar as queries gigantes do app** — o servidor aceita qualquer seleção de campos válida do schema. Implementamos queries próprias, enxutas, usando só os campos confirmados nas respostas reais abaixo.

## Autenticação

- Mutation observada: `passwordAuthenticate(input: { email, password })`.
- Resposta:
  ```json
  {
    "data": {
      "passwordAuthenticate": {
        "requiresOtp": false,
        "user": {
          "id": 14337488,
          "oauthProvider": { "accessToken": "...", "refreshToken": "..." }
        }
      }
    }
  }
  ```
- `requiresOtp: true` indica que o fluxo pede confirmação por email antes de retornar o token (o caso citado pelo usuário). Nesse caso deve existir uma segunda mutation (nome ainda não capturado — provavelmente algo como `otpAuthenticate`) que recebe o código enviado por email e retorna o mesmo formato `user.oauthProvider.accessToken`.
- **Autenticação nas chamadas seguintes**: header `Authorization: Bearer <accessToken>`. Não há dependência de cookies.
- `refreshToken` também é retornado — sugere que pode existir uma mutation de refresh que renove o `accessToken` sem precisar repetir OTP. **Ainda não descoberto.** Enquanto isso, ao expirar o `accessToken` trataremos como sessão expirada e pediremos novo login manual (comportamento já especificado).
- Estratégia de captura: como o login pode envolver OTP (segunda chamada), a forma mais robusta é o Puppeteer escutar todas as respostas de rede da página durante o login manual e procurar recursivamente por `oauthProvider.accessToken` em qualquer resposta GraphQL — funciona independente do nome exato da mutation usada (senha direta ou senha+OTP). O `client_id` é extraído da query string da própria requisição.

## Perfis dos alunos (filhas)

Query própria (baseada nos campos confirmados em `AppQuery` → `viewer.entities`):

```graphql
query ListEntities {
  viewer {
    id: dbId
    fullname
    entities(limit: 100) {
      nodes {
        id: dbId
        type
        disabled
        fullname
      }
    }
  }
}
```

Filtramos no client por `type === "STUDENT" && !disabled`. Exemplo real (2 filhas):

```json
{"id": 1238329700, "type": "STUDENT", "disabled": false, "fullname": "BARBÁRA KANN THEYS"}
{"id": 1238329730, "type": "STUDENT", "disabled": false, "fullname": "GIOVANA KANN THEYS"}
```

## Listagem de mensagens por aluno

Query própria (baseada em `EntityMessagesQuery`):

```graphql
query ListMessages($entityId: ID!, $limit: Int, $offset: Int) {
  node(id: $entityId) {
    ... on Entity {
      messages(limit: $limit, offset: $offset) {
        nodes {
          id: dbId
          created
          sentAt
          summary
          imagesCount
        }
        pageInfo { hasNextPage }
      }
    }
  }
}
```

- Paginação via `offset`/`limit` (a UI usa `limit: 25`).
- **Ordenação**: mais recente primeiro (confirmado pelos timestamps decrescentes na amostra real). Isso permite parar a paginação assim que encontrarmos uma mensagem com `created`/`sentAt` anterior ao `since` do sync incremental — sem precisar varrer tudo a cada execução.
- `imagesCount` indica quantas fotos a mensagem tem; só buscamos o detalhe (próxima seção) quando `imagesCount > 0`.
- Campos completos disponíveis mas não usados: `subject`, `label`, `entity` (remetente), `toEntity`, etc. — podem ser adicionados depois se quisermos mais metadata na tag/álbum.

## Detalhe da mensagem (fotos)

Query própria (baseada em `MessageNodeEntityQuery` + fragment `MessageMedias`):

```graphql
query GetMessageImages($entityId: ID!, $messageId: ID!) {
  node(id: $entityId) {
    ... on Entity {
      message(id: $messageId) {
        id: dbId
        created
        images: medias(type: IMAGE, limit: 40) {
          nodes {
            id: dbId
            original: uri(size: "w1280")
            mimetype
            origName
          }
        }
      }
    }
  }
}
```

Exemplo real de resposta (mensagem com 5 fotos):

```json
{
  "images": {
    "nodes": [
      {
        "id": 141330639,
        "original": "https://images.classapp.com.br/w1280/classapp-live-media-1/2ec470ac....jpeg",
        "mimetype": "image/jpeg",
        "origName": "0D50193E-3FBF-4E7D-B519-DD7CABA9D9DA-image.jpg"
      }
    ]
  }
}
```

- `id` (dbId da Media) é o identificador estável usado para deduplicação (`attachmentId` no nosso `state.json`).
- `original` é a URL final da imagem, servida por `images.classapp.com.br` (domínio de CDN separado do GraphQL). **Confirmado: não exige autenticação** — download é um GET simples, sem Bearer token.
- `origName` é usado como nome do arquivo enviado ao Immich.
- `w1280` é o parâmetro de tamanho pedido (poderíamos pedir maior/original se existir uma opção tipo `w2048`/sem redimensionamento — a confirmar se necessário mais resolução).

## Detecção de sessão expirada

Diferente de uma API REST comum, GraphQL normalmente retorna **HTTP 200** mesmo em erro de autenticação, com um array `errors` no corpo. **Ainda não capturamos um exemplo real de erro de token expirado** — a lógica atual verifica tanto status HTTP 401/403 quanto a presença de `errors[].extensions.code === "UNAUTHENTICATED"` (ou mensagem contendo "auth"/"token"/"unauthorized"), mas isso deve ser validado na prática quando o token realmente expirar, e ajustado conforme o formato real do erro.

## Observações / pendências

- Nome da mutation de confirmação do código OTP (2º passo do login quando `requiresOtp: true`): não capturado ainda — só necessário se decidirmos automatizar esse passo (não é o caso: o usuário loga manualmente no navegador).
- Mutation de refresh de token (usando `refreshToken`): não capturada. Se existir e for simples, poderíamos renovar o `accessToken` automaticamente sem exigir novo login manual a cada expiração — vale investigar depois.
- `client_id`: capturado dinamicamente durante o login (via Puppeteer, lendo a query string da própria requisição), não é fixo no código nem no `.env`.
