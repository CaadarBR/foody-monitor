# Foody Monitor (`\monitor` → monitor.varandaspizzaria.com)

Node app de monitoramento AO VIVO das entregas no Foody (`server.js` único + `public/index.html`).
Repo: CaadarBR/foody-monitor. Rroda no Easypanel.

# ⚠️ Dois projetos que se cruzam: `\monitor` (este) e `\entregas`

Existem DOIS sistemas que falam com o **mesmo Foody** (mesma conta/sessão) e **um pode interferir no outro** — SEMPRE confira os dois ao mexer em qualquer coisa de Foody:

- **`\monitor`** (este projeto): `server.js` **liga/desliga courier no Foody** (`toggleCourier` → `/api/v2/courier/toggle/{id}`) em dois lugares:
  - **auto-block**: segurou pedido sem aceitar além do limite → desconecta por X min.
  - **auto-shift** ("Desligar no fim do expediente / religar no horário"): no fim do turno desliga todos que estavam conectados, guarda a lista e religa só eles no horário (padrão 17:00). ⚠️ O disparo é só na MADRUGADA (`isLateNightBRT`), pra não re-desligar na janela de loja-fechada do dia/pré-abertura (bug corrigido 02/10/2026 — ver comentário no `processAutoShift`/loop do poll).
  Também poll de 1–10s no Foody (rastreamento/pedidos) → soma carga = risco de **429**.
- **`\entregas`** (`C:\Users\johnc\Claude\Varandas Pizzaria\Entregas`, `entregas.varandaspizzaria.com`): `lib/foody.ts` → `syncFoody()` também **liga/desliga courier no Foody** (`toggleFoody`) pra casar com o `ativo` de lá; e puxa relatórios pro ranking/diárias (também dá 429).

**Consequência prática:** se um courier aparece/some como ativo/online, offline, ou "algo desativando de novo", **NÃO assuma que é só este projeto** — pode ser o `\entregas` (`syncFoody`) ou vice-versa. Os dois disputam o toggle do Foody e somam carga na API. Ao debugar Foody, abra os dois e cheque qual está agindo.

# Infra / deploy
Git `main`. O deploy é por webhook do Easypanel (ver skill `/easypanel`). Working tree pode ficar
ATRASADO em relação ao origin — sempre `git fetch` + conferir antes de editar (em 02/10 o local
estava 12 commits atrás e a feature nem existia no server.js local).
