# ClassApp → Immich Sync

Extrai fotos de mensagens do [ClassApp](https://classapp.com.br) e faz upload incremental para um servidor [Immich](https://immich.app), com tag em cascata por filha (`ClassApp/<Nome>`), timestamp EXIF ajustado para o meio-dia da data da mensagem, e o texto da mensagem salvo como descrição da foto no Immich. O sync roda em duas fases concorrentes (busca de mensagens/fotos e download/upload), com paralelismo configurável.

Para arquitetura, formato da API do ClassApp e limitações conhecidas, veja [`SPEC.md`](SPEC.md).

## Requisitos

- Docker e Docker Compose.
- Uma API Key do Immich (Configurações → API Keys).
- Conta no ClassApp com acesso às filhas cujas mensagens serão sincronizadas.

## Configuração

```bash
cp .env.example .env
# edite .env com IMMICH_BASE_URL e IMMICH_API_KEY
```

## Uso

```bash
docker compose up -d --build                                    # sobe o container
docker compose exec classapp-sync npm run login                  # login manual (só quando a sessão expirar)
docker compose exec classapp-sync npm run sync                    # sincronização incremental
docker compose exec classapp-sync npm run backfill-descriptions   # preenche descrição em fotos já importadas antes desse recurso existir (uso pontual)
```

Durante `npm run login`, acesse `http://localhost:6080` (noVNC) para controlar o Chromium aberto dentro do container e logar manualmente no ClassApp (email/senha + código de confirmação por email, se solicitado). O login é detectado automaticamente — não precisa apertar nada além de completar o login no navegador.

`session.json` (token) e `state.json` (registro incremental) ficam em `./data`, montado do host — sobrevivem a rebuilds e restarts do container.

O paralelismo do `npm run sync` é controlado por `SYNC_CONCURRENCY` no `.env` (padrão: 6).
