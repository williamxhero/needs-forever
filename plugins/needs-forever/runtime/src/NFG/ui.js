export const WEB_HTML = String.raw `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Needs Forever GUI</title>
<style>
:root{
  color-scheme:dark;
  --bg:#101416;--sidebar:#141a1d;--panel:#191f23;--surface:#20282d;--hover:#263138;
  --ink:#e7eeed;--muted:#afbfbe;--quiet:#8c9e9e;--line:#303c41;
  --accent:#79dcc5;--accent-soft:#203a35;--accent-line:#3c685e;
  --green:#93d8ab;--green-soft:#21392b;--green-line:#3c6249;
  --amber:#e9bd7b;--amber-soft:#382e20;
  --purple:#bdb0e9;--purple-soft:#302b40;
  --danger:#efa2ac;--danger-soft:#3c262d;--danger-line:#70434e;
  --sans:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  --mono:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;
}


*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:14px}
.app{height:100vh;min-height:0;display:grid;grid-template-columns:238px minmax(0,1fr)}
aside{padding:24px 14px;border-right:1px solid var(--line);background:var(--sidebar)}
.brand{display:flex;align-items:baseline;gap:9px;padding:0 10px 24px;white-space:nowrap;font-size:17px;font-weight:700;letter-spacing:-.03em}
.brand-forever{color:var(--accent)}
.brand-gui{color:var(--accent);font:italic 700 12px/1 var(--mono);letter-spacing:.1em}
.side-label{padding:0 10px 8px;color:var(--quiet);font-size:10px;letter-spacing:.12em;text-transform:uppercase}
.tasks{display:grid;gap:4px}
.task{min-width:0;width:100%;padding:10px;border:1px solid transparent;border-radius:9px;background:transparent;color:var(--muted);text-align:left;cursor:pointer}
.refresh-icon{flex:0 0 22px;width:22px;height:22px;padding:0;border:1px solid var(--line);border-radius:7px;background:var(--panel);font:700 18px/1 ui-sans-serif;cursor:pointer}
.refresh-icon.on{color:var(--green);border-color:var(--green-line);background:var(--green-soft)}
.refresh-icon.off{color:var(--danger);border-color:var(--danger-line);background:var(--danger-soft)}
.task:hover{background:var(--hover)}
.task.selected{border-color:var(--accent-line);background:var(--accent-soft);color:var(--ink)}
.task-name{display:block;font-weight:650;line-height:1.35}
.task-session-id{display:inline-flex;align-items:center;justify-content:center;min-width:36px;height:18px;margin-right:6px;padding:0 4px;border:1px solid var(--line);border-radius:5px;background:var(--panel);color:var(--quiet);font:700 10px/1 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.06em;vertical-align:middle;cursor:pointer;appearance:none}
.task-meta{display:flex;align-items:center;justify-content:space-between;gap:6px;margin-top:5px;color:var(--quiet);font-size:11px}
.task.selected .task-meta{color:var(--accent)}
.task-actions{display:flex;align-items:center;gap:8px;margin:0 0 12px;padding:8px 0;border-bottom:1px solid var(--line)}
.action-icon{width:32px;height:28px;padding:0;border:1px solid var(--line);border-radius:7px;background:var(--panel);color:var(--muted);font:700 14px/1 ui-sans-serif;cursor:pointer}
.action-icon.session-copy{width:auto;min-width:84px;padding:0 10px;font:700 12px/1 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.04em}
.action-icon:hover{background:var(--accent-soft);color:var(--accent)}
.action-icon.danger{color:var(--danger)}
.action-icon.danger:hover{background:var(--danger-soft)}
.action-icon.on{color:var(--green);border-color:var(--green-line);background:var(--green-soft)}
.empty-side{padding:10px;color:var(--quiet);font-size:12px}
main{height:100%;min-width:0;min-height:0;overflow:hidden;padding:28px 34px 0}
.content{display:flex;flex-direction:column;width:min(1180px,100%);height:100%;min-height:0;margin:0 auto}
.project{margin:1px 0 20px;color:var(--muted);font-size:12px;font-weight:650;letter-spacing:.08em}
.top{display:flex;align-items:flex-end;justify-content:space-between;gap:22px;margin-bottom:24px}
.title{min-width:0}
.title-row{display:block}
.title h1{display:inline;margin:0;font-size:30px;letter-spacing:-.045em}
.goal{max-width:680px;margin:8px 0 0;color:var(--muted);line-height:1.45;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.meta{text-align:right;color:var(--muted);font-size:12px;line-height:1.55;max-width:52%}
.status-time{font-weight:650}
.status-reason{margin-top:4px;max-width:520px;color:var(--muted);line-height:1.45;overflow-wrap:anywhere}
.status{display:inline-flex;align-items:center;gap:6px;margin-bottom:6px;font-weight:700}
.status::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--accent)}
.status.done{color:var(--green)}
.status.done::before{background:var(--green)}
.status.wait{color:var(--purple)}
.status.wait::before{background:var(--purple)}
.status.paused{color:var(--muted)}
.status.paused::before{background:var(--quiet)}
.status.recover{color:var(--amber)}
.status.recover::before{background:var(--amber)}
.toolbar{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:12px;padding:10px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.filters{display:flex;gap:5px;flex-wrap:wrap}
.filter,.refresh{border:1px solid var(--line);border-radius:7px;background:var(--panel);color:var(--muted);padding:6px 10px;font-size:12px;cursor:pointer}
.filter.active{border-color:var(--accent-line);background:var(--accent-soft);color:var(--accent);font-weight:650}
.refresh.on{color:var(--accent);border-color:var(--accent-line);background:var(--accent-soft)}
.timeline{display:grid;flex:1;min-height:0;grid-auto-rows:max-content;align-content:start;gap:10px;overflow:auto;padding:0 2px 52px}
.workspace{display:flex;flex:1;min-width:0;min-height:0}
.content.live-view{width:min(1560px,100%)}
.live-view .workspace{display:grid;grid-template-columns:minmax(0,1fr) minmax(340px,430px);min-height:0}
.live-pane{display:none}
.live-view .live-pane{display:block;min-width:0;min-height:0;overflow:auto;padding:0 18px 52px 2px;border-right:1px solid var(--line)}
.live-view .timeline{padding:0 2px 52px 18px}
.live-head{position:sticky;top:0;z-index:3;margin-bottom:10px;padding:10px 0 12px;border-bottom:1px solid var(--line);background:linear-gradient(var(--bg) 82%,transparent)}
.live-head-row{display:flex;align-items:baseline;justify-content:space-between;gap:10px;flex-wrap:wrap}
.live-head h2{display:inline;margin:0;font-size:17px;letter-spacing:-.02em}
.live-status-line{font-weight:700}
.live-status-line.done{color:var(--green)}
.live-status-line.wait{color:var(--purple)}
.live-status-line.paused{color:var(--muted)}
.live-meta{margin-top:7px;color:var(--muted);font-size:12px;line-height:1.5}
.live-meta strong{color:var(--ink);font-weight:650}
.live-stale{margin-top:7px;padding:7px 9px;border:1px solid var(--danger-line);border-radius:7px;background:var(--danger-soft);color:var(--danger);font-size:12px}
.transcript{display:grid;gap:8px;align-content:start}
.chat-item{min-width:0;padding:10px 12px;border:1px solid var(--line);border-radius:9px;background:var(--panel)}
.chat-item.assistant{border-left:3px solid var(--accent-line)}
.chat-item.user{border-left:3px solid var(--purple)}
.chat-item.direction{border-left:3px solid var(--amber);background:var(--amber-soft)}
.chat-item.decision,.chat-item.verification,.chat-item.status{padding:7px 10px;background:var(--surface);color:var(--muted);font-size:12px}
.chat-item.decision{border-left:3px solid var(--accent)}
.chat-item.verification{border-left:3px solid var(--green-line)}
.chat-item.status{border-left:3px solid var(--quiet)}
.chat-item.tool_call{border-left:3px solid var(--accent-line);background:var(--sidebar)}
.chat-item.tool_result{border-left:3px solid var(--green-line);background:var(--sidebar)}
.chat-item.tool_result.error{border-left-color:var(--danger);background:var(--danger-soft)}
.chat-meta{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:5px;color:var(--quiet);font-size:10px;font-weight:700;letter-spacing:.07em;text-transform:uppercase}
.chat-time{font:11px/1.4 var(--mono);font-variant-numeric:tabular-nums;letter-spacing:0;text-transform:none}
.chat-text{margin:0;color:var(--ink);line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere}
.chat-pre{margin:5px 0 0;overflow:auto;color:var(--muted);font:11px/1.5 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere}
.thinking{border:1px solid var(--line);border-radius:9px;background:var(--sidebar);color:var(--muted)}
.thinking summary{display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding:9px 12px;cursor:pointer;font-size:12px;font-weight:650;list-style:none}
.thinking summary::-webkit-details-marker{display:none}
.thinking summary::before{content:"›";margin-right:7px;color:var(--quiet);font-weight:700}
.thinking[open] summary::before{transform:rotate(90deg)}
.thinking-text{padding:0 12px 11px;color:var(--muted);font-size:12px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere}
.badge{display:inline-block;margin-left:6px;padding:1px 5px;border:1px solid var(--line);border-radius:5px;color:var(--quiet);font:10px/1.5 var(--mono);text-transform:none}
.badge.error{color:var(--danger);border-color:var(--danger-line)}
.jump{position:sticky;bottom:12px;display:block;margin:12px auto 0;padding:6px 11px;border:1px solid var(--accent-line);border-radius:7px;background:var(--panel);color:var(--accent);font-size:12px;cursor:pointer}
.jump[hidden]{display:none}
.stage-summary{display:grid;gap:8px;margin-bottom:10px}
.stage-card{padding:11px 13px;border:1px solid var(--line);border-radius:9px;background:var(--panel)}
.stage-card h3{margin:0 0 7px;color:var(--muted);font-size:10px;letter-spacing:.09em;text-transform:uppercase}
.stage-card ul{margin:0;padding-left:18px;color:var(--ink);line-height:1.5}
.stage-card li+li{margin-top:4px}
.stage-kv{display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 10px;color:var(--muted);font-size:12px;line-height:1.5}
.stage-kv dt{color:var(--quiet)}
.stage-kv dd{margin:0;color:var(--ink);overflow-wrap:anywhere}
.live-tabs{display:none;gap:6px;margin-bottom:8px}
.live-tabs button{padding:6px 11px;border:1px solid var(--line);border-radius:7px;background:var(--panel);color:var(--muted);font-size:12px;cursor:pointer}
.live-tabs button.active{border-color:var(--accent-line);background:var(--accent-soft);color:var(--accent);font-weight:650}
.round{border:1px solid var(--line);border-radius:11px;background:var(--panel);overflow:hidden}
.round-head{display:flex;align-items:baseline;gap:10px;flex-wrap:nowrap;padding:13px 16px;border-bottom:1px solid var(--line)}
.round-toggle{display:flex;align-items:center;gap:10px;min-width:0;border:0;background:transparent;color:var(--ink);font:inherit;text-align:left;cursor:pointer}
.chevron{color:var(--quiet);font-size:15px}
.round-title{flex:0 0 auto;white-space:nowrap;font-weight:700}
.round-time{flex:0 0 auto;color:var(--quiet);font:12px/1.4 var(--mono);font-variant-numeric:tabular-nums;white-space:nowrap}
.round-body{display:block;padding:15px 16px}
.flow-line{margin:0 0 9px;color:var(--ink);line-height:1.45}
.flow-line strong{font-weight:700}
.step-time{margin-right:8px;color:var(--quiet);font:12px ui-monospace,SFMono-Regular,Consolas,monospace}
.decision-block,.prompt-block{margin:0 0 14px;padding:10px 30px 10px 12px;overflow:hidden;border-radius:7px;background:var(--surface);color:var(--muted);font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace}
.collapsible{position:relative;width:100%;border:0;text-align:left;min-height:calc(1.5em + 20px);max-height:calc(1.5em + 20px);cursor:pointer}
.collapsible.expanded{max-height:none;overflow:auto}
.collapsible-content{white-space:pre-wrap}
.collapsible:not(.expanded) .collapsible-content{display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden}
.collapse-marker{position:absolute;top:8px;right:10px;color:var(--quiet);font:700 14px/1 ui-sans-serif}
.collapsible.expanded .collapse-marker{transform:rotate(180deg)}
.prompt-block{margin-bottom:0}
.column{min-width:0;padding:15px 16px}
.column+.column{border-left:1px solid var(--line)}
.column-label{margin-bottom:8px;color:var(--quiet);font-size:10px;font-weight:700;letter-spacing:.09em;text-transform:uppercase}
.event-type{display:inline-block;margin-right:6px;color:var(--accent);font:650 11px ui-monospace,SFMono-Regular,Consolas,monospace}
.event-summary{color:var(--ink);line-height:1.45}
.event-result{margin-top:7px;color:var(--muted);font-size:12px}
.result-continue{color:var(--accent)}
.result-done{color:var(--green)}
.result-wait{color:var(--purple)}
.result-error{color:var(--amber)}
.message{margin-top:8px;padding:8px 10px;border-radius:7px;background:var(--surface);color:var(--muted);font-size:12px;line-height:1.45}
.round-details{display:none;padding:0 16px 16px;border-top:1px solid var(--line);background:var(--sidebar)}
.round.open .round-details{display:block}
.detail-event{padding:10px 0;border-bottom:1px solid var(--line)}
.detail-event:last-child{border-bottom:0}
.detail-row{display:flex;align-items:baseline;gap:9px}
.detail-role{color:var(--muted);font-size:11px}
.detail-time{margin-left:auto;color:var(--quiet);font:11px ui-monospace,SFMono-Regular,Consolas,monospace}
.detail-json{margin:7px 0 0;padding:9px;overflow:auto;border-radius:7px;background:var(--surface);color:var(--muted);font:11px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap}
.drawer{position:fixed;inset:0;display:none;background:rgba(0,0,0,.56)}
.drawer.open{display:block}
.drawer-panel{position:absolute;top:0;right:0;width:min(430px,92vw);height:100%;overflow:auto;padding:22px;background:var(--panel);box-shadow:-8px 0 24px rgba(0,0,0,.32)}
.drawer-close{float:right;border:0;background:transparent;color:var(--muted);font-size:22px;cursor:pointer}
.drawer h2{margin:4px 34px 18px 0;font-size:18px}
.drawer-section{margin-top:18px;padding-top:14px;border-top:1px solid var(--line)}
.drawer-section h3{margin:0 0 8px;font-size:12px;color:var(--muted)}
.drawer-section p{margin:0;color:var(--ink);line-height:1.5}
.empty{padding:38px 16px;border:1px dashed var(--line);border-radius:11px;background:var(--panel);color:var(--muted);text-align:center}
.error{padding:14px;border-radius:8px;background:var(--amber-soft);color:var(--amber)}
@media(max-width:860px){.app{grid-template-columns:205px minmax(0,1fr)}
main{padding:24px 20px}
.round-body{grid-template-columns:1fr}
.column+.column{border-top:1px solid var(--line);border-left:0}
.meta{font-size:11px}
.live-view .workspace{display:flex;flex-direction:column}
.live-view .live-pane{height:100%;border-right:0;padding:0 2px 52px}
.live-view .timeline{padding:0 2px 52px}
.live-pane.mobile-hidden,.timeline.mobile-hidden{display:none}
.live-tabs{display:flex}
}
@media(max-width:620px){.app{display:flex;flex-direction:column;height:100vh}
aside{border-right:0;border-bottom:1px solid var(--line);padding:16px 12px}
.brand{padding-bottom:15px}
.tasks{display:flex;overflow:auto}
.task{min-width:165px}
main{height:auto;flex:1 1 auto;padding:20px 14px 0}
.top{display:block}
.meta{max-width:none;margin-top:14px;text-align:left}
.toolbar{align-items:flex-start;flex-direction:column}
}


button{font-family:inherit}

button:focus-visible,.task:focus-visible{outline:2px solid var(--accent);outline-offset:3px}

.task,.action-icon,.filter,.refresh,.refresh-icon,.collapsible{transition:background-color .16s ease,border-color .16s ease,color .16s ease}

.collapsible:hover{background:var(--hover)}

.task-name,.title h1{overflow-wrap:anywhere}

::selection{background:var(--accent);color:var(--bg)}

@media(prefers-reduced-motion:reduce){*,*::before,*::after{transition:none!important}
}
</style>
</head>
<body>
<div class="app"><aside><div class="brand"><span class="brand-name">Needs <span class="brand-forever">Forever</span></span><span class="brand-gui">GUI</span></div><div class="side-label">任务</div><div id="tasks" class="tasks"><div class="empty-side">正在读取任务…</div></div></aside>
<main><div class="content" id="content"><div id="error" class="error" hidden></div><section id="task-header" class="top" hidden><div class="title"><div class="title-row"><h1 id="task-title"></h1></div><p id="task-goal" class="goal"></p></div><div class="meta"><div id="task-status" class="status"></div><div id="task-meta"></div></div></section><div id="task-actions" class="task-actions" hidden></div><div id="live-tabs" class="live-tabs" hidden></div><div id="workspace" class="workspace"><section id="live" class="live-pane" hidden></section><section id="timeline" class="timeline"><div class="empty">选择一个任务查看监督记录。</div></section></div></div></main></div>
<div id="drawer" class="drawer"><aside class="drawer-panel"><button id="drawer-close" class="drawer-close" aria-label="关闭">×</button><h2 id="drawer-title">轮次详情</h2><div id="drawer-content"></div></aside></div>
<script>
const app={taskId:new URL(location.href).pathname.match(/^\/tasks\/([^/]+)/)?.[1]||null,record:null,filter:'all',auto:true,refreshing:false,liveTab:'chat',followLive:true};
const $=s=>document.querySelector(s); const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const statusLabel={ACTIVE:'正在推进',WAIT_EXTERNAL:'等待外部条件',PAUSED:'已暂停',DONE:'已完成',INTERRUPTED:'已中断'};
function statusClass(s,p){return s==='DONE'?'done':s==='WAIT_EXTERNAL'?'wait':(s==='PAUSED'||s==='INTERRUPTED')?'paused':p==='RECOVERING'?'recover':''}
function statusText(s,p){return s==='ACTIVE'&&p==='RECOVERING'?'恢复中':statusLabel[s]||s}
function shortTime(v){try{return new Date(v).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})}catch{return v}}
function resultClass(v){return v==='DONE'?'result-done':v==='WAIT_EXTERNAL'?'result-wait':v==='CONTINUE'?'result-continue':v==='FAIL'?'result-error':''}
function roleName(v){return v==='supervisor'?'supervisor':v==='worker'?'worker':'系统'}
async function copySessionId(button){const value=button.dataset.sessionId||'';if(!value)return;const copyValue='NF://'+value;try{await navigator.clipboard.writeText(copyValue)}catch{const input=document.createElement('textarea');input.value=copyValue;input.style.position='fixed';input.style.opacity='0';document.body.appendChild(input);input.focus();input.select();document.execCommand('copy');input.remove()}const previous=button.title;button.title='已复制：'+copyValue;button.classList.add('copied');setTimeout(()=>{button.title=previous;button.classList.remove('copied')},3000)}
function wireSessionCopy(){document.querySelectorAll('[data-session-copy]').forEach(button=>{button.onclick=(event)=>{event.preventDefault();event.stopPropagation();void copySessionId(button)}})}function renderTasks(tasks){const root=$('#tasks');if(!tasks.length){root.innerHTML='<div class="empty-side">暂无可发现的任务</div>';return}root.innerHTML=tasks.map(t=>'<div class="task '+(t.taskId===app.taskId?'selected':'')+'" data-task="'+esc(t.taskId)+'"><span class="task-name">'+esc(t.title||t.taskId)+'</span><span class="task-meta"><span>'+esc(statusText(t.status,t.phase))+'</span><span>'+esc(shortTime(t.updatedAt))+'</span></span></div>').join('');root.querySelectorAll('[data-task]').forEach(b=>b.onclick=()=>{app.taskId=b.dataset.task;history.pushState({},'', '/tasks/'+encodeURIComponent(app.taskId));loadRecord()})}
function eventHtml(ev){return '<div><span class="event-type">'+esc(ev.eventType)+'</span><span class="event-summary">'+esc(ev.summary)+'</span></div>'+(ev.result?'<div class="event-result '+resultClass(ev.result)+'">'+esc(ev.result)+'</div>':'')}
function matches(round){if(app.filter==='all')return true;const values=round.technicalEvents; if(app.filter==='worker')return values.some(e=>e.role==='worker');if(app.filter==='supervisor')return values.some(e=>e.role==='supervisor');return values.some(e=>e.result==='FAIL'||e.eventType.startsWith('recovery_')||e.eventType.startsWith('stale_')||e.eventType==='external_wait_required'||e.eventType==='paused')}
function shortDate(v){try{const d=new Date(v);if(Number.isNaN(d.getTime()))return v;return d.getFullYear()+'/'+String(d.getMonth()+1).padStart(2,'0')+'/'+String(d.getDate()).padStart(2,'0')}catch{return v}}
function shortHourMinute(v){try{const d=new Date(v);if(Number.isNaN(d.getTime()))return v;return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0')}catch{return v}}
function collapsibleHtml(className,text,key){return '<button type="button" class="'+className+' collapsible" data-collapsible data-collapsible-key="'+esc(key)+'" aria-expanded="false"><span class="collapsible-content">'+esc(text)+'</span><span class="collapse-marker" aria-hidden="true">⌄</span></button>'}
const routeStatusLabel={observed:'已观测',candidate:'候选（未验证）',blocked:'受阻',exhausted:'已耗尽',forbidden:'禁止',unknown:'未知（未验证）'};
function routeHtml(r,key){
  const audit=r.routeAudit;if(!audit)return '';
  const selected=audit.candidates.find(c=>c.routeId===audit.selectedRouteId);
  const lines=['路线 '+audit.selectedRouteId+' · '+(selected?.title||'未记录路线标题')+' · '+audit.diagnosis.statement,
    '诊断：'+audit.diagnosis.class+' · '+audit.diagnosis.statement,
    '诊断证据：'+(audit.diagnosis.evidenceIds.join('、')||'未记录独立证据'),
    '选择原因：'+audit.selectionReason];
  if(audit.singleRouteReason)lines.push('单路线原因：'+audit.singleRouteReason);
  for(const candidate of audit.candidates){
    lines.push('',candidate.routeId+(candidate.routeId===audit.selectedRouteId?'（选定）':'')+' · '+(routeStatusLabel[candidate.status]||routeStatusLabel.unknown)+' · '+candidate.title,
      '资源：'+(candidate.resource||'未记录'),'假设：'+candidate.hypothesis,
      '证据：'+(candidate.evidenceIds.join('、')||'未记录独立证据'),
      '动作：'+candidate.actions.join('；'),'预期证据：'+candidate.expectedEvidence.join('；'),
      '预期信号：'+candidate.expectedSignal,'风险：'+candidate.risk,
      'fallback：'+(candidate.fallback.routeId||'重新规划')+' · '+candidate.fallback.when);
    if(candidate.discriminatingCheck)lines.push('区分检查：'+candidate.discriminatingCheck);
  }
  lines.push('','成功条件：'+audit.successCondition,'停止条件：'+audit.stopCondition);
  return collapsibleHtml('decision-block route-block',lines.join('\n'),key+':route:'+audit.planId);
}
function roundHtml(r,index){
  const decisionEvent=r.supervisor.findLast(e=>e.eventType==='decision'||e.eventType==='judge_inventory_fallback');
  const interruption=r.supervisor.findLast(e=>e.eventType==='judge_round_interrupted'||e.eventType==='recovery_interrupted'||e.eventType==='supervision_round_cancelled');
  const admissionFailure=r.supervisor.findLast(e=>e.eventType==='judge_admission_failed');
  const lastJudge=r.supervisor.findLast(e=>e.eventType.startsWith('judge_'));
  const timeouts=r.supervisor.filter(e=>e.eventType==='judge_terminated'&&/timeout|超时/i.test(JSON.stringify(e.details)));
  const decisionValue=decisionEvent?.details.decision;
  const action=decisionValue?.action||(interruption?'INTERRUPTED':timeouts.length?'超时':'未完成');
  const decisionText=decisionValue?.reason||(interruption?.details.reason?String(interruption.details.reason):admissionFailure?.details.error?'admission 被拒绝：'+String(admissionFailure.details.error):timeouts.length?'SUPERVISOR '+timeouts.length+' 次判断超时，未产生有效 decision。':'尚未产生有效 SUPERVISOR 判断。');
  const recoverySent=r.continuation.find(e=>e.eventType==='main_session_recovery_prompt_sent');
  const recoveryAck=r.continuation.find(e=>e.eventType==='main_session_recovery_prompt_acknowledged');
  const observedPrompt=r.continuation.findLast(e=>e.eventType==='main_session_worker_prompt_observed'&&typeof e.details.message==='string'&&e.details.message.length>0);
  const recoveryFailure=r.continuation.findLast(e=>e.eventType==='main_session_recovery_prompt_failed');
  const ordinarySent=r.technicalEvents.findLast(e=>e.eventType==='send_prepared'&&e.deliveryId&&r.technicalEvents.some(s=>s.eventType==='send_confirmed'&&s.deliveryId===e.deliveryId));
  const ordinaryConfirmation=ordinarySent&&r.technicalEvents.find(e=>e.eventType==='send_confirmed'&&e.deliveryId===ordinarySent.deliveryId);
  // A direction returned by the hook is only a proposal.  It does not prove
  // that A received a prompt.  The Worker received row must be backed by an
  // observed prompt, an acknowledged recovery delivery, or a confirmed
  // ordinary delivery with its prepared message.
  const acknowledgedRecovery = recoveryAck && (
    typeof recoveryAck.details.message==='string' && recoveryAck.details.message.length>0
      ? recoveryAck
      : recoverySent && recoveryAck.deliveryId && recoverySent.deliveryId===recoveryAck.deliveryId && typeof recoverySent.details.message==='string' && recoverySent.details.message.length>0
        ? recoverySent
        : null
  );
  const deliveredPrompt = observedPrompt
    ? { event: observedPrompt, message: String(observedPrompt.details.message) }
    : acknowledgedRecovery
      ? { event: recoveryAck, message: typeof acknowledgedRecovery.details.message==='string' ? acknowledgedRecovery.details.message : String(recoverySent.details.message) }
      : ordinaryConfirmation && ordinarySent && typeof ordinarySent.details.message==='string' && ordinarySent.details.message.length>0
        ? { event: ordinaryConfirmation, message: String(ordinarySent.details.message) }
        : null;
  const prompt=deliveredPrompt?.message||'';
  const stopAt=r.stop?.at||r.endedAt;
  const decisionAt=decisionEvent?.at||lastJudge?.at||stopAt;
  const returnedAt=deliveredPrompt?.event.at;
  const stopReason=typeof r.stop?.details.stop_reason==='string'?r.stop.details.stop_reason:'';
  const key=JSON.stringify([app.taskId,r.id]);
  const stepTime=v=>'<span class="step-time">'+esc(shortHourMinute(v))+'</span>';
  const recoveryFailureReason=recoveryFailure&&((typeof recoveryFailure.details.error==='string'&&recoveryFailure.details.error)|| (typeof recoveryFailure.details.message==='string'&&recoveryFailure.details.message)||'');
  const recoveryLine=(recoverySent?'<div class="flow-line">'+stepTime(recoverySent.at)+' <strong>NF 推动 A：</strong> <span class="event-result">已发送恢复 prompt</span></div>':'')+(recoveryFailure?'<div class="flow-line">'+stepTime(recoveryFailure.at)+' <strong>NF 推动 A：</strong> <span class="event-result result-error">发送失败'+(recoveryFailureReason?'：'+esc(recoveryFailureReason):'')+'</span></div>':'');
  const recoveryAckLine=recoveryAck?'<div class="flow-line">'+stepTime(recoveryAck.at)+' <strong>A thread：</strong> <span class="event-result">已接收恢复 prompt</span></div>':'';
  return '<article class="round" data-round="'+esc(r.id)+'"><div class="round-head"><span class="round-title">第 '+(index+1)+' 轮</span><span class="round-time">'+esc(shortDate(stopAt))+'</span></div><div class="round-body"><div class="flow-line">'+stepTime(stopAt)+' '+((!r.stop||r.stop.eventType==='main_session_stop_observed')?'<strong>WORKER 发出：</strong> <span class="event-result">Stop</span>':'<strong>WORKER 完成一轮</strong>')+'</div>'+(stopReason?collapsibleHtml('decision-block stop-reason-block',stopReason,key+':stop'):'')+'<div class="flow-line">'+stepTime(decisionAt)+' <strong>SUPERVISOR 判断：</strong> <span class="event-result">'+esc(action)+'</span></div>'+collapsibleHtml('decision-block',decisionText,key+':decision')+routeHtml(r,key)+'<div class="flow-line">'+(returnedAt?stepTime(returnedAt)+' ':'')+'<strong>WORKER 收到：</strong>'+(prompt?'':' <span class="event-result">未交付</span>')+'</div>'+(prompt?collapsibleHtml('prompt-block',prompt,key+':prompt'):'')+recoveryLine+recoveryAckLine+'</div></article>';
}
function setExpanded(node,expanded){node.classList.toggle('expanded',expanded);node.setAttribute('aria-expanded',String(expanded));const marker=node.querySelector('.collapse-marker');if(marker)marker.textContent=expanded?'⌃':'⌄'}
function wireCollapsibles(){document.querySelectorAll('[data-collapsible]').forEach(node=>{node.onclick=()=>setExpanded(node,!node.classList.contains('expanded'))})}
function statusDateTime(v){try{const d=new Date(v);if(Number.isNaN(d.getTime()))return v;return String(d.getFullYear()).slice(-2)+'/'+String(d.getMonth()+1).padStart(2,'0')+'/'+String(d.getDate()).padStart(2,'0')+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0')}catch{return v}}
function expandedKeys(){return new Set([...document.querySelectorAll('[data-collapsible].expanded')].map(node=>node.dataset.collapsibleKey).filter(Boolean))}
function timelineAtBottom(node){return node.scrollHeight-node.scrollTop-node.clientHeight<=24}
function restoreTimelineScroll(node,preserve,followBottom,scrollTop){const apply=()=>{node.scrollTop=(!preserve||followBottom)?node.scrollHeight:scrollTop};if(typeof requestAnimationFrame==='function')requestAnimationFrame(apply);else apply()}
function restoreExpanded(keys){document.querySelectorAll('[data-collapsible]').forEach(node=>setExpanded(node,keys.has(node.dataset.collapsibleKey)))}
function actionButtonHtml(action,label,icon,className=''){return '<button type="button" class="action-icon '+className+'" data-action="'+action+'" aria-label="'+label+'" title="'+label+'">'+icon+'</button>'}
function renderActions(r){const root=$('#task-actions');if(!r||r.readOnly){root.hidden=true;root.innerHTML='';return}root.hidden=false;const paused=r.state.status==='PAUSED'||r.state.status==='INTERRUPTED';root.innerHTML=actionButtonHtml('copy','复制 session ID：'+r.sessionId,r.sessionId,'session-copy')+actionButtonHtml('refresh','当前自动刷新：'+(app.auto?'开':'关'),app.auto?'↻':'Ⅱ',app.auto?'on':'')+actionButtonHtml(paused?'resume':'pause',paused?'恢复 Needs Forever':'停止 Needs Forever',paused?'▶':'Ⅱ')+actionButtonHtml('delete','删除此监督及其 NFG 记录','×','danger');const copyButton=root.querySelector('[data-action="copy"]');if(copyButton){copyButton.dataset.sessionCopy='';copyButton.dataset.sessionId=r.sessionId}wireActions();wireSessionCopy()}
async function controlTask(action){if(!app.taskId)return;if(action==='delete'&&!window.confirm('删除此监督及其 NFG 记录？系统级日志不会删除。'))return;const response=await fetch('/api/tasks/'+encodeURIComponent(app.taskId)+'/control',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action})});const result=await response.json();if(!response.ok)throw new Error(result.error||'控制操作失败');if(action==='delete'){app.record=null;app.taskId=null;history.replaceState({},'', '/');renderRecord();await loadTasks();return}await loadTasks();await loadRecord(false)}
function wireActions(){document.querySelectorAll('[data-action]').forEach(button=>{button.onclick=(event)=>{event.preventDefault();event.stopPropagation();const action=button.dataset.action;if(action==='copy'){const value=app.record?.sessionId||'';button.dataset.sessionId=value;void copySessionId(button);return}if(action==='refresh'){app.auto=!app.auto;renderActions(app.record);return}if(action==='pause'||action==='resume'||action==='delete'){void controlTask(action).catch(error=>{$('#error').textContent=error.message;$('#error').hidden=false})}}})}function recoveryHtml(r){const recovery=r.state.recovery;if(!recovery||recovery.source==='none'||recovery.source==='interrupted')return '';const source={automatic:'自动恢复',user_pause:'人工暂停',user_limit:'达到人工限制',delete:'已删除',done:'已完成'}[recovery.source]||recovery.source;const parts=[source];if(recovery.reason)parts.push(recovery.reason);if(recovery.attempt>0)parts.push('尝试 '+recovery.attempt);if(recovery.nextRetryAt)parts.push('下次重试 '+statusDateTime(recovery.nextRetryAt));if(recovery.nativeReceipt==='waiting')parts.push('等待 native receipt');else if(recovery.nativeReceipt==='received')parts.push('native receipt 已确认');return '<div class="status-reason">'+esc(parts.join(' · '))+'</div>'}function liveIsStale(live){const generated=Date.parse(live.generatedAt);if(!Number.isFinite(generated))return true;return Date.now()-generated>live.staleAfterMs}
function durationText(seconds){const total=Math.max(0,Math.floor(Number(seconds)||0));const hours=Math.floor(total/3600);const minutes=Math.floor((total%3600)/60);const rest=total%60;return (hours?hours+'h ':'')+minutes+'m '+rest+'s'}
function limitsText(limits){if(!limits)return '未记录';const parts=[];parts.push('turns='+(limits.max_worker_turns??'∞'));parts.push('minutes='+(limits.max_minutes??'∞'));if(limits.max_tokens!==undefined)parts.push('tokens='+(limits.max_tokens??'∞'));if(limits.max_cost!==undefined)parts.push('cost='+(limits.max_cost??'∞'));return parts.join(' · ')}
const transcriptLabels={user:'A 输入',assistant:'A',thinking:'thinking',tool_call:'工具调用',tool_result:'工具结果',direction:'B 方向',decision:'C 决策',verification:'独立验证',status:'状态'};
function transcriptItemHtml(item){
  const time=shortTime(item.at);const label=transcriptLabels[item.kind]||item.kind;
  const meta='<div class="chat-meta"><span>'+esc(label)+(item.toolName?' · '+esc(item.toolName):'')+'</span><span class="chat-time">'+esc(time)+'</span></div>';
  if(item.kind==='thinking')return '<details class="thinking" data-transcript-id="'+esc(item.id)+'"><summary><span>thinking</span><span class="chat-time">'+esc(time)+'</span></summary><div class="thinking-text">'+esc(item.text)+'</div></details>';
  if(item.kind==='tool_call')return '<article class="chat-item tool_call" data-transcript-id="'+esc(item.id)+'">'+meta+'<pre class="chat-pre">'+esc(item.text)+'</pre></article>';
  if(item.kind==='tool_result'){const badges=(item.isError?'<span class="badge error">error</span>':'')+(item.truncated?'<span class="badge">truncated</span>':'');return '<article class="chat-item tool_result '+(item.isError?'error':'')+'" data-transcript-id="'+esc(item.id)+'">'+meta+'<pre class="chat-pre">'+esc(item.text)+'</pre>'+badges+'</article>'}
  return '<article class="chat-item '+esc(item.kind)+'" data-transcript-id="'+esc(item.id)+'">'+meta+'<p class="chat-text">'+esc(item.text)+'</p>'+((item.truncated)?'<span class="badge">truncated</span>':'')+'</article>';
}
function transcriptHtml(live){if(!live.transcript.length)return '<div class="empty">暂无已提交的对话。</div>';return live.transcript.map(transcriptItemHtml).join('')}
function liveHtml(r){
  const live=r.live;const state=r.state;const stale=liveIsStale(live);const latestRound=r.rounds.length?r.rounds[r.rounds.length-1].id:'-';
  const active=live.activeSeconds===undefined?'未记录':durationText(live.activeSeconds);
  const staleText=stale?'<div class="live-stale">投影已过期：生成于 '+esc(statusDateTime(live.generatedAt))+'，超过 '+esc(String(live.staleAfterMs))+'ms 未刷新。状态可能已经停止更新。</div>':'';
  return '<div class="live-head" id="live-head"><div class="live-head-row"><h2>实时对话</h2><span class="live-status-line '+statusClass(state.status,state.phase)+'">'+esc(statusText(state.status,state.phase))+'</span></div><div class="live-meta"><strong>phase</strong> '+esc(state.phase)+' · <strong>round</strong> '+esc(latestRound)+' · <strong>turns</strong> '+esc(String(state.workerTurnCount))+' · <strong>active</strong> '+esc(active)+'<br><strong>limits</strong> '+esc(limitsText(live.limits))+' · <strong>window</strong> '+esc(String(live.transcript.length))+'/'+esc(String(live.window.limit))+(live.window.hasMore?'（更早已省略）':'')+'</div>'+(live.limitReason?'<div class="live-meta"><strong>limit</strong> '+esc(live.limitReason)+'</div>':'')+(state.lastError?'<div class="live-meta"><strong>error</strong> '+esc(state.lastError)+'</div>':'')+staleText+'</div><div class="transcript" id="transcript">'+transcriptHtml(live)+'</div><button type="button" id="jump-latest" class="jump" hidden>跳到最新</button>';
}
function stageSummaryHtml(r){
  const acceptance=r.state.acceptance||[];
  const verification=r.rounds.flatMap(round=>round.technicalEvents||[]).findLast(event=>event.eventType==='verification_result');
  const limits=limitsText(r.live&&r.live.limits);
  const acceptanceHtml=acceptance.length?'<ul>'+acceptance.map(item=>'<li>'+esc(item.id)+': '+esc(item.text)+'</li>').join('')+'</ul>':'<div class="live-meta">未记录验收项。</div>';
  const verificationText=verification?((verification.result==='PASS'?'通过':'未通过')+' · '+(verification.summary||'')):'未运行';
  const error=r.state.lastError||r.live?.limitReason||'';
  return '<div class="stage-summary"><section class="stage-card"><h3>验收</h3>'+acceptanceHtml+'</section><section class="stage-card"><h3>状态</h3><dl class="stage-kv"><dt>verification</dt><dd>'+esc(verificationText)+'</dd><dt>limits</dt><dd>'+esc(limits)+'</dd><dt>turns</dt><dd>'+esc(String(r.state.workerTurnCount))+'</dd><dt>updated</dt><dd>'+esc(statusDateTime(r.updatedAt))+'</dd><dt>error</dt><dd>'+esc(error||'无')+'</dd></dl></section></div>';
}
function applyLiveTab(){
  const live=$('#live');const timeline=$('#timeline');
  if(!live||!timeline)return;
  live.classList.toggle('mobile-hidden',app.liveTab==='stages');
  timeline.classList.toggle('mobile-hidden',app.liveTab==='chat');
  document.querySelectorAll('[data-live-tab]').forEach(button=>{const active=button.dataset.liveTab===app.liveTab;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active))});
}
function renderLiveTabs(){const tabs=$('#live-tabs');if(!tabs)return;const live=Boolean(app.record&&app.record.live);tabs.hidden=!live;if(!live){tabs.innerHTML='';const livePane=$('#live');const timeline=$('#timeline');if(livePane)livePane.classList.remove('mobile-hidden');if(timeline)timeline.classList.remove('mobile-hidden');return}if(!tabs.querySelector('[data-live-tab]')){tabs.innerHTML='<button type="button" data-live-tab="chat">对话</button><button type="button" data-live-tab="stages">阶段</button>'}tabs.querySelectorAll('[data-live-tab]').forEach(button=>{button.onclick=()=>{app.liveTab=button.dataset.liveTab==='stages'?'stages':'chat';applyLiveTab()}});applyLiveTab()}
function wireLivePane(){
  const live=$('#live');if(!live)return;
  live.onscroll=()=>{const at=timelineAtBottom(live);app.followLive=at;const jump=$('#jump-latest');if(jump)jump.hidden=at};
  const jump=$('#jump-latest');
  if(jump)jump.onclick=()=>{app.followLive=true;live.scrollTop=live.scrollHeight;jump.hidden=true};
}
function renderRecord(preserve=false,followBottom=false,scrollTop=0){
const r=app.record;const content=$('#content');const timeline=$('#timeline');const livePane=$('#live');const expanded=preserve?expandedKeys():new Set();const live=Boolean(r&&r.live);const liveScrollTop=livePane?livePane.scrollTop:0;
content.classList.toggle('live-view',live);renderLiveTabs();if(livePane)livePane.hidden=!live;
if(!r){$('#task-header').hidden=true;renderActions(null);if(livePane)livePane.innerHTML='';timeline.innerHTML='<div class="empty">选择一个任务查看监督记录。</div>';restoreTimelineScroll(timeline,false,false,0);return}
$('#task-header').hidden=false;$('#task-title').textContent=r.title||r.taskId;$('#task-goal').textContent=r.state.goal;const s=$('#task-status');s.textContent=(statusText(r.state.status,r.state.phase))+' '+statusDateTime(r.updatedAt);s.className='status '+statusClass(r.state.status,r.state.phase);const reason=r.state.lastError||r.state.recoveryCondition?.message||'';$('#task-meta').innerHTML=(reason?'<div class="status-reason">'+esc(reason)+'</div>':'')+recoveryHtml(r);
if(live&&livePane){livePane.innerHTML=liveHtml(r);const jump=livePane.querySelector('#jump-latest');if(jump){jump.hidden=app.followLive;jump.onclick=()=>{app.followLive=true;livePane.scrollTop=livePane.scrollHeight;jump.hidden=true}}}
else if(livePane){livePane.innerHTML=''}
const rounds=r.rounds.filter(matches);timeline.innerHTML=(live?stageSummaryHtml(r):'')+(rounds.length?rounds.map((x,i)=>roundHtml(x,i)).join(''):'<div class="empty">暂无完整 A→B→C 监督轮次。</div>');wireCollapsibles();restoreExpanded(expanded);renderActions(r);timeline.querySelectorAll('.round-toggle').forEach(b=>b.onclick=()=>b.closest('.round').classList.toggle('open'));if(live&&livePane){if(app.followLive)livePane.scrollTop=livePane.scrollHeight;else livePane.scrollTop=liveScrollTop}restoreTimelineScroll(timeline,preserve,followBottom,scrollTop)}async function loadTasks(){const response=await fetch('/api/tasks',{cache:'no-store'});if(!response.ok)throw new Error('读取任务列表失败');const data=await response.json();renderTasks(data.tasks||[]);if(!app.taskId&&data.tasks?.[0]){app.taskId=data.tasks[0].taskId;history.replaceState({},'', '/tasks/'+encodeURIComponent(app.taskId))}return data.tasks||[]}
async function loadRecord(preserve=false){
const timeline=$('#timeline');const followBottom=preserve&&timelineAtBottom(timeline);const scrollTop=timeline.scrollTop;
if(!app.taskId){renderRecord(preserve,followBottom,scrollTop);return}
const response=await fetch('/api/tasks/'+encodeURIComponent(app.taskId),{cache:'no-store'});if(!response.ok)throw new Error((await response.json()).error||'读取任务失败');const next=await response.json();const changed=JSON.stringify(app.record)!==JSON.stringify(next);app.record=next;if(changed||!preserve)renderRecord(preserve,followBottom,scrollTop)}async function load(){try{$('#error').hidden=true;wireLivePane();await loadTasks();if(app.taskId)await loadRecord(false)}catch(e){$('#error').textContent=e.message;$('#error').hidden=false}}
async function refresh(){if(app.refreshing)return;app.refreshing=true;try{$('#error').hidden=true;await loadTasks();if(app.taskId)await loadRecord(true)}catch(e){$('#error').textContent=e.message;$('#error').hidden=false}finally{app.refreshing=false}}
$('#drawer-close').onclick=()=>$('#drawer').classList.remove('open');window.onpopstate=()=>{app.taskId=new URL(location.href).pathname.match(/^\/tasks\/([^/]+)/)?.[1]||null;load()};setInterval(()=>{if(app.auto)refresh()},1500);load();
</script>
</body></html>`;
