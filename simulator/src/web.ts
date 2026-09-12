import {
  GROWTH_CHAMBER_IDS,
  GROWTH_CHAMBER_PARAMETERS,
} from './growth-chamber.js';

export function renderWebPage(nonce: string): string {
  const parameters = JSON.stringify(
    GROWTH_CHAMBER_PARAMETERS.map(({ id, label, unit, min, max, type }) => ({
      id,
      label,
      unit,
      min,
      max,
      type,
    })),
  ).replaceAll('<', '\\u003c');
  const ids = JSON.stringify(GROWTH_CHAMBER_IDS);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Grow Sense — Growth Chamber Simulator</title>
<style nonce="${nonce}">
:root{color-scheme:dark;--bg:#07110d;--panel:#102019;--line:#294537;--text:#edf7f1;--muted:#9bb3a5;--green:#75e09b;--red:#ff8e8e}*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--text)}main{max-width:1100px;margin:auto;padding:28px 18px 60px}h1{margin:.2rem 0;font-size:clamp(1.7rem,4vw,2.6rem)}h2{font-size:1.05rem}.lead,.muted{color:var(--muted)}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(290px,1fr));gap:16px;margin-top:20px}.panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px}.full{grid-column:1/-1}label{display:block;margin:10px 0 4px;color:var(--muted)}input,select,button{width:100%;font:inherit;color:var(--text);background:#091610;border:1px solid var(--line);border-radius:8px;padding:9px}button{cursor:pointer;background:#1d5938;border-color:#39845a;font-weight:650;margin-top:10px}button.secondary{background:#17251e}button.danger{background:#572626;border-color:#8e4242}button:disabled{opacity:.5;cursor:not-allowed}.row{display:flex;gap:8px}.row>*{flex:1}.status{display:inline-block;border-radius:999px;padding:4px 10px;background:#26382f}.status.connected{color:var(--green)}.status.error{color:var(--red)}dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 14px}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}.control{border-top:1px solid var(--line);padding-top:12px;margin-top:12px}.sensor-error{width:auto}pre{max-height:360px;overflow:auto;white-space:pre-wrap;word-break:break-word;background:#07110d;padding:12px;border-radius:8px}.notice{border-left:3px solid var(--green);padding-left:10px}.error-text{color:var(--red);min-height:1.5em}
</style>
</head>
<body><main>
<header><p class="muted">LOCAL LOOPBACK TOOL</p><h1>Growth Chamber Simulator</h1><p class="lead">Bun gateway for the fixed production TLS broker. Credentials stay in gateway memory only.</p></header>
<div class="grid">
<section class="panel" aria-labelledby="connection-title"><h2 id="connection-title">Connection</h2>
<p class="notice"><strong>Broker:</strong> mqtts://mqtt.growsense.my.id:8883</p>
<form id="connect-form" autocomplete="off">
<label for="deviceId">Device ID</label><input id="deviceId" name="deviceId" required minlength="8" maxlength="64" pattern="[A-Za-z0-9_-]+" autocomplete="off">
<label for="secret">Device secret</label><input id="secret" name="deviceSecret" type="password" required maxlength="1024" autocomplete="new-password">
<div class="row"><div><label for="version">Credential version</label><input id="version" name="credentialVersion" type="number" min="1" step="1" value="1" required></div><div><label for="interval">Publish interval (ms)</label><input id="interval" name="intervalMs" type="number" min="100" max="30000" step="100" value="10000" required></div></div>
<label for="ca">Optional CA certificate (PEM, memory only)</label><textarea id="ca" name="ca" rows="4" maxlength="65536" autocomplete="off"></textarea>
<label for="scenario">Command scenario</label><select id="scenario" name="scenario"><option value="normal">Normal</option><option value="reject">Reject</option><option value="delayed">Delayed result (15 s)</option><option value="no-response">No response</option></select>
<button type="submit">Connect device</button></form>
<p id="form-error" class="error-text" role="alert"></p>
<div class="row"><button class="secondary action" data-action="clean">Clean disconnect</button><button class="danger action" data-action="abrupt">Abrupt disconnect</button><button class="secondary action" data-action="reconnect">Reconnect</button></div>
</section>
<section class="panel" aria-labelledby="monitor-title"><h2 id="monitor-title">Monitor</h2><p><span id="status" class="status">disconnected</span></p><dl><dt>Connection ID</dt><dd id="connectionId">—</dd><dt>Revision</dt><dd id="revision">0</dd><dt>Last publish</dt><dd id="lastPublish">—</dd><dt>Last heartbeat</dt><dd id="lastHeartbeat">—</dd></dl><h2>Latest state</h2><pre id="state">{}</pre><h2>Latest telemetry</h2><pre id="telemetry">{}</pre></section>
<section class="panel full" aria-labelledby="parameters-title"><h2 id="parameters-title">Firmware parameters</h2><div id="parameters"></div></section>
<section class="panel full" aria-labelledby="events-title"><h2 id="events-title">Event log</h2><pre id="events" aria-live="polite">Waiting for local events.</pre></section>
</div></main>
<script nonce="${nonce}">
const definitions=${parameters};const ids=${ids};const $=id=>document.getElementById(id);const fmt=value=>value?new Date(value).toLocaleTimeString():'—';
async function request(path,body){const response=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const data=await response.json();if(!response.ok)throw new Error(data.error||'Request failed');return data}
function renderControls(){const root=$('parameters');root.replaceChildren();for(const p of definitions){const box=document.createElement('div');box.className='control';const label=document.createElement('label');label.htmlFor='p-'+p.id;label.textContent=p.label+(p.unit?' ('+p.unit+')':'');const input=document.createElement('input');input.id='p-'+p.id;if(p.type==='control-state'){input.type='checkbox';input.checked=false}else{input.type='number';input.step=p.label==='tempSensor'||p.label==='rhSensor'?'0.1':'1';if(p.min!==undefined)input.min=p.min;if(p.max!==undefined)input.max=p.max;input.value=p.label==='setpointTemp'?'25':p.label==='setpointRH'?'65':p.label==='tempSensor'?'25':'65'}box.append(label,input);if(p.type==='nilai'){const errLabel=document.createElement('label');const err=document.createElement('input');err.type='checkbox';err.className='sensor-error';errLabel.append(err,document.createTextNode(' Simulate sensor error'));box.append(errLabel);const send=()=>request('/api/sensor',{source:p.label,error:err.checked,value:Number(input.value)}).catch(showError);input.addEventListener('change',send);err.addEventListener('change',send)}else input.addEventListener('change',()=>request('/api/control',{source:p.label,value:p.type==='control-state'?input.checked:Number(input.value)}).catch(showError));root.append(box)}}
function showError(error){$('form-error').textContent=error.message}
function update(data){$('status').textContent=data.status;$('status').className='status '+(data.status==='connected'?'connected':data.status==='error'?'error':'');$('connectionId').textContent=data.connectionId||'—';$('revision').textContent=String(data.revision);$('lastPublish').textContent=fmt(data.lastPublishAt);$('lastHeartbeat').textContent=fmt(data.lastHeartbeatAt);$('state').textContent=JSON.stringify(data.state||{},null,2);$('telemetry').textContent=JSON.stringify(data.telemetry||{},null,2);if(data.error)$('form-error').textContent=data.error}
$('connect-form').addEventListener('submit',async event=>{event.preventDefault();$('form-error').textContent='';const form=new FormData(event.currentTarget);const body=Object.fromEntries(form);body.credentialVersion=Number(body.credentialVersion);body.intervalMs=Number(body.intervalMs);try{await request('/api/connect',body);$('secret').value='';$('ca').value=''}catch(error){showError(error)}});for(const button of document.querySelectorAll('.action'))button.addEventListener('click',()=>request('/api/action',{action:button.dataset.action}).catch(showError));
const stream=new EventSource('/api/events');stream.onmessage=event=>{const message=JSON.parse(event.data);if(message.kind==='status')update(message.data);else{$('events').textContent=JSON.stringify(message.data,null,2)+'\\n'+$('events').textContent.slice(0,12000)}};stream.onerror=()=>{$('status').textContent='gateway event stream unavailable'};renderControls();fetch('/api/status').then(r=>r.json()).then(update);
</script></body></html>`;
}
