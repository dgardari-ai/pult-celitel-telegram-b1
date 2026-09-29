'use strict';

(() => {
  const STORAGE_KEY='pult-celitel-telegram-a1-demo-v1';
  const labels={body:'Вес / Талия',pressure:'Давление',feeling:'Самочувствие',medicine:'Лекарство',load:'Нагрузка',note:'Заметка'};
  const effects={easier:'Легче',unchanged:'Без заметного изменения',harder:'Тяжелее'};
  const tg=window.Telegram?.WebApp||null;
  const $=id=>document.getElementById(id);
  const drafts=new Map();
  let sheetMode=null,toastTimer=null,memoryState=null,currentView='today',dynMode='body';

  function demoEntries(){
    const now=Date.now(),day=86400000,hour=3600000,entries=[];
    const body=[
      [12,69.8,83.0],[9,70.0,82.8],[6,69.9,82.6],[3,70.1,82.4],[1,70.2,82.2],[0.125,70.4,82.0]
    ];
    body.forEach(([ago,weight,waist],i)=>entries.push({
      id:'demo-body-'+i,kind:'body',occurredAt:new Date(now-ago*day).toISOString(),
      data:{weightKg:weight,waistCm:waist},note:i===body.length-1?'Учебный замер':'',device:'тест',topic:null
    }));
    const pressure=[
      [10,116,75,60,45],[5,120,78,64,43],[2,117,76,62,47],[2/24,118,76,61,48]
    ];
    pressure.forEach(([ago,sys,dia,pulse,hrv],i)=>entries.push({
      id:'demo-pressure-'+i,kind:'pressure',occurredAt:new Date(now-ago*day).toISOString(),
      data:{systolicMmHg:sys,diastolicMmHg:dia,pulseBpm:pulse,hrvMs:hrv,hrvMethod:'RMSSD',context:i===pressure.length-1?'Учебный пример':null},
      note:'',device:'тест',topic:null
    }));
    entries.push(
      {id:'demo-feeling',kind:'feeling',occurredAt:new Date(now-26*hour).toISOString(),data:{text:'Учебная запись самочувствия — без медицинского вывода.'},note:'',device:null,topic:null},
      {id:'demo-load',kind:'load',occurredAt:new Date(now-30*hour).toISOString(),data:{name:'Прогулка',durationMin:35,after:'easier'},note:'Учебный пример',device:null,topic:null},
      {id:'demo-note',kind:'note',occurredAt:new Date(now-3*day).toISOString(),data:{text:'Учебная заметка для проверки ленты.'},note:'',device:null,topic:null}
    );
    return entries;
  }

  function demoReminders(){
    const now=Date.now(),hour=3600000,day=86400000;
    return [
      {id:'demo-rem-1',text:'Учебное измерение давления',note:'Только демонстрация интерфейса',dueAt:new Date(now+2*hour).toISOString(),repeat:'none',done:false},
      {id:'demo-rem-2',text:'Учебное выбранное действие',note:'Не назначение',dueAt:new Date(now+day).toISOString(),repeat:'daily',done:false}
    ];
  }

  function defaultState(){return {schema:'a2-demo',entries:demoEntries(),reminders:demoReminders()};}
  function readState(){
    try{
      const parsed=JSON.parse(localStorage.getItem(STORAGE_KEY)||'null');
      if(parsed&&Array.isArray(parsed.entries)){
        if(!Array.isArray(parsed.reminders))parsed.reminders=demoReminders();
        parsed.schema='a2-demo';
        return parsed;
      }
    }catch{}
    if(memoryState)return memoryState;
    const state=defaultState();writeState(state);return state;
  }
  function writeState(state){
    memoryState=state;
    try{localStorage.setItem(STORAGE_KEY,JSON.stringify(state));}catch{}
  }
  function applyMacProjection(projection){
    const current=readState(),canonicalIds=new Set(projection.entries.map(e=>e.id));
    const pending=current.entries.filter(e=>e.pendingMobile&&!canonicalIds.has(e.id));
    const entries=projection.entries.map(e=>({
      id:e.id,kind:e.kind,occurredAt:e.occurredAt,createdAt:e.occurredAt,
      data:structuredClone(e.data),note:e.note||'',device:null,topic:e.topic||null,
      source:{channel:'telegram',device:null},pendingMobile:false
    }));
    const reminders=projection.reminders.map(r=>({
      id:r.id,text:r.text,note:r.note||'',dueAt:r.dueAt,repeat:r.repeat,done:false
    }));
    writeState({schema:'b2-canonical',entries:[...entries,...pending],reminders});
    render();
  }
  function updateB2Status(status){
    const link=$('macLinkStatus'),sync=$('syncStatus');
    if(link)link.textContent=status.paired?'Сопряжено':'Не сопряжено';
    if(sync)sync.textContent=status.syncing?'Синхронизация…':status.message||'—';
  }
  function uid(){return crypto.randomUUID?crypto.randomUUID():'demo-'+Date.now()+'-'+Math.random().toString(16).slice(2);}
  function fmtDate(value,short=false){
    return new Date(value).toLocaleString('ru-RU',short?{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}:{day:'2-digit',month:'long',hour:'2-digit',minute:'2-digit'});
  }
  function localNow(value=Date.now()){
    const d=new Date(value);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);
  }
  function n(value){return String(value).replace('.',',');}
  function flash(text){
    clearTimeout(toastTimer);$('toast').textContent=text;$('toast').classList.add('show');
    toastTimer=setTimeout(()=>$('toast').classList.remove('show'),3200);
  }
  function haptic(type='light'){try{tg?.HapticFeedback?.impactOccurred(type);}catch{}}
  function setClosingGuard(){
    const dirty=[...drafts.values()].some(x=>x.dirty);
    try{dirty?tg?.enableClosingConfirmation?.():tg?.disableClosingConfirmation?.();}catch{}
  }
  function initTelegram(){
    if(!tg)return;
    try{
      tg.ready();tg.expand();
      tg.setHeaderColor?.('#FAFBFC');tg.setBackgroundColor?.('#F5F6F7');tg.setBottomBarColor?.('#F5F6F7');
      tg.BackButton?.onClick(()=>{if(sheetMode)closeSheet();});
    }catch{}
  }

  function description(entry){
    const d=entry.data||{};
    if(entry.kind==='body')return [d.weightKg!=null?n(d.weightKg)+' кг':null,d.waistCm!=null?'талия '+n(d.waistCm)+' см':null].filter(Boolean).join(' · ');
    if(entry.kind==='pressure')return [d.systolicMmHg!=null?n(d.systolicMmHg)+'/'+n(d.diastolicMmHg)+' мм рт. ст.':null,d.pulseBpm!=null?'пульс '+n(d.pulseBpm):null,d.hrvMs!=null?'HRV '+n(d.hrvMs)+' мс'+(d.hrvMethod?' · '+d.hrvMethod:''):null,d.context||null].filter(Boolean).join(' · ');
    if(entry.kind==='feeling'||entry.kind==='note')return d.text;
    if(entry.kind==='medicine')return [d.name,d.doseText].filter(Boolean).join(' · ');
    if(entry.kind==='load')return [d.name,d.durationMin!=null?n(d.durationMin)+' мин':null,d.after?effects[d.after]:null].filter(Boolean).join(' · ');
    return '';
  }
  function latest(entries,key){return entries.find(e=>e.data?.[key]!==null&&e.data?.[key]!==undefined&&e.data?.[key]!=='');}
  function sortedEntries(){return readState().entries.slice().sort((a,b)=>Date.parse(b.occurredAt)-Date.parse(a.occurredAt));}
  function entryRow(e){
    const row=document.createElement('div');row.className='entry';
    const a=document.createElement('span');a.className='entry-time';a.textContent=fmtDate(e.occurredAt,true);
    const b=document.createElement('span');b.className='entry-type';b.textContent=labels[e.kind]||e.kind;
    const c=document.createElement('span');c.className='entry-desc';c.textContent=description(e)+(e.note?' · '+e.note:'');
    row.append(a,b,c);return row;
  }

  function renderToday(){
    const entries=sortedEntries();
    $('todayDate').textContent=new Date().toLocaleDateString('ru-RU',{day:'numeric',month:'long',weekday:'long'}).toUpperCase();
    const configs=[['Вес','weightKg','кг'],['Талия','waistCm','см'],['Давление','systolicMmHg','мм рт. ст.']];
    $('metrics').replaceChildren(...configs.map(([label,key,unit])=>{
      const e=latest(entries,key),cell=document.createElement('div');cell.className='metric';
      cell.innerHTML='<div class="metric-label">'+label+'</div>';
      if(!e){cell.insertAdjacentHTML('beforeend','<span class="metric-empty">Нет замера</span>');return cell;}
      const val=key==='systolicMmHg'?n(e.data.systolicMmHg)+'/'+n(e.data.diastolicMmHg):n(e.data[key]);
      const line=document.createElement('div');line.className='metric-line';
      line.innerHTML='<span class="metric-value">'+val+'</span><span class="metric-unit">'+unit+'</span>';
      const date=document.createElement('div');date.className='metric-date';date.textContent=fmtDate(e.occurredAt,true);
      cell.append(line,date);return cell;
    }));
    const stream=$('stream');stream.replaceChildren();
    if(!entries.length){const empty=document.createElement('div');empty.className='empty';empty.textContent='Здесь появятся тестовые наблюдения.';stream.append(empty);}
    entries.slice(0,7).forEach(e=>stream.append(entryRow(e)));
  }

  function pointsFor(entries,key){
    return entries.filter(e=>e.data?.[key]!==null&&e.data?.[key]!==undefined).map(e=>({t:Date.parse(e.occurredAt),v:Number(e.data[key]),entry:e})).sort((a,b)=>a.t-b.t);
  }
  function chartSeries(entries){
    if(dynMode==='body')return {title:'Вес / талия · 14 дней',shared:false,series:[
      {name:'вес · кг',key:'weightKg',className:'',points:pointsFor(entries,'weightKg')},
      {name:'талия · см',key:'waistCm',className:'secondary',points:pointsFor(entries,'waistCm')}
    ]};
    if(dynMode==='pressure')return {title:'Давление · 14 дней',shared:true,series:[
      {name:'систолическое',key:'systolicMmHg',className:'',points:pointsFor(entries,'systolicMmHg')},
      {name:'диастолическое',key:'diastolicMmHg',className:'secondary',points:pointsFor(entries,'diastolicMmHg')}
    ]};
    if(dynMode==='pulse')return {title:'Пульс / HRV · 14 дней',shared:false,series:[
      {name:'пульс · уд/мин',key:'pulseBpm',className:'',points:pointsFor(entries,'pulseBpm')},
      {name:'HRV · мс',key:'hrvMs',className:'secondary',points:pointsFor(entries,'hrvMs')}
    ]};
    return null;
  }
  function renderChart(spec){
    const host=$('chartCard');host.replaceChildren();
    if(!spec){host.className='chart-card chart-empty';host.textContent='Качественные наблюдения остаются временной историей. Для них A2 не изобретает условный «балл здоровья».';return;}
    host.className='chart-card';
    const all=spec.series.flatMap(s=>s.points);
    if(!all.length){host.className='chart-card chart-empty';host.textContent='Для выбранного тестового ряда пока нет точек.';return;}
    const times=all.map(p=>p.t),minT=Math.min(...times),maxT=Math.max(...times),x0=26,x1=326,y0=18,y1=130;
    const sharedValues=spec.shared?all.map(p=>p.v):null;
    const extent=values=>{
      let min=Math.min(...values),max=Math.max(...values);
      if(min===max){min-=1;max+=1;}
      const pad=(max-min)*.12;return [min-pad,max+pad];
    };
    const sharedExtent=sharedValues?extent(sharedValues):null;
    const x=t=>maxT===minT?(x0+x1)/2:x0+(t-minT)/(maxT-minT)*(x1-x0);
    const header=document.createElement('div');header.className='chart-head';
    const b=document.createElement('b');b.textContent=spec.title;
    const span=document.createElement('span');span.textContent='ФАКТИЧЕСКИЕ ТЕСТОВЫЕ ТОЧКИ';
    header.append(b,span);host.append(header);
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 340 164');svg.classList.add('chart-svg');
    [18,74,130].forEach(y=>{const line=document.createElementNS(svg.namespaceURI,'line');line.setAttribute('x1','26');line.setAttribute('x2','326');line.setAttribute('y1',String(y));line.setAttribute('y2',String(y));line.setAttribute('class','chart-grid');svg.append(line);});
    spec.series.forEach(s=>{
      if(!s.points.length)return;
      const ex=sharedExtent||extent(s.points.map(p=>p.v));
      const y=v=>y1-(v-ex[0])/(ex[1]-ex[0])*(y1-y0);
      const poly=document.createElementNS(svg.namespaceURI,'polyline');
      poly.setAttribute('points',s.points.map(p=>x(p.t).toFixed(1)+','+y(p.v).toFixed(1)).join(' '));
      poly.setAttribute('class','chart-line '+s.className);svg.append(poly);
      s.points.forEach(p=>{const c=document.createElementNS(svg.namespaceURI,'circle');c.setAttribute('cx',x(p.t).toFixed(1));c.setAttribute('cy',y(p.v).toFixed(1));c.setAttribute('r','3');c.setAttribute('class','chart-dot '+s.className);svg.append(c);});
    });
    const first=document.createElementNS(svg.namespaceURI,'text');first.setAttribute('x','26');first.setAttribute('y','154');first.setAttribute('class','chart-axis');first.textContent=new Date(minT).toLocaleDateString('ru-RU',{day:'2-digit',month:'2-digit'});
    const last=document.createElementNS(svg.namespaceURI,'text');last.setAttribute('x','326');last.setAttribute('y','154');last.setAttribute('text-anchor','end');last.setAttribute('class','chart-axis');last.textContent=new Date(maxT).toLocaleDateString('ru-RU',{day:'2-digit',month:'2-digit'});
    svg.append(first,last);host.append(svg);
    const legend=document.createElement('div');legend.className='chart-legend';
    spec.series.forEach(s=>{const item=document.createElement('span');const i=document.createElement('i');i.className=s.className;item.append(i,document.createTextNode(s.name));legend.append(item);});
    host.append(legend);
  }
  function renderDynamics(){
    const entries=sortedEntries();
    document.querySelectorAll('[data-dyn]').forEach(b=>b.classList.toggle('active',b.dataset.dyn===dynMode));
    renderChart(chartSeries(entries));
    const stream=$('dynamicsStream');stream.replaceChildren();
    let relevant=[];
    if(dynMode==='body')relevant=entries.filter(e=>e.kind==='body');
    else if(dynMode==='pressure')relevant=entries.filter(e=>e.kind==='pressure'&&e.data?.systolicMmHg!=null);
    else if(dynMode==='pulse')relevant=entries.filter(e=>e.kind==='pressure'&&(e.data?.pulseBpm!=null||e.data?.hrvMs!=null));
    else relevant=entries.filter(e=>e.kind==='feeling'||e.kind==='load');
    if(!relevant.length){const empty=document.createElement('div');empty.className='empty';empty.textContent='Нет тестовых записей этого типа.';stream.append(empty);}
    relevant.slice(0,8).forEach(e=>stream.append(entryRow(e)));
  }

  function renderReminders(){
    const state=readState(),list=$('reminderList');list.replaceChildren();
    $('reminderCount').textContent=state.reminders.length+' ТЕСТОВЫХ';
    if(!state.reminders.length){const empty=document.createElement('div');empty.className='empty';empty.textContent='Здесь появятся выбранные действия.';list.append(empty);return;}
    state.reminders.slice().sort((a,b)=>Date.parse(a.dueAt)-Date.parse(b.dueAt)).forEach(r=>{
      const row=document.createElement('div');row.className='reminder-item'+(r.done?' done':'');
      const check=document.createElement('button');check.type='button';check.className='reminder-check'+(r.done?' done':'');check.setAttribute('aria-label',r.done?'Вернуть в ожидающие':'Отметить выполненным');
      check.addEventListener('click',()=>{const s=readState(),item=s.reminders.find(x=>x.id===r.id);if(item)item.done=!item.done;writeState(s);renderReminders();haptic();});
      const main=document.createElement('div');main.className='reminder-main';const b=document.createElement('b');b.textContent=r.text;const p=document.createElement('p');p.textContent=(r.note||'')+(r.repeat!=='none'?' · '+(r.repeat==='daily'?'ежедневно':'еженедельно'):'');main.append(b,p);
      const due=document.createElement('span');due.className='reminder-due';due.textContent=fmtDate(r.dueAt,true);
      row.append(check,main,due);list.append(row);
    });
  }
  function renderMedcard(){void window.PultB2Sync?.emitStatus?.();}

  function setView(view){
    if(sheetMode)closeSheet();
    currentView=view;
    document.querySelectorAll('.view').forEach(v=>v.classList.toggle('active',v.id===view+'View'));
    document.querySelectorAll('[data-view]').forEach(b=>{const active=b.dataset.view===view;b.classList.toggle('active',active);active?b.setAttribute('aria-current','page'):b.removeAttribute('aria-current');});
    $('main').scrollTop=0;window.scrollTo(0,0);render();
  }
  function render(){renderToday();renderDynamics();renderReminders();renderMedcard();}

  function field(label,name,type='text',value='',hint=''){
    const wrap=document.createElement('div');wrap.className='field';
    const lab=document.createElement('label');lab.htmlFor='f-'+name;lab.textContent=label;
    const input=document.createElement(type==='textarea'?'textarea':type==='select'?'select':'input');
    input.id='f-'+name;input.name=name;
    if(type!=='textarea'&&type!=='select')input.type=type;
    if(type!=='select')input.value=value??'';
    wrap.append(lab,input);
    if(hint){const note=document.createElement('div');note.className='field-hint';note.textContent=hint;wrap.append(note);}
    return {wrap,input};
  }
  function selectField(label,name,value,options){
    const item=field(label,name,'select');for(const [v,t] of options){const o=document.createElement('option');o.value=v;o.textContent=t;item.input.append(o);}item.input.value=value??'';return item;
  }
  function row2(...items){const row=document.createElement('div');row.className='row2';for(const item of items)row.append(item.wrap);return row;}
  function capture(form,draft){for(const input of form.querySelectorAll('[name]'))draft.values[input.name]=input.value;draft.dirty=true;setClosingGuard();}
  function numeric(value,label){
    const t=String(value??'').trim();if(!t)return null;
    if(!/^(?:\d+(?:[.,]\d*)?|[.,]\d+)$/.test(t))throw Error(label+': введите число без постороннего текста.');
    const x=Number(t.replace(',','.'));if(!Number.isFinite(x)||x<0)throw Error(label+': неверное значение.');return x;
  }

  function showSheet(mode,title,kicker){
    sheetMode=mode;$('sheetTitle').textContent=title;$('sheetKicker').textContent=kicker;$('sheetBody').replaceChildren();
    $('sheetBackdrop').hidden=false;$('sheet').classList.add('open');$('sheet').setAttribute('aria-hidden','false');document.body.classList.add('sheet-open');
    try{tg?.BackButton?.show?.();}catch{}
  }
  function closeSheet(){
    sheetMode=null;document.querySelectorAll('.quick').forEach(b=>b.setAttribute('aria-pressed','false'));
    $('sheet').classList.remove('open');$('sheet').setAttribute('aria-hidden','true');$('sheetBackdrop').hidden=true;document.body.classList.remove('sheet-open');
    try{tg?.BackButton?.hide?.();}catch{}
  }
  function openEntry(kind){
    const mode='entry:'+kind;if(sheetMode===mode){closeSheet();return;}
    document.querySelectorAll('.quick').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.kind===kind)));
    showSheet(mode,labels[kind],'БЫСТРАЯ ЗАПИСЬ · B2');buildEntryForm(kind);
  }
  function buildEntryForm(kind){
    const host=$('sheetBody'),key='kind:'+kind;
    const draft=drafts.get(key)||{dirty:false,values:{occurredLocal:localNow(),pressureMode:'pressure'}};
    drafts.set(key,draft);const v=draft.values;
    const form=document.createElement('form');form.noValidate=true;
    const notice=document.createElement('p');notice.className='notice';notice.textContent='B2: запись сначала сохраняется на устройстве и ждёт Mac, если связь недоступна.';form.append(notice);
    if(kind==='body'){
      const w=field('Вес · кг','weightKg','text',v.weightKg),waist=field('Талия · см','waistCm','text',v.waistCm);w.input.inputMode=waist.input.inputMode='decimal';form.append(row2(w,waist));
    }else if(kind==='pressure'){
      const modes=document.createElement('div');modes.className='mode-row';
      for(const [mode,title] of [['pressure','Давление'],['pulse','Пульс / HRV']]){
        const b=document.createElement('button');b.type='button';b.textContent=title;b.classList.toggle('active',(v.pressureMode||'pressure')===mode);
        b.addEventListener('click',()=>{capture(form,draft);draft.values.pressureMode=mode;buildEntryForm(kind);});modes.append(b);
      }
      form.append(modes);
      if((v.pressureMode||'pressure')==='pressure'){
        const s=field('Систолическое','systolicMmHg','text',v.systolicMmHg),di=field('Диастолическое','diastolicMmHg','text',v.diastolicMmHg);s.input.inputMode=di.input.inputMode='decimal';form.append(row2(s,di));
        const p=field('Пульс · необязательно','pulseBpm','text',v.pulseBpm);p.input.inputMode='decimal';form.append(p.wrap);
      }else{
        const p=field('Пульс · уд/мин','pulseBpm','text',v.pulseBpm),h=field('HRV · мс','hrvMs','text',v.hrvMs);p.input.inputMode=h.input.inputMode='decimal';form.append(row2(p,h));
        form.append(selectField('Метод HRV','hrvMethod',v.hrvMethod,[['','Не указан'],['SDNN','SDNN'],['RMSSD','RMSSD']]).wrap,field('Контекст измерения · необязательно','context','text',v.context).wrap);
      }
    }else if(kind==='medicine'){
      form.append(field('Что фактически принято','name','text',v.name).wrap,field('Доза / форма · ровно как указано','doseText','text',v.doseText).wrap);
    }else if(kind==='load'){
      const duration=field('Минуты · необязательно','durationMin','text',v.durationMin);duration.input.inputMode='decimal';
      form.append(field('Что делал','name','text',v.name).wrap,row2(duration,selectField('Состояние после','after',v.after,[['','Не указано'],...Object.entries(effects)])));
    }else form.append(field('Собственное наблюдение','text','textarea',v.text).wrap);
    const when=field('Время события','occurredLocal','datetime-local',v.occurredLocal||localNow());form.append(when.wrap);
    if(!['feeling','note'].includes(kind))form.append(field('Комментарий · необязательно','note','textarea',v.note).wrap);
    const more=document.createElement('details');more.className='more';more.innerHTML='<summary>Дополнительно</summary>';
    more.append(field('Прибор / источник · необязательно','device','text',v.device).wrap,field('Тема · необязательно','topic','text',v.topic).wrap);form.append(more);
    const error=document.createElement('div');error.className='form-error';error.setAttribute('role','alert');form.append(error);
    const actions=document.createElement('div');actions.className='form-actions';
    const cancel=document.createElement('button');cancel.type='button';cancel.className='ghost';cancel.textContent='Отмена';
    const save=document.createElement('button');save.type='submit';save.className='primary';save.textContent='Сохранить';actions.append(cancel,save);form.append(actions);host.replaceChildren(form);
    form.addEventListener('input',()=>capture(form,draft));form.addEventListener('change',()=>capture(form,draft));
    cancel.addEventListener('click',()=>{drafts.delete(key);setClosingGuard();closeSheet();});
    form.addEventListener('submit',async event=>{event.preventDefault();capture(form,draft);error.textContent='';try{
      const entry=saveDraft(kind,draft);
      await window.PultB2Sync?.enqueueEntry?.(entry);
      drafts.delete(key);setClosingGuard();closeSheet();render();haptic('medium');
      flash('Тестовая запись сохранена · ждёт Mac');
      void window.PultB2Sync?.syncNow?.({quiet:true});
    }catch(e){error.textContent=e.message;haptic('rigid');}});
    requestAnimationFrame(()=>form.querySelector('input,textarea,select')?.focus());
  }

  function saveDraft(kind,draft){
    const v=draft.values;if(!v.occurredLocal)throw Error('Проверьте дату и время события.');let data={};
    if(kind==='body'){data={weightKg:numeric(v.weightKg,'Вес'),waistCm:numeric(v.waistCm,'Талия')};if(data.weightKg==null&&data.waistCm==null)throw Error('Укажите вес или талию.');}
    else if(kind==='pressure'){
      if((v.pressureMode||'pressure')==='pressure'){
        data={systolicMmHg:numeric(v.systolicMmHg,'Систолическое'),diastolicMmHg:numeric(v.diastolicMmHg,'Диастолическое'),pulseBpm:numeric(v.pulseBpm,'Пульс'),hrvMs:null,hrvMethod:null,context:null};
        if(data.systolicMmHg==null||data.diastolicMmHg==null)throw Error('Для давления нужны оба значения.');
      }else{
        data={systolicMmHg:null,diastolicMmHg:null,pulseBpm:numeric(v.pulseBpm,'Пульс'),hrvMs:numeric(v.hrvMs,'HRV'),hrvMethod:v.hrvMs?v.hrvMethod||null:null,context:v.context||null};
        if(data.pulseBpm==null&&data.hrvMs==null)throw Error('Укажите пульс или HRV.');
      }
    }else if(kind==='medicine'){data={name:(v.name||'').trim(),doseText:(v.doseText||'').trim()};if(!data.name)throw Error('Укажите название того, что принято.');}
    else if(kind==='load'){data={name:(v.name||'').trim(),durationMin:numeric(v.durationMin,'Длительность'),after:v.after||null};if(!data.name)throw Error('Укажите действие.');}
    else{data={text:(v.text||'').trim()};if(!data.text)throw Error('Введите собственный текст наблюдения.');}
    const state=readState();
    const entry={id:uid(),kind,occurredAt:new Date(v.occurredLocal).toISOString(),createdAt:new Date().toISOString(),data,note:v.note||'',device:v.device||null,topic:v.topic||null,source:{channel:'manual',device:v.device||null},pendingMobile:true};
    state.entries.push(entry);writeState(state);return entry;
  }

  function openReminder(){
    showSheet('reminder','Новое напоминание','НАПОМИНАНИЕ · A2');
    const host=$('sheetBody'),form=document.createElement('form');form.noValidate=true;
    const notice=document.createElement('p');notice.className='notice';notice.textContent='Только уже выбранное действие. A2 не создаёт назначений и не отправляет системные уведомления.';form.append(notice);
    const textField=field('Что сделать','reminderText','text','');
    const due=field('Срок','reminderDue','datetime-local',localNow(Date.now()+2*3600000));
    const repeat=selectField('Повтор','reminderRepeat','none',[['none','Нет'],['daily','Ежедневно'],['weekly','Еженедельно']]);
    const note=field('Заметка · необязательно','reminderNote','textarea','');
    form.append(textField.wrap,due.wrap,repeat.wrap,note.wrap);
    const error=document.createElement('div');error.className='form-error';form.append(error);
    const actions=document.createElement('div');actions.className='form-actions';
    const cancel=document.createElement('button');cancel.type='button';cancel.className='ghost';cancel.textContent='Отмена';
    const save=document.createElement('button');save.type='submit';save.className='primary';save.textContent='Сохранить';
    actions.append(cancel,save);form.append(actions);host.append(form);
    cancel.addEventListener('click',closeSheet);
    form.addEventListener('submit',e=>{e.preventDefault();error.textContent='';const text=textField.input.value.trim();if(!text){error.textContent='Укажите действие.';return;}if(!due.input.value){error.textContent='Укажите срок для тестового напоминания.';return;}
      const state=readState();state.reminders.push({id:uid(),text,note:note.input.value.trim(),dueAt:new Date(due.input.value).toISOString(),repeat:repeat.input.value,done:false});writeState(state);closeSheet();renderReminders();haptic('medium');flash('Тестовое напоминание сохранено');
    });
    requestAnimationFrame(()=>textField.input.focus());
  }

  function openPairing(){
    showSheet('pair','Связь с Mac','B2 · СОПРЯЖЕНИЕ');
    const host=$('sheetBody'),form=document.createElement('form');form.noValidate=true;
    const notice=document.createElement('p');notice.className='notice';
    notice.textContent='Вставьте код сопряжения с Mac. Он сохраняется в защищённом хранилище Telegram и не относится к Медкарте.';
    const code=field('Код сопряжения','pairing','textarea','');
    const error=document.createElement('div');error.className='form-error';error.setAttribute('role','alert');
    const actions=document.createElement('div');actions.className='form-actions';
    const cancel=document.createElement('button');cancel.type='button';cancel.className='ghost';cancel.textContent='Отмена';
    const save=document.createElement('button');save.type='submit';save.className='primary';save.textContent='Сопрячь';
    actions.append(cancel,save);form.append(notice,code.wrap,error,actions);host.append(form);
    cancel.addEventListener('click',closeSheet);
    form.addEventListener('submit',async e=>{e.preventDefault();error.textContent='';try{
      await window.PultB2Sync.setPairing(code.input.value);
      closeSheet();render();flash('Mac сопряжён');void window.PultB2Sync.syncNow({quiet:true});
    }catch(err){error.textContent=err.message;haptic('rigid');}});
    requestAnimationFrame(()=>code.input.focus());
  }

  document.querySelectorAll('.quick').forEach(b=>{b.setAttribute('aria-pressed','false');b.addEventListener('click',()=>{haptic();openEntry(b.dataset.kind);});});
  document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>setView(b.dataset.view)));
  document.querySelectorAll('[data-dyn]').forEach(b=>b.addEventListener('click',()=>{dynMode=b.dataset.dyn;renderDynamics();haptic();}));
  $('closeSheet').addEventListener('click',closeSheet);$('sheetBackdrop').addEventListener('click',closeSheet);
  $('addReminder').addEventListener('click',openReminder);
  $('pairMac').addEventListener('click',openPairing);
  $('syncNow').addEventListener('click',()=>{void window.PultB2Sync?.syncNow?.();});
  $('resetDemo').addEventListener('click',()=>{
    if(!window.confirm('Сбросить только тестовые данные A2?'))return;
    writeState(defaultState());drafts.clear();setClosingGuard();render();flash('Тестовые данные восстановлены');
  });
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&sheetMode){e.preventDefault();closeSheet();}});
  window.PultB2Sync?.configure?.({applyProjection:applyMacProjection,onStatus:updateB2Status});
  window.addEventListener('online',()=>{void window.PultB2Sync?.syncNow?.({quiet:true});});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)void window.PultB2Sync?.syncNow?.({quiet:true});});
  try{tg?.onEvent?.('activated',()=>{void window.PultB2Sync?.syncNow?.({quiet:true});});}catch{}
  initTelegram();setView('today');void window.PultB2Sync?.init?.();
})();

