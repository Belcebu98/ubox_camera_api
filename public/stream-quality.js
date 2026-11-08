'use strict';
(()=>{
 const card=document.createElement('section');card.className='card';
 card.innerHTML='<h2>Calidad del stream</h2><div class="row"><label>Cámara <input id="qualityUid" placeholder="UID"></label><button id="qualityRefresh">Consultar</button></div><p><select id="qualitySelect" aria-label="Calidad"></select></p><div class="row"><button id="qualitySave">Guardar</button><button id="qualityApply">Guardar y aplicar</button><button id="qualityProbe">Medir índices 0–3</button></div><p class="hint">Aplicar reinicia el stream. Medir pausa la grabación y después intenta reanudarla. No ejecutes otra sonda desde la consola simultáneamente.</p><p id="qualityState" role="status"></p>';
 document.querySelector('main').append(card);const el=id=>card.querySelector('#quality'+id);let cameraUid='',busy=false;
 async function request(url,data){const response=await fetch(url,{cache:'no-store',...(data?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}:{})});const value=await response.json();if(!response.ok)throw new Error(value.error||'HTTP '+response.status);return value;}
 async function load(){
  cameraUid=el('Uid').value.trim();const s=await request('/api/cameras/streams'+(cameraUid?'?uid='+encodeURIComponent(cameraUid):''));cameraUid=s.uid;el('Uid').value=cameraUid;
  const select=el('Select');select.replaceChildren(new Option('Automático — '+(s.recommendedStreamIndex===null?'sin mediciones válidas':'recomendado: '+s.recommendedStreamIndex),'auto'));
  for(let i=0;i<4;i++){const r=s.streams[i],valid=r?.status==='ok';const option=new Option(valid?`${i} — ${r.width}×${r.height} · ${r.fps.toFixed(2)} fps · ${r.bitrateKbps??'?'} kbps${i===s.recommendedStreamIndex?' · recomendado':''}`:`${i} — ${r?'sin vídeo válido en última prueba':'sin medir'}`,String(i));option.disabled=!valid;select.add(option);}
  select.value=s.selectionMode==='manual'?String(s.manualStreamIndex):'auto';el('State').textContent=`Activo: ${s.activeStreamIndex??'ninguno'} · Modo: ${s.selectionMode} · Recomendado: ${s.recommendedStreamIndex??'pendiente'}`;
 }
 async function action(fn){if(busy)return;busy=true;for(const b of card.querySelectorAll('button'))b.disabled=true;try{await fn();}catch(e){el('State').textContent=e.message;}finally{busy=false;for(const b of card.querySelectorAll('button'))b.disabled=false;}}
 function checkedUid(){if(!cameraUid||cameraUid!==el('Uid').value.trim())throw new Error('Consulta primero la cámara');return cameraUid;}
 async function save(apply){const uid=checkedUid();if(apply&&!confirm('Cerrar el tramo y reiniciar el stream?'))return;const v=el('Select').value;await request('/api/cameras/preferred-stream',{uid,selectionMode:v==='auto'?'auto':'manual',...(v==='auto'?{}:{streamIndex:Number(v)}),apply});await load();}
 el('Refresh').onclick=()=>action(load);el('Save').onclick=()=>action(()=>save(false));el('Apply').onclick=()=>action(()=>save(true));
 el('Probe').onclick=()=>action(async()=>{const uid=checkedUid();if(!confirm('Pausar grabación y medir los cuatro índices? La prueba puede durar varios minutos.'))return;el('State').textContent='Midiendo índices 0–3…';await request('/api/cameras/quality-probe',{uid,seconds:30});await load();});
 void action(load);
})();
