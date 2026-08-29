<template>
  <div class="econ">
    <header class="head">
      <div>
        <h1 class="title">Economy</h1>
        <p class="sub">
          Org shopping list, craft BOMs, mine/refine estimates, trade &amp; prices — same data as
          TeamSpeak commands. Estimates only; not CIG live market.
        </p>
      </div>
      <button class="btn ghost" :disabled="busy" @click="reloadAll">
        {{ busy ? 'Loading…' : 'Refresh' }}
      </button>
    </header>

    <p v-if="err" class="err">{{ err }}</p>
    <p v-if="msg" class="msg">{{ msg }}</p>

    <nav class="tabs">
      <button
        v-for="t in tabs"
        :key="t.id"
        class="tab"
        :class="{ active: tab === t.id }"
        @click="tab = t.id"
      >
        {{ t.label }}
        <span v-if="t.id === 'work' && openCount > 0" class="badge">{{ openCount }}</span>
      </button>
    </nav>

    <!-- ── Work orders ─────────────────────────────────────────────────── -->
    <section v-if="tab === 'work'" class="panel">
      <div class="card">
        <h2>Add work order</h2>
        <form class="row form" @submit.prevent="addWorkOrder">
          <input
            v-model="woItem"
            class="input"
            placeholder="Blueprint (e.g. P4-AR, Coda)"
            required
          />
          <input v-model.number="woQty" class="input qty" type="number" min="1" max="999" />
          <button class="btn primary" type="submit" :disabled="busy || !woItem.trim()">
            Add
          </button>
        </form>
        <p class="hint">Resolves live BOM via sc-craft.tools, scales by qty, saves to org board.</p>
      </div>

      <div class="card">
        <div class="card-head">
          <h2>Org shopping list</h2>
          <button
            v-if="orders.length && isAdmin"
            class="btn danger ghost"
            :disabled="busy"
            @click="clearWorkOrders"
            title="Admin only"
          >
            Clear all
          </button>
        </div>
        <div v-if="materials.length" class="mat-grid">
          <div v-for="m in materials" :key="m.material + m.unit" class="mat-chip">
            <strong>{{ fmtAmt(m.amount) }}</strong>
            <span
              >SCU {{ m.material }}{{ m.unstable ? ' ⚠️' : ''
              }}{{ m.boxes ? ` (${m.boxes})` : '' }}</span
            >
          </div>
        </div>
        <p v-else class="muted">Nothing on the board — add a work order above.</p>
      </div>

      <div class="card">
        <h2>Open work orders ({{ orders.length }})</h2>
        <ul v-if="orders.length" class="order-list">
          <li v-for="o in orders" :key="o.id" class="order-row">
            <div class="order-main">
              <span class="order-id">#{{ o.id }}</span>
              <span class="order-title">{{ o.qty }}× {{ o.itemName }}</span>
              <span v-if="o.createdBy" class="meta">by {{ o.createdBy }}</span>
            </div>
            <div class="order-bom">
              <span v-for="l in o.lines" :key="l.material" class="bom-line">
                {{ fmtAmt(l.amount) }} SCU{{ l.boxes ? ` (${l.boxes})` : '' }} {{ l.material
                }}{{ l.unstable ? ' ⚠️' : '' }}
              </span>
            </div>
            <button class="btn small" :disabled="busy" @click="doneWorkOrder(o.id)">Done</button>
          </li>
        </ul>
        <p v-else class="muted">No open work orders.</p>
      </div>
    </section>

    <!-- ── Mine / refine ───────────────────────────────────────────────── -->
    <section v-if="tab === 'mine'" class="panel">
      <div class="card">
        <h2>Mine pull</h2>
        <form class="row form" @submit.prevent="runMine">
          <input v-model="mineOre" class="input" list="ore-list" placeholder="Ore (Quantainium)" />
          <input v-model.number="mineScu" class="input qty" type="number" min="1" max="10000" />
          <select v-model="mineMethod" class="input select">
            <option value="">Default method</option>
            <option v-for="m in methods" :key="m.id" :value="m.id">{{ m.name }}</option>
          </select>
          <button class="btn primary" type="submit" :disabled="busy">Calculate</button>
        </form>
        <div v-if="mineResult" class="result">
          <div class="result-title">
            {{ mineResult.targetScu }} SCU {{ mineResult.ore.name }}
            <span v-if="mineResult.ore.unstable">⚠️</span>
          </div>
          <p v-if="mineResult.stabilityLine" class="warn-line">{{ mineResult.stabilityLine }}</p>
          <p>
            Suggested refine:
            <strong>{{ mineResult.suggestedMethod.name }}</strong>
            (~{{ mineResult.suggestedMethod.yieldPct }}%)
          </p>
          <p class="meta">Mode: {{ mineResult.ore.mode }} · Stability: {{ mineResult.ore.stability }}</p>
        </div>
      </div>

      <div class="card">
        <h2>Refine yield</h2>
        <form class="row form" @submit.prevent="runRefine">
          <input v-model="refineOre" class="input" list="ore-list" placeholder="Ore" />
          <input v-model.number="refineScu" class="input qty" type="number" min="1" max="10000" />
          <select v-model="refineMethod" class="input select">
            <option v-for="m in methods" :key="m.id" :value="m.id">
              {{ m.name }} ({{ m.yieldPct }}%)
            </option>
          </select>
          <button class="btn primary" type="submit" :disabled="busy">Calculate</button>
        </form>
        <div v-if="refineResult" class="result">
          <p>
            {{ refineResult.inputScu }} SCU raw →
            <strong>{{ refineResult.outputScu }} SCU</strong>
            refined ({{ refineResult.method.name }})
          </p>
          <p class="meta">
            Yield ~{{ refineResult.method.yieldPct }}% by method (same for every ore; station can
            change it)
          </p>
        </div>
      </div>

      <datalist id="ore-list">
        <option v-for="o in ores" :key="o.id" :value="o.name" />
      </datalist>
    </section>

    <!-- ── Craft ───────────────────────────────────────────────────────── -->
    <section v-if="tab === 'craft'" class="panel">
      <div class="card">
        <h2>Blueprint search</h2>
        <form class="row form" @submit.prevent="searchBlueprints">
          <input
            v-model="bpQuery"
            class="input"
            placeholder="In-game name (P4-AR, Coda, Greatsword…)"
          />
          <button class="btn primary" type="submit" :disabled="busy || !bpQuery.trim()">
            Search
          </button>
        </form>
        <ul v-if="bpResults.length" class="list">
          <li v-for="bp in bpResults" :key="bp.id" class="list-row">
            <div>
              <strong>{{ bp.name }}</strong>
              <span v-if="bp.category" class="meta"> · {{ bp.category }}</span>
            </div>
            <button class="btn small" @click="loadCraft(bp.name)">BOM</button>
          </li>
        </ul>
        <p v-if="bpAttr" class="attr">{{ bpAttr }}</p>
      </div>

      <div v-if="craftResult" class="card">
        <div class="card-head">
          <h2>{{ craftResult.qty }}× {{ craftResult.blueprint.name }}</h2>
          <button class="btn primary small" :disabled="busy" @click="saveCraftAsWorkOrder">
            Save as work order
          </button>
        </div>
        <ul class="bom-list">
          <li v-for="l in craftResult.bom" :key="l.material">
            {{ fmtAmt(l.amount) }} {{ l.unit }} {{ l.material }}{{ l.unstable ? ' ⚠️' : '' }}
          </li>
        </ul>
        <p class="attr">{{ craftResult.attribution }}</p>
      </div>
    </section>

    <!-- ── Trade ───────────────────────────────────────────────────────── -->
    <section v-if="tab === 'trade'" class="panel">
      <div class="card">
        <h2>Trade routes</h2>
        <p v-if="overview && !overview.clients.scTrade" class="warn">
          sc-trade disabled (<code>ECONOMY_SCTRADE=0</code>).
        </p>
        <p v-else-if="overview && !overview.clients.scTradeToken" class="warn">
          <strong>SC Trade API token missing.</strong> Set env
          <code>SC_TRADE_API_TOKEN</code> (Patreon licence from sc-trade.tools) and restart.
          Ships catalog works without a token; routes / buyers / itinerary / circuit need it.
        </p>
        <form class="rowform wrap" @submit.prevent="runTradeRoutes">
          <input v-model="tradeShip" class="input" placeholder="Ship (Freelancer)" />
          <input
            v-model.number="tradeInvest"
            class="input qty wide"
            type="number"
            min="1000"
            step="1000"
            placeholder="Invest aUEC"
          />
          <input v-model.number="tradeStops" class="input qty" type="number" min="1" max="8" />
          <select v-model="tradeProfit" class="input select">
            <option value="time">Profit / time</option>
            <option value="pure">Pure profit</option>
          </select>
          <input v-model="tradeLoc" class="input" placeholder="Location filter (Stanton)" />
          <button class="btn primary" type="submit" :disabled="busy || tradeBlocked">
            Find routes
          </button>
        </form>
        <div v-if="tradeRoutes.length" class="routes">
          <div v-for="(r, i) in tradeRoutes" :key="r.id ?? i" class="route-card">
            <div class="route-title">
              #{{ r.id ?? i + 1 }}
              <span v-if="r.profit != null" class="profit">{{ fmtMoney(r.profit) }} aUEC</span>
              <span v-if="r.profitPerMinute != null" class="meta">
                · {{ Math.round(r.profitPerMinute) }}/min
              </span>
              <button
                v-if="r.id != null"
                class="btn small"
                :disabled="busy || tradeBlocked"
                @click="runCircuit(r.id!)"
              >
                Circuit
              </button>
            </div>
            <p class="meta">
              {{ r.origin?.locationAndShop || r.origin?.location || r.origin?.shop || '?' }}
              →
              {{
                r.destination?.locationAndShop || r.destination?.location || r.destination?.shop || '?'
              }}
            </p>
            <p v-if="r.origin?.itemName" class="meta">
              Buy {{ r.origin.itemName }}
              <template v-if="r.origin.itemQuantityInScu">
                ({{ r.origin.itemQuantityInScu }} SCU)
              </template>
              @ {{ fmtMoney(r.origin.price) }}
            </p>
          </div>
        </div>
        <p v-if="tradeAttr" class="attr">{{ tradeAttr }}</p>
      </div>

      <div class="card">
        <h2>Best buyers</h2>
        <form class="rowform" @submit.prevent="runBuyers">
          <input v-model="buyerCommodity" class="input" placeholder="Commodity (Agricium)" />
          <input v-model.number="buyerScu" class="input qty" type="number" min="1" max="10000" />
          <input v-model="buyerLoc" class="input" placeholder="loc (Stanton)" />
          <button class="btn primary" type="submit" :disabled="busy || tradeBlocked">
            Find buyers
          </button>
        </form>
        <ul v-if="buyers.length" class="list">
          <li v-for="(b, i) in buyers" :key="i" class="list-row">
            <div>
              <strong>{{ fmtMoney(b.price) }}</strong>
              <span class="meta">
                · {{ b.locationAndShop || b.location || b.shop || '—' }}
                <template v-if="b.itemQuantityInScu || b.quantityInScu">
                  · {{ b.itemQuantityInScu || b.quantityInScu }} SCU
                </template>
              </span>
            </div>
          </li>
        </ul>
      </div>

      <div class="card">
        <h2>Itinerary (shop → shop)</h2>
        <p class="hint">
          Shop paths must match sc-trade.tools names (use
          <code>&gt;</code> separators).
        </p>
        <form class="rowform wrap" @submit.prevent="runItinerary">
          <input v-model="itinFrom" class="input wide" placeholder="From shop path" required />
          <input v-model="itinTo" class="input wide" placeholder="To shop path" required />
          <button class="btn primary" type="submit" :disabled="busy || tradeBlocked">
            Find itinerary
          </button>
        </form>
        <div v-if="itinRoutes.length" class="routes">
          <div v-for="(r, i) in itinRoutes" :key="'i' + (r.id ?? i)" class="route-card">
            <div class="route-title">
              Itinerary #{{ r.id ?? i + 1 }}
              <span v-if="r.profit != null" class="profit">{{ fmtMoney(r.profit) }} aUEC</span>
            </div>
            <p class="meta">
              {{ r.origin?.locationAndShop || r.origin?.shop || '?' }}
              →
              {{ r.destination?.locationAndShop || r.destination?.shop || '?' }}
            </p>
          </div>
        </div>
      </div>

      <div class="card">
        <h2>Circuit loop</h2>
        <p class="hint">Use a route id from Find routes, or the Circuit button on a result.</p>
        <form class="rowform" @submit.prevent="runCircuit(circuitId)">
          <input
            v-model.number="circuitId"
            class="input qty wide"
            type="number"
            min="1"
            placeholder="Trade id"
          />
          <button
            class="btn primary"
            type="submit"
            :disabled="busy || tradeBlocked || !circuitId"
          >
            Run circuit
          </button>
        </form>
        <div v-if="circuitRoutes.length" class="routes">
          <div v-for="(r, i) in circuitRoutes" :key="'c' + (r.id ?? i)" class="route-card">
            <div class="route-title">
              Circuit step {{ i + 1 }}
              <span v-if="r.profit != null" class="profit">{{ fmtMoney(r.profit) }} aUEC</span>
            </div>
            <p class="meta">
              {{ r.origin?.locationAndShop || r.origin?.shop || '?' }}
              →
              {{ r.destination?.locationAndShop || r.destination?.shop || '?' }}
            </p>
          </div>
        </div>
      </div>
    </section>

    <!-- ── Prices ──────────────────────────────────────────────────────── -->
    <section v-if="tab === 'prices'" class="panel">
      <div class="card">
        <h2>UEX commodity prices</h2>
        <form class="row form" @submit.prevent="runPrices">
          <select
            v-model="priceQuery"
            class="input select price-commodity-select"
            :disabled="busy || !uexCommodities.length"
            @change="runPrices"
          >
            <option disabled value="">
              {{
                uexCommodities.length
                  ? `Select commodity (${uexCommodities.length})…`
                  : uexCommoditiesLoading
                    ? 'Loading commodities…'
                    : 'No commodities (UEX offline?)'
              }}
            </option>
            <option v-for="c in uexCommodities" :key="c.id + c.name" :value="c.name">
              {{ c.name }}{{ c.code ? ` (${c.code})` : '' }}{{ c.isRaw ? ' · raw' : '' }}
            </option>
          </select>
          <button
            class="btn primary"
            type="submit"
            :disabled="busy || !priceQuery"
            title="Lookup selected commodity"
          >
            Lookup
          </button>
        </form>
        <p v-if="uexCommoditiesErr" class="muted">{{ uexCommoditiesErr }}</p>
        <div v-if="priceResult" class="result">
          <div class="result-title">{{ priceResult.commodity.name }}</div>
          <p>
            Sell avg: <strong>{{ fmtMoney(priceResult.sell) }}</strong>
            · Buy avg: <strong>{{ fmtMoney(priceResult.buy) }}</strong>
            <span v-if="priceResult.source" class="meta"> · {{ priceResult.source }}</span>
          </p>
          <p v-if="priceResult.supply" class="meta">
            Supply
            {{
              priceResult.supply.supplyPct != null
                ? `~${Math.round(priceResult.supply.supplyPct)}% of avg stock`
                : 'n/a'
            }}
            · {{ priceResult.supply.sampleSize }} terminals
          </p>
          <ul v-if="priceResult.supply?.sellTerminals?.length" class="list compact">
            <li
              v-for="t in priceResult.supply.sellTerminals"
              :key="t.name + t.price"
              class="list-row"
            >
              <span>{{ t.name }}</span>
              <span class="meta">sell {{ fmtMoney(t.price) }}</span>
            </li>
          </ul>
          <ul v-if="priceResult.matches?.length" class="list compact">
            <li v-for="m in priceResult.matches" :key="m.code + m.name" class="list-row">
              <span>{{ m.name }}{{ m.isRaw ? ' (raw)' : '' }}</span>
              <span class="meta">sell {{ fmtMoney(m.sell) }} · buy {{ fmtMoney(m.buy) }}</span>
            </li>
          </ul>
          <p class="attr">{{ priceResult.attribution }}</p>
        </div>
      </div>
    </section>

    <!-- ── Catalog ─────────────────────────────────────────────────────── -->
    <section v-if="tab === 'catalog'" class="panel">
      <div class="card">
        <div class="card-head">
          <h2>Ores ({{ filteredOres.length }})</h2>
          <input v-model="oreFilter" class="input compact" placeholder="Filter…" />
        </div>
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Mode</th>
                <th>Stability</th>
                <th>~aUEC/SCU</th>
                <th>Default method</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="o in filteredOres" :key="o.id">
                <td>
                  {{ o.name }}
                  <span v-if="o.unstable">⚠️</span>
                </td>
                <td>{{ o.mode }}</td>
                <td>
                  <span :class="'stab-' + o.stability">{{ o.stability }}</span>
                  <span v-if="o.refineWithinMin" class="meta">
                    · ≤{{ o.refineWithinMin }}m
                  </span>
                </td>
                <td>{{ o.valueScuApprox != null ? fmtMoney(o.valueScuApprox) : '—' }}</td>
                <td>{{ o.defaultMethod }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-if="overview" class="attr">Seed: {{ overview.catalogAsOf }}</p>
      </div>

      <div class="card">
        <h2>Refine methods</h2>
        <ul class="list">
          <li v-for="m in methods" :key="m.id" class="list-row">
            <div>
              <strong>{{ m.name }}</strong>
              <span class="meta"> · ~{{ m.yieldPct }}% yield · time×{{ m.timeMult }} · cost×{{ m.costMult }}</span>
              <p v-if="m.notes" class="hint">{{ m.notes }}</p>
            </div>
          </li>
        </ul>
      </div>
    </section>

    <!-- ── Cache ───────────────────────────────────────────────────────── -->
    <section v-if="tab === 'cache'" class="panel">
      <div class="card">
        <div class="card-head">
          <h2>Disk cache</h2>
          <button
            v-if="isAdmin"
            class="btn primary"
            :disabled="busy"
            @click="refreshCache"
            title="Admin only"
          >
            {{ busy ? 'Refreshing…' : 'Refresh now' }}
          </button>
        </div>
        <p v-if="!isAdmin" class="hint">Cache refresh is admin-only on the dashboard (TS: !econ refresh).</p>
        <div v-if="cache" class="cache-stats">
          <p>
            <span class="meta">Cache</span> <code>{{ cache.rootLabel }}</code>
          </p>
          <p>
            {{ cache.totalFiles }} files · ~{{ Math.round((cache.totalBytes || 0) / 1024) }} KB
          </p>
          <ul class="list compact">
            <li v-for="s in cache.sources" :key="s.source" class="list-row">
              <span>{{ s.source }}</span>
              <span class="meta">
                {{ s.files }} files ({{ s.fresh }} fresh / {{ s.stale }} stale)
              </span>
            </li>
          </ul>
          <div v-if="cache.lastRefresh" class="result">
            <p class="meta">Last refresh ~{{ cache.lastRefresh.ageMin }} min ago</p>
            <ul class="list compact">
              <li
                v-for="(r, i) in cache.lastRefresh.results"
                :key="i"
                class="list-row"
              >
                <span>{{ r.ok ? '✓' : '○' }} {{ r.source }}/{{ r.key }}</span>
                <span class="meta">{{ r.detail }}</span>
              </li>
            </ul>
          </div>
          <p v-else class="muted">Never refreshed (will warm after boot, or click Refresh).</p>
        </div>
        <div v-if="overview" class="clients">
          <h3>Clients</h3>
          <span class="pill" :class="{ on: overview.clients.scCraft }">sc-craft</span>
          <span class="pill" :class="{ on: overview.clients.scTrade }">sc-trade</span>
          <span class="pill" :class="{ on: overview.clients.scTradeToken }">trade token</span>
          <span class="pill" :class="{ on: overview.clients.uex }">UEX</span>
        </div>
      </div>
    </section>

    <!-- ── Snapshots (datarunner ingest) ──────────────────────────────── -->
    <section v-if="tab === 'snapshots'" class="panel">
      <div class="card">
        <div class="card-head">
          <h2>Inbound terminal snapshots</h2>
          <button class="btn ghost" :disabled="busy" type="button" @click="loadSnapshots">Reload</button>
        </div>
        <p class="hint">
          Linux datarunner POSTs to <code>/api/economy/ingest/terminal-snapshot</code>. Accepted
          rows beat UEX in <code>!econ prices</code> when newer. Reject drops them from the local cache.
        </p>
        <p v-if="!snapshots.length" class="muted">No snapshots yet.</p>
        <ul v-else class="order-list">
          <li v-for="s in snapshots" :key="s.id" class="order-row">
            <div class="order-main">
              <strong>#{{ s.id }} {{ s.terminal_name || 'terminal #' + s.id_terminal }}</strong>
              <span class="meta">
                {{ s.type }} · {{ s.environment }} · {{ s.status }} · {{ s.prices?.length || 0 }}
                rows · v{{ s.game_version }}
              </span>
            </div>
            <div v-if="isAdmin" class="row form">
              <button
                class="btn ghost"
                :disabled="busy || s.status === 'accepted'"
                type="button"
                @click="setSnapshotStatus(s.id, 'accept')"
              >
                Accept
              </button>
              <button
                class="btn danger ghost"
                :disabled="busy || s.status === 'rejected'"
                type="button"
                @click="setSnapshotStatus(s.id, 'reject')"
              >
                Reject
              </button>
            </div>
          </li>
        </ul>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import api from '../api/axios.js';
import { useSession } from '../composables/useSession.js';

type TabId = 'work' | 'mine' | 'craft' | 'trade' | 'prices' | 'catalog' | 'cache' | 'snapshots';

const session = useSession();
const isAdmin = computed(() => session.currentUser.value?.role === 'admin');

const tabs: Array<{ id: TabId; label: string }> = [
  { id: 'work', label: 'Work orders' },
  { id: 'mine', label: 'Mine / refine' },
  { id: 'craft', label: 'Craft' },
  { id: 'trade', label: 'Trade' },
  { id: 'prices', label: 'Prices' },
  { id: 'catalog', label: 'Catalog' },
  { id: 'cache', label: 'Cache' },
  { id: 'snapshots', label: 'Snapshots' },
];

const tab = ref<TabId>('work');
const busy = ref(false);
const err = ref('');
const msg = ref('');

const overview = ref<{
  catalogAsOf: string;
  clients: {
    scCraft: boolean;
    scTrade: boolean;
    scTradeToken: boolean;
    uex: boolean;
  };
} | null>(null);

interface WorkLine {
  material: string;
  amount: number;
  unit: string;
  unstable?: boolean;
  /** E-BOX: "2×32" crate breakdown */
  boxes?: string;
  totalBoxes?: number;
  largestCrate?: number;
}
interface WorkOrder {
  id: number;
  itemName: string;
  qty: number;
  lines: WorkLine[];
  createdBy: string | null;
  createdAt: number;
}

const orders = ref<WorkOrder[]>([]);
const materials = ref<WorkLine[]>([]);
const openCount = computed(() => orders.value.length);

const woItem = ref('');
const woQty = ref(1);

const ores = ref<
  Array<{
    id: string;
    name: string;
    mode: string;
    stability: string;
    refineWithinMin: number | null;
    valueScuApprox: number | null;
    defaultMethod: string;
    unstable: boolean;
  }>
>([]);
const methods = ref<
  Array<{
    id: string;
    name: string;
    yieldPct: number;
    timeMult: number;
    costMult: number;
    notes: string;
  }>
>([]);
const oreFilter = ref('');
const filteredOres = computed(() => {
  const q = oreFilter.value.trim().toLowerCase();
  if (!q) return ores.value;
  return ores.value.filter(
    (o) => o.name.toLowerCase().includes(q) || o.id.includes(q) || o.mode.includes(q),
  );
});

const mineOre = ref('Quantainium');
const mineScu = ref(32);
const mineMethod = ref('');
const mineResult = ref<{
  targetScu: number;
  ore: { name: string; mode: string; stability: string; unstable: boolean };
  stabilityLine: string;
  suggestedMethod: { name: string; yieldPct: number };
} | null>(null);

const refineOre = ref('Quantainium');
const refineScu = ref(32);
const refineMethod = ref('dinyx');
const refineResult = ref<{
  inputScu: number;
  outputScu: number;
  method: { name: string; yieldPct: number };
} | null>(null);

const bpQuery = ref('');
const bpResults = ref<Array<{ id: number; name: string; category: string | null }>>([]);
const bpAttr = ref('');
const craftResult = ref<{
  qty: number;
  blueprint: { name: string };
  bom: WorkLine[];
  attribution: string;
} | null>(null);

type TradeRouteRow = {
  id?: number;
  profit?: number;
  profitPerMinute?: number;
  origin?: {
    locationAndShop?: string;
    location?: string;
    shop?: string;
    itemName?: string;
    itemQuantityInScu?: number;
    price?: number;
  };
  destination?: { locationAndShop?: string; location?: string; shop?: string };
};

const tradeShip = ref('Freelancer');
const tradeInvest = ref(100000);
const tradeStops = ref(2);
const tradeProfit = ref<'time' | 'pure'>('time');
const tradeLoc = ref('Stanton');
const tradeRoutes = ref<TradeRouteRow[]>([]);
const tradeAttr = ref('');
const buyerCommodity = ref('Agricium');
const buyerScu = ref(32);
const buyerLoc = ref('Stanton');
const buyers = ref<
  Array<{
    price?: number;
    locationAndShop?: string;
    location?: string;
    shop?: string;
    itemQuantityInScu?: number;
    quantityInScu?: number;
  }>
>([]);
const itinFrom = ref('Stanton > microTech > Port Tressler > Platinum Bay');
const itinTo = ref('Stanton > Crusader > Yela > Grim HEX');
const itinRoutes = ref<TradeRouteRow[]>([]);
const circuitId = ref<number | null>(null);
const circuitRoutes = ref<TradeRouteRow[]>([]);
const tradeBlocked = computed(
  () =>
    !!(overview.value && (!overview.value.clients.scTrade || !overview.value.clients.scTradeToken)),
);

const priceQuery = ref('');
const uexCommodities = ref<
  Array<{
    id: number;
    name: string;
    code: string;
    sell: number | null;
    buy: number | null;
    isRaw: boolean;
  }>
>([]);
const uexCommoditiesLoading = ref(false);
const uexCommoditiesErr = ref('');
const priceResult = ref<{
  commodity: { name: string };
  source?: string;
  sell: number | null;
  buy: number | null;
  matches: Array<{
    name: string;
    code: string;
    sell: number | null;
    buy: number | null;
    isRaw: boolean;
  }>;
  supply?: {
    supplyPct: number | null;
    sampleSize: number;
    sellTerminals: Array<{ name: string; price: number }>;
  } | null;
  attribution: string;
} | null>(null);

const cache = ref<{
  rootLabel: string;
  totalFiles: number;
  totalBytes: number;
  sources: Array<{ source: string; files: number; fresh: number; stale: number }>;
  lastRefresh: {
    ageMin: number;
    results: Array<{ source: string; key: string; ok: boolean; detail: string }>;
  } | null;
} | null>(null);

const snapshots = ref<
  Array<{
    id: number;
    terminal_name: string | null;
    id_terminal: number;
    type: string;
    environment: string;
    status: string;
    game_version: string;
    prices: unknown[];
  }>
>([]);

function fmtAmt(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000);
}

function fmtMoney(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return Math.round(n).toLocaleString();
}

function apiErr(e: unknown): string {
  const x = e as { response?: { data?: { error?: string } }; message?: string };
  return x.response?.data?.error ?? x.message ?? 'Request failed';
}

async function loadOverview() {
  const res = await api.get('/api/economy/overview');
  overview.value = res.data;
}

async function loadWorkOrders() {
  const res = await api.get('/api/economy/workorders');
  orders.value = res.data.orders ?? [];
  materials.value = res.data.materials ?? [];
}

async function loadCatalog() {
  const [o, m] = await Promise.all([api.get('/api/economy/ores'), api.get('/api/economy/methods')]);
  ores.value = o.data.ores ?? [];
  methods.value = m.data.methods ?? [];
  if (!refineMethod.value && methods.value[0]) {
    refineMethod.value = methods.value[0].id;
  }
}

async function loadCache() {
  const res = await api.get('/api/economy/cache');
  cache.value = res.data;
}

/** UEX full list for Prices dropdown (lazy; cached server-side). */
async function loadUexCommodities(force = false) {
  if (uexCommoditiesLoading.value) return;
  if (uexCommodities.value.length && !force) return;
  uexCommoditiesLoading.value = true;
  uexCommoditiesErr.value = '';
  try {
    const res = await api.get('/api/economy/commodities');
    uexCommodities.value = res.data.commodities ?? [];
    // Default to Quantainium / first match if nothing selected
    if (!priceQuery.value && uexCommodities.value.length) {
      const pref =
        uexCommodities.value.find((c) => /quantainium/i.test(c.name) && !c.isRaw) ??
        uexCommodities.value.find((c) => /quantainium/i.test(c.name)) ??
        uexCommodities.value[0];
      if (pref) priceQuery.value = pref.name;
    }
  } catch (e) {
    uexCommoditiesErr.value = apiErr(e);
    uexCommodities.value = [];
  } finally {
    uexCommoditiesLoading.value = false;
  }
}

async function reloadAll() {
  busy.value = true;
  err.value = '';
  try {
    await Promise.all([loadOverview(), loadWorkOrders(), loadCatalog(), loadCache()]);
    if (tab.value === 'prices') await loadUexCommodities();
  } catch (e) {
    err.value = apiErr(e);
  } finally {
    busy.value = false;
  }
}

async function addWorkOrder() {
  busy.value = true;
  err.value = '';
  msg.value = '';
  try {
    const res = await api.post('/api/economy/workorders', {
      item: woItem.value.trim(),
      qty: woQty.value || 1,
    });
    msg.value = `Saved work order #${res.data.order.id} — ${res.data.order.qty}× ${res.data.order.itemName}`;
    woItem.value = '';
    woQty.value = 1;
    await loadWorkOrders();
  } catch (e) {
    err.value = apiErr(e);
  } finally {
    busy.value = false;
  }
}

async function doneWorkOrder(id: number) {
  busy.value = true;
  err.value = '';
  try {
    await api.delete(`/api/economy/workorders/${id}`);
    msg.value = `Removed work order #${id}`;
    await loadWorkOrders();
  } catch (e) {
    err.value = apiErr(e);
  } finally {
    busy.value = false;
  }
}

async function clearWorkOrders() {
  if (!confirm('Clear all open work orders?')) return;
  busy.value = true;
  err.value = '';
  try {
    const res = await api.delete('/api/economy/workorders');
    msg.value = `Cleared ${res.data.cleared} work order(s)`;
    await loadWorkOrders();
  } catch (e) {
    err.value = apiErr(e);
  } finally {
    busy.value = false;
  }
}

async function runMine() {
  busy.value = true;
  err.value = '';
  try {
    const params: Record<string, string | number> = {
      ore: mineOre.value.trim(),
      scu: mineScu.value || 32,
    };
    if (mineMethod.value) params.method = mineMethod.value;
    const res = await api.get('/api/economy/mine', { params });
    mineResult.value = res.data;
  } catch (e) {
    mineResult.value = null;
    err.value = apiErr(e);
  } finally {
    busy.value = false;
  }
}

async function runRefine() {
  busy.value = true;
  err.value = '';
  try {
    const res = await api.get('/api/economy/refine', {
      params: {
        ore: refineOre.value.trim(),
        scu: refineScu.value || 32,
        method: refineMethod.value || 'dinyx',
      },
    });
    refineResult.value = res.data;
  } catch (e) {
    refineResult.value = null;
    err.value = apiErr(e);
  } finally {
    busy.value = false;
  }
}

async function searchBlueprints() {
  busy.value = true;
  err.value = '';
  bpResults.value = [];
  try {
    const res = await api.get('/api/economy/blueprints', {
      params: { q: bpQuery.value.trim() },
    });
    bpResults.value = res.data.items ?? [];
    bpAttr.value = res.data.attribution ?? '';
  } catch (e) {
    err.value = apiErr(e);
  } finally {
    busy.value = false;
  }
}

async function loadCraft(name: string, qty = 1) {
  busy.value = true;
  err.value = '';
  try {
    const res = await api.get('/api/economy/craft', { params: { q: name, qty } });
    craftResult.value = res.data;
  } catch (e) {
    craftResult.value = null;
    err.value = apiErr(e);
  } finally {
    busy.value = false;
  }
}

async function saveCraftAsWorkOrder() {
  if (!craftResult.value) return;
  busy.value = true;
  err.value = '';
  try {
    const res = await api.post('/api/economy/workorders', {
      item: craftResult.value.blueprint.name,
      qty: craftResult.value.qty,
    });
    msg.value = `Saved work order #${res.data.order.id}`;
    tab.value = 'work';
    await loadWorkOrders();
  } catch (e) {
    err.value = apiErr(e);
  } finally {
    busy.value = false;
  }
}

async function runTradeRoutes() {
  busy.value = true;
  err.value = '';
  tradeRoutes.value = [];
  try {
    const res = await api.post('/api/economy/trade/routes', {
      ship: tradeShip.value.trim() || 'Freelancer',
      invest: tradeInvest.value || 100000,
      stops: tradeStops.value || 2,
      profit: tradeProfit.value,
      loc: tradeLoc.value.trim() || undefined,
    });
    tradeRoutes.value = res.data.routes ?? [];
    tradeAttr.value = res.data.attribution ?? '';
    if (!tradeRoutes.value.length) msg.value = 'No routes returned';
  } catch (e) {
    err.value = apiErr(e);
  } finally {
    busy.value = false;
  }
}

async function runBuyers() {
  busy.value = true;
  err.value = '';
  buyers.value = [];
  try {
    const res = await api.post('/api/economy/trade/buyers', {
      commodity: buyerCommodity.value.trim(),
      scu: buyerScu.value || 32,
      loc: buyerLoc.value.trim() || undefined,
    });
    buyers.value = res.data.buyers ?? [];
    tradeAttr.value = res.data.attribution ?? '';
  } catch (e) {
    err.value = apiErr(e);
  } finally {
    busy.value = false;
  }
}

async function runItinerary() {
  busy.value = true;
  err.value = '';
  itinRoutes.value = [];
  try {
    const res = await api.post('/api/economy/trade/itinerary', {
      from: itinFrom.value.trim(),
      to: itinTo.value.trim(),
      ship: tradeShip.value.trim() || 'Freelancer',
      invest: tradeInvest.value || 100000,
      stops: tradeStops.value || 3,
      profit: tradeProfit.value,
      loc: tradeLoc.value.trim() || undefined,
    });
    itinRoutes.value = res.data.routes ?? [];
    tradeAttr.value = res.data.attribution ?? '';
    if (!itinRoutes.value.length) msg.value = 'No itinerary routes returned';
  } catch (e) {
    err.value = apiErr(e);
  } finally {
    busy.value = false;
  }
}

async function runCircuit(id: number | null) {
  if (id == null || !Number.isFinite(id) || id <= 0) {
    err.value = 'Circuit needs a valid trade route id';
    return;
  }
  circuitId.value = id;
  busy.value = true;
  err.value = '';
  circuitRoutes.value = [];
  try {
    const res = await api.post('/api/economy/trade/circuit', {
      id,
      ship: tradeShip.value.trim() || 'Freelancer',
      invest: tradeInvest.value || 100000,
      stops: tradeStops.value || 2,
      profit: tradeProfit.value,
      loc: tradeLoc.value.trim() || undefined,
    });
    circuitRoutes.value = res.data.routes ?? [];
    tradeAttr.value = res.data.attribution ?? '';
    if (!circuitRoutes.value.length) msg.value = 'No circuit routes returned';
  } catch (e) {
    err.value = apiErr(e);
  } finally {
    busy.value = false;
  }
}

async function runPrices() {
  busy.value = true;
  err.value = '';
  priceResult.value = null;
  try {
    const res = await api.get('/api/economy/prices', {
      params: { q: priceQuery.value.trim() },
    });
    priceResult.value = res.data;
  } catch (e) {
    err.value = apiErr(e);
  } finally {
    busy.value = false;
  }
}

async function refreshCache() {
  busy.value = true;
  err.value = '';
  msg.value = '';
  try {
    const res = await api.post('/api/economy/cache/refresh');
    msg.value = res.data.ok ? 'Cache refresh finished' : 'Cache refresh finished with errors';
    await loadCache();
    await loadOverview();
  } catch (e) {
    err.value = apiErr(e);
  } finally {
    busy.value = false;
  }
}

async function loadSnapshots() {
  try {
    const res = await api.get('/api/economy/ingest/snapshots');
    snapshots.value = res.data.snapshots ?? [];
  } catch (e) {
    err.value = apiErr(e);
  }
}

async function setSnapshotStatus(id: number, action: 'accept' | 'reject') {
  busy.value = true;
  err.value = '';
  try {
    await api.post(`/api/economy/ingest/snapshots/${id}/${action}`);
    msg.value = `Snapshot #${id} ${action}ed`;
    await loadSnapshots();
  } catch (e) {
    err.value = apiErr(e);
  } finally {
    busy.value = false;
  }
}

watch(tab, (t) => {
  if (t === 'prices') void loadUexCommodities();
  if (t === 'snapshots') void loadSnapshots();
});

onMounted(reloadAll);
</script>

<style scoped>
.econ {
  max-width: 960px;
  margin: 0 auto;
  padding: 0 0 80px;
}
.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 12px;
}
.title {
  margin: 0;
  font-size: 1.4rem;
}
.sub {
  color: var(--text-secondary, #888);
  font-size: 0.9rem;
  margin: 6px 0 0;
  max-width: 52rem;
}
.tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 12px 0 16px;
}
.tab {
  padding: 8px 12px;
  border-radius: 999px;
  border: 1px solid var(--border-color, #333);
  background: var(--hover-bg, #1a1a20);
  color: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.tab.active {
  background: var(--color-primary, #6366f1);
  border-color: var(--color-primary, #6366f1);
  color: #fff;
}
.badge {
  background: rgba(255, 255, 255, 0.2);
  border-radius: 999px;
  padding: 0 6px;
  font-size: 11px;
}
.panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.card {
  border: 1px solid var(--border-color, #333);
  border-radius: 12px;
  padding: 14px 16px;
  background: var(--bg-secondary, #141418);
}
.card h2 {
  margin: 0 0 10px;
  font-size: 1rem;
}
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}
.card-head h2 {
  margin: 0;
}
.rowform {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.rowform.wrap {
  align-items: stretch;
}
.input {
  flex: 1 1 160px;
  min-width: 120px;
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid var(--border-color, #333);
  background: var(--hover-bg, #1a1a20);
  color: inherit;
  font-size: 13px;
}
.input.qty {
  flex: 0 0 80px;
  min-width: 72px;
}
.input.qty.wide {
  flex: 0 0 120px;
}
.input.wide {
  flex: 1 1 100%;
  min-width: 200px;
}
a {
  color: var(--color-primary, #818cf8);
}
.input.select {
  flex: 0 1 200px;
}
/* Full UEX list — wide enough for long names; native select scrolls when open */
.input.select.price-commodity-select {
  flex: 1 1 280px;
  min-width: 220px;
  max-width: 100%;
}
.input.compact {
  flex: 0 0 180px;
  max-width: 200px;
}
.btn {
  padding: 8px 14px;
  border-radius: 8px;
  border: 1px solid var(--border-color, #333);
  background: var(--hover-bg, #1a1a20);
  color: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}
.btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.btn.primary {
  background: var(--color-primary, #6366f1);
  border-color: var(--color-primary, #6366f1);
  color: #fff;
}
.btn.ghost {
  background: transparent;
}
.btn.danger {
  color: #ef4444;
}
.btn.small {
  padding: 5px 10px;
  font-size: 12px;
}
.hint,
.meta,
.attr {
  font-size: 12px;
  color: var(--text-secondary, #888);
  margin: 8px 0 0;
}
.muted {
  color: var(--text-tertiary, #666);
  font-size: 13px;
}
.err {
  color: #f87171;
  font-size: 13px;
  margin: 0 0 8px;
}
.msg {
  color: var(--color-primary, #818cf8);
  font-size: 13px;
  margin: 0 0 8px;
}
.warn {
  background: rgba(245, 158, 11, 0.12);
  border: 1px solid rgba(245, 158, 11, 0.35);
  color: #fbbf24;
  padding: 8px 10px;
  border-radius: 8px;
  font-size: 13px;
  margin-bottom: 10px;
}
.warn-line {
  color: #fbbf24;
  font-size: 13px;
}
.mat-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.mat-chip {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 12px;
  border-radius: 10px;
  background: var(--hover-bg, #1a1a20);
  border: 1px solid var(--border-color, #333);
  font-size: 13px;
  min-width: 100px;
}
.order-list,
.list,
.bom-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.order-row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 6px 12px;
  padding: 10px 0;
  border-bottom: 1px solid var(--border-color, #333);
}
.order-main {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: baseline;
}
.order-id {
  font-family: var(--font-mono, monospace);
  color: var(--color-primary, #818cf8);
  font-weight: 700;
}
.order-title {
  font-weight: 600;
}
.order-bom {
  grid-column: 1 / -1;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.bom-line {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--hover-bg, #1a1a20);
}
.order-row .btn {
  grid-column: 2;
  grid-row: 1;
  align-self: start;
}
.list-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
  border-bottom: 1px solid var(--border-color, #222);
  font-size: 13px;
}
.list.compact .list-row {
  padding: 4px 0;
}
.bom-list li {
  padding: 4px 0;
  font-size: 14px;
}
.result {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--border-color, #333);
}
.result-title {
  font-weight: 700;
  font-size: 15px;
  margin-bottom: 6px;
}
.routes {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 12px;
}
.route-card {
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid var(--border-color, #333);
  background: var(--hover-bg, #1a1a20);
}
.route-title {
  font-weight: 600;
  margin-bottom: 4px;
}
.profit {
  color: #34d399;
  margin-left: 6px;
}
.table-wrap {
  overflow-x: auto;
}
.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.table th,
.table td {
  text-align: left;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border-color, #333);
}
.table th {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-secondary, #888);
}
.stab-critical {
  color: #f87171;
  font-weight: 600;
}
.stab-volatile {
  color: #fbbf24;
  font-weight: 600;
}
.stab-stable {
  color: #34d399;
}
.clients {
  margin-top: 14px;
}
.clients h3 {
  margin: 0 0 8px;
  font-size: 13px;
}
.pill {
  display: inline-block;
  margin: 0 6px 6px 0;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 12px;
  background: var(--hover-bg, #1a1a20);
  color: var(--text-secondary, #888);
  border: 1px solid var(--border-color, #333);
}
.pill.on {
  color: #34d399;
  border-color: rgba(52, 211, 153, 0.4);
}
code {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
}
</style>
