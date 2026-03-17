/**
 * RouteManager — addin.js  v4.0
 * Map Add-in para MyGeotab
 *
 * Características:
 *  - Posición en tiempo real via service.events.attach('change')
 *  - Rutas trazadas por calles (OSRM, sin API key)
 *  - Recorrido real acumulado en canvas
 *  - Zonas de Geotab visualizadas en el mapa
 *  - Detección de desvíos con alerta visual
 *  - Paradas con llegada automática por geofence
 *
 * Prefijo "rm" en todas las variables globales
 * para evitar conflictos con otros add-ins.
 */

/* ─────────────────────────────────────────
   ESTADO GLOBAL
───────────────────────────────────────── */
const rmS = {
  svc: null,
  elt: null,                  // referencia al contenedor del panel
  routes: [],
  alerts: [],
  zones: [],
  zoneCanvasObjs: {},
  visibleZones: new Set(),
  waypoints: [],
  threshold: 200,
  activeRouteId: null,
  co: {
    planned: null,
    real:    null,
    stops:   [],
    vehicle: null,
    deviations: [],
  },
  realPath: [],
  osrmPath: null,
  deviating: false,
  devStart: null,
  eventHandler: null,
};

// Helper: busca un elemento por ID dentro del panel (elt),
// con fallback a document para compatibilidad
function rmEl(id){
  if(rmS.elt) return rmS.elt.querySelector('#'+id);
  return rmEl(id);
}

/* ─────────────────────────────────────────
   PERSISTENCIA
───────────────────────────────────────── */
const rmLoad = () => {
  rmS.routes = JSON.parse(localStorage.getItem('rm4_routes') || '[]');
  rmS.alerts = JSON.parse(localStorage.getItem('rm4_alerts') || '[]');
};
const rmSave = () => {
  localStorage.setItem('rm4_routes', JSON.stringify(rmS.routes));
  localStorage.setItem('rm4_alerts', JSON.stringify(rmS.alerts));
};

/* ─────────────────────────────────────────
   GEO UTILS
───────────────────────────────────────── */
function rmHav(la1,lo1,la2,lo2){
  const R=6371000,dL=(la2-la1)*Math.PI/180,dO=(lo2-lo1)*Math.PI/180;
  const a=Math.sin(dL/2)**2+Math.cos(la1*Math.PI/180)*Math.cos(la2*Math.PI/180)*Math.sin(dO/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}
function rmSegD(pla,plo,ala,alo,bla,blo){
  const ab2=(blo-alo)**2+(bla-ala)**2;
  if(!ab2)return rmHav(pla,plo,ala,alo);
  let t=((plo-alo)*(blo-alo)+(pla-ala)*(bla-ala))/ab2;
  t=Math.max(0,Math.min(1,t));
  return rmHav(pla,plo,ala+t*(bla-ala),alo+t*(blo-alo));
}
function rmPolyD(pla,plo,poly){
  let min=Infinity;
  for(let i=0;i<poly.length-1;i++){
    const d=rmSegD(pla,plo,poly[i][0],poly[i][1],poly[i+1][0],poly[i+1][1]);
    if(d<min)min=d;
  }
  return min;
}
const rmPct  = wps => wps.length ? Math.round(wps.filter(w=>w.done).length/wps.length*100) : 0;
const rmFmtD = m => m<1000 ? `${Math.round(m)}m` : `${(m/1000).toFixed(1)}km`;
const rmFmtT = s => { const h=Math.floor(s/3600),m=Math.floor((s%3600)/60); return h?`${h}h ${m}min`:`${m}min`; };

/* ─────────────────────────────────────────
   TOAST
───────────────────────────────────────── */
let rmTT;
function rmToast(msg,type='i'){
  const el=rmEl('rm-toast');
  if(!el)return;
  el.textContent=msg; el.className=`show ${type}`;
  clearTimeout(rmTT); rmTT=setTimeout(()=>el.classList.remove('show'),4000);
}

/* ─────────────────────────────────────────
   TABS
───────────────────────────────────────── */
function rmInitTabs(elt){
  const root = elt || document;
  root.querySelector('.rm-tabs').addEventListener('click', e=>{
    const btn=e.target.closest('.tab-btn');
    if(!btn)return;
    root.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('on'));
    root.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('on'));
    btn.classList.add('on');
    const t=btn.dataset.tab;
    root.getElementById
      ? root.getElementById('tab-'+t)?.classList.add('on')
      : root.querySelector('#tab-'+t)?.classList.add('on');
    if(t==='monitor') rmRenderMonitor();
    if(t==='alerts')  rmRenderAlerts();
    if(t==='reports') rmRenderReports();
    if(t==='zones')   rmRenderZonesList();
  });
}

/* ─────────────────────────────────────────
   CHIPS
───────────────────────────────────────── */
function rmInitChips(elt){
  const root = elt || document;
  const chipsEl = root.querySelector ? root.querySelector('#rm-chips') : root.getElementById('rm-chips');
  if(!chipsEl)return;
  chipsEl.addEventListener('click',e=>{
    const c=e.target.closest('.chip');
    if(!c)return;
    chipsEl.querySelectorAll('.chip').forEach(x=>x.classList.remove('on'));
    c.classList.add('on');
    rmS.threshold=parseInt(c.dataset.val);
  });
}

/* ─────────────────────────────────────────
   CANVAS HELPERS
   Usa service.canvas de Geotab Map Add-in API
───────────────────────────────────────── */
function rmClearCo(){
  const c=rmS.co;
  const rm=obj=>{ try{ if(obj)obj.remove(); }catch(_){} };
  rm(c.planned); rm(c.real); rm(c.vehicle);
  c.stops.forEach(rm); c.deviations.forEach(rm);
  c.planned=null; c.real=null; c.vehicle=null;
  c.stops=[]; c.deviations=[];
  rmS.realPath=[];
}

/**
 * Dibuja la ruta planificada (OSRM path) en el mapa de Geotab
 * usando canvas.path()
 */
function rmDrawPlanned(path, deviating=false){
  const canvas=rmS.svc.canvas;
  rmClearCo();

  // Polyline planificada: azul normal, rojo si está desviado
  const segs=path.map((p,i)=>({
    point:{lat:p[0],lng:p[1]},
    ...(i===0 && {moveTo:true})
  }));
  const pl=canvas.path(segs,2);
  pl.setAttribute({strokeStyle: deviating?'#FF3D3D':'#0075C9', lineWidth:5, opacity:.85});
  rmS.co.planned=pl;

  // Polyline recorrido real (vacía inicialmente)
  const rl=canvas.path([{point:{lat:path[0][0],lng:path[0][1]},moveTo:true}],3);
  rl.setAttribute({strokeStyle:'#00D68F', lineWidth:4, opacity:.95});
  rmS.co.real=rl;
}

/**
 * Actualiza el recorrido real acumulando la nueva posición
 */
function rmUpdateRealPath(lat,lng){
  rmS.realPath.push({lat,lng});
  const rl=rmS.co.real;
  if(!rl||rmS.realPath.length<2)return;
  try{
    const segs=rmS.realPath.map((p,i)=>({
      point:{lat:p.lat,lng:p.lng},
      ...(i===0 && {moveTo:true})
    }));
    rl.setAttribute({path:segs});
  }catch(_){}
}

/**
 * Mueve el marcador del vehículo. Si no existe, lo crea.
 */
function rmMoveVehicle(lat,lng,deviating=false){
  const canvas=rmS.svc.canvas;
  const color=deviating?'#FF3D3D':'#FF6B2B';
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="34" height="34" viewBox="0 0 34 34">
    <circle cx="17" cy="17" r="15" fill="${color}" stroke="white" stroke-width="3"/>
    <text x="17" y="22" text-anchor="middle" font-size="15">🚛</text>
  </svg>`;
  const iconUrl='data:image/svg+xml;base64,'+btoa(svg);

  if(!rmS.co.vehicle){
    rmS.co.vehicle=canvas.marker({lat,lng},{url:iconUrl,width:34,height:34},10);
  } else {
    try{
      rmS.co.vehicle.setCoords({lat,lng});
      rmS.co.vehicle.setAttribute({url:iconUrl});
    }catch(_){
      try{ rmS.co.vehicle.setAttribute({lat,lng,url:iconUrl}); }catch(__){ }
    }
  }
}

/**
 * Agrega marcadores de paradas en el mapa
 */
function rmDrawStops(waypoints){
  const canvas=rmS.svc.canvas;
  rmS.co.stops.forEach(m=>{ try{m.remove();}catch(_){} });
  rmS.co.stops=[];
  waypoints.forEach((wp,i)=>{
    const isFirst=i===0, isLast=i===waypoints.length-1;
    const color=wp.done?'#00D68F':isFirst?'#FF6B2B':'#0075C9';
    const label=wp.done?'✓':isFirst?'D':isLast?'F':String(i+1);
    const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="28" height="36" viewBox="0 0 28 36">
      <path d="M14 0C6.27 0 0 6.27 0 14c0 10.5 14 22 14 22S28 24.5 28 14C28 6.27 21.73 0 14 0z" fill="${color}"/>
      <circle cx="14" cy="14" r="9" fill="white" fill-opacity=".9"/>
      <text x="14" y="18" text-anchor="middle" font-family="sans-serif" font-size="${label.length>1?8:10}" font-weight="700" fill="${color}">${label}</text>
    </svg>`;
    const m=canvas.marker(
      {lat:wp.lat,lng:wp.lon},
      {url:'data:image/svg+xml;base64,'+btoa(svg),width:28,height:36},
      5+i
    );
    rmS.co.stops.push(m);
  });
}

/**
 * Agrega un marcador de desvío en el mapa
 */
function rmAddDeviationMarker(lat,lng){
  const canvas=rmS.svc.canvas;
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">
    <circle cx="11" cy="11" r="10" fill="#FF3D3D" stroke="white" stroke-width="2"/>
    <text x="11" y="15" text-anchor="middle" font-size="12" fill="white" font-weight="700">!</text>
  </svg>`;
  const m=canvas.marker(
    {lat,lng},
    {url:'data:image/svg+xml;base64,'+btoa(svg),width:22,height:22},
    8
  );
  rmS.co.deviations.push(m);
}

/* ─────────────────────────────────────────
   ZONAS DE GEOTAB
   Carga Zones con sus polígonos y los dibuja
   en el mapa usando canvas.path()
───────────────────────────────────────── */
async function rmLoadZones(){
  try{
    const zones=await rmS.svc.api.call('Get',{
      typeName:'Zone',
      resultsLimit:500
    });
    rmS.zones=zones||[];
    rmRenderZonesList();
    // Mostrar todas las zonas por defecto
    rmS.zones.forEach(z=>rmShowZone(z,true));
    rmToast(`✓ ${rmS.zones.length} zonas cargadas`,'s');
  }catch(e){
    console.warn('[RM] Error cargando zonas:',e);
    rmToast('Error al cargar zonas','e');
  }
}

/**
 * Muestra u oculta una zona en el mapa
 * Una zona puede tener múltiples polígonos (points array)
 */
function rmShowZone(zone, visible){
  const canvas=rmS.svc.canvas;
  const zid=zone.id;

  // Ocultar si existe
  if(rmS.zoneCanvasObjs[zid]){
    rmS.zoneCanvasObjs[zid].forEach(obj=>{
      try{ obj.remove(); }catch(_){}
    });
    delete rmS.zoneCanvasObjs[zid];
  }
  rmS.visibleZones.delete(zid);

  if(!visible)return;

  // Dibujar el polígono de la zona
  const pts=zone.points||[];
  if(pts.length<3)return;

  // Geotab points: [ {x: lon, y: lat} ]
  const segs=pts.map((p,i)=>({
    point:{lat:p.y,lng:p.x},
    ...(i===0 && {moveTo:true})
  }));
  // Cerrar el polígono
  segs.push({point:{lat:pts[0].y,lng:pts[0].x}});

  // Color de la zona: usar el color de Geotab si está disponible
  const hexColor=zone.zoneTypes?.[0]?.color||'#0075C9';
  const strokeColor=hexColor;
  const fillColor=hexColor+'33'; // 20% opacidad

  const obj=canvas.path(segs,1);
  try{
    obj.setAttribute({
      strokeStyle:strokeColor,
      lineWidth:2,
      opacity:0.8,
      fillStyle:fillColor,
    });
  }catch(_){
    // Algunos builds de Geotab no soportan fillStyle
    obj.setAttribute({strokeStyle:strokeColor,lineWidth:2,opacity:0.8});
  }

  rmS.zoneCanvasObjs[zid]=[obj];
  rmS.visibleZones.add(zid);
}

function rmRenderZonesList(){
  const list=rmEl('rm-zones-list');
  const countEl=rmEl('rm-zones-count');
  const filter=(rmEl('rm-zone-filter')?.value||'').toLowerCase();
  const zones=rmS.zones.filter(z=>(z.name||'').toLowerCase().includes(filter));

  countEl.textContent=`${zones.length} zona${zones.length!==1?'s':''}`;

  if(!zones.length){
    list.innerHTML='<div class="empty"><span>📐</span>Sin zonas.</div>';
    return;
  }

  list.innerHTML=zones.map(z=>{
    const color=z.zoneTypes?.[0]?.color||'#0075C9';
    const isOn=rmS.visibleZones.has(z.id);
    return `<div class="zone-item ${isOn?'on':''}" onclick="rmToggleZone('${z.id}')">
      <div class="zone-color" style="background:${color};border:1px solid rgba(255,255,255,.2)"></div>
      <div style="flex:1;min-width:0">
        <span class="zone-name">${z.name||z.id}</span>
        <span class="zone-type">${z.zoneTypes?.map(t=>t.name||'').join(', ')||'Sin tipo'}</span>
      </div>
      <span style="font-size:10px;color:${isOn?'var(--green)':'var(--t3)'}">${isOn?'●':'○'}</span>
    </div>`;
  }).join('');
}

window.rmToggleZone=function(zoneId){
  const zone=rmS.zones.find(z=>z.id===zoneId);
  if(!zone)return;
  const isOn=rmS.visibleZones.has(zoneId);
  rmShowZone(zone,!isOn);
  rmRenderZonesList();
};

/* ─────────────────────────────────────────
   OSRM — Ruteo por calles
───────────────────────────────────────── */
async function rmCalcOSRM(waypoints){
  if(waypoints.length<2)return null;
  const coords=waypoints.map(w=>`${w.lon},${w.lat}`).join(';');
  const url=`https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`;
  try{
    const r=await fetch(url);
    const d=await r.json();
    if(d.code!=='Ok')return null;
    const rt=d.routes[0];
    return{
      path:rt.geometry.coordinates.map(c=>[c[1],c[0]]),
      dist:rt.distance,
      dur:rt.duration
    };
  }catch(e){
    console.warn('[RM] OSRM error:',e);
    return null;
  }
}

/* ─────────────────────────────────────────
   WAYPOINTS DEL FORMULARIO
───────────────────────────────────────── */
function rmRenderWpList(){
  const list=rmEl('rm-wp-list');
  const wps=rmS.waypoints;

  if(!wps.length){
    list.innerHTML='<div class="wp-empty">Clic en el mapa para agregar paradas, o usá "+ Manual"</div>';
    rmEl('rm-summary').style.display='none';
    rmDrawFormMarkers();
    return;
  }

  list.innerHTML=wps.map((wp,i)=>`
    <div class="wp-item">
      <div class="wp-n">${i+1}</div>
      <div class="wp-i">
        <span class="wp-name">${wp.name}</span>
        <span class="wp-coord">${wp.lat.toFixed(5)}, ${wp.lon.toFixed(5)} · ${wp.dwell}min</span>
      </div>
      <div class="wp-act">
        ${i>0?`<button class="ib" onclick="rmMoveWp(${i},-1)">↑</button>`:''}
        ${i<wps.length-1?`<button class="ib" onclick="rmMoveWp(${i},1)">↓</button>`:''}
        <button class="ib del" onclick="rmDelWp(${i})">✕</button>
      </div>
    </div>`).join('');

  const totalDist=wps.slice(0,-1).reduce((s,w,i)=>s+rmHav(w.lat,w.lon,wps[i+1].lat,wps[i+1].lon),0);
  rmEl('rm-s-stops').textContent=wps.length;
  rmEl('rm-s-dist').textContent=rmFmtD(totalDist)+' aprox.';
  rmEl('rm-s-dur').textContent='—';
  rmEl('rm-summary').style.display='flex';

  rmDrawFormMarkers();
}

function rmDrawFormMarkers(){
  // Limpiar marcadores de paradas del form
  rmS.co.stops.forEach(m=>{ try{m.remove();}catch(_){} });
  rmS.co.stops=[];
  const canvas=rmS.svc?.canvas;
  if(!canvas||!rmS.waypoints.length)return;

  rmS.waypoints.forEach((wp,i)=>{
    const isFirst=i===0,isLast=i===rmS.waypoints.length-1;
    const color=isFirst?'#FF6B2B':'#0075C9';
    const label=isFirst?'D':isLast?'F':String(i+1);
    const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="28" height="36" viewBox="0 0 28 36">
      <path d="M14 0C6.27 0 0 6.27 0 14c0 10.5 14 22 14 22S28 24.5 28 14C28 6.27 21.73 0 14 0z" fill="${color}"/>
      <circle cx="14" cy="14" r="9" fill="white" fill-opacity=".9"/>
      <text x="14" y="18" text-anchor="middle" font-family="sans-serif" font-size="${label.length>1?8:10}" font-weight="700" fill="${color}">${label}</text>
    </svg>`;
    const m=canvas.marker({lat:wp.lat,lng:wp.lon},{url:'data:image/svg+xml;base64,'+btoa(svg),width:28,height:36},5+i);
    rmS.co.stops.push(m);
  });

  // Polyline entre paradas (preview)
  if(rmS.waypoints.length>=2){
    if(rmS.co.planned){ try{rmS.co.planned.remove();}catch(_){} rmS.co.planned=null; }
    const segs=rmS.waypoints.map((w,i)=>({point:{lat:w.lat,lng:w.lon},...(i===0&&{moveTo:true})}));
    const pl=canvas.path(segs,1);
    pl.setAttribute({strokeStyle:'#0075C9',lineWidth:3,opacity:.5});
    rmS.co.planned=pl;
  }

  // Centrar mapa
  const lats=rmS.waypoints.map(w=>w.lat), lons=rmS.waypoints.map(w=>w.lon);
  rmS.svc.map.setBounds({
    sw:{lat:Math.min(...lats)-.005,lng:Math.min(...lons)-.005},
    ne:{lat:Math.max(...lats)+.005,lng:Math.max(...lons)+.005}
  });
}

window.rmMoveWp=(i,d)=>{ [rmS.waypoints[i],rmS.waypoints[i+d]]=[rmS.waypoints[i+d],rmS.waypoints[i]]; rmRenderWpList(); };
window.rmDelWp =(i)=>  { rmS.waypoints.splice(i,1); rmRenderWpList(); };

/* ─────────────────────────────────────────
   CAPTURAR CLIC EN EL MAPA → AGREGAR PARADA
───────────────────────────────────────── */
function rmSetupMapClick(){
  rmS.svc.events.attach('click',data=>{
    // Solo en tab Asignar, solo en el mapa (no en vehículo ni zona)
    if(!rmEl('tab-assign')?.classList.contains('on'))return;
    const loc=data.location||data;
    if(!loc||loc.lat===undefined)return;
    // Ignorar clics en entidades (vehículo, zona)
    if(data.type&&data.type!=='map')return;
    const name=`Parada ${rmS.waypoints.length+1}`;
    rmS.waypoints.push({name,lat:loc.lat,lon:loc.lng||loc.lon,dwell:10});
    rmRenderWpList();
    rmToast(`📍 ${name} agregada`,'s');
  });
}

/* ─────────────────────────────────────────
   GUARDAR RUTA
───────────────────────────────────────── */
async function rmSaveRoute(){
  const name=rmEl('rm-rname').value.trim();
  const deviceId=rmEl('rm-device').value;
  const deviceName=rmEl('rm-device').options[rmEl('rm-device').selectedIndex]?.text||'';
  const driverId=rmEl('rm-driver').value;

  if(!name)         return rmToast('El nombre es obligatorio','e');
  if(!deviceId)     return rmToast('Seleccioná un vehículo','e');
  if(rmS.waypoints.length<2)return rmToast('Necesitás al menos 2 paradas','e');

  const btn=rmEl('rm-btn-save');
  btn.disabled=true; btn.textContent='Guardando...';

  let osrmPath=rmS.osrmPath;
  if(!osrmPath){
    const r=await rmCalcOSRM(rmS.waypoints);
    osrmPath=r?r.path:rmS.waypoints.map(w=>[w.lat,w.lon]);
    if(r){
      rmEl('rm-s-dist').textContent=rmFmtD(r.dist);
      rmEl('rm-s-dur').textContent=rmFmtT(r.dur);
    }
  }

  const route={
    id:'rm4_'+Date.now(), name, deviceId, deviceName, driverId,
    threshold:rmS.threshold,
    waypoints:rmS.waypoints.map(w=>({...w,done:false})),
    osrmPath,
    status:'active', createdAt:new Date().toISOString(), deviations:[],
  };
  rmS.routes.push(route); rmSave();
  rmToast(`✓ Ruta "${name}" activada`,'s');

  // Limpiar form
  rmS.waypoints=[]; rmS.osrmPath=null;
  rmEl('rm-rname').value='';
  rmRenderWpList();
  btn.disabled=false; btn.textContent='Activar Ruta';

  // Ir al monitor
  setTimeout(()=>{
    document.querySelector('[data-tab="monitor"]').click();
  },600);
}

/* ─────────────────────────────────────────
   MONITOREO — TIEMPO REAL
   Usa service.events.attach('change') que recibe
   IDeviceChangeEvent cada vez que el vehículo
   se mueve en el mapa de Geotab (tiempo real nativo)
───────────────────────────────────────── */
function rmStartTracking(route){
  rmStopTracking();
  rmS.activeRouteId=route.id;
  rmS.deviating=false; rmS.devStart=null; rmS.realPath=[];

  // Dibujar ruta en el mapa
  const path=route.osrmPath||route.waypoints.map(w=>[w.lat,w.lon]);
  rmDrawPlanned(path,false);
  rmDrawStops(route.waypoints);

  // Centrar mapa
  const lats=route.waypoints.map(w=>w.lat), lons=route.waypoints.map(w=>w.lon);
  rmS.svc.map.setBounds({
    sw:{lat:Math.min(...lats)-.005,lng:Math.min(...lons)-.005},
    ne:{lat:Math.max(...lats)+.005,lng:Math.max(...lons)+.005}
  });

  // ★ Tiempo real: events.attach('change') se dispara
  //   cada vez que el vehículo se mueve en el mapa
  rmS.eventHandler=(data)=>{
    if(data.type!=='device')return;
    if(data.entity?.id!==route.deviceId)return;
    if(!data.location)return;
    const {lat,lng,speed}=data.location;
    rmProcessPos(route,lat,lng,Math.round(speed||0));
  };
  rmS.svc.events.attach('change',rmS.eventHandler);

  // Posición inicial inmediata via API
  rmS.svc.api.call('Get',{
    typeName:'DeviceStatusInfo',
    search:{deviceSearch:{id:route.deviceId}}
  }).then(res=>{
    if(res?.length&&res[0].latitude){
      rmProcessPos(route,res[0].latitude,res[0].longitude,Math.round(res[0].speed||0));
    }
  }).catch(()=>{});

  rmSetHdr('green','En vivo — Tiempo real');
}

function rmStopTracking(){
  if(rmS.eventHandler&&rmS.svc){
    try{ rmS.svc.events.detach('change',rmS.eventHandler); }catch(_){}
    rmS.eventHandler=null;
  }
  rmClearCo();
  rmSetHdr('','En espera');
}

/* ─────────────────────────────────────────
   PROCESAR POSICIÓN
───────────────────────────────────────── */
function rmProcessPos(route,lat,lng,speed){
  const ARRIVAL=120;
  const THRESHOLD=route.threshold||200;

  // Mover vehículo en el mapa
  rmMoveVehicle(lat,lng,rmS.deviating);

  // Acumular recorrido real
  rmUpdateRealPath(lat,lng);

  // Verificar llegada a paradas
  route.waypoints.forEach((wp,i)=>{
    if(wp.done)return;
    if(rmHav(lat,lng,wp.lat,wp.lon)<=ARRIVAL){
      wp.done=true; wp.arrivedAt=new Date().toISOString();
      rmSave();
      rmToast(`✓ Parada completada: ${wp.name}`,'s');
      // Actualizar marcador
      rmDrawStops(route.waypoints);
    }
  });

  // Detección de desvío sobre polyline OSRM
  const poly=route.osrmPath||route.waypoints.map(w=>[w.lat,w.lon]);
  if(poly.length>=2){
    const dist=rmPolyD(lat,lng,poly);
    if(dist>THRESHOLD){
      if(!rmS.deviating){
        rmS.deviating=true; rmS.devStart=Date.now();
      } else if((Date.now()-rmS.devStart)>15000){
        const alreadyActive=route.deviations.find(d=>d.status==='active');
        if(!alreadyActive){
          const dev={id:'dev_'+Date.now(),dist:Math.round(dist),lat,lng,startTime:new Date().toISOString(),status:'active'};
          route.deviations.push(dev);
          rmS.alerts.unshift({...dev,routeName:route.name,type:'deviation',timestamp:new Date().toISOString()});
          rmSave(); rmUpdateAlertBadge();
          rmToast(`⚠️ DESVÍO — ${rmFmtD(dist)} fuera de ruta`,'w');
          // Poner polyline en rojo
          try{ rmS.co.planned?.setAttribute({strokeStyle:'#FF3D3D'}); }catch(_){}
          rmAddDeviationMarker(lat,lng);
          const bar=rmEl('rm-dev-bar');
          if(bar){ bar.classList.add('on'); rmEl('rm-dev-txt').textContent=`DESVIADO — ${rmFmtD(dist)} fuera de ruta`; }
          rmMoveVehicle(lat,lng,true);
        }
      }
    } else if(rmS.deviating){
      rmS.deviating=false; rmS.devStart=null;
      const active=route.deviations.find(d=>d.status==='active');
      if(active){ active.status='resolved'; active.resolvedAt=new Date().toISOString(); }
      const alertA=rmS.alerts.find(a=>a.id===active?.id);
      if(alertA){ alertA.status='resolved'; alertA.resolvedAt=new Date().toISOString(); }
      rmSave();
      try{ rmS.co.planned?.setAttribute({strokeStyle:'#0075C9'}); }catch(_){}
      const bar=rmEl('rm-dev-bar');
      if(bar) bar.classList.remove('on');
      rmMoveVehicle(lat,lng,false);
      rmToast('✓ Vehículo retomó la ruta','s');
    }
  }

  rmUpdateDetail(route,{lat,lng,speed});
}

/* ─────────────────────────────────────────
   PANEL DE DETALLE
───────────────────────────────────────── */
function rmUpdateDetail(route,pos){
  const comp=route.waypoints.filter(w=>w.done).length;
  const p=rmPct(route.waypoints);
  const next=route.waypoints.find(w=>!w.done);
  const dot=rmEl('rm-track-dot');
  const lbl=rmEl('rm-track-lbl');
  const val=rmEl('rm-track-val');
  if(dot){
    if(rmS.deviating){ dot.className='dot red'; lbl.textContent='DESVIADO'; val.textContent='Fuera de ruta'; }
    else if(pos){ dot.className='dot green'; lbl.textContent='En ruta'; val.textContent=new Date().toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit'}); }
    else{ dot.className='dot yellow'; lbl.textContent='Esperando...'; val.textContent='—'; }
  }
  const pb=rmEl('rm-pb'); if(pb)pb.style.width=p+'%';
  const pctEl=rmEl('rm-pct'); if(pctEl)pctEl.textContent=p+'%';
  const stopsEl=rmEl('rm-stops'); if(stopsEl)stopsEl.textContent=`${comp}/${route.waypoints.length}`;
  const devsEl=rmEl('rm-devs'); if(devsEl)devsEl.textContent=route.deviations.length;
  const nextEl=rmEl('rm-next'); if(nextEl)nextEl.textContent=next?next.name.substring(0,20):'¡Completada!';
  const spEl=rmEl('rm-speed'); if(spEl&&pos)spEl.textContent=(pos.speed||0)+' km/h';

  const tl=rmEl('rm-timeline');
  if(tl)tl.innerHTML=route.waypoints.map(wp=>`
    <div class="tl-s ${wp.done?'done':'pend'}">
      <div class="tl-d"></div>
      <div><span class="tl-name">${wp.name}</span>
      <span class="tl-time">${wp.arrivedAt?'✓ '+new Date(wp.arrivedAt).toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit'}):'Pendiente · '+wp.dwell+'min'}</span></div>
    </div>`).join('');
}

/* ─────────────────────────────────────────
   RENDER MONITOR
───────────────────────────────────────── */
function rmRenderMonitor(){
  const active=rmS.routes.filter(r=>r.status==='active');
  const el=rmEl('rm-active-routes');
  if(!active.length){
    el.innerHTML='<div class="empty"><span>📡</span>Sin rutas activas.</div>';
    return;
  }
  el.innerHTML=active.map(r=>{
    const p=rmPct(r.waypoints),c=r.waypoints.filter(w=>w.done).length;
    return `<div class="route-card ${rmS.activeRouteId===r.id?'sel':''}" onclick="rmSelectRoute('${r.id}')">
      <div class="rc-h"><span class="rc-name">${r.name}</span><span class="badge b-green">ACTIVA</span></div>
      <div class="rc-meta">🚛 ${r.deviceName} · 📍 ${c}/${r.waypoints.length} paradas</div>
      <div class="rc-prog"><div class="rc-fill" style="width:${p}%"></div></div>
    </div>`;
  }).join('');
}

window.rmSelectRoute=function(routeId){
  const route=rmS.routes.find(r=>r.id===routeId);
  if(!route)return;
  rmStartTracking(route);
  rmEl('rm-detail').style.display='flex';
  rmEl('rm-detail-name').textContent=route.name;
  rmUpdateDetail(route,null);
  rmRenderMonitor();
};

/* ─────────────────────────────────────────
   ALERTS & REPORTS
───────────────────────────────────────── */
function rmUpdateAlertBadge(){
  const n=rmS.alerts.filter(a=>a.status==='active').length;
  const dot=rmEl('rm-alerts-dot');
  if(dot)dot.classList.toggle('vis',n>0);
}

function rmRenderAlerts(){
  const el=rmEl('rm-alert-list');
  if(!rmS.alerts.length){ el.innerHTML='<div class="empty"><span>🔔</span>Sin alertas.</div>'; return; }
  el.innerHTML=rmS.alerts.map(a=>`
    <div class="al-item ${a.status==='active'?'act':'res'}">
      <div class="al-icon">${a.status==='active'?'🔴':'✅'}</div>
      <div class="al-body">
        <div class="al-title">${a.status==='active'?'DESVÍO ACTIVO':'Desvío resuelto'} — ${a.routeName}</div>
        <div class="al-meta"><span>📍 ${a.dist}m fuera de ruta</span><span>${new Date(a.startTime).toLocaleString('es-AR')}</span></div>
        <div class="al-coord">GPS: ${a.lat?.toFixed(6)}, ${a.lng?.toFixed(6)||a.lon?.toFixed(6)}</div>
      </div>
      <button class="ib del" onclick="rmDismissAlert('${a.id}')">✕</button>
    </div>`).join('');
}

window.rmDismissAlert=id=>{ rmS.alerts=rmS.alerts.filter(a=>a.id!==id); rmSave(); rmUpdateAlertBadge(); rmRenderAlerts(); };

function rmRenderReports(){
  const el=rmEl('rm-reports-wrap');
  if(!rmS.routes.length){ el.innerHTML='<div class="empty"><span>📋</span>Sin rutas.</div>'; return; }
  el.innerHTML=`<table class="rep-tbl"><thead><tr><th>Ruta</th><th>Estado</th><th>Paradas</th><th>Desvíos</th><th></th></tr></thead><tbody>
    ${rmS.routes.map(r=>{
      const c=r.waypoints.filter(w=>w.done).length,p=rmPct(r.waypoints);
      return `<tr>
        <td><b>${r.name}</b><br><span style="color:var(--t3);font-size:9px">${r.deviceName}</span></td>
        <td><span class="badge ${r.status==='active'?'b-green':'b-red'}">${r.status.toUpperCase()}</span></td>
        <td>${c}/${r.waypoints.length}<div class="tp"><div style="width:${p}%"></div></div></td>
        <td style="font-family:var(--mono)">${(r.deviations||[]).length}</td>
        <td><button class="ib del" onclick="rmDeleteRoute('${r.id}')">🗑️</button></td>
      </tr>`;
    }).join('')}</tbody></table>`;
}

window.rmDeleteRoute=id=>{
  if(!confirm('¿Eliminar esta ruta?'))return;
  rmS.routes=rmS.routes.filter(r=>r.id!==id); rmSave();
  if(rmS.activeRouteId===id){ rmStopTracking(); rmS.activeRouteId=null; }
  rmRenderReports(); rmToast('Ruta eliminada','i');
};

/* ─────────────────────────────────────────
   MODAL — PARADA MANUAL
───────────────────────────────────────── */
function rmOpenWpModal(){
  const body=rmEl('rm-modal-body');
  body.innerHTML=`
    <p class="modal-t">Agregar Parada Manual</p>
    <div class="fg" style="margin-bottom:10px">
      <label class="fl">Nombre</label>
      <input type="text" id="rm-wp-name" class="fi" placeholder="Ej: Cliente ABC">
    </div>
    <div class="f2" style="margin-bottom:10px">
      <div class="fg"><label class="fl">Latitud</label><input type="number" id="rm-wp-lat" class="fi" step=".00001" placeholder="-38.9516"></div>
      <div class="fg"><label class="fl">Longitud</label><input type="number" id="rm-wp-lon" class="fi" step=".00001" placeholder="-68.0591"></div>
    </div>
    <div class="fg" style="margin-bottom:10px">
      <label class="fl">Tiempo en parada</label>
      <select id="rm-wp-dwell" class="fs">
        <option value="5">5 min</option><option value="10" selected>10 min</option>
        <option value="15">15 min</option><option value="30">30 min</option>
      </select>
    </div>
    <div class="modal-act">
      <button class="btn btn-g btn-sm" onclick="rmCloseModal()">Cancelar</button>
      <button class="btn btn-p btn-sm" onclick="rmConfirmWp()">Confirmar</button>
    </div>`;
  rmEl('rm-modal').classList.add('open');
}

window.rmCloseModal=()=>rmEl('rm-modal').classList.remove('open');
window.rmConfirmWp=()=>{
  const name=rmEl('rm-wp-name').value.trim();
  const lat=parseFloat(rmEl('rm-wp-lat').value);
  const lon=parseFloat(rmEl('rm-wp-lon').value);
  const dwell=parseInt(rmEl('rm-wp-dwell').value);
  if(!name||isNaN(lat)||isNaN(lon))return rmToast('Completá todos los campos','e');
  rmS.waypoints.push({name,lat,lon,dwell});
  rmCloseModal(); rmRenderWpList();
  rmToast(`Parada "${name}" agregada`,'s');
};

/* ─────────────────────────────────────────
   HEADER STATUS
───────────────────────────────────────── */
function rmSetHdr(type,txt){
  const dot=rmEl('rm-dot');
  const t=rmEl('rm-status-txt');
  if(dot)dot.className='dot'+(type?' '+type:'');
  if(t)t.textContent=txt;
}

/* ─────────────────────────────────────────
   PUNTO DE ENTRADA — Map Add-in
   Patrón correcto: solo "src" en config.json
   El HTML se inyecta con elt.innerHTML
   El CSS se inyecta con un <link> tag
───────────────────────────────────────── */
geotab.addin.routemanager2 = (elt, service) => {

  // 1. Inyectar CSS del panel
  if (!document.querySelector('link[href*="addin.css"]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://mtoros14.github.io/routemanager/addin.css';
    document.head.appendChild(link);
  }

  // 2. Inyectar HTML del panel en elt (el contenedor que Geotab nos da)
  elt.innerHTML = `
<div id="rm-panel">
  <header class="rm-hdr">
    <div class="rm-logo">
      <div class="rm-logo-icon">🗺️</div>
      <span class="rm-logo-name">RouteManager</span>
      <span class="rm-logo-ver">v4.0</span>
    </div>
    <div class="rm-hdr-status">
      <div class="dot" id="rm-dot"></div>
      <span id="rm-status-txt">Iniciando...</span>
    </div>
  </header>
  <nav class="rm-tabs">
    <button class="tab-btn on" data-tab="assign">✚ Asignar</button>
    <button class="tab-btn" data-tab="zones">📐 Zonas</button>
    <button class="tab-btn" data-tab="monitor">📡 Monitor</button>
    <button class="tab-btn" data-tab="alerts">🔔 Alertas <span class="tab-dot" id="rm-alerts-dot"></span></button>
    <button class="tab-btn" data-tab="reports">📋 Historial</button>
  </nav>
  <div class="tab-panel on" id="tab-assign">
    <p style="font-size:15px;font-weight:700;letter-spacing:-.3px">Nueva Ruta</p>
    <p style="font-size:11px;color:var(--t3);margin-top:-6px">Hacé clic en el mapa para agregar paradas.</p>
    <div class="fg"><label class="fl">Nombre</label><input type="text" id="rm-rname" class="fi" placeholder="Ej: Reparto zona norte"></div>
    <div class="f2">
      <div class="fg"><label class="fl">Vehículo</label><select id="rm-device" class="fs"><option value="">— Seleccionar —</option></select></div>
      <div class="fg"><label class="fl">Conductor</label><select id="rm-driver" class="fs"><option value="">— Seleccionar —</option></select></div>
    </div>
    <div class="fg"><label class="fl">Umbral de desvío</label>
      <div class="chips" id="rm-chips">
        <span class="chip" data-val="100">100 m</span>
        <span class="chip on" data-val="200">200 m</span>
        <span class="chip" data-val="300">300 m</span>
        <span class="chip" data-val="500">500 m</span>
      </div>
    </div>
    <div class="divider"></div>
    <div style="display:flex;justify-content:space-between;align-items:center">
      <span class="sec-title">Paradas</span>
      <button class="btn btn-g btn-sm" id="rm-btn-addwp">+ Manual</button>
    </div>
    <div id="rm-wp-list" class="wp-list"><div class="wp-empty">Clic en el mapa para agregar paradas, o usá "+ Manual"</div></div>
    <div id="rm-summary" class="sum" style="display:none">
      <div class="sum-i"><span class="sum-l">Paradas</span><span class="sum-v" id="rm-s-stops">—</span></div>
      <div class="sum-i"><span class="sum-l">Distancia</span><span class="sum-v" id="rm-s-dist">—</span></div>
      <div class="sum-i"><span class="sum-l">Duración est.</span><span class="sum-v" id="rm-s-dur">—</span></div>
    </div>
    <div class="frow">
      <button class="btn btn-g btn-sm" id="rm-btn-clear">Limpiar</button>
      <button class="btn btn-g btn-sm" id="rm-btn-calc">🗺️ Calcular ruta</button>
      <button class="btn btn-p" id="rm-btn-save">Activar Ruta</button>
    </div>
  </div>
  <div class="tab-panel" id="tab-zones">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <p style="font-size:15px;font-weight:700">Zonas Geotab</p>
      <button class="btn btn-g btn-sm" id="rm-btn-reload-zones">↺ Recargar</button>
    </div>
    <p style="font-size:11px;color:var(--t3);margin-top:-6px">Zonas definidas en tu base de datos.</p>
    <div class="fg"><label class="fl">Filtrar</label><input type="text" id="rm-zone-filter" class="fi" placeholder="Buscar zona..."></div>
    <div style="display:flex;justify-content:space-between;align-items:center">
      <span class="sec-title" id="rm-zones-count">— zonas</span>
      <div style="display:flex;gap:6px">
        <button class="btn btn-g btn-sm" id="rm-btn-zones-all">Mostrar todas</button>
        <button class="btn btn-g btn-sm" id="rm-btn-zones-none">Ocultar todas</button>
      </div>
    </div>
    <div id="rm-zones-list" class="zones-list"><div class="empty"><span>📐</span>Cargando zonas...</div></div>
  </div>
  <div class="tab-panel" id="tab-monitor">
    <p style="font-size:15px;font-weight:700">Monitoreo en Vivo</p>
    <span class="sec-title">Rutas activas</span>
    <div id="rm-active-routes"><div class="empty"><span>📡</span>Sin rutas activas.</div></div>
    <div id="rm-detail" style="display:none;flex-direction:column;gap:10px">
      <div class="divider"></div>
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span class="sec-title" id="rm-detail-name">—</span>
        <span id="rm-live-badge" style="font-size:9px;font-family:var(--mono);color:var(--green);background:rgba(0,214,143,.12);padding:2px 7px;border-radius:8px">● EN VIVO</span>
      </div>
      <div class="dev-bar" id="rm-dev-bar">⚠️ <span id="rm-dev-txt">DESVIADO</span></div>
      <div class="sc"><div class="dot" id="rm-track-dot"></div><div><span class="lbl" id="rm-track-lbl">Esperando...</span><span class="val" id="rm-track-val">—</span></div></div>
      <div class="pb-wrap">
        <div class="pb-h"><span>Completación</span><span id="rm-pct" style="font-family:var(--mono);font-weight:700">0%</span></div>
        <div class="pb"><div class="pb-fill" id="rm-pb" style="width:0%"></div></div>
      </div>
      <div class="sg">
        <div class="st"><span class="lbl">Velocidad</span><span class="val" id="rm-speed">—</span></div>
        <div class="st"><span class="lbl">Paradas</span><span class="val" id="rm-stops">0/0</span></div>
        <div class="st"><span class="lbl">Desvíos</span><span class="val" id="rm-devs">0</span></div>
        <div class="st"><span class="lbl">Próxima parada</span><span class="val" id="rm-next" style="font-size:10px;line-height:1.3">—</span></div>
      </div>
      <span class="sec-title">Estado de paradas</span>
      <div id="rm-timeline" class="tl"></div>
      <button class="btn btn-d btn-sm btn-full" id="rm-btn-stop">⏹ Detener seguimiento</button>
    </div>
  </div>
  <div class="tab-panel" id="tab-alerts">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <p style="font-size:15px;font-weight:700">Alertas</p>
      <button class="btn btn-g btn-sm" id="rm-btn-clear-alerts">Limpiar</button>
    </div>
    <div id="rm-alert-list" class="al-list"><div class="empty"><span>🔔</span>Sin alertas.</div></div>
  </div>
  <div class="tab-panel" id="tab-reports">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <p style="font-size:15px;font-weight:700">Historial</p>
      <button class="btn btn-g btn-sm" id="rm-btn-export">↓ CSV</button>
    </div>
    <div id="rm-reports-wrap"><div class="empty"><span>📋</span>Sin rutas registradas.</div></div>
  </div>
  <div class="rm-modal" id="rm-modal"><div class="modal-sh"><div id="rm-modal-body"></div></div></div>
  <div id="rm-toast"></div>
</div>`;

  // 3. Inicializar lógica (buscar elementos dentro de elt, no en document)
  rmS.svc = service;
  rmS.elt = elt;  // guardar referencia al contenedor
  rmLoad();
  rmInitTabs(elt);
  rmInitChips(elt);
  rmSetupMapClick();
  rmUpdateAlertBadge();

  // Cargar vehículos
  service.api.call('Get',{typeName:'Device',resultsLimit:500}).then(devices=>{
    const sel=rmEl('rm-device');
    (devices||[]).forEach(d=>{
      const o=document.createElement('option');
      o.value=d.id; o.textContent=d.name; sel.appendChild(o);
    });
  }).catch(e=>console.warn('[RM] devices:',e));

  // Cargar conductores
  service.api.call('Get',{typeName:'User',resultsLimit:500}).then(users=>{
    const sel=rmEl('rm-driver');
    (users||[]).forEach(u=>{
      const o=document.createElement('option');
      o.value=u.id; o.textContent=u.name||`${u.firstName||''} ${u.lastName||''}`.trim(); sel.appendChild(o);
    });
  }).catch(e=>console.warn('[RM] users:',e));

  // Cargar zonas
  rmLoadZones();

  // Botones del form
  rmEl('rm-btn-addwp').onclick=rmOpenWpModal;
  rmEl('rm-btn-clear').onclick=()=>{
    rmS.waypoints=[]; rmS.osrmPath=null;
    rmEl('rm-rname').value='';
    rmRenderWpList();
    if(rmS.co.planned){ try{rmS.co.planned.remove();}catch(_){} rmS.co.planned=null; }
  };
  rmEl('rm-btn-calc').onclick=async()=>{
    if(rmS.waypoints.length<2)return rmToast('Necesitás al menos 2 paradas','e');
    const btn=rmEl('rm-btn-calc');
    btn.disabled=true; btn.textContent='Calculando...';
    try{
      const r=await rmCalcOSRM(rmS.waypoints);
      if(!r)throw new Error('Sin resultado');
      rmS.osrmPath=r.path;
      // Dibujar polyline OSRM en el mapa
      if(rmS.co.planned){ try{rmS.co.planned.remove();}catch(_){} rmS.co.planned=null; }
      const canvas=service.canvas;
      const segs=r.path.map((p,i)=>({point:{lat:p[0],lng:p[1]},...(i===0&&{moveTo:true})}));
      const pl=canvas.path(segs,1);
      pl.setAttribute({strokeStyle:'#0075C9',lineWidth:4,opacity:.8});
      rmS.co.planned=pl;
      rmEl('rm-s-dist').textContent=rmFmtD(r.dist);
      rmEl('rm-s-dur').textContent=rmFmtT(r.dur);
      rmEl('rm-summary').style.display='flex';
      rmToast(`✓ Ruta calculada: ${rmFmtD(r.dist)} · ${rmFmtT(r.dur)}`,'s');
    }catch(e){
      rmToast('Error calculando ruta','e');
    } finally {
      btn.disabled=false; btn.textContent='🗺️ Calcular ruta';
    }
  };
  rmEl('rm-btn-save').onclick=rmSaveRoute;
  rmEl('rm-btn-stop').onclick=()=>{
    rmStopTracking(); rmS.activeRouteId=null;
    rmEl('rm-detail').style.display='none';
    rmRenderMonitor(); rmToast('Seguimiento detenido','i');
  };
  rmEl('rm-btn-clear-alerts').onclick=()=>{
    rmS.alerts=[]; rmSave(); rmUpdateAlertBadge(); rmRenderAlerts(); rmToast('Alertas limpiadas','i');
  };
  rmEl('rm-btn-export').onclick=()=>{
    if(!rmS.routes.length)return rmToast('Sin rutas','e');
    const hdr=['ID','Nombre','Estado','Creada','Paradas','Completadas','Desvíos'];
    const rows=rmS.routes.map(r=>[r.id,r.name,r.status,new Date(r.createdAt).toLocaleDateString('es-AR'),r.waypoints.length,r.waypoints.filter(w=>w.done).length,(r.deviations||[]).length]);
    const csv=[hdr,...rows].map(r=>r.join(',')).join('\n');
    const a=Object.assign(document.createElement('a'),{href:URL.createObjectURL(new Blob([csv],{type:'text/csv'})),download:`rutas_${new Date().toISOString().split('T')[0]}.csv`});
    a.click(); rmToast('CSV exportado ✓','s');
  };
  rmEl('rm-modal').addEventListener('click',e=>{ if(e.target.id==='rm-modal')rmCloseModal(); });

  // Zonas controls
  rmEl('rm-btn-reload-zones').onclick=rmLoadZones;
  rmEl('rm-btn-zones-all').onclick=()=>{ rmS.zones.forEach(z=>rmShowZone(z,true)); rmRenderZonesList(); };
  rmEl('rm-btn-zones-none').onclick=()=>{ rmS.zones.forEach(z=>rmShowZone(z,false)); rmRenderZonesList(); };
  rmEl('rm-zone-filter').addEventListener('input',rmRenderZonesList);

  rmSetHdr('green','Conectado');
};
