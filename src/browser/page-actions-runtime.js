"use strict";

function pageActionsRuntime() {
  return String.raw`
  let veyraActionHost=null,veyraActionRoot=null,veyraActionMenu=null,veyraActionToast=null,veyraActionOpenedAt=0,veyraTouchTimer=0,veyraTouchOrigin=null;
  function veyraEditingTarget(target){try{return !!(target&&target.closest&&target.closest('input,textarea,select,[contenteditable="true"],[role="textbox"]'))}catch{return false}}
  function veyraEnsureActionHost(){
    if(veyraActionHost&&veyraActionRoot)return veyraActionRoot;
    veyraActionHost=document.createElement('div');veyraActionHost.setAttribute('data-veyra-actions','');
    veyraActionHost.style.cssText='position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;';
    veyraActionRoot=veyraActionHost.attachShadow({mode:'open'});
    const style=document.createElement('style');
    style.textContent=':host{all:initial}.menu{position:fixed;z-index:2;min-width:228px;max-width:min(310px,calc(100vw - 20px));max-height:min(76vh,620px);overflow:auto;padding:6px;background:#111923;color:#edf3fb;border:1px solid #42516a;border-radius:11px;box-shadow:0 14px 42px #000a;font:14px/1.35 system-ui,-apple-system,Segoe UI,sans-serif;pointer-events:auto;overscroll-behavior:contain}.menu button{display:block;width:100%;min-height:44px;padding:10px 12px;border:0;border-radius:7px;background:transparent;color:inherit;text-align:left;font:inherit;touch-action:manipulation;cursor:pointer}.menu button:hover,.menu button:focus{background:#243348;outline:none}.menu .group{height:1px;background:#344256;margin:5px 4px}.toast{position:fixed;z-index:3;left:50%;bottom:24px;transform:translateX(-50%);max-width:calc(100vw - 28px);padding:10px 14px;border:1px solid #42516a;border-radius:9px;background:#111923;color:#edf3fb;box-shadow:0 8px 28px #0009;font:13px system-ui,sans-serif;pointer-events:auto}';
    veyraActionRoot.appendChild(style);document.documentElement.appendChild(veyraActionHost);return veyraActionRoot;
  }
  function veyraCloseActionMenu(){if(veyraActionMenu){veyraActionMenu.remove();veyraActionMenu=null}}
  function veyraToast(text){const root=veyraEnsureActionHost();if(veyraActionToast)veyraActionToast.remove();const toast=document.createElement('div');toast.className='toast';toast.setAttribute('role','status');toast.textContent=String(text||'');root.appendChild(toast);veyraActionToast=toast;setTimeout(()=>{if(veyraActionToast===toast){toast.remove();veyraActionToast=null}},3200)}
  async function veyraCopyText(text){const value=String(text||'');if(!value)return false;try{if(navigator.clipboard&&navigator.clipboard.writeText){await navigator.clipboard.writeText(value);return true}}catch{}try{const area=document.createElement('textarea');area.value=value;area.setAttribute('readonly','');area.style.cssText='position:fixed;left:-9999px;top:0;opacity:0';document.body.appendChild(area);area.select();const ok=document.execCommand('copy');area.remove();return !!ok}catch{return false}}
  async function veyraViewPageSource(){
    try{
      const origin=API_ORIGIN||location.origin;const endpoint=new URL('/api/view-source',origin).href;
      const response=await nativeFetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:virtualUrl})});
      let payload={};try{payload=await response.json()}catch{}
      if(!response.ok||!payload.ok)throw new Error(payload.error||'Source capture failed.');
      const sourcePageUrl=new URL(payload.webUrl,origin).href;
      emit('page.view-source',sourcePageUrl,{sourceUri:payload.schemeUrl,sourceTarget:virtualUrl});
    }catch(error){veyraToast('View source failed: '+String(error&&error.message||error).slice(0,180))}
  }
  function veyraActionElement(target){if(target&&target.nodeType===3)target=target.parentElement;return target instanceof Element?target:null}
  function veyraElementUrl(el,selector,attrs){try{const node=el&&el.closest?el.closest(selector):null;if(!node)return '';let raw='';for(const attr of attrs){raw=node[attr]||node.getAttribute(attr)||'';if(raw)break}return raw?canonicalizeMaybeProxy(raw):''}catch{return ''}}
  function veyraContextMenu(x,y,target){
    if(!rootProxiedFrame())return;const el=veyraActionElement(target);if(!el)return;veyraActionOpenedAt=Date.now();veyraCloseActionMenu();const root=veyraEnsureActionHost();
    const selected=String(window.getSelection&&window.getSelection()||'').trim();
    const link=veyraElementUrl(el,'a[href],area[href]',['href']);
    const image=veyraElementUrl(el,'img,source',['currentSrc','src','srcset']);
    const media=veyraElementUrl(el,'video,audio,source',['currentSrc','src']);
    const menu=document.createElement('div');menu.className='menu';menu.setAttribute('role','menu');menu.setAttribute('aria-label','Page actions');menu.style.left=Math.max(8,Math.min(Number(x)||8,innerWidth-250))+'px';menu.style.top=Math.max(8,Math.min(Number(y)||8,innerHeight-420))+'px';
    function item(label,run){const button=document.createElement('button');button.type='button';button.setAttribute('role','menuitem');button.textContent=label;button.addEventListener('click',async event=>{event.preventDefault();event.stopPropagation();veyraCloseActionMenu();try{await run()}catch(error){veyraToast(String(error&&error.message||error))}});menu.appendChild(button)}
    function divider(){const line=document.createElement('div');line.className='group';menu.appendChild(line)}
    if(selected)item('Copy selection',async()=>veyraToast(await veyraCopyText(selected)?'Selection copied':'Could not copy selection'));
    if(link){item('Open link',()=>emit('contextmenu.open-link',link));item('Open link in new tab',()=>topPost({type:'veyra:open',url:link,sessionId:SESSION_ID}));item('Copy link',async()=>veyraToast(await veyraCopyText(link)?'Link copied':'Could not copy link'));divider()}
    if(image){item('Open image in new tab',()=>topPost({type:'veyra:open',url:image,sessionId:SESSION_ID}));item('Copy image address',async()=>veyraToast(await veyraCopyText(image)?'Image address copied':'Could not copy image address'));divider()}
    if(media){item('Play / pause media',()=>{const node=el.closest('video,audio');if(node){if(node.paused)void node.play();else node.pause()}});item('Copy media address',async()=>veyraToast(await veyraCopyText(media)?'Media address copied':'Could not copy media address'));divider()}
    item('View page source  ·  Ctrl+U',veyraViewPageSource);
    item('Inspect element',()=>{inspectSelected=el;inspectEmit('veyra:inspect-select',el);topPost({type:'veyra:inspect-state',enabled:false,sessionId:SESSION_ID,pageUrl:virtualUrl})});
    item('Select all',()=>{try{document.execCommand('selectAll')}catch{}});item('Reload page',()=>emit('contextmenu.reload',virtualUrl));item('Back',()=>history.back());item('Forward',()=>history.forward());item('Print',()=>window.print());
    root.appendChild(menu);veyraActionMenu=menu;requestAnimationFrame(()=>{const rect=menu.getBoundingClientRect();menu.style.left=Math.max(8,Math.min(Number(x)||8,innerWidth-rect.width-8))+'px';menu.style.top=Math.max(8,Math.min(Number(y)||8,innerHeight-rect.height-8))+'px'});
  }
  document.addEventListener('contextmenu',function(event){if(!rootProxiedFrame()||veyraEditingTarget(event.target))return;event.preventDefault();event.stopPropagation();veyraContextMenu(event.clientX,event.clientY,event.target)},true);
  document.addEventListener('touchstart',function(event){if(!rootProxiedFrame()||!event.touches||event.touches.length!==1||veyraEditingTarget(event.target))return;const touch=event.touches[0];veyraTouchOrigin={x:touch.clientX,y:touch.clientY,target:event.target};clearTimeout(veyraTouchTimer);veyraTouchTimer=setTimeout(()=>{if(veyraTouchOrigin&&Date.now()-veyraActionOpenedAt>650)veyraContextMenu(veyraTouchOrigin.x,veyraTouchOrigin.y,veyraTouchOrigin.target);veyraTouchOrigin=null},700)},{capture:true,passive:true});
  document.addEventListener('touchmove',function(event){if(!veyraTouchOrigin||!event.touches||!event.touches.length)return;const touch=event.touches[0];if(Math.abs(touch.clientX-veyraTouchOrigin.x)>12||Math.abs(touch.clientY-veyraTouchOrigin.y)>12){clearTimeout(veyraTouchTimer);veyraTouchOrigin=null}},{capture:true,passive:true});
  document.addEventListener('touchend',function(){clearTimeout(veyraTouchTimer);veyraTouchOrigin=null},{capture:true,passive:true});document.addEventListener('touchcancel',function(){clearTimeout(veyraTouchTimer);veyraTouchOrigin=null},{capture:true,passive:true});
  document.addEventListener('click',function(event){if(!veyraActionMenu)return;const path=event.composedPath?event.composedPath():[];if(!path.includes(veyraActionHost))veyraCloseActionMenu()},true);
  document.addEventListener('keydown',function(event){const key=String(event.key||'').toLowerCase();if(!rootProxiedFrame())return;if(!(event.ctrlKey||event.metaKey)||event.altKey||event.shiftKey||key!=='u')return;if(veyraEditingTarget(event.target)){event.stopImmediatePropagation();return}event.preventDefault();event.stopImmediatePropagation();void veyraViewPageSource()},true);
  `;
}

module.exports = { pageActionsRuntime };
