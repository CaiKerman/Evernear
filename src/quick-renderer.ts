import type { QuickInput } from './quick-input.js';
type State = ReturnType<QuickInput['snapshot']>;
declare global { interface Window { quick: { invoke: (name: string, ...args: any[]) => Promise<any>; subscribe: (f: (state: State) => void) => () => void } } }
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let state: State, composing = false, expanded = false;
const input = $<HTMLTextAreaElement>('input'), preset = $<HTMLSelectElement>('preset'), context = $<HTMLInputElement>('context');
function error(e: unknown) { $('status').textContent = String(e).replace(/^Error: Error invoking remote method '[^']+': Error: /, ''); $('status').classList.add('error'); }
async function call(name: string, ...args: any[]) { try { return await window.quick.invoke(name, ...args); } catch (e) { error(e); throw e; } }
function fire(name: string, ...args: any[]) { void call(name, ...args).catch(() => {}); }
function expand(value: boolean) { expanded = value; $('result-panel').hidden = !value; fire('quick:expand', value); }
function render(next: State) {
    const fresh = !state || state.id !== next.id;
    state = next;
    preset.value = next.settings.preset; context.checked = next.settings.context;
    input.placeholder = next.settings.preset === 'translate' ? '输入中文或英文，回车翻译…' : '输入文字，回车发送…';
    const running = next.status === 'running';
    $<HTMLButtonElement>('send').hidden = running; $('cancel').hidden = !running;
    $<HTMLButtonElement>('copy').disabled = !next.result;
    $('result-label').textContent = next.status === 'done' ? '结果' : running ? '生成中…' : '未完成';
    $('result').textContent = next.result;
    $('timing').textContent = next.totalMs === null ? '' : `首段 ${next.firstMs ?? '—'} ms · 总耗时 ${next.totalMs} ms`;
    $('status').classList.toggle('error', !!next.error);
    $('status').textContent = next.error || (running ? '生成中 · 可取消' : next.busySource ? `文字任务忙：${next.busySource}` : `${next.settings.context ? `局部上下文 · ${next.historyTurns / 2} 轮` : '无上下文'} · 右键设置 · Shift+Enter 换行`);
    if (fresh && next.id) expand(true);
}
input.addEventListener('compositionstart', () => composing = true);
input.addEventListener('compositionend', () => composing = false);
input.onkeydown = e => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing || composing || e.keyCode === 229) return;
    e.preventDefault(); if (state?.status !== 'running') $('quick-form').dispatchEvent(new Event('submit', { cancelable: true }));
};
$('quick-form').onsubmit = e => { e.preventDefault(); if (composing || state?.status === 'running') return; fire('quick:send', input.value); };
$('cancel').onclick = () => fire('quick:cancel');
$('clear').onclick = () => fire('quick:clear');
$('copy').onclick = () => fire('quick:copy');
$('collapse').onclick = () => expand(false);
$('settings').onclick = () => fire('quick:settings');
$('hide').onclick = () => fire('quick:hide');
preset.onchange = context.onchange = () => void call('quick:mode', preset.value, context.checked).then(render).catch(() => { if (state) { preset.value = state.settings.preset; context.checked = state.settings.context; } });
document.onkeydown = e => { if (e.key === 'Escape') { if (expanded) expand(false); else fire('quick:hide'); } };
window.quick.subscribe(render);
void call('quick:snapshot').then(render).catch(() => {});
