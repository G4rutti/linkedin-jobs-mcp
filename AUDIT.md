# Auditoria — linkedin-jobs-mcp

Data: 16 de novembro de 2026
Escopo: `src/*.ts`, `scripts/*.mjs`, `package.json`. Base: o fluxo de login e as travas do [familysearch-mcp](https://github.com/G4rutti/familysearch-mcp), mais as funções de vaga e a detecção de bloqueio do [eliasbiondo/linkedin-mcp-server](https://github.com/eliasbiondo/linkedin-mcp-server).

## Resumo

Servidor só de leitura: nenhuma ferramenta candidata, manda mensagem, conecta ou posta. O maior risco não é de código, é de conta. O LinkedIn proíbe cliente automatizado, e por isso a busca e o detalhe da vaga usam os endpoints públicos **sem os seus cookies**. A sessão só é usada nos extras do `get-job-details` quando você está logado.

| # | Trava | Teste |
|---|---|---|
| 1 | Cookie só vai pra `https://*.linkedin.com` (barra `linkedin.com.evil.com`, `evillinkedin.com`, `http://`) | *never sends cookies to a non-LinkedIn URL* |
| 2 | Redirect seguido à mão, até 5 saltos, e cada salto checado | *does not follow a redirect off linkedin.com* |
| 3 | Busca e detalhe público não mandam cookie nenhum | *public endpoints never carry the session cookie* |
| 4 | 429/999: sem nova tentativa, pausa de 15 min | *rate limit pauses everything and does not retry* |
| 5 | Redirect pra `/checkpoint` ou `/challenge` também pausa (vindo do eliasbiondo) | *a security checkpoint redirect triggers the pause* |
| 6 | Redirect pra `/login`, `/authwall` ou `/uas/login` = sessão expirada | *authwall redirect means the session expired* |
| 7 | ID de vaga validado como só dígitos antes de montar a URL | *rejects malformed job ids before any request* |

## Outras decisões

- **Ritmo:** no mínimo ~4 s entre requisições, com até 50% de variação aleatória, uma de cada vez. `maxPages` vai no máximo a 10, e o `fresh-jobs` aceita no máximo 5 termos com 5 páginas cada.
- **Sem `set-session-cookie`:** no familysearch, essa ferramenta faz os cookies passarem pela conversa com a IA (achado 8 de lá). Aqui ela não existe, então o único caminho é o `login-with-browser`, que grava direto no arquivo local.
- **Arquivos:** `~/.linkedin-jobs-mcp/` com permissão 0700, `config.json` e `state.json` com 0600 e gravação atômica (arquivo temporário e depois `rename`). No Windows o `chmod` não tem efeito, igual ao achado 9 do familysearch.
- **`state.json`:** guarda só as buscas salvas e os IDs de vaga já vistos, no máximo 5000. Nada de cookie.
- **Processo filho:** `spawn(process.execPath, [script fixo])`, sem shell.
- **Login:** só os cookies de `linkedin.com` são salvos. O `li_at` sozinho não basta: o script espera o `/voyager/api/me` responder, pra não salvar um login pela metade (2FA ou checkpoint).
- **Erros:** as mensagens são montadas a partir de status e caminho, nunca com cookie.
- **Sem perfis de pessoas:** o eliasbiondo tem `get_person_profile` e `search_people`. Ficaram de fora porque não servem pra procurar vaga e coletam dado de terceiros.

## Não verificado ao vivo

- Os extras logados do `get-job-details` (`/voyager/api/jobs/jobPostings/{id}`): o endpoint e os campos (`listedAt`, `applies`, `applyMethod`, `applyingInfo.applied`) vêm de bibliotecas conhecidas, não de uma sessão real. Se falhar, a ferramenta devolve uma nota e segue com os dados públicos.
- O `npm run login` não foi rodado (exige o seu navegador e a sua conta).

Busca, detalhe público, `fresh-jobs` e a marcação de vaga vista foram testados contra o LinkedIn real em 16/11/2026.

## Economia de requisições (0.5.0)

O throttle só espaça as requisições. Estas mudanças cortam requisições que não precisavam acontecer:

| Onde | Antes | Agora |
|---|---|---|
| `search-jobs` / `fresh-jobs` | pedia todas as `maxPages`, mesmo depois de uma página curta | para na primeira página com menos de 10 vagas; com `onlyNew`, para também na primeira página só com vagas já vistas |
| Busca repetida | refazia tudo | resultado da mesma URL vem do cache por 5 min |
| `get-job-details` | 1 pública + 1 logada a cada chamada | pública em cache por 6 h, extras logados por 1 h (em disco: `cache-jobs.json`, `cache-extras.json`); `refresh: true` ignora o cache |
| `triage-jobs` | 2 requisições por vaga (pública + logada) | 1 por vaga não cacheada: a classificação não usa os extras logados |
| Extras logados quebrados | 1 requisição perdida por vaga | depois da primeira falha, pula por 1 h |
| `check-saved-searches` | rodava de novo mesmo checada 1 min antes | pula busca checada há menos de 10 min (`force: true` roda mesmo assim) |
| Pausa de 15 min | só em memória: reiniciar o servidor liberava | salva em `runtime.json`; o servidor reiniciado continua respeitando |

`session-status` agora mostra o `lastBlock` (endpoint e se a requisição levava a sua sessão). `withSession: false` significa que o LinkedIn barrou o endpoint público pelo IP, não a sua conta. As ferramentas devolvem `requests` pra mostrar quantas requisições de fato foram feitas.

## Ajustes 0.5.1 (26/11/2026)

Achados ao ler o `session-status` depois do primeiro uso real:

- **Redirecionamento em loop com o cookie:** o `get-job-details` logado deu "Too many redirects". Antes, cada salto era uma requisição de verdade e só a primeira passava pelo throttle: um loop disparava até 6 requisições seguidas, sem espaço, levando o cookie. Agora cada salto passa pelo throttle e o primeiro URL repetido para tudo, com o caminho percorrido (só caminhos, nunca cookie) na mensagem de erro.
- **Extras logados agora são opt-in** (`LINKEDIN_EXTRAS=1`). Eles chamam a API interna do LinkedIn com o seu cookie, nunca foram verificados ao vivo e falharam nas 5 vezes em que rodaram. É a requisição de maior risco pra conta, e o que ela entrega (contagem de candidatos, "já me candidatei") não vale isso.
