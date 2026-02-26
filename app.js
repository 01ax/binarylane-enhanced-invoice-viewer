const API_BASE = 'https://api.binarylane.com.au/v2/customers/my/invoices';
const IDLE_TIMEOUT_MS = 15 * 60 * 1000;

const $ = (id) => document.getElementById(id);
const state = {
  invoices: [], filtered: [], apiKey: '', apiPage: 0, hasMore: true,
  queryRows: [], serverStatus: new Map()
};
let idleTimer;

const esc = (s) => String(s ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const money = (n) => new Intl.NumberFormat('en-AU',{style:'currency',currency:'AUD'}).format(Number(n||0));
const parseDate = (s)=> s ? new Date(s) : null;
function fmtDate(s){ const d=parseDate(s); return d && !Number.isNaN(+d) ? new Intl.DateTimeFormat('en-AU',{day:'2-digit',month:'short',year:'numeric',hour:'numeric',minute:'2-digit',hour12:true}).format(d) : '-'; }

const cents = (n)=> Math.round(Number(n||0)*100);
const dec = (c)=> Number((c/100).toFixed(2));
const gstTitle = (before,gst,after)=> `Before tax: ${money(before)}&#10;GST amount: ${money(gst)}&#10;After tax: ${money(after)}`;
const markedAmount = (after,before,gst)=> `<span class="amount-tip" title="${gstTitle(before,gst,after)}"><span class="amount-mark">†</span>${money(after)}</span>`;

function setStatus(msg, err=false){ const el=$('status'); if(!el) return; el.textContent=msg; el.style.color=err?'#ff9d9d':'#9aa4b2'; }

function onActivity(){
  clearTimeout(idleTimer);
  idleTimer = setTimeout(()=>{ sessionStorage.removeItem('bl_api_key'); $('apiKey').value=''; setStatus('API key cleared due to inactivity.'); }, IDLE_TIMEOUT_MS);
}
function maybeClearOnReload(){ const nav=performance.getEntriesByType('navigation')[0]; if(nav && nav.type==='reload') sessionStorage.removeItem('bl_api_key'); }

function normalizeBatch(payload){
  if (Array.isArray(payload)) return payload;
  if (payload?.invoices && Array.isArray(payload.invoices)) return payload.invoices;
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
  for(const it of (items||[])){
    const name=(it.name||'Unnamed item').trim(); const amount=Number(it.amount||0); const includesTax=Boolean(it.amount_includes_tax);
    if(isPrimaryServiceLine(name)){
      current={ server: canonicalServiceName(name), rows:[] };
      groups.push(current);
      current.rows.push({name,amount,includesTax,type:'primary'});
    } else {
      if(!current){ current={server:'Unassigned account items',rows:[]}; groups.push(current); }
      current.rows.push({name,amount,includesTax,type:'addon'});
    }
  }
  return groups;
}

function computeServerStatus(){
  const perServer = new Map();
  let globalLatest = null;
  for(const inv of state.invoices){
    for(const it of (inv.invoice_items||[])){
      const n = it?.name || '';
      if(!isPrimaryServiceLine(n)) continue;
      const server = canonicalServiceName(n);
      const end = parsePeriodEnd(n);
      if(end && (!globalLatest || end > globalLatest)) globalLatest = end;
      const rec = perServer.get(server) || { latestEnd:null };
      if(end && (!rec.latestEnd || end > rec.latestEnd)) rec.latestEnd = end;
      perServer.set(server, rec);
    }
  }
  state.serverStatus = new Map();
  for(const [server, rec] of perServer.entries()){
    const active = globalLatest && rec.latestEnd ? Math.abs(rec.latestEnd - globalLatest) <= 86400000 : false;
    state.serverStatus.set(server, active ? 'active' : 'cancelled');
  }
}

function fillServerSelect(){
  const el=$('serverSelect'); if(!el) return;
  const showCancelled = !!$('showCancelled')?.checked;
  let names=[...state.serverStatus.keys()].sort((a,b)=>a.localeCompare(b));
  if(!showCancelled) names = names.filter(n => state.serverStatus.get(n)==='active');
  el.innerHTML = names.length
    ? ['<option value="">Select a server</option>', ...names.map(n=>`<option value="${esc(n)}">${esc(n)}${state.serverStatus.get(n)==='cancelled'?' (cancelled)':''}</option>`)].join('')
    : '<option value="">(no servers)</option>';
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
  $('stats').innerHTML = `<div class="stat"><div class="k">Invoices</div><div class="v">${list.length}</div></div><div class="stat"><div class="k">Total</div><div class="v">${money(total)}</div></div><div class="stat"><div class="k">Tax</div><div class="v">${money(tax)}</div></div><div class="stat"><div class="k">Paid / Unpaid</div><div class="v">${paid} / ${list.length-paid}</div></div>`;
}

function renderAnalytics(){
  const monthly=new Map();
  for(const inv of state.filtered){
    const d=parseDate(inv.created||inv.date_due||inv.created_at); if(!d) continue;
    const k=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    monthly.set(k,(monthly.get(k)||0)+Number(inv.amount||0));
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
  if(titleEl) titleEl.textContent = `Monthly Spend${yearLabel ? ` (${yearLabel})` : ''}`;

  const max=Math.max(1,...rows.map(([,v])=>v));
  $('monthlyBars').innerHTML = rows.length
    ? rows.map(([k,v])=>`<div class="bar-row"><div>${esc(monthName(k))}</div><div class="bar-track"><div class="bar-fill" style="width:${Math.max(2,Math.round((v/max)*100))}%"></div></div><div>${money(v)}</div></div>`).join('')
    : '<p class="muted">No data for selected range.</p>';

  const sv=new Map();
  for(const inv of state.filtered) for(const it of (inv.invoice_items||[])){ const n=(it.name||'').trim(); if(isPrimaryServiceLine(n)){ const key=canonicalServiceName(n); sv.set(key,(sv.get(key)||0)+Number(it.amount||0)); }}
  const top=[...sv.entries()].sort((a,b)=>b[1]-a[1]).slice(0,12);
  $('topItems').innerHTML = top.length ? top.map(([n,a])=>`<div class="item-row"><div>${esc(n)}</div><div><strong>${money(a)}</strong></div></div>`).join('') : '<p class="muted">No service-level data in selected range.</p>';
}

function groupLineItems(items, taxModel){
  const groups=[]; const by=new Map(); let last=null;
  const ensure=(k,kind='service')=>{ if(!by.has(k)){ const o={name:k,total:0,ex:0,tax:0,rows:[],kind}; by.set(k,o); groups.push(o);} return by.get(k); };
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
  return groups.sort((a,b)=>b.total-a.total);
}

function renderList(){
  const box=$('invoiceList');
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
      return `<div class="li-group ${g.kind}"><div class="li-group-head"><div class="li-group-name">${esc(g.name)}</div><div class="li-group-total">${taxModel.ok?markedAmount(g.total,g.ex,g.tax):money(g.total)}</div></div><div class="li-group-body">${primary}${addonBlock}</div></div>`;
    }).join('');

    const lineSubtotalDisplay = taxModel.ok ? dec(taxModel.subtotal + taxModel.tax) : (inv.invoice_items||[]).reduce((a,it)=>a+Number(it.amount||0),0);
    const beforeTaxDisplay = dec(cents(inv.amount||0) - cents(inv.tax||0));
    const displayLabel = taxModel.ok ? 'Line items subtotal (incl GST, derived)' : 'Line items subtotal (ex GST)';
    const note = taxModel.ok
      ? '<div class="small" style="margin-top:8px;color:#9ec5ff">Per-line GST shown as derived allocation and reconciled to invoice GST total.</div>'
      : '<div class="small" style="margin-top:8px;color:#f0c38a">Per-line GST cannot be safely derived for this invoice; line items shown ex GST.</div>';

    return `<details class="invoice" id="inv-${esc(inv.invoice_number)}"><summary><div><strong>#${esc(inv.invoice_number)}</strong> <span class="small">(${esc(inv.reference||'')})</span><br/><span class="small">Created: ${fmtDate(inv.created||inv.created_at||inv.date_due)}</span></div><div style="text-align:right"><div><span class="badge ${inv.paid?'paid':'unpaid'}">${inv.paid?'PAID':'UNPAID'}</span></div><div><strong>${markedAmount(inv.amount||0,beforeTaxDisplay,inv.tax||0)}</strong></div></div></summary><div class="body"><div class="small">Invoice ID: ${esc(inv.invoice_id)} · Due: ${fmtDate(inv.date_due)} · Download: <a href="${esc(inv.invoice_download_url||'#')}" target="_blank" rel="noopener noreferrer">PDF</a></div><div class="row" style="justify-content:flex-end; margin-top:8px;"><button type="button" class="secondary collapse-invoice">Collapse invoice</button></div><div class="li-wrap">${groupHtml || '<p class="small">No line items</p>'}</div>${note}<div class="invoice-footer"><div class="frow"><span>${displayLabel}</span><strong>${taxModel.ok?markedAmount(lineSubtotalDisplay,dec(taxModel.subtotal),dec(taxModel.tax)):money(lineSubtotalDisplay)}</strong></div><div class="frow"><span>Tax (invoice)</span><strong>${money(inv.tax||0)}</strong></div><div class="frow total"><span>Invoice total</span><strong>${markedAmount(inv.amount||0,beforeTaxDisplay,inv.tax||0)}</strong></div><div class="frow"><span>Status</span><strong>${inv.paid?'PAID':'UNPAID'}</strong></div><div class="frow action"><span></span><button type="button" class="secondary scroll-top-invoice">Scroll to top of invoice</button></div></div></div></details>`;
  }).join('');
}

function render(){ renderStats(); renderAnalytics(); renderList(); }

function runServerQuery(){
  const server=$('serverSelect')?.value; if(!server) return setStatus('Choose a server first.', true);
  const from=$('fromDate')?.value ? new Date(`${$('fromDate').value}T00:00:00`) : null;
  const to=$('toDate')?.value ? new Date(`${$('toDate').value}T23:59:59`) : null;
  const out=[];

  for(const inv of state.invoices){
    const d=parseDate(inv.created||inv.date_due||inv.created_at); if(!d) continue;
    if(from && d<from) continue; if(to && d>to) continue;
    const taxModel = buildTaxModel(inv);

    for(const g of groupInvoiceByServerOrder(inv.invoice_items||[])){
      if(g.server!==server) continue;

      let current = null;
      for(const r of g.rows){
        const rowIdx = (inv.invoice_items||[]).findIndex((x)=>x.name===r.name && Number(x.amount||0)===Number(r.amount||0));
        const rowEx = cents(r.amount);
        const rowG = taxModel.ok ? (taxModel.gstByIdx.get(rowIdx)||0) : Math.round(rowEx*0.10);
        const lx = dec(rowEx), lt = dec(rowG), li = dec(rowEx + rowG);

        if(r.type==='primary'){
          if(current) out.push(current);
          current = {
            date:d,
            invoice_number:inv.invoice_number,
            invoice_id:inv.invoice_id,
            server,
            primaryLine:r.name,
            addons:[],
            ex:lx,
            tax:lt,
            inc:li,
            paid:!!inv.paid,
            derived:taxModel.ok
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
              derived:taxModel.ok
            };
          }
          current.addons.push(r.name);
          current.ex = dec(cents(current.ex)+rowEx);
          current.tax = dec(cents(current.tax)+rowG);
          current.inc = dec(cents(current.inc)+rowEx+rowG);
        }
      }
      if(current) out.push(current);
    }
  }

  out.sort((a,b)=>b.date-a.date);
  state.queryRows=out;
  const sumEx=out.reduce((a,r)=>a+r.ex,0), sumTax=out.reduce((a,r)=>a+r.tax,0), sumInc=out.reduce((a,r)=>a+r.inc,0);
  $('querySummary').innerHTML = `<div class="stat"><div class="k">Matched segments</div><div class="v">${out.length}</div></div><div class="stat"><div class="k">Ex GST</div><div class="v">${money(sumEx)}</div></div><div class="stat"><div class="k">GST</div><div class="v">${money(sumTax)}</div></div><div class="stat"><div class="k">Inc GST</div><div class="v">${money(sumInc)}</div></div>`;

  if(!out.length){ $('queryTable').innerHTML='<p class="muted">No matched items for this server/date range.</p>'; return; }
  $('queryTable').innerHTML = `<div class="small" style="margin-bottom:8px">GST per line is shown as derived allocation when invoice constraints pass; otherwise GST is estimated at 10% for visibility only.</div><table><thead><tr><th>Date</th><th>Invoice</th><th>Server</th><th>Server charge</th><th>Add-ons</th><th>Ex GST</th><th>GST</th><th>Inc GST</th><th>Mode</th></tr></thead><tbody>${out.map(r=>`<tr><td>${esc(fmtDate(r.date.toISOString()))}</td><td><a href="#" class="jump-invoice" data-invoice="${esc(r.invoice_number)}">#${esc(r.invoice_number)}</a></td><td>${esc(r.server)}</td><td>${esc(r.primaryLine)}</td><td>${r.addons.length?`<ul class="addon-chip-list">${r.addons.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`:'—'}</td><td>${money(r.ex)}</td><td>${money(r.tax)}</td><td>${money(r.inc)}</td><td>${r.derived?'derived':'estimated'}</td></tr>`).join('')}</tbody></table>`;
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
  Object.assign(state,{invoices:[],filtered:[],apiKey:'',apiPage:0,hasMore:true,queryRows:[],serverStatus:new Map()});
  const s=$('serverSelect'); if(s) s.innerHTML='<option value="">(no servers)</option>';
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
}

async function onFetch(){
  try{
    const key=$('apiKey').value.trim(); if(!key) return setStatus('Paste API key first.',true);
    if($('remember').checked) sessionStorage.setItem('bl_api_key',key);
    state.apiKey=key;
    await fetchAllInvoices();
    computeServerStatus();
    applyFilters();
    fillServerSelect();
    if($('serverSelect')?.value) runServerQuery();
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
  $('runQueryBtn')?.addEventListener('click', runServerQuery); $('exportQueryBtn')?.addEventListener('click', exportServerQueryCsv);
  $('showCancelled')?.addEventListener('change', ()=>{ const cur=$('serverSelect')?.value; fillServerSelect(); if(cur) $('serverSelect').value = [...$('serverSelect').options].some(o=>o.value===cur) ? cur : ''; });

  if($('fromDate')) $('fromDate').value=''; if($('toDate')) $('toDate').value='';

  document.addEventListener('click',(e)=>{ const b=e.target.closest('.collapse-invoice'); if(!b) return; const d=b.closest('details.invoice'); if(d) d.open=false; });
  document.addEventListener('click',(e)=>{ const l=e.target.closest('.jump-invoice'); if(!l) return; e.preventDefault(); jumpToInvoice(l.getAttribute('data-invoice')); });
  document.addEventListener('click',(e)=>{ const b=e.target.closest('.scroll-top-invoice'); if(!b) return; const d=b.closest('details.invoice'); if(d) d.scrollIntoView({behavior:'smooth',block:'start'}); });

  ['mousemove','keydown','click','scroll'].forEach(ev=>addEventListener(ev,onActivity,{passive:true}));
  onActivity(); setActiveTab('invoices');
  if($('queryTable')) $('queryTable').innerHTML='<p class="muted">Fetch invoices, then run a server query.</p>';
  render();
})();
