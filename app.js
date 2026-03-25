const API_BASE = 'https://api.binarylane.com.au/v2/customers/my/invoices';
const SERVERS_API_BASE = 'https://api.binarylane.com.au/v2/servers';
const IDLE_TIMEOUT_MS = 15 * 60 * 1000;

const $ = (id) => document.getElementById(id);
const state = {
  invoices: [], filtered: [], apiKey: '', apiPage: 0, hasMore: true,
  queryRows: [], serverStatus: new Map(),
  serverOrder: [],
  serverIdByName: new Map(),
  serverGstMode: 'reconciled'
};
let idleTimer;

const esc = (s) => String(s ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const currencyFmt = new Intl.NumberFormat('en-AU',{style:'currency',currency:'AUD'});
const round2 = (n)=> Math.round((Number(n||0) + Number.EPSILON) * 100) / 100;
const money = (n) => currencyFmt.format(round2(n));
const moneyInc = (n) => currencyFmt.format(round2(n));
const serviceDisplayAmounts = (ex)=> {
  const before = round2(ex);
  const rawGst = before * 0.10;
  const afterRaw = before + rawGst;
  const after = round2(afterRaw);
  const gst = round2(after - before);
  return { before, rawGst, gst, afterRaw, after };
};
const parseDate = (s)=> s ? new Date(s) : null;
function fmtDate(s){ const d=parseDate(s); return d && !Number.isNaN(+d) ? new Intl.DateTimeFormat('en-AU',{day:'2-digit',month:'short',year:'numeric',hour:'numeric',minute:'2-digit',hour12:true}).format(d) : '-'; }

const cents = (n)=> Math.round(Number(n||0)*100);
const dec = (c)=> Number((c/100).toFixed(2));
function roundDiffHtml(){
  return '';
}

function gstTitle(before,gst,after,meta=null){
  const lines = [
    `Before tax: ${money(before)}`,
    `GST amount: ${money(gst)}`,
    `After tax: ${currencyFmt.format(round2(after))}`
  ];
  if(meta?.kind === 'grouped-service'){
    lines.push('');
    lines.push('Grouped GST working:');
    lines.push(`${money(meta.before)} × 10% = ${meta.rawGst.toFixed(3)}`);
    lines.push(`${meta.before.toFixed(2)} + ${meta.rawGst.toFixed(3)} = ${meta.afterRaw.toFixed(3)}`);
    lines.push(`Rounded display total: ${money(meta.after)}`);
  }
  return lines.join('&#10;');
}
const markedAmount = (after,before,gst,meta=null)=> `<span class="amount-tip" title="${gstTitle(before,gst,after,meta)}"><span class="amount-mark">†</span>${moneyInc(after)}</span>`;

function setStatus(msg, err=false){ const el=$('status'); if(!el) return; el.textContent=msg; el.style.color=err?'#ff9d9d':'#9aa4b2'; }

function onActivity(){
  clearTimeout(idleTimer);
  idleTimer = setTimeout(()=>{ sessionStorage.removeItem('bl_api_key'); $('apiKey').value=''; setStatus('API key cleared due to inactivity.'); }, IDLE_TIMEOUT_MS);
}
function maybeClearOnReload(){ const nav=performance.getEntriesByType('navigation')[0]; if(nav && nav.type==='reload') sessionStorage.removeItem('bl_api_key'); }

function normalizeBatch(payload){
  if (Array.isArray(payload)) return payload;
  if (payload?.invoices && Array.isArray(payload.invoices)) return payload.invoices;
  if (payload?.servers && Array.isArray(payload.servers)) return payload.servers;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

async function fetchPage(key,page){
  const res = await fetch(`${API_BASE}?page=${page}&per_page=100`, { headers:{ Authorization:`Bearer ${key}` } });
  const text = await res.text();
  let payload; try{ payload = JSON.parse(text); } catch { payload = {raw:text}; }
  if(!res.ok) throw new Error(payload?.error || payload?.message || `API ${res.status}`);
  return normalizeBatch(payload);
}

async function fetchServerPage(key,page){
  const res = await fetch(`${SERVERS_API_BASE}?page=${page}&per_page=200`, { headers:{ Authorization:`Bearer ${key}` } });
  const text = await res.text();
  let payload; try{ payload = JSON.parse(text); } catch { payload = {raw:text}; }
  if(!res.ok) throw new Error(payload?.error || payload?.message || `API ${res.status}`);
  return normalizeBatch(payload);
}

async function fetchAllServers(){
  const idMap = new Map();
  for(let page=1; page<=50; page++){
    const batch = await fetchServerPage(state.apiKey,page);
    if(!batch.length) break;
    for(const srv of batch){
      const key = String(srv?.name || '').trim().toLowerCase();
      const id = Number(srv?.id);
      if(key && Number.isFinite(id)) idMap.set(key, id);
    }
    if(batch.length < 200) break;
  }
  state.serverIdByName = idMap;
}

function serverSortId(name){
  const key = String(name || '').trim().toLowerCase();
  return state.serverIdByName.get(key) ?? Number.MAX_SAFE_INTEGER;
}

async function fetchAllInvoices(){
  state.invoices=[]; state.apiPage=0; state.hasMore=true;
  let total=0;
  while(state.hasMore){
    const next = state.apiPage + 1;
    setStatus(`Fetching invoices... page ${next}`);
    const batch = await fetchPage(state.apiKey,next);
    if(!batch.length){ state.hasMore=false; break; }
    state.invoices.push(...batch); total += batch.length; state.apiPage = next;
    if(batch.length < 100 || next >= 200) state.hasMore=false;
  }
  setStatus(`Fetched all invoices: ${total} total.`);
}

function buildTaxModel(inv){
  const items=(inv.invoice_items||[]).map((it,idx)=>({idx,c:cents(it.amount),name:(it.name||'').toLowerCase(),includesTax:!!it.amount_includes_tax}));
  const subtotal=items.reduce((a,i)=>a+i.c,0);
  const tax=cents(inv.tax||0), total=cents(inv.amount||0);
  const hasNegative = items.some(i=>i.c<0) || tax<0;
  const hasCreditLike = items.some(i=>/credit|discount|refund|adjust/i.test(i.name));
  const hasIncludesTax = items.some(i=>i.includesTax);
  const expectedTax = Math.round(subtotal*0.10);
  const ok = !hasNegative && !hasCreditLike && !hasIncludesTax && Math.abs((subtotal+tax)-total)<=1 && Math.abs(tax-expectedTax)<=1;

  const gstByIdx = new Map();
  if(ok){
    let sum=0;
    for(const it of items){ const g=Math.round(it.c*0.10); gstByIdx.set(it.idx,g); sum+=g; }
    let remainder = tax - sum;
    if(remainder!==0 && items.length){
      const sorted=[...items].sort((a,b)=>b.c-a.c);
      let k=0;
      while(remainder!==0 && k<sorted.length*2){
        const it=sorted[k%sorted.length];
        gstByIdx.set(it.idx, (gstByIdx.get(it.idx)||0) + (remainder>0?1:-1));
        remainder += remainder>0?-1:1;
        k++;
      }
    }
  }
  return {ok, subtotal, tax, total, gstByIdx};
}

function inRange(inv, range){
  if(range==='all') return true;
  const d=parseDate(inv.created || inv.date_due || inv.created_at); if(!d) return false;
  const now=new Date();
  if(range==='12'){ const s=new Date(now); s.setMonth(now.getMonth()-12); return d>=s; }
  if(range==='6'){ const s=new Date(now); s.setMonth(now.getMonth()-6); return d>=s; }
  if(range==='prev6'){ const e=new Date(now); e.setMonth(now.getMonth()-6); const s=new Date(now); s.setMonth(now.getMonth()-12); return d>=s && d<e; }
  return true;
}

function isPrimaryServiceLine(name){ return /\s\/\sServer Operating System:/i.test(name||''); }
function canonicalServiceName(name){
  const n=(name||'').trim(); const cut=n.indexOf(' / Server Operating System:');
  let s = cut>0 ? n.slice(0,cut).trim() : n;
  s = s.replace(/\s*\([^)]*hours\)\s*$/i,'').replace(/\s*\([^)]*to[^)]*\)\s*$/i,'').trim();
  return s || 'Service';
}

function parsePeriodEnd(name){
  const m = String(name||'').match(/\((\d{1,2}\s+[A-Za-z]+\s+\d{4})\s+to\s+(\d{1,2}\s+[A-Za-z]+\s+\d{4})\s+-/i);
  if(!m) return null;
  const d = new Date(m[2]);
  return Number.isNaN(+d) ? null : d;
}

function groupInvoiceByServerOrder(items){
  const groups=[]; let current=null;
  for(let idx=0; idx<(items||[]).length; idx++){
    const it = items[idx];
    const name=(it.name||'Unnamed item').trim(); const amount=Number(it.amount||0); const includesTax=Boolean(it.amount_includes_tax);
    if(isPrimaryServiceLine(name)){
      current={ server: canonicalServiceName(name), rows:[] };
      groups.push(current);
      current.rows.push({idx,name,amount,includesTax,type:'primary'});
    } else {
      if(!current){ current={server:'Unassigned account items',rows:[]}; groups.push(current); }
      current.rows.push({idx,name,amount,includesTax,type:'addon'});
    }
  }
  return groups;
}

function computeServerStatus(){
  const perServer = new Map();
  const firstSeenOrder = [];
  let globalLatest = null;
  const ACTIVE_WINDOW_MS = 45 * 86400000; // billing cycles can drift; avoid over-marking as cancelled
  for(const inv of state.invoices){
    for(const it of (inv.invoice_items||[])){
      const n = it?.name || '';
      if(!isPrimaryServiceLine(n)) continue;
      const server = canonicalServiceName(n);
      if(!perServer.has(server)) firstSeenOrder.push(server);
      const end = parsePeriodEnd(n);
      if(end && (!globalLatest || end > globalLatest)) globalLatest = end;
      const rec = perServer.get(server) || { latestEnd:null, seen:0 };
      rec.seen += 1;
      if(end && (!rec.latestEnd || end > rec.latestEnd)) rec.latestEnd = end;
      perServer.set(server, rec);
    }
  }
  state.serverOrder = [...firstSeenOrder].sort((a,b)=>{
    const aid = serverSortId(a);
    const bid = serverSortId(b);
    if(aid !== bid) return aid - bid;
    return firstSeenOrder.indexOf(a) - firstSeenOrder.indexOf(b);
  });
  state.serverStatus = new Map();
  for(const [server, rec] of perServer.entries()){
    if(!globalLatest || !rec.latestEnd){
      state.serverStatus.set(server, 'unknown');
      continue;
    }
    const active = (globalLatest - rec.latestEnd) <= ACTIVE_WINDOW_MS;
    state.serverStatus.set(server, active ? 'active' : 'cancelled');
  }
}

function getFilteredServerNames(query=''){
  const showCancelled = !!$('showCancelled')?.checked;
  let names = state.serverOrder.length ? [...state.serverOrder] : [...state.serverStatus.keys()];
  names = names.filter((n, idx) => names.indexOf(n) === idx);
  if(!showCancelled) names = names.filter(n => state.serverStatus.get(n)!=='cancelled');
  const q = query.trim().toLowerCase();
  if(q) names = names.filter(n => n.toLowerCase().includes(q));
  return names;
}

function updateServerPickerLabel(){
  const label = $('serverPickerLabel');
  const value = $('serverSelect')?.value || '';
  if(!label) return;
  if(value){
    label.textContent = value;
    label.classList.remove('is-placeholder');
  } else {
    label.textContent = 'Click to search and choose a server';
    label.classList.add('is-placeholder');
  }
}

function fillServerSelect(query=''){
  const el=$('serverSelect'); if(!el) return;
  const currentValue = el.value;
  const names = getFilteredServerNames(query);
  el.innerHTML = names.length
    ? names.map(n=>`<option value="${esc(n)}">${esc(n)}</option>`).join('')
    : '<option value="">(no matching servers)</option>';
  if(currentValue && names.includes(currentValue)) {
    el.value = currentValue;
  } else {
    el.value = '';
    el.selectedIndex = -1;
  }
  updateServerPickerLabel();
}

function renderServerSearchResults(query=''){
  const box = $('serverSearchResults');
  const count = $('serverSearchCount');
  if(!box) return;
  const names = getFilteredServerNames(query);
  if(count) count.textContent = `${names.length} visible`;
  if(!names.length){
    box.innerHTML = '<div class="server-search-empty">No matching servers.</div>';
    return;
  }
  box.innerHTML = names.map((n)=>{
    const st = state.serverStatus.get(n);
    const meta = st==='cancelled' ? 'Cancelled server' : (st==='unknown' ? 'Status unknown' : 'Active server');
    const active = $('serverSelect')?.value === n;
    return `<button type="button" class="server-result${active ? ' active' : ''}" data-server="${esc(n)}"><span class="server-result-name">${esc(n)}</span><span class="server-result-meta">${esc(meta)}</span></button>`;
  }).join('');
}

function openServerSearchModal(){
  fillServerSelect($('serverSearch')?.value || '');
  renderServerSearchResults($('serverSearch')?.value || '');
  $('serverSearchModal')?.classList.remove('hidden');
  setTimeout(()=> $('serverSearch')?.focus(), 0);
}

function closeServerSearchModal(){
  $('serverSearchModal')?.classList.add('hidden');
}

function runServerQueryIfReady(){
  if($('serverSelect')?.value) runServerQuery();
  else {
    state.queryRows = [];
    if($('querySummary')) $('querySummary').innerHTML = '';
    if($('queryTable')) $('queryTable').innerHTML = '<p class="muted">Choose a server to view matching items.</p>';
  }
}

function chooseServer(name){
  const el = $('serverSelect');
  if(!el) return;
  fillServerSelect($('serverSearch')?.value || '');
  el.value = name;
  updateServerPickerLabel();
  renderServerSearchResults($('serverSearch')?.value || '');
  closeServerSearchModal();
  runServerQueryIfReady();
}

function applyFilters(){
  const range=$('range').value; const q=$('search').value.trim().toLowerCase();
  state.filtered = state.invoices.filter(inv=>{
    if(!inRange(inv,range)) return false;
    if(!q) return true;
    const hay=[inv.invoice_number,inv.reference,...(inv.invoice_items||[]).map(i=>i.name)].join(' ').toLowerCase();
    return hay.includes(q);
  });
  $('viewPage').value = '1';
  render();
}

function renderStats(){
  const list=state.filtered; const total=list.reduce((s,i)=>s+Number(i.amount||0),0); const tax=list.reduce((s,i)=>s+Number(i.tax||0),0);
  const paid=list.filter(i=>i.paid).length;
  $('stats').innerHTML = `<div class="stat"><div class="k">Invoices</div><div class="v">${list.length}</div></div><div class="stat"><div class="k">Total</div><div class="v">${moneyInc(total)}</div></div><div class="stat"><div class="k">Tax</div><div class="v">${money(tax)}</div></div><div class="stat"><div class="k">Paid / Unpaid</div><div class="v">${paid} / ${list.length-paid}</div></div>`;
}

function renderAnalytics(){
  const monthly=new Map();
  for(const inv of state.filtered){
    const d=parseDate(inv.created||inv.date_due||inv.created_at); if(!d) continue;
    const k=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    const ex = Number(inv.amount||0) - Number(inv.tax||0);
    const gst = Number(inv.tax||0);
    const inc = Number(inv.amount||0);
    const cur = monthly.get(k) || {ex:0,gst:0,inc:0};
    cur.ex += ex; cur.gst += gst; cur.inc += inc;
    monthly.set(k,cur);
  }

  const rows=[...monthly.entries()].sort((a,b)=>a[0].localeCompare(b[0]));
  const years=[...new Set(rows.map(([k])=>k.split('-')[0]))];
  const multiYear = years.length > 1;
  const yearLabel = years.length<=1 ? (years[0]||'') : `${years[0]}/${years[years.length-1]}`;
  const monthName = (k)=>{
    const [y,m]=k.split('-').map(Number);
    const d = new Date(y,m-1,1);
    return multiYear
      ? new Intl.DateTimeFormat('en-AU',{month:'short', year:'numeric'}).format(d)
      : new Intl.DateTimeFormat('en-AU',{month:'short'}).format(d);
  };

  const titleEl = $('monthlyTitle');
  if(titleEl) titleEl.textContent = `Monthly Spend (inc GST)${yearLabel ? ` (${yearLabel})` : ''}`;

  const max=Math.max(1,...rows.map(([,v])=>v.inc));
  $('monthlyBars').innerHTML = rows.length
    ? rows.map(([k,v])=>`<div class="bar-row"><div>${esc(monthName(k))}</div><div class="bar-track"><div class="bar-fill" style="width:${Math.max(2,Math.round((v.inc/max)*100))}%"></div></div><div>${markedAmount(v.inc,v.ex,v.gst)}</div></div>`).join('')
    : '<p class="muted">No data for selected range.</p>';

  const sv=new Map();
  for(const inv of state.filtered){
    const taxModel = buildTaxModel(inv);
    const items = inv.invoice_items||[];
    for(let idx=0; idx<items.length; idx++){
      const it = items[idx];
      const n=(it.name||'').trim();
      if(!isPrimaryServiceLine(n)) continue;
      const key=canonicalServiceName(n);
      const ex=Number(it.amount||0);
      const gst = taxModel.ok ? dec(taxModel.gstByIdx.get(idx)||0) : round2(ex*0.10);
      const inc = ex + gst;
      const cur = sv.get(key) || {ex:0,gst:0,inc:0};
      cur.ex += ex; cur.gst += gst; cur.inc += inc;
      sv.set(key,cur);
    }
  }
  const top=[...sv.entries()]
    .map(([n,a])=>{
      const display = serviceDisplayAmounts(a.ex);
      return [n, {...a, display}];
    })
    .sort((a,b)=>b[1].display.after-a[1].display.after)
    .slice(0,12);
  $('topItems').innerHTML = top.length ? top.map(([n,a])=>`<div class="item-row"><div>${esc(n)}</div><div><strong>${markedAmount(a.display.after,a.display.before,a.display.gst,{kind:'grouped-service',...a.display})}</strong></div></div>`).join('') : '<p class="muted">No service-level data in selected range.</p>';
}

function groupLineItems(items, taxModel){
  const groups=[]; const by=new Map(); let last=null;
  const ensure=(k,kind='service')=>{ if(!by.has(k)){ const o={name:k,total:0,ex:0,tax:0,rows:[],kind,display:null}; by.set(k,o); groups.push(o);} return by.get(k); };
  for(let i=0;i<(items||[]).length;i++){
    const it=items[i];
    const name=(it.name||'Unnamed item').trim();
    const amount=Number(it.amount||0);
    const ex = dec(cents(amount));
    const tax = taxModel.ok ? dec(taxModel.gstByIdx.get(i)||0) : 0;
    const inc = dec(cents(amount) + (taxModel.ok ? (taxModel.gstByIdx.get(i)||0) : 0));
    if(isPrimaryServiceLine(name)){ const key=canonicalServiceName(name); const g=ensure(key,'service'); g.total+=inc; g.ex+=ex; g.tax+=tax; g.rows.push({name,amount:inc,ex,tax,type:'primary'}); last=key; continue; }
    const g=ensure(last || 'General account charges', last ? 'service':'general'); g.total+=inc; g.ex+=ex; g.tax+=tax; g.rows.push({name,amount:inc,ex,tax,type:'addon'});
  }
  for(const g of groups){
    g.display = g.kind === 'service' ? serviceDisplayAmounts(g.ex) : { before: g.ex, gst: g.tax, after: g.total };
  }
  return groups.sort((a,b)=>{
    const aService = a.kind === 'service';
    const bService = b.kind === 'service';
    if(aService && bService){
      const aid = serverSortId(a.name);
      const bid = serverSortId(b.name);
      if(aid !== bid) return aid - bid;
    }
    if(aService !== bService) return aService ? -1 : 1;
    return 0;
  });
}

function renderList(){
  const box=$('invoiceList');
  const openIds = new Set(Array.from(document.querySelectorAll('details.invoice[open]')).map(d=>d.id));
  if(!state.filtered.length){ box.innerHTML='<p class="muted">No invoices in this view.</p>'; $('viewMeta').textContent=''; return; }
  const perPage = Math.max(1, Number($('viewPerPage').value || 50));
  const totalPages = Math.max(1, Math.ceil(state.filtered.length / perPage));
  let page = Math.max(1, Number($('viewPage').value || 1));
  if(page>totalPages){ page=totalPages; $('viewPage').value=String(page); }
  $('viewMeta').textContent = `of ${totalPages} pages (${state.filtered.length} invoices)`;

  const sorted=[...state.filtered].sort((a,b)=>new Date(b.created||b.date_due||0)-new Date(a.created||a.date_due||0));
  const start=(page-1)*perPage; const slice=sorted.slice(start,start+perPage);
  box.innerHTML = slice.map(inv=>{
    const taxModel = buildTaxModel(inv);
    const groups=groupLineItems(inv.invoice_items||[], taxModel);
    const groupHtml=groups.map(g=>{
      const primary=g.rows.filter(r=>r.type==='primary').map(r=>`<div class="li-row"><div class="li-name">${esc(r.name)}</div><div class="li-amt">${taxModel.ok?markedAmount(r.amount,r.ex,r.tax):money(r.amount)}</div></div>`).join('');
      const addons=g.rows.filter(r=>r.type!=='primary').map(r=>`<div class="li-row addon-row"><div class="li-name">${esc(r.name)} <span class="tiny-tag">add-on</span></div><div class="li-amt">${taxModel.ok?markedAmount(r.amount,r.ex,r.tax):money(r.amount)}</div></div>`).join('');
      const addonCount=g.rows.filter(r=>r.type!=='primary').length;
      const addonBlock = addonCount ? `<details class="addon-toggle-wrap"><summary class="addon-toggle"><span class="label-show">Show add-ons</span><span class="label-hide">Hide add-ons</span> <span class="addon-count">(${addonCount})</span></summary><div class="addon-list">${addons}</div></details>` : '';
      const groupDisplay = g.display || { before: g.ex, gst: g.tax, after: g.total };
      const groupMeta = g.kind === 'service' ? { kind:'grouped-service', ...groupDisplay } : null;
      return `<div class="li-group ${g.kind}"><div class="li-group-head"><div class="li-group-name">${esc(g.name)}</div><div class="li-group-total">${markedAmount(groupDisplay.after,groupDisplay.before,groupDisplay.gst,groupMeta)}</div></div><div class="li-group-body">${primary}${addonBlock}</div></div>`;
    }).join('');

    const lineSubtotalDisplay = taxModel.ok ? dec(taxModel.subtotal + taxModel.tax) : (inv.invoice_items||[]).reduce((a,it)=>a+Number(it.amount||0),0);
    const beforeTaxDisplay = dec(cents(inv.amount||0) - cents(inv.tax||0));
    const displayLabel = taxModel.ok ? 'Line items subtotal (incl GST, derived)' : 'Line items subtotal (ex GST)';
    const note = taxModel.ok
      ? '<div class="small" style="margin-top:8px;color:#9ec5ff">Per-line GST shown as derived allocation and reconciled to invoice GST total.</div>'
      : '<div class="small" style="margin-top:8px;color:#f0c38a">Per-line GST cannot be safely derived for this invoice; line items shown ex GST.</div>';

    const invoiceSearch = `<div class="invoice-inline-search-wrap"><div class="invoice-search-topline"><label class="invoice-sticky-search">Find within this invoice<input class="invoice-item-search-input" type="text" placeholder="search server/service names in this invoice" autocomplete="off" spellcheck="false" /></label><div class="invoice-search-nav"><button type="button" class="secondary invoice-search-prev" title="Previous match">↑</button><button type="button" class="secondary invoice-search-next" title="Next match">↓</button><button type="button" class="secondary collapse-invoice" title="Collapse invoice">Collapse invoice</button></div></div><div class="invoice-item-search-meta small">Search highlights matching server groups in this invoice.</div></div>`;
    return `<details class="invoice" id="inv-${esc(inv.invoice_number)}"><summary><div><strong>#${esc(inv.invoice_number)}</strong> <span class="small">(${esc(inv.reference||'')})</span><br/><span class="small">Created: ${fmtDate(inv.created||inv.created_at||inv.date_due)}</span></div><div style="text-align:right"><div><span class="badge ${inv.paid?'paid':'unpaid'}">${inv.paid?'PAID':'UNPAID'}</span></div><div><strong>${markedAmount(inv.amount||0,beforeTaxDisplay,inv.tax||0)}</strong></div></div></summary><div class="body"><div class="small">Invoice ID: ${esc(inv.invoice_id)} · Due: ${fmtDate(inv.date_due)} · Download: <a href="${esc(inv.invoice_download_url||'#')}" target="_blank" rel="noopener noreferrer">PDF</a></div>${invoiceSearch}<div class="li-wrap">${groupHtml || '<p class="small">No line items</p>'}</div>${note}<div class="invoice-footer"><div class="frow"><span>${displayLabel}</span><strong>${taxModel.ok?markedAmount(lineSubtotalDisplay,dec(taxModel.subtotal),dec(taxModel.tax)):money(lineSubtotalDisplay)}</strong></div><div class="frow"><span>Tax (invoice)</span><strong>${money(inv.tax||0)}</strong></div><div class="frow total"><span>Invoice total</span><strong>${markedAmount(inv.amount||0,beforeTaxDisplay,inv.tax||0)}</strong></div><div class="frow"><span>Status</span><strong>${inv.paid?'PAID':'UNPAID'}</strong></div><div class="frow action"><span></span><button type="button" class="secondary scroll-top-invoice">Scroll to top of invoice</button></div></div></div></details>`;
  }).join('');

  if(openIds.size){
    for(const id of openIds){
      const d = document.getElementById(id);
      if(d) d.open = true;
    }
  }
}

function getInvoiceSearchMatches(invoiceEl){
  const q = invoiceEl?.querySelector('.invoice-item-search-input')?.value?.trim().toLowerCase() || '';
  if(!q || !invoiceEl) return [];
  return Array.from(invoiceEl.querySelectorAll('.li-group.service')).filter(g=>{
    const name = g.querySelector('.li-group-name')?.textContent?.trim().toLowerCase() || '';
    return name.includes(q);
  });
}

function highlightInvoiceSearchMatches(invoiceEl, scrollToCurrent=false){
  if(!invoiceEl) return;
  const q = invoiceEl.querySelector('.invoice-item-search-input')?.value?.trim().toLowerCase() || '';
  const groups = Array.from(invoiceEl.querySelectorAll('.li-group.service'));
  const matches = [];
  for(const g of groups){
    const name = g.querySelector('.li-group-name')?.textContent?.trim().toLowerCase() || '';
    const match = q && name.includes(q);
    g.classList.toggle('search-hit', !!match);
    g.classList.remove('search-current');
    if(match) matches.push(g);
  }
  let idx = Number(invoiceEl.dataset.searchIndex || 0);
  if(!matches.length) idx = 0;
  else {
    if(idx >= matches.length) idx = 0;
    if(idx < 0) idx = 0;
    matches[idx].classList.add('search-current');
    if(scrollToCurrent) matches[idx].scrollIntoView({behavior:'smooth', block:'center'});
  }
  invoiceEl.dataset.searchIndex = String(idx);
  const meta = invoiceEl.querySelector('.invoice-item-search-meta');
  if(meta){
    if(!q) meta.textContent = 'Search highlights matching server groups in this invoice.';
    else if(!matches.length) meta.textContent = '0 matching server groups in this invoice.';
    else meta.textContent = `${matches.length} matching server group${matches.length===1?'':'s'} in this invoice • showing ${idx+1} of ${matches.length}`;
  }
  const prev = invoiceEl.querySelector('.invoice-search-prev');
  const next = invoiceEl.querySelector('.invoice-search-next');
  const noNav = matches.length < 2;
  if(prev) prev.disabled = noNav;
  if(next) next.disabled = noNav;
}

function moveInvoiceSearchMatch(btnOrInvoiceEl, direction=1){
  const invoiceEl = btnOrInvoiceEl?.classList?.contains?.('invoice') ? btnOrInvoiceEl : btnOrInvoiceEl?.closest?.('details.invoice');
  if(!invoiceEl) return;
  const matches = getInvoiceSearchMatches(invoiceEl);
  if(!matches.length) return;
  let idx = Number(invoiceEl.dataset.searchIndex || 0);
  idx = ((idx + direction) % matches.length + matches.length) % matches.length;
  invoiceEl.dataset.searchIndex = String(idx);
  highlightInvoiceSearchMatches(invoiceEl, true);
}

function render(){ renderStats(); renderAnalytics(); renderList(); }


function runServerQuery(){
  const server=$('serverSelect')?.value; if(!server) return setStatus('Choose a server first.', true);
  const from=$('fromDate')?.value ? new Date(`${$('fromDate').value}T00:00:00`) : null;
  const to=$('toDate')?.value ? new Date(`${$('toDate').value}T23:59:59`) : null;
  state.serverGstMode = $('serverGstMode')?.value || state.serverGstMode || 'per-server';
  const usePerServer = state.serverGstMode === 'per-server';
  const out=[];

  const finalizeSegment = (row)=>{
    if(!row) return row;
    const display = serviceDisplayAmounts(row.ex);
    row.displayBefore = display.before;
    row.displayTax = display.gst;
    row.displayInc = display.after;
    row.displayRawGst = display.rawGst;
    row.displayAfterRaw = display.afterRaw;
    if(usePerServer){
      row.tax = display.gst;
      row.inc = display.after;
      row.derived = false;
      row.mode = 'per-server';
    }
    return row;
  };

  for(const inv of state.invoices){
    const d=parseDate(inv.created||inv.date_due||inv.created_at); if(!d) continue;
    if(from && d<from) continue; if(to && d>to) continue;
    const taxModel = buildTaxModel(inv);

    for(const g of groupInvoiceByServerOrder(inv.invoice_items||[])){
      if(g.server!==server) continue;

      let current = null;
      for(const r of g.rows){
        const rowIdx = Number.isInteger(r.idx) ? r.idx : -1;
        const rowEx = cents(r.amount);
        const rowG = taxModel.ok ? (taxModel.gstByIdx.get(rowIdx)||0) : Math.round(rowEx*0.10);
        const lx = dec(rowEx), lt = dec(rowG), li = dec(rowEx + rowG);

        if(r.type==='primary'){
          if(current) out.push(finalizeSegment(current));
          current = {
            date:d,
            invoice_number:inv.invoice_number,
            invoice_id:inv.invoice_id,
            server,
            primaryLine:r.name,
            addons:[],
            ex:lx,
            tax:usePerServer ? 0 : lt,
            inc:usePerServer ? lx : li,
            paid:!!inv.paid,
            derived:taxModel.ok,
            mode: usePerServer ? 'per-server' : (taxModel.ok ? 'derived':'estimated')
          };
        } else {
          if(!current){
            current = {
              date:d,
              invoice_number:inv.invoice_number,
              invoice_id:inv.invoice_id,
              server,
              primaryLine:'(unassigned segment)',
              addons:[],
              ex:0,
              tax:0,
              inc:0,
              paid:!!inv.paid,
              derived:taxModel.ok,
              mode: usePerServer ? 'per-server' : (taxModel.ok ? 'derived':'estimated')
            };
          }
          current.addons.push(r.name);
          current.ex = dec(cents(current.ex)+rowEx);
          if(!usePerServer){
            current.tax = dec(cents(current.tax)+rowG);
            current.inc = dec(cents(current.inc)+rowEx+rowG);
          }
        }
      }
      if(current) out.push(finalizeSegment(current));
    }
  }

  const grouped = new Map();
  for(const row of out){
    const key = [row.invoice_id || '', row.invoice_number || '', row.server || '', row.date?.toISOString?.() || ''].join('|');
    const rec = grouped.get(key) || {
      date: row.date,
      invoice_number: row.invoice_number,
      invoice_id: row.invoice_id,
      server: row.server,
      primaryLine: row.primaryLine,
      primaryLines: [],
      groupedRows: [],
      addons: [],
      ex: 0,
      tax: 0,
      inc: 0,
      paid: row.paid,
      derived: row.derived,
      mode: row.mode
    };
    rec.primaryLines.push(row.primaryLine);
    rec.groupedRows.push({
      primaryLine: row.primaryLine,
      addons: [...(row.addons || [])],
      ex: row.ex,
      tax: row.tax,
      inc: row.inc,
      displayBefore: row.displayBefore,
      displayTax: row.displayTax,
      displayInc: row.displayInc,
      displayRawGst: row.displayRawGst,
      displayAfterRaw: row.displayAfterRaw
    });
    rec.addons.push(...(row.addons || []));
    rec.ex = dec(cents(rec.ex) + cents(row.ex));
    rec.tax = dec(cents(rec.tax) + cents(row.tax));
    rec.inc = dec(cents(rec.inc) + cents(row.inc));
    rec.primaryLine = rec.primaryLines.length > 1 ? `${rec.primaryLines.length} grouped usage items` : rec.primaryLines[0];
    rec.isGrouped = rec.primaryLines.length > 1;
    rec.displayBefore = undefined;
    rec.displayTax = undefined;
    rec.displayInc = undefined;
    rec.displayRawGst = undefined;
    rec.displayAfterRaw = undefined;
    grouped.set(key, rec);
  }

  const merged = [...grouped.values()].map(finalizeSegment).sort((a,b)=>b.date-a.date);
  state.queryRows=merged;
  const sumEx=merged.reduce((a,r)=>a+r.ex,0), sumTax=merged.reduce((a,r)=>a+(r.displayTax ?? r.tax),0), sumInc=merged.reduce((a,r)=>a+(r.displayInc ?? r.inc),0);
  $('querySummary').innerHTML = `<div class="stat"><div class="k">Matched invoice items</div><div class="v">${merged.length}</div></div><div class="stat"><div class="k">Ex GST</div><div class="v">${money(sumEx)}</div></div><div class="stat"><div class="k">GST</div><div class="v">${money(sumTax)}</div></div><div class="stat"><div class="k">Inc GST</div><div class="v">${moneyInc(sumInc)}</div></div>`;

  if(!merged.length){ $('queryTable').innerHTML='<p class="muted">No matched items for this server/date range.</p>'; return; }
  const modeNote = usePerServer
    ? 'GST mode: Customer-style grouped GST. Server totals are calculated from grouped ex-GST subtotal × 10%, then rounded to 2 decimals.'
    : 'GST mode: Invoice-reconciled source data, but displayed server totals still use grouped GST rounding for consistency.';
  $('queryTable').innerHTML = `<div class="small" style="margin-bottom:8px">${modeNote}<br/>Rows are grouped per invoice for the selected server so totals reconcile more closely with the invoice view. Displayed values use standard 2-decimal rounding, and the tooltip shows the grouped GST working.</div><table><thead><tr><th>Date</th><th>Invoice</th><th>Server</th><th>Server charge</th><th>Add-ons</th><th>Ex GST</th><th>GST</th><th>Inc GST</th><th>Mode</th></tr></thead><tbody>${merged.map(r=>{
    const groupedBreakdown = r.isGrouped
      ? `<button type="button" class="query-group-trigger" data-group='${esc(JSON.stringify({ invoice: r.invoice_number, server: r.server, lines: r.groupedRows }))}'>${esc(r.primaryLine)}<span class="query-group-hint">(click to expand)</span></button>`
      : esc(r.primaryLine);
    const addonCell = r.isGrouped ? '—' : (r.addons.length?`<ul class="addon-chip-list">${r.addons.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`:'—');
    return `<tr><td>${esc(fmtDate(r.date.toISOString()))}</td><td><a href="#" class="jump-invoice" data-invoice="${esc(r.invoice_number)}">#${esc(r.invoice_number)}</a></td><td>${esc(r.server)}</td><td>${groupedBreakdown}</td><td>${addonCell}</td><td>${money(r.displayBefore ?? r.ex)}</td><td>${money(r.displayTax ?? r.tax)}</td><td><div class="inc-cell"><div class="inc-main">${markedAmount(r.displayInc ?? r.inc,r.displayBefore ?? r.ex,r.displayTax ?? r.tax,{kind:'grouped-service',before:r.displayBefore ?? r.ex,rawGst:r.displayRawGst ?? ((r.displayTax ?? r.tax)),afterRaw:r.displayAfterRaw ?? (r.displayInc ?? r.inc),after:r.displayInc ?? r.inc})}</div></div></td><td>${r.mode || (r.derived?'derived':'estimated')}</td></tr>`;
  }).join('')}</tbody></table>`;
}

function exportServerQueryCsv(){
  const rows=state.queryRows||[]; if(!rows.length) return setStatus('Run a server query first.',true);
  const escCsv=(v)=>`"${String(v??'').replaceAll('"','""')}"`;
  const head=['date','invoice_number','invoice_id','server','server_charge','addons','ex_gst','gst','inc_gst','mode','paid'];
  const lines=[head.join(',')];
  for(const r of rows){ lines.push([r.date.toISOString(),r.invoice_number,r.invoice_id,r.server,r.primaryLine||'',r.addons.join(' | '),r.ex.toFixed(2),r.tax.toFixed(2),r.inc.toFixed(2),r.derived?'derived':'estimated',r.paid?'yes':'no'].map(escCsv).join(',')); }
  const blob=new Blob([lines.join('\n')],{type:'text/csv;charset=utf-8'}); const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download=`server-cost-query-${Date.now()}.csv`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

function clearAll(){
  sessionStorage.removeItem('bl_api_key'); $('apiKey').value='';
  Object.assign(state,{invoices:[],filtered:[],apiKey:'',apiPage:0,hasMore:true,queryRows:[],serverStatus:new Map(),serverOrder:[],serverGstMode:'per-server'});
  if($('serverGstMode')) $('serverGstMode').value = 'per-server';
  if($('serverSearch')) $('serverSearch').value = '';
  const s=$('serverSelect'); if(s) s.innerHTML='<option value="">(no servers)</option>';
  updateServerPickerLabel();
  if($('querySummary')) $('querySummary').innerHTML=''; if($('queryTable')) $('queryTable').innerHTML='';
  render(); setStatus('Cleared.');
}


function jumpToInvoice(invoiceNumber){
  const n = String(invoiceNumber||'').replace(/^#/, '');
  setActiveTab('invoices');
  const search = $('search');
  if (search) search.value = n;
  applyFilters();
  const detail = document.getElementById(`inv-${n}`);
  if (detail){
    detail.open = true;
    detail.scrollIntoView({behavior:'smooth', block:'start'});
  }
}

function setActiveTab(tab){
  const invoices=tab==='invoices';
  $('tabInvoices')?.classList.toggle('active',invoices); $('tabServer')?.classList.toggle('active',!invoices);
  $('invoicesPane')?.classList.toggle('hidden',!invoices); $('serverPane')?.classList.toggle('hidden',invoices);
  if(invoices) $('queryGroupModal')?.classList.add('hidden');
}

function refreshMoneyViews(){
  if(state.invoices.length) applyFilters();
  if(state.queryRows.length) runServerQuery();
}

async function onFetch(){
  try{
    const key=$('apiKey').value.trim(); if(!key) return setStatus('Paste API key first.',true);
    if($('remember').checked) sessionStorage.setItem('bl_api_key',key);
    state.apiKey=key;
    const [invoicesRes, serversRes] = await Promise.allSettled([fetchAllInvoices(), fetchAllServers()]);
    if(invoicesRes.status === 'rejected') throw invoicesRes.reason;
    if(serversRes.status === 'rejected'){
      console.warn('Server ordering lookup failed; using observed invoice order instead.', serversRes.reason);
      state.serverIdByName = new Map();
    }
    computeServerStatus();
    applyFilters();
    fillServerSelect();
    runServerQueryIfReady();
  }catch(e){ console.error(e); setStatus(`Fetch failed: ${e.message}. Check API key, CORS, or network.`,true); }
}

(function init(){
  maybeClearOnReload();
  const saved=sessionStorage.getItem('bl_api_key'); if(saved){ $('apiKey').value=saved; state.apiKey=saved; }

  $('fetchBtn').addEventListener('click', onFetch);
  $('apiKey').addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ e.preventDefault(); onFetch(); } });
  $('clearBtn').addEventListener('click', clearAll);
  $('toggleKey').addEventListener('click', ()=>{ const el=$('apiKey'); el.type = el.type==='password' ? 'text':'password'; $('toggleKey').classList.toggle('is-visible', el.type!=='password');
    $('toggleKey').setAttribute('aria-label', el.type==='password'?'Show API key':'Hide API key');
    $('toggleKey').setAttribute('title', el.type==='password'?'Show API key':'Hide API key'); });
  $('range').addEventListener('change', applyFilters); $('search').addEventListener('input', applyFilters);
  $('viewPerPage').addEventListener('change', ()=>{ $('viewPage').value='1'; renderList(); });
  $('applyViewPage').addEventListener('click', renderList);
  $('tabInvoices')?.addEventListener('click', ()=>setActiveTab('invoices')); $('tabServer')?.addEventListener('click', ()=>setActiveTab('server'));
  $('exportQueryBtn')?.addEventListener('click', exportServerQueryCsv);
  $('serverGstMode')?.addEventListener('change', runServerQueryIfReady);
  $('serverPickerBtn')?.addEventListener('click', openServerSearchModal);
  $('serverSearch')?.addEventListener('input', ()=>{
    fillServerSelect($('serverSearch')?.value || '');
    renderServerSearchResults($('serverSearch')?.value || '');
  });
  $('serverSearch')?.addEventListener('keydown', (e)=>{
    if(e.key === 'Escape'){ e.preventDefault(); closeServerSearchModal(); }
    if(e.key === 'Enter'){
      e.preventDefault();
      const first = $('serverSearchResults')?.querySelector('.server-result');
      const name = first?.getAttribute('data-server');
      if(name) chooseServer(name);
    }
  });
  $('serverSearchCloseBtn')?.addEventListener('click', closeServerSearchModal);
  $('serverSearchModal')?.addEventListener('click', (e)=>{ if(e.target.id==='serverSearchModal') closeServerSearchModal(); });
  $('serverSearchResults')?.addEventListener('click', (e)=>{
    const btn = e.target.closest('.server-result');
    if(!btn) return;
    chooseServer(btn.getAttribute('data-server') || '');
  });
  $('showCancelled')?.addEventListener('change', ()=>{
    fillServerSelect($('serverSearch')?.value || '');
    renderServerSearchResults($('serverSearch')?.value || '');
    runServerQueryIfReady();
  });
  $('fromDate')?.addEventListener('change', runServerQueryIfReady);
  $('toDate')?.addEventListener('change', runServerQueryIfReady);

  $('helpBtn')?.addEventListener('click', ()=> $('helpModal')?.classList.remove('hidden'));
  $('helpCloseBtn')?.addEventListener('click', ()=> $('helpModal')?.classList.add('hidden'));
  $('helpModal')?.addEventListener('click', (e)=>{ if(e.target.id==='helpModal') $('helpModal').classList.add('hidden'); });

  if($('fromDate')) $('fromDate').value=''; if($('toDate')) $('toDate').value='';
  updateServerPickerLabel();

  document.addEventListener('input', (e)=>{
    if(!e.target.matches('.invoice-item-search-input')) return;
    const invoice = e.target.closest('details.invoice');
    if(!invoice) return;
    invoice.dataset.searchIndex = '0';
    highlightInvoiceSearchMatches(invoice, true);
  });
  document.addEventListener('keydown', (e)=>{
    if(!e.target.matches('.invoice-item-search-input')) return;
    const invoice = e.target.closest('details.invoice');
    if(!invoice) return;
    if(e.key==='Enter'){ e.preventDefault(); moveInvoiceSearchMatch(invoice, 1); }
    if(e.key==='ArrowUp'){ e.preventDefault(); moveInvoiceSearchMatch(invoice, -1); }
    if(e.key==='ArrowDown'){ e.preventDefault(); moveInvoiceSearchMatch(invoice, 1); }
  });
  document.addEventListener('click', (e)=>{
    const prev = e.target.closest('.invoice-search-prev');
    const next = e.target.closest('.invoice-search-next');
    if(prev) moveInvoiceSearchMatch(prev, -1);
    if(next) moveInvoiceSearchMatch(next, 1);
  });

  document.addEventListener('click',(e)=>{ const b=e.target.closest('.collapse-invoice'); if(!b) return; const d=b.closest('details.invoice'); if(d) d.open=false; setTimeout(()=>{ if(d) highlightInvoiceSearchMatches(d, false); }, 0); });
  document.addEventListener('click',(e)=>{ const l=e.target.closest('.jump-invoice'); if(!l) return; e.preventDefault(); jumpToInvoice(l.getAttribute('data-invoice')); });
  document.addEventListener('click',(e)=>{
    const q = e.target.closest('.query-group-trigger');
    if(!q) return;
    try {
      const payload = JSON.parse(q.getAttribute('data-group') || '{}');
      const meta = $('queryGroupModalMeta');
      const body = $('queryGroupModalBody');
      const panel = $('queryGroupPanel');
      if(meta) meta.textContent = `${payload.server || 'Server'} • invoice #${payload.invoice || ''}`;
      if(body) body.innerHTML = (payload.lines || []).map(g=>`<div class="query-group-card"><div class="query-group-row"><div class="query-group-row-title">${esc(g.primaryLine || '')}</div><div class="query-group-row-amt">${markedAmount(g.displayInc ?? g.inc,g.displayBefore ?? g.ex,g.displayTax ?? g.tax,{kind:'grouped-service',before:g.displayBefore ?? g.ex,rawGst:g.displayRawGst ?? (g.displayTax ?? g.tax),afterRaw:g.displayAfterRaw ?? (g.displayInc ?? g.inc),after:g.displayInc ?? g.inc})}</div></div>${g.addons?.length ? `<div class="query-group-addon-wrap"><div class="query-group-addon-label">Add-ons</div><ul class="addon-chip-list">${g.addons.map(x=>`<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}</div>`).join('');
      $('queryGroupModal')?.classList.remove('hidden');
      if(panel){ panel.style.position = ''; panel.style.margin = ''; panel.style.left = ''; panel.style.top = ''; }
    } catch (err) {
      console.error(err);
    }
  });
  $('queryGroupCloseBtn')?.addEventListener('click', ()=> $('queryGroupModal')?.classList.add('hidden'));
  document.addEventListener('click',(e)=>{ const b=e.target.closest('.scroll-top-invoice'); if(!b) return; const d=b.closest('details.invoice'); if(d) d.scrollIntoView({behavior:'smooth',block:'start'}); });
  document.addEventListener('toggle',(e)=>{
    if(!e.target.matches('details.invoice')) return;
    setTimeout(()=>highlightInvoiceSearchMatches(e.target, false), 0);
  }, true);

  {
    const modal = $('queryGroupModal');
    const panel = $('queryGroupPanel');
    const handle = $('queryGroupDragHandle');
    let drag = null;
    const startDrag = (clientX, clientY) => {
      if(!panel) return;
      const rect = panel.getBoundingClientRect();
      drag = { dx: clientX - rect.left, dy: clientY - rect.top };
      panel.style.position = 'fixed';
      panel.style.margin = '0';
      panel.style.left = `${rect.left}px`;
      panel.style.top = `${rect.top}px`;
    };
    const moveDrag = (clientX, clientY) => {
      if(!drag || !panel) return;
      const maxLeft = Math.max(8, window.innerWidth - panel.offsetWidth - 8);
      const maxTop = Math.max(8, window.innerHeight - panel.offsetHeight - 8);
      panel.style.left = `${Math.min(maxLeft, Math.max(8, clientX - drag.dx))}px`;
      panel.style.top = `${Math.min(maxTop, Math.max(8, clientY - drag.dy))}px`;
    };
    const stopDrag = () => { drag = null; };
    handle?.addEventListener('mousedown', (e)=>{ startDrag(e.clientX, e.clientY); e.preventDefault(); });
    document.addEventListener('mousemove', (e)=> moveDrag(e.clientX, e.clientY));
    document.addEventListener('mouseup', stopDrag);
    handle?.addEventListener('touchstart', (e)=>{ const t=e.touches[0]; if(!t) return; startDrag(t.clientX, t.clientY); }, {passive:true});
    document.addEventListener('touchmove', (e)=>{ const t=e.touches[0]; if(!t) return; moveDrag(t.clientX, t.clientY); }, {passive:true});
    document.addEventListener('touchend', stopDrag, {passive:true});
    document.addEventListener('keydown', (e)=>{ if(e.key==='Escape') modal?.classList.add('hidden'); });
  }

  ['mousemove','keydown','click','scroll'].forEach(ev=>addEventListener(ev,onActivity,{passive:true}));
  onActivity(); setActiveTab('invoices');
  if($('queryTable')) $('queryTable').innerHTML='<p class="muted">Fetch invoices, then run a server query.</p>';
  render();
})();
