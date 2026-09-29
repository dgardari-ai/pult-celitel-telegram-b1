'use strict';

(() => {
  const tg=window.Telegram?.WebApp||null;
  const inTelegram=!!(tg&&tg.initData);
  const OUTBOX_KEY='pult_b2_outbox_v1';
  const PAIR_KEY='pult_b2_pairing_v1';
  let callbacks={applyProjection:null,onStatus:null};
  let syncing=false,lastError=null;

  const apiBase=()=>String(window.PULT_B2_API_BASE||'').replace(/\/+$/,'');
  const fallbackKey=key=>'pult-b2-fallback-'+key;

  function callbackStorage(storage,method,key,value){
    return new Promise((resolve,reject)=>{
      try{
        const done=(error,result)=>error?reject(new Error(String(error))):resolve(result);
        if(method==='getItem')storage.getItem(key,done);
        else if(method==='setItem')storage.setItem(key,value,done);
        else if(method==='removeItem')storage.removeItem(key,done);
      }catch(error){reject(error);}
    });
  }
  async function deviceGet(key){
    if(inTelegram&&tg?.DeviceStorage?.getItem)return callbackStorage(tg.DeviceStorage,'getItem',key);
    try{return localStorage.getItem(fallbackKey(key));}catch{return null;}
  }
  async function deviceSet(key,value){
    if(inTelegram&&tg?.DeviceStorage?.setItem)return callbackStorage(tg.DeviceStorage,'setItem',key,value);
    localStorage.setItem(fallbackKey(key),value);return true;
  }
  async function secureGet(key){
    if(inTelegram&&tg?.SecureStorage?.getItem)return callbackStorage(tg.SecureStorage,'getItem',key);
    if(inTelegram)return null;
    try{return localStorage.getItem(fallbackKey('secure-'+key));}catch{return null;}
  }
  async function secureSet(key,value){
    if(inTelegram&&tg?.SecureStorage?.setItem)return callbackStorage(tg.SecureStorage,'setItem',key,value);
    if(inTelegram)throw new Error('SecureStorage недоступен в этом Telegram-клиенте.');
    localStorage.setItem(fallbackKey('secure-'+key),value);return true;
  }

  function parsePairing(value){
    const parts=String(value||'').trim().split('.');
    if(parts.length!==3||parts[0]!=='PULTB2'||!/^[A-Za-z0-9_-]{40,}$/.test(parts[1])||!/^[A-Za-z0-9_-]{40,}$/.test(parts[2]))
      throw new Error('Неверный код сопряжения.');
    return {version:1,mobileAuth:parts[1],aesKey:parts[2]};
  }
  async function getPairing(){
    const raw=await secureGet(PAIR_KEY);
    if(!raw)return null;
    try{const value=JSON.parse(raw);if(value?.version===1&&value.mobileAuth&&value.aesKey)return value;}catch{}
    return null;
  }
  async function setPairing(bundle){
    const value=parsePairing(bundle);
    await secureSet(PAIR_KEY,JSON.stringify(value));
    lastError=null;await emitStatus();
    return value;
  }
  function b64url(bytes){
    let binary='';for(const b of bytes)binary+=String.fromCharCode(b);
    return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  }
  function unb64url(value){
    const padded=value.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-value.length%4)%4);
    const binary=atob(padded),out=new Uint8Array(binary.length);
    for(let i=0;i<binary.length;i++)out[i]=binary.charCodeAt(i);
    return out;
  }
  async function aesKey(value,usage){
    return crypto.subtle.importKey('raw',unb64url(value),{name:'AES-GCM'},false,usage);
  }
  async function seal(value,keyValue){
    const iv=crypto.getRandomValues(new Uint8Array(12));
    const key=await aesKey(keyValue,['encrypt']);
    const plain=new TextEncoder().encode(JSON.stringify(value));
    const cipher=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},key,plain));
    return {version:1,alg:'A256GCM',nonce:b64url(iv),ciphertext:b64url(cipher)};
  }
  async function open(sealed,keyValue){
    if(!sealed||sealed.version!==1||sealed.alg!=='A256GCM')throw new Error('Неверный шифрованный пакет.');
    const key=await aesKey(keyValue,['decrypt']);
    const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64url(sealed.nonce)},key,unb64url(sealed.ciphertext));
    return JSON.parse(new TextDecoder().decode(plain));
  }

  async function readOutbox(){
    try{
      const raw=await deviceGet(OUTBOX_KEY);
      const value=JSON.parse(raw||'[]');
      return Array.isArray(value)?value:[];
    }catch{return [];}
  }
  async function writeOutbox(value){await deviceSet(OUTBOX_KEY,JSON.stringify(value));}

  function commandForEntry(entry){
    const zone=Intl.DateTimeFormat().resolvedOptions().timeZone||'Etc/UTC';
    return {
      version:1,command:'create-entry',deliveryId:entry.id,createdAt:entry.createdAt||new Date().toISOString(),
      entry:{
        id:entry.id,kind:entry.kind,occurredAt:entry.occurredAt,eventTimeZone:zone,
        data:structuredClone(entry.data),note:entry.note||'',topic:entry.topic||null,
        sourceDevice:entry.device||tg?.platform||'Telegram Mini App'
      }
    };
  }
  async function enqueueEntry(entry){
    const outbox=await readOutbox();
    if(!outbox.some(item=>item.deliveryId===entry.id)){
      outbox.push({deliveryId:entry.id,queuedAt:new Date().toISOString(),command:commandForEntry(entry)});
      await writeOutbox(outbox);
    }
    await emitStatus();
  }
  async function api(path,options={}){
    const base=apiBase();if(!base)throw new Error('HTTPS-адрес Mac ещё не задан.');
    const pair=await getPairing();if(!pair)throw new Error('Сначала сопрягите Mini App с Mac.');
    const headers={...(options.headers||{}),'x-pult-mobile-auth':pair.mobileAuth};
    const response=await fetch(base+path,{...options,headers});
    if(!response.ok){
      let detail='HTTP '+response.status;
      try{detail=(await response.json()).error||detail;}catch{}
      throw new Error(detail);
    }
    return response;
  }
  async function syncNow({quiet=false}={}){
    if(syncing)return false;syncing=true;
    try{
      const pair=await getPairing();
      if(!pair)throw new Error('Сначала сопрягите Mini App с Mac.');
      let outbox=await readOutbox();
      for(const item of outbox){
        const sealed=await seal(item.command,pair.aesKey);
        await api('/v1/to-mac',{
          method:'POST',headers:{'content-type':'application/json'},
          body:JSON.stringify({deliveryId:item.deliveryId,sealed})
        });
      }
      const pending=[],confirmed=[];
      for(const item of outbox){
        let acked=false;
        for(let attempt=0;attempt<20;attempt++){
          const response=await api('/v1/to-mac/status?deliveryId='+encodeURIComponent(item.deliveryId));
          const status=await response.json();
          if(status.acked){acked=true;break;}
          if(attempt<19)await new Promise(resolve=>setTimeout(resolve,100));
        }
        if(acked)confirmed.push(item.deliveryId);
        else pending.push(item);
      }
      if(pending.length!==outbox.length)await writeOutbox(pending);
      outbox=pending;

      let projection=null;
      const attempts=confirmed.length?20:1;
      for(let attempt=0;attempt<attempts;attempt++){
        const snapResponse=await api('/v1/from-mac/snapshot');
        const snap=await snapResponse.json();
        if(snap.snapshot){
          const candidate=await open(snap.snapshot.sealed,pair.aesKey);
          if(candidate?.version!==1||!Array.isArray(candidate.entries)||!Array.isArray(candidate.reminders))
            throw new Error('Mac вернул неверную проекцию.');
          projection=candidate;
          if(confirmed.every(id=>candidate.entries.some(entry=>entry.id===id)))break;
        }
        if(attempt<attempts-1)await new Promise(resolve=>setTimeout(resolve,100));
      }
      if(projection)callbacks.applyProjection?.(projection);
      lastError=null;
      if(!quiet&&outbox.length===0)callbacks.onStatus?.({message:'Синхронизировано'});
      return true;
    }catch(error){
      lastError=error.message||String(error);
      if(!quiet)callbacks.onStatus?.({message:lastError,error:true});
      return false;
    }finally{syncing=false;await emitStatus();}
  }
  async function emitStatus(){
    const [pair,outbox]=await Promise.all([getPairing(),readOutbox()]);
    callbacks.onStatus?.({
      paired:!!pair,
      outbox:outbox.length,
      apiConfigured:!!apiBase(),
      syncing,
      error:lastError,
      message:lastError||(!pair?'Не сопряжено':!apiBase()?'HTTPS ещё не настроен':outbox.length?outbox.length+' ждут Mac':'Готово')
    });
  }
  function configure(next){callbacks={...callbacks,...next};}
  async function init(){
    await emitStatus();
    if(apiBase()&&await getPairing())await syncNow({quiet:true});
  }

  window.PultB2Sync={configure,init,setPairing,getPairing,enqueueEntry,syncNow,emitStatus,seal,open,parsePairing};
})();
