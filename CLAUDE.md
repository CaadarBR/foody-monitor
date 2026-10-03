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

# 💡 Ideias pendentes (não construídas)

- **Agrupar por localização quando sai com 1** — quando o entregador sai com só 1 pedido,
  checar se tinha outro pedido pronto/na fila indo pra PERTO (raio em metros, ex 500m) + pronto
  na mesma janela de tempo → avisar que dava pra agrupar. Alerta (🧩) + msg opcional. Depende da
  **coordenada do destino** do pedido (confirmar nos campos via `[DIAG]`).
- **5º pedido como última entrega (auto-dispatch oportunista)** — hoje o máx/entregador é 4
  (`config.autoDispatch.max`). Permitir/sugerir um 5º pedido ACIMA do máx QUANDO: (a) o pedido
  está pronto com **prazo baixo** (urgente), (b) o destino fica na **mesma região/rota** dos que
  o cara já vai levar, e (c) entraria como a **ÚLTIMA parada** — aí o tempo ainda fica OK e o
  entregador já está na região. "Encaixe" oportunista aproveitando que já tem alguém indo pra lá.
  Depende de: coords do destino + `deliveryDueDate` (já confirmado que existe) + ordem/rota.

# Infra / deploy
Git `main`. O deploy é por webhook do Easypanel (ver skill `/easypanel`). Working tree pode ficar
ATRASADO em relação ao origin — sempre `git fetch` + conferir antes de editar (em 02/10 o local
estava 12 commits atrás e a feature nem existia no server.js local).
