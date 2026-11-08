'use strict';
(()=>{
  const box=document.createElement('section');box.className='card';
  const title=document.createElement('h2');title.textContent='Batería de las cámaras';
  const summary=document.createElement('p');summary.className='hint';
  const list=document.createElement('div');box.append(title,summary,list);
  const main=document.querySelector('main');main.insertBefore(box,main.children[2]||null);
  let busy=false;
  async function update(){
    if(busy)return;busy=true;
    try{
      const response=await fetch('/api/nvr/cameras',{signal:AbortSignal.timeout(10000)});
      if(!response.ok)throw new Error('No se pudo leer la batería');
      const data=await response.json();list.replaceChildren();
      summary.textContent=(data.stale?'Datos desactualizados o pendientes. ':'')+(data.error?data.error+'. ':'')+'Lectura de la nube, no medición directa. Varias cámaras en telemetría; una sola grabación activa.';
      for(const camera of data.cameras){
        const row=document.createElement('div');row.style.cssText='padding:12px 0;border-bottom:1px solid #475d7c';
        const name=document.createElement('strong');name.textContent=camera.name+' · '+camera.uid+(camera.uid===data.activeCameraUid?' · CÁMARA DEL GRABADOR':'');
        const state=document.createElement('p');state.textContent='Batería: '+(camera.batteryPercent===null?'sin dato':camera.batteryPercent+' %')+' · '+(camera.charging===null?'Carga: sin dato':camera.charging?'Cargando':'No figura cargando')+(camera.lowBattery?' · AVISO: batería baja':'');
        if(camera.lowBattery)state.style.color='#ffce86';
        const time=document.createElement('p');time.className='hint';time.textContent='Consultado: '+(camera.fetchedAt?new Date(camera.fetchedAt).toLocaleString():'pendiente')+'. Hora de medición de batería: no proporcionada.';
        row.append(name,state,time);list.append(row);
      }
      if(!data.cameras.length)list.textContent='Esperando login y lista de cámaras.';
    }catch(error){summary.textContent=error.message+'. El último panel no debe considerarse actualizado.';}finally{busy=false;}
  }
  const timer=setInterval(update,15000);window.addEventListener('pagehide',()=>clearInterval(timer));void update();
})();
